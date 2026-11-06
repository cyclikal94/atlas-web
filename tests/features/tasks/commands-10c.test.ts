// @vitest-environment node
import { describe, expect, test } from "vitest";
import * as commands from "../../../src/features/tasks/model/commands";
import { taskCommandSpecs } from "../../../src/features/tasks/register";
import { outboxWorld } from "../../support/data/outbox-world";
import { cacheRow } from "../../support/data/rows";
import { record as defaultsRecord, ME } from "../../support/data/sharing";

/**
 * WEB-10c's queued commands (A9, A12–A14; WEB-04 §5.2 and §5.7 items 3–4; plan §3.2's builder table) through the PRODUCTION enqueue plan
 * over the IndexedDB double: each stored header's kind, primaries, side effects, bases, bumps and version records, the wire body, the
 * defaults captured, the stored-draft admission the registry derives, and the pending evidence a completion carries.
 */
const OCC = "70000000-0000-4000-8000-000000000101";
const PRE_A = "70000000-0000-4000-8000-000000000102";
const PRE_B = "70000000-0000-4000-8000-000000000103";
const MINE = "70000000-0000-4000-8000-000000000104";
const MINE_A = "70000000-0000-4000-8000-000000000105";
const SESSION = "70000000-0000-4000-8000-000000000106";
const TOKEN = "c".repeat(64);

const bodyOf = (w: Awaited<ReturnType<typeof outboxWorld>>, localId: string) =>
  (
    w.rows("draft_commands") as Array<{
      local_id: string;
      command: { command: Record<string, unknown>; defaults_revision?: string };
    }>
  ).find((r) => r.local_id === localId)?.command;
const versions = (w: Awaited<ReturnType<typeof outboxWorld>>) =>
  Object.fromEntries(
    w.versions().map((v) => [v.resource_id, v.locally_assumed_version]),
  );

describe("set_dependencies", () => {
  test("checked against the occurrence's version (raised), each prerequisite an unchecked ordering target; the whole list and strict sent", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: OCC, kind: "occurrence", version: 3 }),
      cacheRow({ id: PRE_A, kind: "occurrence", version: 7 }),
    ]);
    const out = await w.outbox.enqueue(
      commands.setDependencies({
        occurrenceId: OCC,
        prerequisites: [PRE_A, PRE_B],
        strict: true,
      }),
    );
    expect(out.kind).toBe("queued");
    const draft = w.drafts()[0];
    expect(draft?.kind).toBe("set_dependencies");
    expect(draft?.target_resource_ids).toEqual([OCC, PRE_A, PRE_B]);
    expect(draft?.bumped).toEqual([OCC]);
    expect(draft?.expected_version).toBe(3);
    expect(versions(w)[OCC]).toBe(4);
    expect(bodyOf(w, draft?.local_id as string)?.command).toEqual({
      kind: "set_dependencies",
      occurrence_id: OCC,
      expected_version: 3,
      prerequisites: [PRE_A, PRE_B],
      strict: true,
    });
    expect(
      taskCommandSpecs().set_dependencies?.admission?.({
        ...draft,
        command: bodyOf(w, draft?.local_id as string),
      } as never),
    ).toEqual({
      [OCC]: { requiresEdit: true },
    });
  });

  test("a known denial of the occurrence refuses it in the writing transaction", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: OCC, kind: "occurrence", version: 3, can_edit: false }),
    ]);
    const out = await w.outbox.enqueue(
      commands.setDependencies({
        occurrenceId: OCC,
        prerequisites: [],
        strict: false,
      }),
    );
    expect(out).toEqual({ kind: "refused", reason: "denied" });
  });
});

