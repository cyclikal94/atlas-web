// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { HandOff } from "../../src/data";
import { digestOf } from "../../src/data/model/canonical";
import type { EnqueueRequest, TargetSpec } from "../../src/data/model/outbox";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import { inspectFormRecovery } from "../../src/data/plans/form-copies";
import { MAX_WRITER_GEN } from "../../src/data/plans/form-recovery";
import { createConditionalFormPort } from "../../src/data/ports/conditional-form";
import { type OutboxWorld, outboxWorld } from "../support/data/outbox-world";

/**
 * WEB-11a review 4 of 23 October 2026, finding 1 (the third design assessment's C8, schedules T3/T4): a held change's content is HANDED
 * OFF to the outbox in ONE transaction (`transferDraft`): the draft is written and the form copy that held it ends, keeping a tombstone,
 * or neither. Over the production outbox facade, the production plans and the IndexedDB double. Whatever Sync does with the draft
 * afterwards (discard, edit, supersede, send and receipt), the copy stays ended, and a retry of the same hand-off writes nothing: a
 * draft is never recreated from a copy that was already handed off. FIXTURE evidence (the double, not a real engine).
 */
const CONTEXT = "people-held:p:f";
const TAB = "aaaaaaaa-0000-4000-8000-000000000001";
const HEAD = "~head";
const NOW = "2026-10-23T09:00:00.000Z";

const target: TargetSpec = {
  resourceId: "f",
  role: "primary",
  basis: "resource",
  versionChecked: false,
  seedIfUntracked: 1,
};
const request = (text: string, localId = TAB): EnqueueRequest => ({
  localId,
  endpoint: "/task-commands",
  targets: [target],
  build: () => ({ command: { command: { kind: "put_field", id: "f", text } } }),
});

/** The held copy and the field's head, as "Hold as draft" writes them (one transaction, through the conditional port). */
async function held(w: OutboxWorld) {
  const port = createConditionalFormPort({
    service: () => w.service,
    now: () => NOW,
  });
  const answer = await port.apply([
    {
      snapshot: {
        formContext: CONTEXT,
        tabInstanceId: TAB,
        values: { held: "the person's text" },
        savedAt: NOW,
      },
      terminal: false,
      expect: { state: "absent" },
    },
    {
      snapshot: {
        formContext: CONTEXT,
        tabInstanceId: HEAD,
        values: { held_head: "current" },
        savedAt: NOW,
      },
      terminal: true,
      expect: { state: "absent" },
    },
  ]);
  if (answer.kind !== "saved") throw new Error("setup");
  const [source, head] = answer.digests as [string, string];
  const handOff: HandOff = {
    source: { formContext: CONTEXT, tabInstanceId: TAB, digest: source },
    tombstone: { held_end: "transferred" },
    also: [
      {
        formContext: CONTEXT,
        tabInstanceId: HEAD,
        terminal: true,
        digest: head,
      },
    ],
  };
  return { port, handOff };
}

const stored = (w: OutboxWorld, tab = TAB) =>
  w.service.store.run(inspectFormRecovery, {
    incarnationId: w.service.incarnationId,
    formContext: CONTEXT,
    tabInstanceId: tab,
  });
const rowOf = (w: OutboxWorld, tab = TAB): FormRecoveryRow | undefined =>
  (w.snapshot()?.form_recovery as FormRecoveryRow[] | undefined)?.find(
    (row) => row.tab_instance_id === tab,
  );

