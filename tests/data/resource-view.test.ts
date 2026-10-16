// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { DraftRow } from "../../src/data/model/types";
import {
  type ResourceView,
  readOutstanding,
  readResourceView,
} from "../../src/data/plans/pending-reads";
import {
  configureSourceRequest,
  createSourceRequest,
  importRequest,
} from "../../src/features/calendars/model/commands";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";
import { draftRow } from "../support/data/rows";
import type { PageSpec } from "../support/data/sync-pages";

/**
 * WEB-13a revision 2: the resource view (`readResourceView`) and the observation a save states (`EnqueueRequest.observed`), through the
 * PRODUCTION facade, plans and dispatcher over the double of IndexedDB. A publication is made by the real delta-page writer (W1,
 * `commitPage`), which publishes a receipted create and retires it in ONE transaction. FIXTURE evidence.
 */
const SOURCE = "00000000-0000-4000-8000-0000000000c5";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
/** What `service.commit` answers for a page the writer committed. */
const COMMITTED = { kind: "applied", value: { kind: "committed" } };
const KINDS = { createKind: "create_source", settingsKind: "configure_source" };

const view = (w: OutboxWorld): Promise<ResourceView> =>
  w.service.store.run(readResourceView, {
    incarnationId: w.service.incarnationId,
    id: SOURCE,
    ...KINDS,
  });

const projection = (version: number, timezone: string) => ({
  id: SOURCE,
  kind: "calendar_source",
  parent_id: null,
  label: "Chores",
  value: {
    health: "pending",
    last_success: null,
    coverage_start: null,
    coverage_end: null,
    timezone,
  },
  version,
  can_edit: true,
  archived: false,
});

const page = (
  revision: number,
  version: number,
  timezone: string,
): PageSpec => ({
  phase: "delta",
  hasMore: false,
  nextCursor: `cursor-${revision}`,
  batches: [
    {
      revision,
      changes: [{ kind: "upsert", resource: projection(version, timezone) }],
    },
  ],
});

async function queued(
  w: OutboxWorld,
  request: Parameters<OutboxWorld["outbox"]["enqueue"]>[0],
) {
  const outcome = await w.outbox.enqueue(request);
  if (outcome.kind !== "queued") throw new Error(`setup: ${outcome.kind}`);
  await w.settle();
  return outcome.localId;
}

describe("readResourceView: one read of one resource", () => {
  test("a create's whole lifecycle: queued, receipted and not published, then published and retired AT ONCE by the delta page", async () => {
    const w = await outboxWorld();
    const create = await queued(
      w,
      createSourceRequest({ id: SOURCE, label: "Chores", timezone: "UTC" }),
    );
    const waiting = await view(w);
    expect(waiting).toMatchObject({ base: null, merged: null });
    expect(waiting.create).toMatchObject({
      local_id: create,
      status: "queued",
    });
    w.script.push(w.receipt(5));
    w.start();
    await w.settle();
    const receipted = await view(w);
    expect(receipted.base).toBeNull();
    expect(receipted.create).toMatchObject({
      local_id: create,
      status: "acknowledged",
    });
    expect(receipted.observation.token).not.toBe(waiting.observation.token);
    const out = await w.commit(w.input(page(5, 2, "Asia/Tokyo")));
    expect(out).toMatchObject(COMMITTED);
    const published = await view(w);
    expect(published.base).toMatchObject({ id: SOURCE, version: 2 });
    expect(published.merged?.value).toMatchObject({ timezone: "Asia/Tokyo" });
    // Never half-way: the create is gone in the same read that shows the cached source.
    expect(published.create).toBeNull();
    expect(published.outstanding.total).toBe(0);
    expect(published.observation.token).not.toBe(receipted.observation.token);
  });

  test("the newest settings change that APPLIES, whatever was saved after it (an import) and whatever needs a decision", async () => {
    const w = await outboxWorld();
    await queued(
      w,
      createSourceRequest({ id: SOURCE, label: "Chores", timezone: "UTC" }),
    );
    const configure = await queued(
      w,
      configureSourceRequest(
        { id: SOURCE, value: null },
        { timezone: "Asia/Tokyo", enabled: true },
      ),
    );
    const imported = await queued(
      w,
      importRequest({
        sourceId: SOURCE,
        ics: ICS,
        from: "2026-01-01",
        through: "2026-12-31",
      }),
    );
    const seen = await view(w);
    expect(seen.outstanding.latest?.local_id).toBe(imported);
    expect(seen.outstanding.latestOfKind?.local_id).toBe(configure);
    expect(seen.outstanding.latestOfKind?.command).toMatchObject({
      command: { timezone: "Asia/Tokyo" },
    });
    const outstanding = await w.service.store.run(readOutstanding, {
      incarnationId: w.service.incarnationId,
      id: SOURCE,
      kind: "configure_source",
    });
    expect(outstanding.latestOfKind?.local_id).toBe(configure);
    // A change that needs a decision is not a value the person has: the newest one that still applies is.
    w.put("drafts", [
      draftRow({
        local_id: "conflicted",
        created_seq: 99,
        endpoint: "/calendar-commands",
        kind: "configure_source",
        status: "version_conflict",
        command: {
          command: { kind: "configure_source", id: SOURCE, timezone: "UTC" },
        },
        target_resource_ids: [SOURCE],
        index_targets: [SOURCE],
      }),
    ]);
    expect((await view(w)).outstanding.latestOfKind?.local_id).toBe(configure);
  });

  test("bounded: at 501 drafts against the source it reads at most one window per call and at most three bodies (control at 5)", async () => {
    for (const n of [5, 501]) {
      const w = await outboxWorld();
      w.put(
        "drafts",
        Array.from({ length: n }, (_, i) =>
          draftRow({
            local_id: `d${i}`,
            created_seq: i + 1,
            endpoint: "/calendar-commands",
            kind: i === 0 ? "create_source" : "configure_source",
            command: {
              command: {
                kind: i === 0 ? "create_source" : "configure_source",
                id: SOURCE,
                label: "Chores",
                timezone: `Zone/${i}`,
              },
            },
            target_resource_ids: [SOURCE],
            index_targets: [SOURCE],
          }),
        ),
      );
      w.env.idb.reads.maxBatch.clear();
      w.env.idb.reads.rows.clear();
      const seen = await view(w);
      expect(seen.outstanding.total).toBe(n);
      expect(seen.outstanding.latestOfKind?.local_id).toBe(`d${n - 1}`);
      expect(seen.create?.local_id).toBe("d0");
      expect(w.env.idb.reads.maxBatch.get("drafts") ?? 0).toBeLessThanOrEqual(
        DATA_CONFIG.queueWorkingSet,
      );
      expect(
        w.env.idb.reads.rows.get("draft_commands") ?? 0,
      ).toBeLessThanOrEqual(3);
    }
  });
});