describe("complete_dependencies", () => {
  const input = (
    over: Partial<commands.CompleteDependenciesInput> = {},
  ): commands.CompleteDependenciesInput => ({
    occurrenceId: OCC,
    previewToken: TOKEN,
    mode: "complete_prerequisites",
    happenedAt: 1_800_000_000,
    rootEvidence: null,
    rootStream: { id: MINE, known: true },
    prerequisites: [
      { occurrenceId: PRE_A, stream: MINE_A },
      { occurrenceId: PRE_B, stream: null },
    ],
    defaults: defaultsRecord(),
    ...over,
  });

  test("MU-10C-15/14: in complete_prerequisites mode my streams of the root and of each held prerequisite are raised; the progress defaults are captured", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: MINE, kind: "progress", version: 2 }),
      cacheRow({ id: MINE_A, kind: "progress", version: 5 }),
    ]);
    const out = await w.outbox.enqueue(commands.completeDependencies(input()));
    expect(out.kind).toBe("queued");
    const draft = w.drafts()[0];
    expect(draft?.target_resource_ids).toEqual([OCC, PRE_A, PRE_B]);
    expect(draft?.side_effect_bases).toEqual({ [MINE]: 2, [MINE_A]: 5 });
    expect(versions(w)).toMatchObject({ [MINE]: 3, [MINE_A]: 6 });
    const body = bodyOf(w, draft?.local_id as string);
    expect(body?.command).toEqual({
      kind: "complete_dependencies",
      occurrence_id: OCC,
      preview_token: TOKEN,
      mode: "complete_prerequisites",
      happened_at: 1_800_000_000,
    });
    expect(typeof body?.defaults_revision).toBe("string");
    expect(
      taskCommandSpecs().complete_dependencies?.admission?.({
        ...draft,
        command: body,
      } as never),
    ).toEqual({
      [MINE]: { requiresEdit: true, joinRequiresEdit: OCC },
      [MINE_A]: { requiresEdit: true },
    });
  });

  test("a prerequisite stream said to be held but without a known base is refused (no_base): the caller names only streams it holds", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: MINE, kind: "progress", version: 2 })]);
    expect(
      await w.outbox.enqueue(commands.completeDependencies(input())),
    ).toEqual({
      kind: "refused",
      reason: "no_base",
    });
  });

  test("another mode raises only my root stream (seeded at 1 when created on demand) and sends the root evidence", async () => {
    const w = await outboxWorld();
    const out = await w.outbox.enqueue(
      commands.completeDependencies(
        input({
          mode: "advisory_override",
          rootEvidence: { kind: "quantity", amount: "30" },
          rootStream: { id: MINE, known: false },
        }),
      ),
    );
    expect(out.kind).toBe("queued");
    const draft = w.drafts()[0];
    expect(draft?.target_resource_ids).toEqual([OCC]);
    expect(draft?.side_effect_bases).toEqual({ [MINE]: 1 });
    expect(bodyOf(w, draft?.local_id as string)?.command.root_evidence).toEqual(
      {
        kind: "quantity",
        amount: "30",
      },
    );
  });

  test("MU-10C-35: its pending evidence is a tick of each completed prerequisite and the root's own evidence, by occurrence", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: MINE, kind: "progress", version: 2 }),
      cacheRow({ id: MINE_A, kind: "progress", version: 1 }),
    ]);
    const queued = await w.outbox.enqueue(
      commands.completeDependencies(
        input({ rootEvidence: { kind: "quantity", amount: "4" } }),
      ),
    );
    expect(queued.kind).toBe("queued");
    const draft = w.drafts()[0];
    const pending = commands.pendingEvidenceListOf(
      { ...draft, command: bodyOf(w, draft?.local_id as string) } as never,
      draft?.account_id as string,
    );
    expect(pending.map((p) => [p.occurrenceId, p.evidence])).toEqual([
      [OCC, { kind: "quantity", amount: "4" }],
      [PRE_A, { kind: "checkbox", complete: true }],
      [PRE_B, { kind: "checkbox", complete: true }],
    ]);
    expect(
      commands.pendingEvidenceListOf(
        { ...draft, command: bodyOf(w, draft?.local_id as string) } as never,
        "someone-else",
      ),
    ).toEqual([]);
  });
});