describe("review 4, finding 1: a hand-off is ONE transaction (T3)", () => {
  test("the draft is written and the copy ends in the same commit; the copy keeps its tombstone and the conditional family's generation", async () => {
    const w = await outboxWorld();
    const { handOff } = await held(w);
    expect(await w.outbox.enqueue(request("first"), handOff)).toMatchObject({
      kind: "queued",
      localId: TAB,
    });
    expect(w.drafts().map((d) => d.local_id)).toEqual([TAB]);
    expect(await stored(w)).toEqual({
      kind: "ended",
      fields: { held_end: "transferred" },
      digest: digestOf({ held_end: "transferred" }),
    });
    expect(rowOf(w)).toMatchObject({
      terminal: true,
      writer_gen: MAX_WRITER_GEN,
      form_context: CONTEXT,
    });
    // The head is untouched (only the hold's own copy ends).
    expect(rowOf(w, HEAD)?.fields).toEqual({ held_head: "current" });
  });

  test("control: an enqueue without a hand-off touches no form copy", async () => {
    const w = await outboxWorld();
    await held(w);
    expect((await w.outbox.enqueue(request("plain"))).kind).toBe("queued");
    expect((await stored(w)).kind).toBe("live");
  });

  for (const moved of ["another state", "ended elsewhere", "the head moved"])
    test(`a hand-off whose rows are not as read (${moved}) writes NOTHING: no draft, the copy as it is`, async () => {
      const w = await outboxWorld();
      const { port, handOff } = await held(w);
      if (moved === "another state") {
        const next = await port.put(
          {
            formContext: CONTEXT,
            tabInstanceId: TAB,
            values: { held: "edited elsewhere" },
            savedAt: NOW,
          },
          handOff.source.digest,
        );
        expect(next.kind).toBe("saved");
      } else if (moved === "ended elsewhere")
        expect((await port.end(CONTEXT, TAB, handOff.source.digest)).kind).toBe(
          "ended",
        );
      else {
        const head = handOff.also[0] as HandOff["also"][number];
        expect(
          (
            await port.apply([
              {
                snapshot: {
                  formContext: CONTEXT,
                  tabInstanceId: HEAD,
                  values: { held_head: "another" },
                  savedAt: NOW,
                },
                terminal: true,
                expect: { state: "ended", digest: head.digest },
              },
            ])
          ).kind,
        ).toBe("saved");
      }
      const before = rowOf(w);
      expect(await w.outbox.enqueue(request("first"), handOff)).toEqual({
        kind: "refused",
        reason: "source_changed",
      });
      expect(w.drafts()).toEqual([]);
      expect(w.rows("draft_commands")).toEqual([]);
      expect(rowOf(w)).toEqual(before);
    });

  test("a draft that already has the local id is never adopted as the hand-off: nothing is written, both are as they were", async () => {
    const w = await outboxWorld();
    const { handOff } = await held(w);
    expect((await w.outbox.enqueue(request("earlier"))).kind).toBe("queued");
    const draft = w.drafts()[0];
    expect(await w.outbox.enqueue(request("first"), handOff)).toEqual({
      kind: "refused",
      reason: "source_changed",
    });
    expect(w.drafts()).toEqual([draft]);
    expect((await stored(w)).kind).toBe("live");
  });

  for (const fault of [false, true])
    test(`a failure inside the transaction rolls BOTH back: no draft and the copy live (${fault ? "fault" : "healthy control"})`, async () => {
      const w = await outboxWorld();
      const { handOff } = await held(w);
      if (fault)
        w.env.idb.inject({
          match: (tx) => tx.label === "data.transferDraft",
          // The draft's own writes are in the transaction's overlay when it fails.
          mode: { kind: "throw_on_write", n: 3, as: "error" },
          times: 1,
        });
      const out = await w.outbox.enqueue(request("first"), handOff);
      if (fault) {
        expect(out).toEqual({ kind: "refused", reason: "storage" });
        expect(w.drafts()).toEqual([]);
        expect(w.rows("draft_commands")).toEqual([]);
        expect((await stored(w)).kind).toBe("live");
        // Nothing was handed off: the same hand-off may be made again, once.
        expect((await w.outbox.enqueue(request("first"), handOff)).kind).toBe(
          "queued",
        );
      }
      expect(w.drafts()).toHaveLength(1);
      expect((await stored(w)).kind).toBe("ended");
    });

  test("its answer lost after it committed: the copy says it was handed off, and a retry writes nothing", async () => {
    const w = await outboxWorld();
    const { handOff } = await held(w);
    const remove = w.env.idb.inject({
      match: (tx) => tx.label === "data.transferDraft",
      mode: "commit_then_lose_completion",
      times: 1,
    });
    // Its caller never hears that it committed (whatever it is told, if anything, is not what happened).
    void w.outbox.enqueue(request("first"), handOff).catch(() => undefined);
    await w.settle();
    remove();
    expect(await stored(w)).toMatchObject({
      kind: "ended",
      fields: { held_end: "transferred" },
    });
    expect(w.drafts()).toHaveLength(1);
    const seq = w.drafts()[0]?.created_seq;
    expect(await w.outbox.enqueue(request("first"), handOff)).toEqual({
      kind: "refused",
      reason: "source_changed",
    });
    expect(w.drafts().map((d) => d.created_seq)).toEqual([seq]);
  });

  test("while signing out (closing) a hand-off is refused and nothing is written", async () => {
    const w = await outboxWorld();
    const { handOff } = await held(w);
    await w.service.store.run(setClosing, {
      incarnationId: w.service.incarnationId,
      now: 1,
      token: "t",
    });
    const out = await w.outbox.enqueue(request("first"), handOff);
    expect(out.kind).toBe("refused");
    expect(w.drafts()).toEqual([]);
    expect((await stored(w)).kind).toBe("live");
  });
});

describe("review 4, finding 1: Sync's writers never undo a hand-off (T4)", () => {
  for (const sync of ["discard", "edit", "supersede", "send"] as const)
    test(`after ${sync === "send" ? "the draft is sent and receipted" : `Sync ${sync}s the draft`}, the copy is still ended and the same hand-off writes nothing`, async () => {
      const w = await outboxWorld();
      const { handOff } = await held(w);
      expect((await w.outbox.enqueue(request("first"), handOff)).kind).toBe(
        "queued",
      );
      const tombstone = rowOf(w);
      if (sync === "discard")
        expect((await w.outbox.discard(TAB)).kind).toBe("discarded");
      else if (sync === "edit")
        expect((await w.outbox.editQueued(TAB, request("edited"))).kind).toBe(
          "edited",
        );
      else if (sync === "supersede") {
        // Only a conflicted draft is superseded (a 409 made it one).
        w.put("drafts", [
          {
            ...(w.drafts()[0] as object),
            status: "version_conflict",
          },
        ]);
        expect(
          (
            await w.outbox.supersede(
              TAB,
              request("replacement", "bbbbbbbb-0000-4000-8000-000000000002"),
            )
          ).kind,
        ).toBe("superseded");
      } else {
        w.online = true;
        w.start();
        await w.settle();
        expect(w.sent).toHaveLength(1);
      }
      const drafts = w.drafts().map((d) => [d.local_id, d.created_seq]);
      const bodies = w.rows("draft_commands");
      expect(rowOf(w)).toEqual(tombstone);
      expect(await w.outbox.enqueue(request("first"), handOff)).toEqual({
        kind: "refused",
        reason: "source_changed",
      });
      expect(w.drafts().map((d) => [d.local_id, d.created_seq])).toEqual(
        drafts,
      );
      expect(w.rows("draft_commands")).toEqual(bodies);
    });
});