describe("a save that states what it saw is written only if its transaction sees the same (S6, S8)", () => {
  async function cachedSource() {
    const w = await outboxWorld();
    expect(await w.commit(w.input(page(3, 3, "Europe/Vienna")))).toMatchObject(
      COMMITTED,
    );
    return w;
  }
  const change = (
    timezone: string,
    observed?: ResourceView["observation"],
    localId?: string,
  ) =>
    configureSourceRequest(
      { id: SOURCE, value: projection(3, "Europe/Vienna").value },
      { timezone, enabled: false },
      localId,
      observed,
    );
  const bodies = (w: OutboxWorld) =>
    [...w.drafts()]
      .sort((a: DraftRow, b: DraftRow) => a.created_seq - b.created_seq)
      .map((d) => w.commandOf(d.local_id));

  test("control: nothing changed since the read, the change is written on the version that read saw", async () => {
    const w = await cachedSource();
    const seen = await view(w);
    expect(
      await w.outbox.enqueue(change("UTC", seen.observation)),
    ).toMatchObject({
      kind: "queued",
    });
    expect(bodies(w)).toEqual([
      {
        command: {
          kind: "configure_source",
          id: SOURCE,
          expected_version: 3,
          timezone: "UTC",
          enabled: false,
        },
      },
    ]);
  });

  test("another save of the source commits in between: refused as changed, NOTHING written, versions untouched", async () => {
    const w = await cachedSource();
    const seen = await view(w);
    await queued(w, change("Asia/Tokyo"));
    const before = w.snapshot();
    expect(await w.outbox.enqueue(change("UTC", seen.observation))).toEqual({
      kind: "refused",
      reason: "changed",
    });
    expect(w.snapshot()?.drafts).toEqual(before?.drafts);
    expect(w.snapshot()?.draft_commands).toEqual(before?.draft_commands);
    expect(w.snapshot()?.resource_versions).toEqual(before?.resource_versions);
  });

  test("a queued body edited in between without a version change, or a publication in between: refused as changed", async () => {
    const edited = await cachedSource();
    const first = await queued(edited, change("Asia/Tokyo"));
    const seen = await view(edited);
    expect(
      await edited.outbox.editQueued(
        first,
        change("America/New_York", undefined, first),
      ),
    ).toMatchObject({ kind: "edited" });
    expect(edited.versions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locally_assumed_version: 4 }),
      ]),
    );
    expect(
      await edited.outbox.enqueue(change("UTC", seen.observation)),
    ).toEqual({
      kind: "refused",
      reason: "changed",
    });

    const published = await cachedSource();
    const read = await view(published);
    expect(
      await published.commit(published.input(page(4, 4, "Asia/Tokyo"))),
    ).toMatchObject(COMMITTED);
    expect(
      await published.outbox.enqueue(change("UTC", read.observation)),
    ).toEqual({ kind: "refused", reason: "changed" });
    expect(published.drafts()).toEqual([]);
  });

  test("a retry of a save that was MADE (its answer lost) is recognised, although its own write changed what it saw", async () => {
    const w = await cachedSource();
    const seen = await view(w);
    const request = change("UTC", seen.observation, "the-same-save");
    expect(await w.outbox.enqueue(request)).toMatchObject({
      kind: "queued",
      localId: "the-same-save",
    });
    expect(await w.outbox.enqueue(request)).toMatchObject({
      kind: "queued",
      localId: "the-same-save",
    });
    expect(w.drafts()).toHaveLength(1);
  });

  test("a supersession from a conflict states it too: written when unchanged, refused (the old draft kept) when another save came between", async () => {
    for (const between of [false, true]) {
      const w = await cachedSource();
      const old = await queued(w, change("Asia/Tokyo"));
      w.put("drafts", [
        { ...(w.drafts()[0] as DraftRow), status: "version_conflict" },
      ]);
      const seen = await view(w);
      if (between) await queued(w, change("America/New_York"));
      const outcome = await w.outbox.supersede(
        old,
        change("UTC", seen.observation),
      );
      if (between) {
        expect(outcome).toEqual({ kind: "refused", reason: "changed" });
        expect(w.drafts().map((d) => d.local_id)).toContain(old);
      } else {
        expect(outcome).toMatchObject({ kind: "superseded" });
        expect(w.drafts().map((d) => d.local_id)).not.toContain(old);
      }
    }
  });
});