describe("timers (B6)", () => {
  test("MU-10C-24: a start seeds its session at 1 (no expected version) and raises my stream as a side effect; an Anyone first stream captures the defaults", async () => {
    const w = await outboxWorld();
    w.put("cache", [cacheRow({ id: MINE, kind: "progress", version: 4 })]);
    await w.outbox.enqueue(
      commands.startTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: MINE,
        startedAt: 1_800_000_100,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    const draft = w.drafts()[0];
    expect(draft?.kind).toBe("start_timer");
    expect(draft?.target_resource_ids).toEqual([SESSION, OCC]);
    expect(draft?.side_effect_bases).toEqual({ [MINE]: 4 });
    expect(draft?.expected_version).toBeUndefined();
    expect(versions(w)).toMatchObject({ [SESSION]: 1, [MINE]: 5 });
    expect(bodyOf(w, draft?.local_id as string)).toEqual({
      command: {
        kind: "start_timer",
        occurrence_id: OCC,
        session_id: SESSION,
        started_at: 1_800_000_100,
      },
    });
    const first = await outboxWorld();
    await first.outbox.enqueue(
      commands.startTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: MINE,
        startedAt: 1_800_000_100,
        firstAnyoneStream: true,
        defaults: defaultsRecord(),
      }),
    );
    expect(first.drafts()[0]?.side_effect_bases).toEqual({ [MINE]: 1 });
    expect(
      typeof bodyOf(first, first.drafts()[0]?.local_id as string)
        ?.defaults_revision,
    ).toBe("string");
  });

  test("MU-10C-21: a stop is checked against the SESSION's version (the start's record), never the occurrence's", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      cacheRow({ id: MINE, kind: "progress", version: 4 }),
      cacheRow({ id: OCC, kind: "occurrence", version: 9 }),
    ]);
    await w.outbox.enqueue(
      commands.startTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: MINE,
        startedAt: 1_800_000_100,
        firstAnyoneStream: false,
        defaults: null,
      }),
    );
    await w.outbox.enqueue(
      commands.stopTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: MINE,
        streamKnown: true,
        knownVersion: null,
        stoppedAt: 1_800_000_400,
      }),
    );
    const [start, stop] = [...w.drafts()].sort(
      (a, b) => a.created_seq - b.created_seq,
    );
    expect(stop?.depends_on).toEqual([start?.local_id]);
    expect(stop?.expected_version).toBe(1);
    expect(bodyOf(w, stop?.local_id as string)?.command).toEqual({
      kind: "stop_timer",
      occurrence_id: OCC,
      session_id: SESSION,
      expected_version: 1,
      stopped_at: 1_800_000_400,
    });
    expect(versions(w)).toMatchObject({ [SESSION]: 2, [MINE]: 6 });
    expect(
      taskCommandSpecs().stop_timer?.admission?.({
        ...stop,
        command: bodyOf(w, stop?.local_id as string),
      } as never),
    ).toEqual({ [MINE]: { requiresEdit: true } });
  });

  test("a stop of a session only a read knows uses that version; a stream this device does not hold is no target", async () => {
    const w = await outboxWorld();
    await w.outbox.enqueue(
      commands.cancelTimer({
        occurrenceId: OCC,
        sessionId: SESSION,
        progressId: MINE,
        streamKnown: false,
        knownVersion: 3,
      }),
    );
    const draft = w.drafts()[0];
    expect(draft?.expected_version).toBe(3);
    expect(draft?.side_effect_bases).toEqual({});
    expect(bodyOf(w, draft?.local_id as string)?.command).toEqual({
      kind: "cancel_timer",
      occurrence_id: OCC,
      session_id: SESSION,
      expected_version: 3,
    });
  });
});

describe("the registry", () => {
  test("every WEB-10c kind is described, and none offers a rebuild or a current read (WF-QUEUE-02 offers discard)", () => {
    const specs = taskCommandSpecs();
    for (const kind of [
      "set_dependencies",
      "complete_dependencies",
      "start_timer",
      "stop_timer",
      "cancel_timer",
    ]) {
      expect(specs[kind]?.describe({} as never)).toBeTruthy();
      expect(specs[kind]?.rebuild).toBeUndefined();
      expect(specs[kind]?.readCurrent).toBeUndefined();
    }
    for (const kind of commands.QUEUED_KINDS) expect(specs[kind]).toBeDefined();
    expect(ME).toBeTruthy();
  });
});
