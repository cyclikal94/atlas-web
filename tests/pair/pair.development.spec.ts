import { randomUUID } from "node:crypto";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { PROOF_SCHEMA } from "../../scripts/integration/diagnostic-evidence.mjs";
import {
  reachedClient,
  segmentedProblems,
} from "../../scripts/integration/pair-attempts.mjs";
import {
  type ContinuationContext,
  expiryControl as expirySchedule,
  queueContinuation as queueSchedule,
  refusalPair,
  reloadHook,
} from "../../scripts/integration/pair-schedule.mjs";
import {
  DIAGNOSTIC_SELECTION,
  PAIR_SELECTION,
  selectionIdentity,
} from "../../scripts/integration/pair-selection.mjs";
import {
  BACKEND,
  expect,
  raw,
  records,
  test,
  untilRecord,
  untilView,
} from "../integration/helpers";
import {
  API_VERSION,
  abandonOpenIntervals,
  access,
  accountFor,
  barrier,
  bodyOf,
  type ChainModel,
  captureTrace,
  caseRow,
  compatOf,
  DIAGNOSTIC_RECEIPT,
  diagnostic,
  drivePieces,
  endInterval,
  enqueueThroughProduction,
  headOf,
  type Interval,
  insertSyntheticBatch,
  leaderOf,
  type Markers,
  type Milestone,
  markers,
  nudge,
  observe,
  observeCommandPosts,
  observeRecoveryOf,
  oracle,
  outboxOf,
  PAIR_BACKEND,
  type Probe,
  pairPage,
  preGrant,
  probeSync,
  RELEASED_VERSION,
  rawSignInAs,
  rawSyncDirect,
  readerOf,
  rearmHold,
  releaseHold,
  SELECTION_SHA256,
  type Seeded,
  type Stored,
  seedPerson,
  seedSentinel,
  seedWReal,
  seen,
  sessionProbe,
  sha256,
  signInAs,
  stored,
  syncRecords,
  type TapRecord,
  tap,
  tokenHeader,
  traceFrom,
  traceLength,
  until,
  untilGated,
  type Writer,
  writeProof,
  writerAccount,
  writerFor,
} from "./support";

/**
 * WEB-09c R23-PAIR: the DEVELOPMENT-PAIR journey. A real browser engine runs the PRODUCTION composition (the session harness page with
 * `?leader=production`: the election, the sync engine and the recovery job, production quota, session persistence, W27 staging and W1
 * activation, raw IndexedDB) against the backend the runner selected:
 *   - `development`: the approved UNRELEASED pairing (Decision D, 29 Oct 2026; scripts/integration/pair-selection.mjs), told through the
 *     DIAGNOSTIC boot option `?segmented=capable&maxChanges=m` that its server segments; or
 *   - `released`: the released-backend CONTROL (contract-pin.json), whole-revision cases only.
 * Every workload is seeded through PUBLIC routes by another account (W-synthetic's one notice row is the labelled exception), BEFORE the
 * reader signs in: the reader's first snapshot and its durable cursor come from real authentication and synchronisation, and the browser
 * holds the complete old state (with unrelated sentinel rows) at the pre-grant barrier. Only then is the single public grant made.
 *
 * Revision 25 (R24-PAIR.c, DA-PAIR-S): the hold is armed by the interval's OPENING and stays in force through any follower's set-up, the
 * grant and the drive; the workload is the grant's RECEIPT revision; an answer before it (an ordinary poll during the grant) is kept as an
 * incidental answer and never ends the drive; every hook acts on the server's PIECE (its revision and segment index), never on an attempt's
 * ordinal; a partly driven case releases the hold at an explicit hand-off.
 *
 * The TAP (scripts/integration/pair-tap.mjs) records the server's exact bodies; a case that alters an answer says so in its title and its
 * interval record keeps the altered answer apart from the server's. The final cache is checked against what the writer wrote (never the
 * trace), and every interval record is validated (scripts/integration/pair-evidence.mjs) before the case asserts anything else.
 *
 * Revision 26 (R26-DIAG): REAL expiry (PAIR-X0) and REAL pruning (PAIR-X2) run only against the approved DIAGNOSTIC executable
 * (`--backend diagnostic`; pair-selection.mjs DIAGNOSTIC_SELECTION), each in its own fresh fixture attempt, through its private stdin
 * controls (the runner's bridge: support.ts `diagnostic`). Nothing is injected: the 410 is the server's, caused by the sync clock (X0) or
 * the real collector (X2), and each case writes a causal proof the runner checks against the attempt's transcript.
 *
 * Not here: a retired own device and the composed Keep/Delete lifecycle (WEB-09d), device memory, tuning (the 150-sample sweep is a
 * separate obligation).
 */
test.describe.configure({ mode: "serial" });
test.beforeEach(({ browserName: _b }, info) => {
  info.setTimeout(15 * 60_000);
});
test.afterEach(async ({ browserName: _b }, info) => {
  if (!PAIR_BACKEND) return;
  // A case that failed before ending its interval keeps it as an INCOMPLETE record, before the logs are reset.
  await abandonOpenIntervals(
    `the case ended ${info.status} before its interval was complete`,
  );
  // Every fault a case armed must have fired; an unfired one is never silently carried into the next case. No body write may have failed.
  const unfired = (await tap.faults()).filter((f) => f.fired === null);
  const reset = await tap.reset();
  expect(unfired, "every armed tap fault fired").toEqual([]);
  expect(reset.write_errors, "every tap body was written").toEqual([]);
});

const engineOf = (info: TestInfo) => info.project.name.replace(/^pair-/, "");

interface Opened {
  page: Page;
  reader: ReturnType<typeof readerOf>;
  w: Writer;
  sentinel: Seeded;
  workload: Seeded;
  old: Stored;
  oldRows: NonNullable<Stored["rows"]>;
  iv: Interval;
  model: ChainModel;
}
/** Sentinel + W-real (revoked) seeded through public routes; the reader signs in on a pair page; the complete old state; the interval. */
async function openWReal(
  context: BrowserContext,
  info: TestInfo,
  id: string,
  m: number | null,
  also: string[] = [],
): Promise<Opened> {
  const reader = readerOf(id);
  const w = await writerFor(writerAccount());
  const sentinel = await seedSentinel(w, reader.account_id);
  const workload = await seedWReal(w, [reader.account_id, ...also]);
  const page = await pairPage(context, m);
  await signInAs(page, reader);
  await untilView(page, "displaying", undefined, 60_000);
  const pre = await preGrant(page, reader.account_id, id, engineOf(info));
  expect(
    pre.oldRows.some((r) => r.id === sentinel.person),
    "the sentinel is in the old state",
  ).toBe(true);
  expect(
    pre.oldRows.some((r) => r.id === workload.person),
    "nothing of the workload is in the old state",
  ).toBe(false);
  return { page, reader, w, sentinel, workload, ...pre };
}

/**
 * The shape of a bounded delivery over the answers the client RECEIVED, in order (a lost attempt is not one): every request asked for m,
 * every answer within m, ONE revision in index order ending once (pair-attempts.mjs `segmentedProblems`, qualified at the real hop boundary).
 */
function expectSegmented(
  steps: TapRecord[],
  m: number,
  revision: number | null,
) {
  expect(
    segmentedProblems(steps, m, revision),
    "the received pieces are one bounded revision in index order",
  ).toEqual([]);
}

/** Ends a W-real interval whose terminal state is a whole activation of the workload, with the oracle. */
async function finishAdded(
  o: Opened,
  final: Stored,
  extra: Record<string, unknown> = {},
  injected?: string,
) {
  const verdict = oracle(o.oldRows, final.rows ?? [], {
    add: o.workload,
    sentinel: o.sentinel,
  });
  const record = await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    appliedRevision: final.applied_revision,
    oracle: verdict,
    person: o.workload.person,
    extra,
    ...(injected ? { injectedOutsideTap: injected } : {}),
  });
  expect(verdict.problems).toEqual([]);
  return record;
}

/** After a 410 (real or injected): the hold is released at the hand-off; the recovery runs by itself to a valid cache holding the workload. */
async function untilRecovered(o: Opened, page: Page): Promise<Stored> {
  await releaseHold(o.iv, "the hand-off: the 410 recovery runs unheld");
  await nudge(page);
  const done = await until(
    () => stored(page, o.reader.account_id, true),
    (s) =>
      s.phase === "delta" &&
      s.cache_status === "valid" &&
      s.delta_stage === null &&
      s.staged === 0 &&
      (s.rows ?? []).some((r) => r.id === o.workload.person),
    "the recovery's valid cache with the workload",
    180_000,
  );
  barrier(o.iv, "activation_complete", {
    recovered: true,
    applied_revision: done.applied_revision,
  });
  return done;
}
async function finishRecovered(
  o: Opened,
  done: Stored,
  extra: Record<string, unknown> = {},
  rowsOf: (rows: NonNullable<Stored["rows"]>) => NonNullable<Stored["rows"]> = (
    rows,
  ) => rows,
) {
  const verdict = oracle(o.oldRows, rowsOf(done.rows ?? []), {
    add: o.workload,
    sentinel: o.sentinel,
  });
  const record = await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "recovered",
    appliedRevision: done.applied_revision,
    oracle: verdict,
    person: o.workload.person,
    extra,
  });
  expect(verdict.problems).toEqual([]);
  return record;
}

// ---- P0 ------------------------------------------------------------------------------------------------------------------------------
test("PAIR-P0: the backend is the one selected (its /health version; whether it accepts max_changes) and the page names its composition", async ({
  context,
  provokes,
}) => {
  caseRow("PAIR-P0");
  provokes(400);
  const health = (await (await fetch(`${BACKEND}/health`)).json()) as {
    api_version: string;
  };
  const session = await rawSignInAs(readerOf("PAIR-P0"));
  const bounded = await rawSyncDirect(session, "?max_changes=4");
  if (PAIR_BACKEND === "development") {
    expect(health.api_version).toBe(PAIR_SELECTION.backend.apiVersion);
    expect(API_VERSION).toBe(PAIR_SELECTION.backend.apiVersion);
    expect(SELECTION_SHA256).toBe(PAIR_SELECTION.manifest.sha256);
    expect(bounded.status, "the development backend accepts max_changes").toBe(
      200,
    );
  } else if (PAIR_BACKEND === "diagnostic") {
    // Revision 26: the approved diagnostic executable, its own receipt, and its private controls answering for THIS attempt.
    expect(health.api_version).toBe(DIAGNOSTIC_SELECTION.backend.apiVersion);
    expect(API_VERSION).toBe(DIAGNOSTIC_SELECTION.backend.apiVersion);
    expect(SELECTION_SHA256).toBe(selectionIdentity());
    expect(DIAGNOSTIC_RECEIPT?.features).toEqual(DIAGNOSTIC_SELECTION.features);
    expect(bounded.status, "the diagnostic backend accepts max_changes").toBe(
      200,
    );
    const state = await diagnostic("inspect");
    expect(state.attempt).toBe(DIAGNOSTIC_RECEIPT?.attempt);
    expect(state.result.sync_now, "the sync clock is at its start").toBe(
      DIAGNOSTIC_RECEIPT?.sync_start,
    );
  } else {
    expect(
      String(health.api_version).startsWith(
        RELEASED_VERSION.split("-")[0] as string,
      ),
    ).toBe(true);
    expect(health.api_version).not.toBe(PAIR_SELECTION.backend.apiVersion);
    // The released backend refuses the unknown parameter (BE-Q23 contract §1): the control really lacks bounded delivery.
    expect(bounded.status).toBe(400);
    expect(bounded.json?.code).toBe("malformed_request");
  }
  if (PAIR_BACKEND === "diagnostic") await dispatchControls(context);
  // pairPage verifies what each page told its production leader (and, against the diagnostic executable, its compatibility policy).
  await pairPage(context, 4);
  await pairPage(context, null);
});

/** One create_person of the signed-in reader, saved through the PRODUCTION outbox facade. */
const createPersonSpec = (id: string, name: string) => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  command: {
    commands: [
      {
        kind: "create_person",
        id,
        name,
        initial_policy: { grants: [], exclude_accounts: [] },
      },
    ],
  },
  displayPatch: { [id]: { label: name } },
});
/**
 * R38-DIAG (design assessment C2/Q1/Q3), against the approved diagnostic executable before any clock step, in P0's own disposable attempt:
 *   - UNSUPPORTED, no dispatch: a document WITHOUT the selection's policy (the released range) judges the executable's real `/health`
 *     unsupported; a draft saved through the production outbox is kept `queued` with no attempt while the production dispatcher is paused
 *     `compat_unsupported`, and the page sends no command;
 *   - SUPPORTED dispatch: that page is closed and a document WITH the policy takes the account's leadership: it judges the same `/health`
 *     supported and its production dispatcher sends the held draft and a new one, each ONCE with its local id as the key, and admits each
 *     real receipt (W6) with its pending effect. No command is sent by setup HTTP and nothing is seeded.
 */
async function dispatchControls(context: BrowserContext) {
  const reader = readerOf("PAIR-P0");
  const account = reader.account_id;
  const local = async (page: Page, ids: string[]) =>
    (await stored(page, account, false, ids)) as Stored;
  const without = await pairPage(context, 4, undefined, { policy: "omit" });
  const sentWithout = observeCommandPosts(without);
  await signInAs(without, reader);
  await untilView(without, "displaying", undefined, 60_000);
  const held = randomUUID();
  const queued = await enqueueThroughProduction(
    without,
    createPersonSpec(held, "PAIR-P0 held while unsupported"),
  );
  expect(queued.kind, "the production outbox admits the draft").toBe("queued");
  const heldId = queued.localId as string;
  const deadline = Date.now() + 15_000;
  let outbox = await outboxOf(without);
  while (
    !(outbox?.kind === "paused" && outbox.reason === "compat_unsupported") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    outbox = await outboxOf(without);
  }
  expect(outbox, "the production dispatcher is paused, unsupported").toEqual({
    kind: "paused",
    reason: "compat_unsupported",
  });
  const kept = await local(without, [held]);
  expect(
    kept.local?.drafts.find((d) => d.local_id === heldId),
    "the draft is kept, never attempted",
  ).toMatchObject({ status: "queued", attempts: 0, receipt_revision: null });
  expect(sentWithout, "no command is sent while unsupported").toHaveLength(0);
  await without.close();

  const page = await pairPage(context, 4);
  const sent = observeCommandPosts(page);
  await untilView(page, "displaying", undefined, 60_000);
  expect(await compatOf(page)).toEqual({
    status: "supported",
    version: DIAGNOSTIC_RECEIPT?.api_version,
  });
  const fresh = randomUUID();
  const second = await enqueueThroughProduction(
    page,
    createPersonSpec(fresh, "PAIR-P0 sent while supported"),
  );
  expect(second.kind, "the production outbox admits the draft").toBe("queued");
  const freshId = second.localId as string;
  const receipted = (s: Stored, id: string) =>
    (s.local?.drafts ?? []).some(
      (d) => d.local_id === id && Number.isInteger(d.receipt_revision),
    ) &&
    (s.local?.effects ?? []).some(
      (e) => e.local_id === id && Number.isInteger(e.receipt_revision),
    );
  await until(
    () => local(page, [held, fresh]),
    (s) => receipted(s, heldId) && receipted(s, freshId),
    "both drafts' real receipts are admitted",
    60_000,
  );
  for (const id of [heldId, freshId])
    expect(
      sent.filter((x) => x.idempotency_key === id),
      `${id} is sent once, with its local id as the key`,
    ).toHaveLength(1);
  expect(sent.map((x) => x.status)).toEqual(sent.map(() => 200));
  expect(sentWithout, "the unsupported document sent nothing").toHaveLength(0);
  await page.close();
}

// ---- W-real, whole and bounded -------------------------------------------------------------------------------------------------------
test("PAIR-W1: W-real as ONE whole response (the page is told nothing, as production): the complete old state until one atomic activation", async ({
  context,
}, info) => {
  caseRow("PAIR-W1");
  const o = await openWReal(context, info, "PAIR-W1", null);
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
  });
  for (const r of run.steps)
    expect(r.query?.max_changes ?? null, "no request opts in").toBeNull();
  // Exactly ONE target response (the receipt's revision, whole); every other answer the client received is kept and is an empty page.
  expect(run.target, "one target workload response").toHaveLength(1);
  expect(run.target[0]?.segment ?? null).toBeNull();
  expect(run.target[0]?.changes).toBe(200);
  expect(run.target[0]?.last_revision).toBe(run.goal.through);
  for (const r of run.incidental)
    expect(r.batches, `incidental answer ${r.seq} is empty`).toBe(0);
  expect(run.steps).toHaveLength(run.target.length + run.incidental.length);
  await finishAdded(o, run.final as Stored);
});

for (const [id, m] of [
  ["PAIR-W2", 4],
  ["PAIR-W3", 100],
] as const)
  test(`${id}: W-real in pieces of max_changes=${m}, held at EVERY piece: the request carries the stored cursor, each piece is persisted as the next index, nothing is visible until the last piece's atomic activation`, async ({
    context,
  }, info) => {
    caseRow(id);
    const o = await openWReal(context, info, id, m);
    const run = await drivePieces({
      page: () => o.page,
      account: o.reader.account_id,
      iv: o.iv,
      old: o.old,
      model: o.model,
      start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    });
    expectSegmented(run.steps, m, run.goal.through);
    expect(run.model.restarted).toBe(0);
    // Each piece repeats the person as an ancestor of its fields (contract §3.5), counted against m.
    const record = await finishAdded(o, run.final as Stored);
    const repeated = record.overhead.filter((p) => p.person_upserts > 0).length;
    expect(
      repeated,
      "the person is carried by every piece holding fields",
    ).toBe(record.overhead.filter((p) => p.changes > 0).length);
  });

// ---- W-synthetic (LABELLED SYNTHETIC) ------------------------------------------------------------------------------------------------
for (const [id, m] of [
  ["PAIR-S1", 100],
  ["PAIR-S2", null],
] as const)
  test(`${id}: W-synthetic (LABELLED SYNTHETIC: one notice row naming 800 resources inserted directly into the disposable database), ${m === null ? "as one whole response" : `in pieces of max_changes=${m}`}: the old state until one activation of the revision`, async ({
    context,
  }, info) => {
    caseRow(id);
    const reader = readerOf(id);
    const w = await writerFor(writerAccount());
    const sentinel = await seedSentinel(w, reader.account_id);
    const synthetic = await seedPerson(
      w,
      [reader.account_id],
      799,
      "W-synthetic",
    );
    const page = await pairPage(context, m);
    await signInAs(page, reader);
    await untilView(page, "displaying", undefined, 60_000);
    const pre = await preGrant(page, reader.account_id, id, engineOf(info));
    expect(
      pre.oldRows.filter((r) => r.parent_id === synthetic.person),
    ).toHaveLength(799);
    const run = await drivePieces({
      page: () => page,
      account: reader.account_id,
      iv: pre.iv,
      old: pre.old,
      model: pre.model,
      start: () => insertSyntheticBatch(reader.account_id, synthetic),
    });
    if (m !== null) expectSegmented(run.steps, m, run.goal.through);
    else {
      // ONE whole target response of 800 changes; any other answer the client received is an empty page, kept.
      expect(run.target.map((r) => r.changes)).toEqual([800]);
      for (const r of run.incidental) expect(r.batches).toBe(0);
    }
    const final = run.final as Stored;
    // The revision the synthetic transaction inserted, read inside it.
    expect(final.applied_revision).toBe(run.goal.through);
    // The batch re-sends what the reader holds: the cache is the old one, row for row.
    const verdict = oracle(pre.oldRows, final.rows ?? [], { sentinel });
    // Every resource of the batch was delivered (each id at least once across the pieces).
    const ids = new Set<string>();
    for (const r of run.target.filter((x) => x.body_file)) {
      const body = JSON.parse(
        bodyOf(r.body_file as string).toString("utf8"),
      ) as {
        batches: Array<{ changes: Array<{ resource?: { id: string } }> }>;
      };
      for (const b of body.batches)
        for (const c of b.changes) if (c.resource) ids.add(c.resource.id);
    }
    expect(
      [synthetic.person, ...synthetic.fields.map((f) => f.id)].every((x) =>
        ids.has(x),
      ),
      "all 800 delivered",
    ).toBe(true);
    await endInterval(page, pre.iv, {
      backend: PAIR_BACKEND,
      workload: "W-synthetic",
      preGrantCursor: pre.old.cursor as string,
      terminal: "activated",
      appliedRevision: final.applied_revision,
      oracle: verdict,
      person: synthetic.person,
      injectedOutsideTap:
        "LABELLED SYNTHETIC: one notice row inserted directly into the disposable database",
    });
    expect(verdict.problems).toEqual([]);
  });

// ---- interruption: reload, lost response, second tab, takeover ------------------------------------------------------------------------
test("PAIR-R1: a real reload while piece 3 is held (the answer reaches nobody): the reloaded leader asks from the stored continuation, keeps the staged pieces and activates once", async ({
  context,
}, info) => {
  caseRow("PAIR-R1");
  const o = await openWReal(context, info, "PAIR-R1", 4);
  let reloaded = false;
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ piece, before, release }) => {
      // The server's piece 3 of the target, the valid next piece of the chain: never the fourth attempt.
      if (piece?.index !== 3 || !piece.next || reloaded) return undefined;
      reloaded = true;
      expect(before.delta_stage?.next_index).toBe(3);
      await captureTrace(o.page, o.iv, "before the reload");
      await o.page.goto("about:blank");
      await release();
      await pairPage(context, 4, o.page);
      return { delivered: false };
    },
  });
  expect(reloaded).toBe(true);
  // Every attempt is kept: the held piece 3 was LOST (released to the departed page), then asked again from the same stored cursor.
  const lost = run.attempts.filter((a) => a.client === "lost");
  expect(lost, "exactly one lost attempt").toHaveLength(1);
  const retry = run.attempts.find(
    (a) => a.step !== null && a.seq > (lost[0]?.seq as number),
  );
  expect(retry?.client, "the next attempt reached the client").toBe("received");
  expect(retry?.request_cursor, "the retry asks from the same cursor").toBe(
    lost[0]?.request_cursor,
  );
  expect(retry?.segment?.index, "the retry is the same piece").toBe(
    lost[0]?.segment?.index,
  );
  expect(
    run.steps.some((r) => r.seq === lost[0]?.seq),
    "the lost attempt is not a received piece",
  ).toBe(false);
  expectSegmented(run.steps, 4, run.goal.through);
  await finishAdded(o, run.final as Stored, {
    reloaded_at_piece: 3,
    lost_seq: lost[0]?.seq,
    lost_downstream: lost[0]?.downstream,
    retried_seq: retry?.seq,
  });
});

test("PAIR-R2: the connection is destroyed AFTER the backend answered piece 2 (TAP-INJECTED: the server's delivered-ID ledger is ahead of the client): the same cursor is asked again, the same piece is answered, and the revision activates once", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-R2");
  provokes(502);
  const o = await openWReal(context, info, "PAIR-R2", 4);
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: async () => {
      await tap.fault({ kind: "drop_connection", afterIndex: 2 });
      return access(o.w, "grant", o.workload.person, o.reader.account_id);
    },
  });
  // The tap holds the server's two answers to the SAME cursor: the dropped one (never received) and the one asked again, with the same
  // piece (contract §3.8: re-sending a cursor returns the same piece if nothing changed).
  const all = syncRecords(await tap.log(o.iv.since)).filter(
    (r) => r.label === o.iv.id && r.status === 200,
  );
  const dropped = all.find((r) => r.dropped);
  expect(dropped, "the tap dropped one answer").toBeDefined();
  const again = all.find(
    (r) =>
      r.seq > (dropped as TapRecord).seq &&
      r.query?.cursor === dropped?.query?.cursor,
  );
  expect(again, "the same cursor was asked again").toBeDefined();
  const batchesOf = (r: TapRecord) =>
    JSON.stringify(
      (
        JSON.parse(bodyOf(r.body_file as string).toString("utf8")) as {
          batches: unknown;
        }
      ).batches,
    );
  expect(batchesOf(again as TapRecord)).toBe(batchesOf(dropped as TapRecord));
  expect(
    run.attempts.filter((a) => a.client === "dropped").map((a) => a.seq),
    "the dropped answer is kept as a dropped attempt",
  ).toEqual([dropped?.seq]);
  expect(run.model.restarted).toBe(0);
  await finishAdded(o, run.final as Stored, {
    dropped_seq: dropped?.seq,
    asked_again_seq: again?.seq,
  });
});

test("PAIR-T1: a second tab of the same browser reads the old complete state through its own connection while the last piece is held, and the whole revision after the activation", async ({
  context,
}, info) => {
  caseRow("PAIR-T1");
  const o = await openWReal(context, info, "PAIR-T1", 4);
  // Opened with the interval's hold in force: an ordinary poll its attachment causes is held and kept (R24-PAIR.c's schedule).
  const follower = await pairPage(context, 4);
  expect(
    (await follower.evaluate(() => window.__atlasFixture?.session?.leader()))
      ?.attachment,
  ).not.toBe("leader");
  let checkedLast = false;
  let checkedNew = false;
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ record, piece, phase, before, target }) => {
      const other = (await stored(follower, o.reader.account_id)) as Stored;
      if (phase !== "after_activation") {
        expect(other.cache_digest, "the follower sees the old live cache").toBe(
          o.old.cache_digest,
        );
        // The target's ACTUAL last piece, held: the old state is still all the follower sees.
        if (piece?.last && piece.revision === target.through) {
          observe(
            o.iv,
            "follower_old_at_last_piece",
            record.seq,
            other.cache_digest,
          );
          checkedLast = true;
        }
      } else {
        // A held answer after the activation (the feed's completion page): the follower sees the activated revision.
        expect(other.applied_revision).toBe(target.through);
        expect(
          other.cache_digest,
          "the follower sees the activated cache",
        ).toBe(before.cache_digest);
        observe(
          o.iv,
          "follower_new_after_activation",
          record.seq,
          other.cache_digest,
        );
        checkedNew = true;
      }
      return undefined;
    },
  });
  expect(checkedLast).toBe(true);
  const fromFollower = (await stored(follower, o.reader.account_id)) as Stored;
  expect(fromFollower.cache_digest).toBe((run.final as Stored).cache_digest);
  if (!checkedNew)
    observe(
      o.iv,
      "follower_new_after_activation",
      run.terminal?.final_seq as number,
      fromFollower.cache_digest,
    );
  await finishAdded(o, run.final as Stored);
});

test("PAIR-T2: the leading tab is closed while piece 2 is held; the other tab takes the real leadership, asks from the stored continuation and finishes the revision once", async ({
  context,
}, info) => {
  caseRow("PAIR-T2");
  const o = await openWReal(context, info, "PAIR-T2", 4);
  const next = await pairPage(context, 4);
  let current = o.page;
  let closed = false;
  const run = await drivePieces({
    page: () => current,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ piece, release }) => {
      // The server's piece 2 of the target, the valid next piece: never the third attempt.
      if (piece?.index !== 2 || !piece.next || closed) return undefined;
      closed = true;
      await captureTrace(o.page, o.iv, "before the leading tab is closed");
      await o.page.close();
      await release();
      current = next;
      await expect
        .poll(
          async () =>
            (
              await next.evaluate(() =>
                window.__atlasFixture?.session?.leader(),
              )
            )?.attachment,
          { timeout: 30_000 },
        )
        .toBe("leader");
      await nudge(next);
      return { delivered: false };
    },
  });
  expect(closed).toBe(true);
  o.page = next;
  await finishAdded(o, run.final as Stored, { leader_closed_at_piece: 2 });
});

// ---- per-response authorisation --------------------------------------------------------------------------------------------------
test("PAIR-A1: the person is REVOKED while piece 2 is held: no later answer discloses a field never sent before the revocation, and the cache converges to the old state without the workload", async ({
  context,
}, info) => {
  caseRow("PAIR-A1");
  const o = await openWReal(context, info, "PAIR-A1", 4);
  const delivered = new Set<string>();
  let revokedAt: number | null = null;
  let grant: Milestone | null = null;
  let revoke: Milestone | null = null;
  const upserts = (r: TapRecord) =>
    (
      JSON.parse(bodyOf(r.body_file as string).toString("utf8")) as {
        batches: Array<{
          changes: Array<{ kind: string; resource?: { id: string } }>;
        }>;
      }
    ).batches
      .flatMap((b) => b.changes)
      .filter((c) => c.kind === "upsert" && c.resource)
      .map((c) => (c.resource as { id: string }).id);
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: async () => {
      grant = await access(
        o.w,
        "grant",
        o.workload.person,
        o.reader.account_id,
      );
      return grant;
    },
    onHeld: async ({ record, piece, addMilestone }) => {
      if (record.status === 200 && record.body_file && revokedAt === null)
        for (const id of upserts(record)) delivered.add(id);
      // The grant's piece 2, held: the revocation is a LATER milestone the drive must reach (its own receipt revision).
      if (
        piece?.index === 2 &&
        piece.next &&
        piece.revision === grant?.revision &&
        revokedAt === null
      ) {
        revoke = await access(
          o.w,
          "revoke",
          o.workload.person,
          o.reader.account_id,
        );
        addMilestone(revoke);
        revokedAt = record.seq;
      }
      return undefined;
    },
  });
  expect(revokedAt).not.toBeNull();
  expect(run.goal.through, "the drive reached the revocation").toBe(
    (revoke as Milestone | null)?.revision,
  );
  const workloadIds = new Set([
    o.workload.person,
    ...o.workload.fields.map((f) => f.id),
  ]);
  for (const r of run.steps.filter(
    (x) => x.seq > (revokedAt as number) && x.status === 200 && x.body_file,
  ))
    for (const id of upserts(r))
      expect(
        workloadIds.has(id) && !delivered.has(id),
        `seq ${r.seq} discloses ${id}, never sent before the revocation`,
      ).toBe(false);
  const final = run.final as Stored;
  const verdict = oracle(o.oldRows, final.rows ?? [], {
    absent: o.workload,
    sentinel: o.sentinel,
  });
  await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    appliedRevision: final.applied_revision,
    oracle: verdict,
    person: o.workload.person,
    extra: {
      revoked_after_seq: revokedAt,
      delivered_before_revocation: delivered.size,
    },
  });
  expect(verdict.problems).toEqual([]);
});

// ---- account / device / revision binding (the server's 410 is REAL) ------------------------------------------------------------------
async function bindingCase(
  context: BrowserContext,
  info: TestInfo,
  id: "PAIR-B1" | "PAIR-B2" | "PAIR-B3",
  arm: (o: Opened) => Promise<void>,
  also: string[] = [],
) {
  const o = await openWReal(context, info, id, 4, also);
  const prepare = await armPrepare(o, id);
  let refused: TapRecord | null = null;
  await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: async () => {
      // The request-side gate (DA-PAIR-S): no browser /sync reaches the backend until the foreign continuation is prepared and the fault is
      // armed, so piece 0 cannot be generated first. The foreign reads go directly to the backend, outside the gate.
      await tap.gate(true);
      await untilUpstreamSettled(o.iv);
      const grant = await access(
        o.w,
        "grant",
        o.workload.person,
        o.reader.account_id,
      );
      await prepare();
      await arm(o);
      await tap.gate(false);
      return grant;
    },
    onHeld: async ({ record }) => {
      if (record.status !== 410) return undefined;
      refused = record;
      return {
        stop: true,
        reason: "the server's 410: the recovery continues by itself",
      };
    },
  });
  const answer = refused as TapRecord | null;
  expect(answer, "the server answered the bad continuation").not.toBeNull();
  expect(answer?.code, "the SERVER's own error code").toBe("resync_required");
  expect(
    answer?.delivered,
    "the 410 is the server's, unaltered",
  ).toBeUndefined();
  const faults = await tap.faults();
  expect(faults.filter((f) => f.fired !== null)).toHaveLength(1);
  const done = await untilRecovered(o, o.page);
  await finishRecovered(o, done, { refused_seq: answer?.seq });
}
/** Every browser /sync the tap already forwarded has its server answer (none is still upstream), so the gate covers all later ones. */
async function untilUpstreamSettled(iv: Interval) {
  await expect
    .poll(
      async () =>
        syncRecords(await tap.log(iv.since)).filter(
          (r) =>
            r.label === iv.id &&
            r.status === null &&
            !r.gated &&
            !r.upstream_error,
        ).length,
      { timeout: 30_000, message: "no /sync is still upstream" },
    )
    .toBe(0);
}
/** B2/B3: the foreign continuation, read directly from the backend by another device or account after the grant. */
const foreign: Record<string, string> = {};
async function armPrepare(o: Opened, id: string): Promise<() => Promise<void>> {
  if (id === "PAIR-B1") return async () => undefined;
  const who = id === "PAIR-B2" ? o.reader : accountFor("pair-b3-foreign");
  const other = await rawSignInAs(who, `${id.toLowerCase()}-other-device`);
  const head = await headOf(other);
  return async () => {
    if (id === "PAIR-B3")
      await access(o.w, "grant", o.workload.person, who.account_id);
    const piece = await rawSyncDirect(
      other,
      `?cursor=${encodeURIComponent(head)}&max_changes=4`,
    );
    expect(piece.status, JSON.stringify(piece.json)).toBe(200);
    expect(
      piece.json?.batches?.[0]?.segment?.index,
      "the other session's first piece",
    ).toBe(0);
    foreign[id] = piece.json?.next_cursor as string;
  };
}

test("PAIR-B1: a TAMPERED continuation (TAP-INJECTED into piece 0's next_cursor) is refused by the SERVER with 410 resync_required; the client discards the stage and recovers to the whole revision", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-B1");
  provokes(410);
  await bindingCase(context, info, "PAIR-B1", async () => {
    await tap.fault({ kind: "tamper_next_cursor", afterIndex: 0 });
  });
});

test("PAIR-B2: ANOTHER DEVICE's real continuation of the same account (TAP-INJECTED into piece 0's next_cursor) is refused by the SERVER with 410; the client recovers", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-B2");
  provokes(410);
  await bindingCase(context, info, "PAIR-B2", async () => {
    await tap.fault({
      kind: "substitute_next_cursor",
      afterIndex: 0,
      value: foreign["PAIR-B2"] as string,
    });
  });
});

test("PAIR-B3: ANOTHER ACCOUNT's real continuation (TAP-INJECTED into piece 0's next_cursor) is refused by the SERVER with 410; the client recovers", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-B3");
  provokes(410);
  await bindingCase(
    context,
    info,
    "PAIR-B3",
    async () => {
      await tap.fault({
        kind: "substitute_next_cursor",
        afterIndex: 0,
        value: foreign["PAIR-B3"] as string,
      });
    },
    [accountFor("pair-b3-foreign").account_id],
  );
});

// ---- duplicate, gap, order, revision (TAP-INJECTED, client-side rules against real pieces) --------------------------------------------
for (const [id, fault, what] of [
  [
    "PAIR-G1",
    { kind: "segment_index_delta", afterIndex: 2, delta: 1 },
    "piece 2's index is moved on by one (a gap)",
  ],
  [
    "PAIR-G2",
    { kind: "replay_previous", afterIndex: 2 },
    "piece 1 is answered again in place of piece 2 (a repeat at the current cursor)",
  ],
  [
    "PAIR-G3",
    { kind: "revision_delta", afterIndex: 2, delta: 1 },
    "piece 2 names another revision",
  ],
] as const)
  test(`${id}: TAP-INJECTED: ${what}; the client discards the stage, asks again from the boundary (the pre-grant cursor) and activates the revision once`, async ({
    context,
  }, info) => {
    caseRow(id);
    const o = await openWReal(context, info, id, 4);
    const run = await drivePieces({
      page: () => o.page,
      account: o.reader.account_id,
      iv: o.iv,
      old: o.old,
      model: o.model,
      start: async () => {
        await tap.fault(fault);
        return access(o.w, "grant", o.workload.person, o.reader.account_id);
      },
    });
    expect(run.model.restarted, "one restart at the boundary").toBe(1);
    const faulted = run.steps.findIndex((r) => r.delivered);
    expect(faulted).toBeGreaterThanOrEqual(2);
    // The boundary: the cursor the target's piece 0 was asked from (an incidental page before it may have renewed the pre-grant cursor).
    const boundary = run.target.find((r) => r.segment?.index === 0)?.query
      ?.cursor;
    expect(boundary, "the target's piece 0 was received").toBeDefined();
    expect(
      run.steps[faulted + 1]?.query?.cursor,
      "the request after the broken piece asks from the boundary",
    ).toBe(boundary);
    await finishAdded(o, run.final as Stored, { faulted_step: faulted });
  });

test("PAIR-X1: TAP-INJECTED 410 resync_required in place of piece 2 (client-only: NOT server expiry or pruning): the stage is discarded and the recovery builds the whole revision", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-X1");
  provokes(410);
  const o = await openWReal(context, info, "PAIR-X1", 4);
  let injected: TapRecord | null = null;
  await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: async () => {
      await tap.fault({ kind: "answer_410", afterIndex: 2 });
      return access(o.w, "grant", o.workload.person, o.reader.account_id);
    },
    onHeld: async ({ record }) => {
      if (seen(record).status !== 410) return undefined;
      injected = record;
      return {
        stop: true,
        reason: "the injected 410: the recovery continues by itself",
      };
    },
  });
  const answer = injected as TapRecord | null;
  expect(answer?.status, "the server answered the piece").toBe(200);
  expect(answer?.delivered?.status, "the client was answered 410").toBe(410);
  const done = await untilRecovered(o, o.page);
  await finishRecovered(o, done, { injected_seq: answer?.seq });
});

// ---- REAL expiry and REAL pruning (revision 26, R26-DIAG: the diagnostic executable only) ---------------------------------------------
// Revision 27 (R27-DIAG.a): every order the proof claims is between positions of the attempt's causal journal — the runner's tap, control
// and bridge events and the spec's acknowledged MARKERS (support.ts `markers`) — never between this process's clock and the runner's.
// Revision 27 (R27-DIAG.b): after the real 410 the interval's hold stays armed and the recovery is OBSERVED at held snapshot pages by the
// leader and an independent follower page (support.ts `observeRecoveryOf`, pair-recovery.mjs), instead of being waited for unheld.
const receiptOf = () => {
  if (!DIAGNOSTIC_RECEIPT) throw new Error("no diagnostic receipt");
  return DIAGNOSTIC_RECEIPT;
};
/** The held piece the X0/X2 schedule acts on: the target's piece 2, the valid next piece and not the last (a continuation follows it). */
const isScheduledPiece = (
  piece: { index: number; next: boolean; last: boolean } | null,
) => piece?.index === 2 && piece.next && !piece.last;
const floorIn = (
  state: { accounts: Array<{ id: string; sync_floor: number }> },
  account: string,
): number | undefined =>
  state.accounts.find((a) => a.id === account)?.sync_floor;
const stageOf = (s: Stored) =>
  s.delta_stage
    ? { revision: s.delta_stage.revision, next_index: s.delta_stage.next_index }
    : null;
/**
 * The schedule every causal case shares at its chosen piece (pair-schedule.mjs `queueContinuation`, revision 28): the request gate closes
 * BEFORE the piece is released, so the continuation request the client then makes waits at the tap, unforwarded; the piece is observed
 * persisted as the stage (the continuation stored); the request is observed queued at the gate. `control(ctx)` then runs the diagnostic
 * command(s) with the continuation CONTEXT made from the held record before anything ran (R28-DIAG.a: never a value the caller assigns from
 * this helper's return); the gate opens only after its answers. Resolves with the context.
 */
type Continuation = ContinuationContext<ReturnType<typeof tokenHeader>>;
function queueContinuation(
  o: Opened,
  record: TapRecord,
  release: () => Promise<void>,
  control: (ctx: Continuation) => Promise<void>,
  // Revision 39 (R39-DIAG): XL0 binds the gated request as its departed request before the control runs (pair-schedule.mjs `refusalPair`).
  queued?: (request: TapRecord, ctx: Continuation) => void,
): Promise<Continuation> {
  return queueSchedule(
    {
      headerOf: tokenHeader,
      gate: (open) => tap.gate(open),
      release,
      untilStored: (ctx) =>
        until(
          () => stored(o.page, o.reader.account_id),
          (s) =>
            s.cursor === ctx.token &&
            s.delta_stage?.next_index === ctx.header.index,
          "the staged piece persisted, its continuation stored",
        ),
      untilGated: (ctx) => untilGated(o.iv, ctx.token),
      queued: queued
        ? (request, ctx) => queued(request as TapRecord, ctx)
        : undefined,
    },
    record,
    control,
  );
}
/**
 * The follower page, opened while the refusal is HELD (the leader's engine waits on it). Revision 28 (design assessment DA28-OBS): it must
 * POSITIVELY attach as a follower (an unavailable or "none" attachment is not a follower), within a bounded wait.
 */
async function openFollower(context: BrowserContext) {
  const follower = await pairPage(context, 4);
  await expect
    .poll(
      async () =>
        ((await leaderOf(follower)) as { attachment?: string } | null)
          ?.attachment ?? null,
      { message: "the second page attaches as a follower", timeout: 30_000 },
    )
    .toBe("follower");
  return follower;
}
/**
 * The held refusal: the server's 410 has not reached the client; the reader still shows the old cache and keeps its stage. The follower
 * is opened now. Returns what the observer needs (the refusal's exchange and the generation stored then).
 */
async function atHeldRefusal(
  o: Opened,
  context: BrowserContext,
  record: TapRecord,
  before: Stored,
  controls: Record<string, number>,
) {
  expect(before.cache_digest).toBe(o.old.cache_digest);
  observe(
    o.iv,
    "reader_old_at_refusal",
    record.seq,
    before.cache_digest,
    stageOf(before),
  );
  controls.inspect_at_refusal = (await diagnostic("inspect")).seq;
  const follower = await openFollower(context);
  return {
    follower,
    refusal: {
      seq: record.seq,
      generation: before.recovery_generation as number,
    },
  };
}
/** The real-410 recovery observed at held snapshot pages, then the activation barrier; the final leader state (rows included). */
async function recoverObserved(
  o: Opened,
  held: { follower: Page; refusal: { seq: number; generation: number } },
  caller: "ordinary" | "recovery",
  onPage?: (kind: string) => Promise<void>,
  expectFinal: (rows: NonNullable<Stored["rows"]>) => string[] = (rows) =>
    oracle(o.oldRows, rows, { add: o.workload, sentinel: o.sentinel }).problems,
) {
  const done = await observeRecoveryOf({
    iv: o.iv,
    account: o.reader.account_id,
    leader: () => o.page,
    follower: held.follower,
    caller,
    refusal: held.refusal,
    oldDigest: o.old.cache_digest,
    expectFinal,
    onPage: onPage ? (kind) => onPage(kind) : undefined,
  });
  barrier(o.iv, "activation_complete", {
    recovered: true,
    observed: true,
    applied_revision: done.applied_revision,
  });
  return done;
}
/**
 * The expiry schedule X0, XR0 and XL0 share (pair-schedule.mjs `expiryControl`, revision 28): inspect, E−1 (the same token answered), E, the
 * session live, inspect again; then `afterE(ctx)`. Every hook receives the continuation context before it runs.
 */
function expiryControl(
  context: BrowserContext,
  m: Markers,
  controls: Record<string, number>,
  probes: Record<string, unknown>,
  hooks: {
    beforeInspect?: (ctx: Continuation) => Promise<void>;
    afterE?: (ctx: Continuation) => Promise<void>;
  } = {},
) {
  return expirySchedule<ReturnType<typeof tokenHeader>>(
    {
      receipt: receiptOf(),
      diagnostic: (op, args) =>
        diagnostic(op as Parameters<typeof diagnostic>[0], args) as Promise<{
          seq: number;
          result: Record<string, unknown>;
        }>,
      // A labelled, bracketed probe of the SAME continuation on the SAME session.
      probeAt: (label, token) =>
        m.bracket(label, () => probeSync(label, { context }, token)),
      sessionLive: () => m.bracket("session-live", () => sessionProbe(context)),
      controls,
      probes,
    },
    hooks,
  );
}
/** E+1: the same token refused (a labelled, bracketed probe after the clock step). */
async function expiryAfter(
  context: BrowserContext,
  m: Markers,
  token: string,
  controls: Record<string, number>,
  probes: Record<string, unknown>,
) {
  const E = tokenHeader(token).expiry;
  controls.advance_e_plus_1 = (
    await diagnostic("advance_clock", { time: E + 1 })
  ).seq;
  const atPlus = await m.bracket("x0-e-plus-1", () =>
    probeSync("x0-e-plus-1", { context }, token),
  );
  expect(atPlus.status, "the token is refused at E+1").toBe(410);
  probes.e_plus_1 = atPlus;
}
const realRefusal = (answer: TapRecord | null, token: string) => {
  expect(answer, "the server refused the continuation").not.toBeNull();
  expect(answer?.code).toBe("resync_required");
  expect(
    answer?.delivered,
    "the 410 is the server's, unaltered",
  ).toBeUndefined();
  expect(answer?.query?.cursor).toBe(token);
};
/** Settles the final view: the recovery's cache shown (no gate), the person sees the account. */
async function untilShown(page: Page) {
  await untilView(page, "displaying", undefined, 120_000);
  await expect(page.locator('[data-cache-gate="refreshing"]')).toHaveCount(0, {
    timeout: 120_000,
  });
}

test("PAIR-X0: REAL continuation EXPIRY (the diagnostic sync clock; no collection): with the browser's next continuation QUEUED at the request gate, the clock moves from start to E−1 (the same token on the same session is still answered) and to E, the token's own expiry; the SERVER answers 410 resync_required; while it is held the old cache and the stage remain; the recovery is observed at held snapshot pages by the leader and a follower, hidden until one atomic exposure", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-X0");
  provokes(410);
  const receipt = receiptOf();
  const m = markers("PAIR-X0");
  const o = await openWReal(context, info, "PAIR-X0", 4);
  const controls: Record<string, number> = {};
  const probes: Record<string, unknown> = {};
  let staged: TapRecord | null = null;
  let refused: TapRecord | null = null;
  let held: Awaited<ReturnType<typeof atHeldRefusal>> | null = null;
  let token = "";
  await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ record, piece, before, release }) => {
      if (staged === null && isScheduledPiece(piece)) {
        staged = record;
        expect(before.delta_stage?.next_index).toBe(2);
        token = (
          await queueContinuation(
            o,
            record,
            release,
            expiryControl(context, m, controls, probes),
          )
        ).token;
        return undefined;
      }
      if (staged !== null && refused === null && record.status === 410) {
        refused = record;
        held = await atHeldRefusal(o, context, record, before, controls);
        return {
          stop: true,
          reason: "the server's real 410 (expiry): the recovery is observed",
        };
      }
      return undefined;
    },
  });
  const answer = refused as TapRecord | null;
  realRefusal(answer, token);
  await expiryAfter(context, m, token, controls, probes);
  const done = await recoverObserved(
    o,
    held as unknown as NonNullable<typeof held>,
    "ordinary",
  );
  await untilShown(o.page);
  const proof = writeProof("PAIR-X0", o.iv.engine, {
    schema: PROOF_SCHEMA,
    case: "PAIR-X0",
    caller: "ordinary",
    interval: o.iv.id,
    attempt: receipt.attempt,
    engine: o.iv.engine,
    reader_account: o.reader.account_id,
    mark_prefix: m.prefix,
    marks: m.marks,
    continuation: { token_sha256: sha256(token), header: tokenHeader(token) },
    staged: { tap_seq: (staged as TapRecord | null)?.seq ?? null },
    refused: { tap_seq: answer?.seq ?? null },
    hand_off_seq: o.iv.handOff?.at_seq ?? null,
    controls,
    probes,
  });
  await finishRecovered(o, done, {
    refused_seq: answer?.seq,
    diagnostic_proof: proof,
  });
});

/** X2's gate-and-drain, grant and ageing (shared by X2 and XR2): nothing of the target is requested before its batch is aged. */
async function pruneSetup(
  o: Opened,
  m: Markers,
  controls: Record<string, number>,
) {
  const receipt = receiptOf();
  const reader = o.reader.account_id;
  // Gate and drain BEFORE the grant: no request can carry the target until its batch has been aged.
  await tap.gate(true);
  await untilUpstreamSettled(o.iv);
  const drained = await m.mark("drain_complete");
  await m.mark("grant_begin");
  const grant = await access(o.w, "grant", o.workload.person, reader);
  await m.mark("grant_end");
  const state = await diagnostic("inspect");
  controls.inspect_before_ageing = state.seq;
  const batch = (
    state.result.batches as Array<{
      account: string;
      revision: number;
      payload_sha256: string;
    }>
  ).find((b) => b.account === reader && b.revision === grant.revision);
  expect(batch, "the reader's target batch is stored").toBeDefined();
  const target = {
    account: reader,
    revision: grant.revision,
    payload_sha256: batch?.payload_sha256 as string,
  };
  const aged = await diagnostic("age_history", {
    batches: [
      { ...target, created_at: receipt.sync_start - receipt.retention_seconds },
    ],
  });
  controls.age_history = aged.seq;
  // Nothing reached the backend between the drain and the ageing (the gate held every /sync): judged on journal positions, not clocks.
  expect(
    syncRecords(await tap.log(o.iv.since))
      .filter(
        (r) =>
          r.label === o.iv.id &&
          !r.gated &&
          ((r.j_request ?? 0) > drained ||
            r.revision === grant.revision ||
            r.last_revision === grant.revision),
      )
      .map((r) => r.seq),
    "no /sync reached the backend between the drain and the ageing",
  ).toEqual([]);
  return { grant, target };
}
/** The untouched CONTROL account of X2/XR2, prepared before the reader signs in: its own fresh revision and a live continuation of it. */
async function pruneControlAccount(name: string) {
  const controlAccount = accountFor(name);
  const w0 = await writerFor(writerAccount());
  const controlPerson = await seedPerson(
    w0,
    [controlAccount.account_id],
    10,
    "X2 control",
  );
  await access(w0, "revoke", controlPerson.person, controlAccount.account_id);
  const controlSession = await rawSignInAs(controlAccount, `${name}-device`);
  const controlHead = await headOf(controlSession);
  const controlGrant = await access(
    w0,
    "grant",
    controlPerson.person,
    controlAccount.account_id,
  );
  const controlPiece = await rawSyncDirect(
    controlSession,
    `?cursor=${encodeURIComponent(controlHead)}&max_changes=4`,
  );
  expect(controlPiece.status).toBe(200);
  expect(
    controlPiece.json?.batches?.[0]?.segment?.index,
    "the control's piece 0",
  ).toBe(0);
  const controlToken = controlPiece.json?.next_cursor as string;
  expect(tokenHeader(controlToken).revision).toBe(controlGrant.revision);
  return { controlAccount, controlSession, controlGrant, controlToken };
}
/** The collection at the sync start with the continuation queued (X2/XR2), and the control account's continuation probed after it. */
function pruneControl(
  m: Markers,
  controls: Record<string, number>,
  reader: string,
  target: () => { revision: number },
  ctl: Awaited<ReturnType<typeof pruneControlAccount>>,
  out: { probe: Probe | null },
) {
  const receipt = receiptOf();
  return async (ctx: Continuation) => {
    const header = ctx.header;
    const t = target();
    const collected = await diagnostic("collect", { time: receipt.sync_start });
    controls.collect = collected.seq;
    const c = collected.result;
    expect(
      (c.removed_batches as Array<{ account: string; revision: number }>).map(
        (b) => `${b.account}@${b.revision}`,
      ),
      "the collector removed exactly the aged target batch",
    ).toEqual([`${reader}@${t.revision}`]);
    expect(
      floorIn(c.after, reader),
      "the reader's floor is the pruned revision",
    ).toBe(t.revision);
    expect(header.boundary).toBeLessThan(t.revision);
    expect(header.expiry, "the token is unexpired").toBeGreaterThan(
      collected.sync_now,
    );
    expect(floorIn(c.after, ctl.controlAccount.account_id)).toBe(
      floorIn(c.before, ctl.controlAccount.account_id),
    );
    // The untouched account's live continuation is still answered after the collection (a labelled, bracketed probe).
    out.probe = await m.bracket("x2-control", () =>
      probeSync(
        "x2-control",
        { session: ctl.controlSession },
        ctl.controlToken,
      ),
    );
    expect(
      out.probe.status,
      "the control account's continuation still works",
    ).toBe(200);
  };
}
const pruneProofPart = (
  ctl: Awaited<ReturnType<typeof pruneControlAccount>>,
  probe: Probe | null,
) => ({
  account: ctl.controlAccount.account_id,
  revision: ctl.controlGrant.revision,
  continuation_sha256: sha256(ctl.controlToken),
  continuation_header: tokenHeader(ctl.controlToken),
  probe_after: probe,
});

test("PAIR-X2: REAL PRUNING (the real collector; no clock step): with the request gate closed and drained BEFORE the grant, the target batch is aged in setup before any of it is requested; with the browser's next continuation QUEUED at the gate, the collector runs at the sync start, removes exactly that batch and raises the floor past the continuation's boundary while the token is unexpired and an untouched account keeps its history and continuation; the SERVER answers 410; the recovery is observed at held snapshot pages, hidden until one atomic exposure", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-X2");
  provokes(410);
  const receipt = receiptOf();
  const m = markers("PAIR-X2");
  const ctl = await pruneControlAccount("pair-x2-control");
  const o = await openWReal(context, info, "PAIR-X2", 4);
  const reader = o.reader.account_id;
  const controls: Record<string, number> = {};
  const out: { probe: Probe | null } = { probe: null };
  let staged: TapRecord | null = null;
  let refused: TapRecord | null = null;
  let held: Awaited<ReturnType<typeof atHeldRefusal>> | null = null;
  let token = "";
  let target: {
    account: string;
    revision: number;
    payload_sha256: string;
  } | null = null;
  await drivePieces({
    page: () => o.page,
    account: reader,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: async () => {
      const set = await pruneSetup(o, m, controls);
      target = set.target;
      await tap.gate(false);
      return set.grant;
    },
    onHeld: async ({ record, piece, before, release }) => {
      if (staged === null && isScheduledPiece(piece)) {
        staged = record;
        expect(before.delta_stage?.next_index).toBe(2);
        token = (
          await queueContinuation(
            o,
            record,
            release,
            pruneControl(
              m,
              controls,
              reader,
              () => target as { revision: number },
              ctl,
              out,
            ),
          )
        ).token;
        return undefined;
      }
      if (staged !== null && refused === null && record.status === 410) {
        refused = record;
        held = await atHeldRefusal(o, context, record, before, controls);
        return {
          stop: true,
          reason: "the server's real 410 (pruning): the recovery is observed",
        };
      }
      return undefined;
    },
  });
  const answer = refused as TapRecord | null;
  realRefusal(answer, token);
  const done = await recoverObserved(
    o,
    held as unknown as NonNullable<typeof held>,
    "ordinary",
  );
  await untilShown(o.page);
  const proof = writeProof("PAIR-X2", o.iv.engine, {
    schema: PROOF_SCHEMA,
    case: "PAIR-X2",
    caller: "ordinary",
    interval: o.iv.id,
    attempt: receipt.attempt,
    engine: o.iv.engine,
    reader_account: reader,
    mark_prefix: m.prefix,
    marks: m.marks,
    target,
    continuation: { token_sha256: sha256(token), header: tokenHeader(token) },
    staged: { tap_seq: (staged as TapRecord | null)?.seq ?? null },
    refused: { tap_seq: answer?.seq ?? null },
    hand_off_seq: o.iv.handOff?.at_seq ?? null,
    controls,
    control_account: pruneProofPart(ctl, out.probe),
  });
  await finishRecovered(o, done, {
    refused_seq: answer?.seq,
    diagnostic_proof: proof,
  });
});

// ---- revision 27 (R27-DIAG.b; design assessment C4): X0 with named admitted LOCAL WORK and a RELOAD ----------------------------------
/** The local work's state at a barrier (`localWorkProblems`, diagnostic-evidence.mjs): the draft, its pending effects, the live cache. */
async function localAt(
  page: Page,
  account: string,
  localId: string,
  resource: string,
) {
  const s = (await stored(page, account, false, [resource])) as Stored;
  const draft = s.local?.drafts.find((d) => d.local_id === localId) ?? null;
  return {
    draft,
    effects: (s.local?.effects ?? []).filter((e) => e.local_id === localId),
    resource_in_cache: s.local?.in_cache[resource] ?? 0,
    applied_revision: s.applied_revision,
    composition_seq: s.composition_seq,
    drafts: s.drafts,
  };
}

test("PAIR-XL0: REAL EXPIRY with named admitted LOCAL WORK and a RELOAD: one create_person of the reader saved through the PRODUCTION outbox, sent once and receipted while the continuation is queued (before the clock steps); after E the page is reloaded, the request it had queued reaches nobody and the reloaded page asks again from the same stored continuation; the SERVER answers 410; the draft and its pending effect stand through the hidden recovery and are settled once the recovery's cache holds the person", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-XL0");
  provokes(410);
  const receipt = receiptOf();
  const m = markers("PAIR-XL0");
  const o = await openWReal(context, info, "PAIR-XL0", 4);
  const account = o.reader.account_id;
  const sent = observeCommandPosts(o.page);
  const controls: Record<string, number> = {};
  const probes: Record<string, unknown> = {};
  const barriers: Record<string, unknown> = {};
  const P = randomUUID();
  const name = "PAIR-XL0 local work";
  let localId = "";
  let receiptRevision: number | null = null;
  let staged: TapRecord | null = null;
  let lost: TapRecord | null = null;
  let refused: TapRecord | null = null;
  let held: Awaited<ReturnType<typeof atHeldRefusal>> | null = null;
  let token = "";
  // Revision 39 (R39-DIAG): the departed and the live request are bound by identity before the gate opens, and the driver handles the
  // departed answer first and the live refusal (still held) second, whichever the proxy held first (pair-schedule.mjs `refusalPair`).
  const pair = refusalPair<TapRecord>({ label: o.iv.id });
  await drivePieces({
    page: () => o.page,
    account,
    iv: o.iv,
    old: o.old,
    model: o.model,
    localWork: true,
    select: pair.select,
    start: () => access(o.w, "grant", o.workload.person, account),
    onHeld: async ({ record, piece, before, release, declareLocalWork }) => {
      if (staged === null && isScheduledPiece(piece)) {
        staged = record;
        expect(before.delta_stage?.next_index).toBe(2);
        token = (
          await queueContinuation(
            o,
            record,
            release,
            expiryControl(context, m, controls, probes, {
              // The local work, admitted while the continuation waits at the gate and BEFORE the durable baseline of the clock steps.
              beforeInspect: async () => {
                // R38-DIAG (C2): the writer's own admission, asserted BEFORE the receipt wait and before any clock step: the page's verdict
                // from the real /health under the selection's policy, and this page leads (its production dispatcher sends).
                expect(
                  await compatOf(o.page),
                  "the production writer is admitted by the selection's policy",
                ).toEqual({
                  status: "supported",
                  version: DIAGNOSTIC_RECEIPT?.api_version,
                });
                expect(
                  (await leaderOf(o.page))?.attachment,
                  "this page leads: its own dispatcher sends",
                ).toBe("leader");
                const saved = await enqueueThroughProduction(o.page, {
                  endpoint: "/commands",
                  targets: [
                    {
                      resourceId: P,
                      role: "primary",
                      basis: "resource",
                      versionChecked: false,
                      seedIfUntracked: 1,
                    },
                  ],
                  command: {
                    commands: [
                      {
                        kind: "create_person",
                        id: P,
                        name,
                        initial_policy: { grants: [], exclude_accounts: [] },
                      },
                    ],
                  },
                  displayPatch: { [P]: { label: name } },
                });
                expect(
                  saved.kind,
                  "the production outbox admits the draft",
                ).toBe("queued");
                localId = saved.localId as string;
                const admitted = await until(
                  () => stored(o.page, account, false, [P]),
                  (s) =>
                    (s.local?.drafts ?? []).some(
                      (d) =>
                        d.local_id === localId &&
                        Number.isInteger(d.receipt_revision),
                    ) &&
                    (s.local?.effects ?? []).some(
                      (e) =>
                        e.local_id === localId &&
                        Number.isInteger(e.receipt_revision),
                    ),
                  "the local command's receipt is admitted",
                  60_000,
                );
                receiptRevision =
                  admitted.local?.drafts.find((d) => d.local_id === localId)
                    ?.receipt_revision ?? null;
                expect(receiptRevision).toBeGreaterThan(
                  record.revision as number,
                );
                expect(
                  sent.filter((x) => x.idempotency_key === localId),
                  "sent once, with its local id as the key",
                ).toHaveLength(1);
                await m.mark("receipt_admitted");
                barriers.receipt_admitted = await localAt(
                  o.page,
                  account,
                  localId,
                  P,
                );
                declareLocalWork({
                  drafts: admitted.drafts,
                  composition_seq: admitted.composition_seq,
                  reason: `the admitted create_person ${localId}`,
                });
              },
              // The reload: after E is acknowledged, before the gate opens (pair-schedule.mjs `reloadHook`, revision 28 R28-DIAG.a). Every
              // comparison inside it is with the continuation CONTEXT the control hands it, never the outer `token` assigned only once
              // `queueContinuation` returns (after this very hook).
              afterE: reloadHook({
                mark: (name) => m.mark(name),
                beforeReload: () =>
                  captureTrace(o.page, o.iv, "before the reload"),
                reload: async () => {
                  await o.page.goto("about:blank");
                  await pairPage(context, 4, o.page);
                },
                records: async () => syncRecords(await tap.log(o.iv.since)),
                stored: async () => (await stored(o.page, account)) as Stored,
                until: (read, accept, what) => until(read, accept, what),
                label: o.iv.id,
                after: async () => {
                  barriers.after_reload = await localAt(
                    o.page,
                    account,
                    localId,
                    P,
                  );
                },
                // The reloaded page's own request, bound as the live one while the gate is still closed.
                reloaded: (request, at) => pair.reloaded(request, at),
              }),
            }),
            // The request the departed page queued before the clock steps, bound before the control runs.
            (request, ctx) => pair.queued(request, ctx),
          )
        ).token;
        return undefined;
      }
      // The departed page's 410 reaches nobody (lost, released first); the live 410 is observed while held and handed off.
      return pair.answer(
        { record, release },
        {
          lost: (r) => {
            lost = r;
          },
          live: async (r) => {
            refused = r;
            held = await atHeldRefusal(o, context, r, before, controls);
          },
        },
      );
    },
  });
  const answer = refused as TapRecord | null;
  realRefusal(answer, token);
  expect(
    lost,
    "the departed page's request was refused and lost",
  ).not.toBeNull();
  await expiryAfter(context, m, token, controls, probes);
  const withoutLocal = (rows: NonNullable<Stored["rows"]>) =>
    rows.filter((r) => r.id !== P);
  const done = await recoverObserved(
    o,
    held as unknown as NonNullable<typeof held>,
    "ordinary",
    async (kind) => {
      barriers[kind] = await localAt(o.page, account, localId, P);
    },
    (rows) => [
      ...oracle(o.oldRows, withoutLocal(rows), {
        add: o.workload,
        sentinel: o.sentinel,
      }).problems,
      ...(rows.filter((r) => r.id === P && r.label === name).length === 1
        ? []
        : ["the recovery's cache does not hold the local person exactly once"]),
    ],
  );
  await untilShown(o.page);
  // Once the account is displayed, the receipt is settled (ordinary W23 in the activation, or W26 after display): never left behind.
  await until(
    async () => (await stored(o.page, account, false, [P])) as Stored,
    (s) =>
      !(s.local?.drafts ?? []).some((d) => d.local_id === localId) &&
      !(s.local?.effects ?? []).some((e) => e.local_id === localId),
    "the local work is settled",
    120_000,
  );
  barriers.settled = await localAt(o.page, account, localId, P);
  const proof = writeProof("PAIR-XL0", o.iv.engine, {
    schema: PROOF_SCHEMA,
    case: "PAIR-XL0",
    caller: "ordinary",
    interval: o.iv.id,
    attempt: receipt.attempt,
    engine: o.iv.engine,
    reader_account: account,
    mark_prefix: m.prefix,
    marks: m.marks,
    continuation: { token_sha256: sha256(token), header: tokenHeader(token) },
    staged: { tap_seq: (staged as TapRecord | null)?.seq ?? null },
    lost: { tap_seq: (lost as TapRecord | null)?.seq ?? null },
    refused: { tap_seq: answer?.seq ?? null },
    hand_off_seq: o.iv.handOff?.at_seq ?? null,
    controls,
    probes,
    local_work: {
      local_id: localId,
      resource_id: P,
      command_sha256:
        (barriers.receipt_admitted as Awaited<ReturnType<typeof localAt>>)
          ?.draft?.command_digest ?? null,
      receipt_revision: receiptRevision,
      sent: sent.filter(
        (x) => x.idempotency_key === localId || x.idempotency_key === null,
      ),
      barriers,
    },
  });
  await finishRecovered(
    o,
    done as Stored,
    {
      refused_seq: answer?.seq,
      lost_seq: (lost as TapRecord | null)?.seq,
      diagnostic_proof: proof,
    },
    (rows) => rows.filter((r) => r.id !== P),
  );
});

// ---- the recovery caller ----------------------------------------------------------------------------------------------------------
/** A real revocation of the page's session from another session of the same account (the page is not told). */
async function revokeSession(page: Page, reader: ReturnType<typeof readerOf>) {
  const settled = (await records(page)).auth_state.settled;
  const revoker = await rawSignInAs(reader);
  const revoked = await raw("DELETE", `/sessions/${settled?.session_id}`, {
    cookie: revoker.cookie,
    headers: { "x-csrf-token": revoker.csrf },
  });
  expect([200, 204]).toContain(revoked.status);
}
/** The page's next request meets the revocation: a real 401, recorded as an invalid_session fence. */
async function awaitFence(page: Page) {
  await nudge(page);
  await untilRecord(
    page,
    (s) =>
      Object.values(s.fences)
        .flat()
        .some((f) => f.kind === "invalid_session"),
    "the real 401 is recorded as an invalid_session fence",
  );
}
async function fence(page: Page, reader: ReturnType<typeof readerOf>) {
  await revokeSession(page, reader);
  await awaitFence(page);
}
type TraceEntry = {
  at: number;
  event: string;
  data?: { klass?: string; result?: string; kind?: string };
};
const traceOf = async (page: Page) =>
  (await page.evaluate(
    () => window.__atlasFixture?.session?.trace ?? [],
  )) as TraceEntry[];

test("PAIR-RC1: the FENCED RECOVERY catch-up (a real revocation, a real 401, a password sign-in again) reads the dense revision in pieces of max_changes=4 with the recovery class only, and activates it while the account is hidden", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-RC1");
  provokes(401);
  const o = await openWReal(context, info, "PAIR-RC1", 4);
  // Not driven (the matrix: `none`): the fenced recovery runs by itself; every answer the opening's hold held is released and kept.
  await releaseHold(o.iv, "not driven: the fenced recovery runs unheld");
  await fence(o.page, o.reader);
  const fencedAt = Date.now();
  const grant = await access(
    o.w,
    "grant",
    o.workload.person,
    o.reader.account_id,
  );
  o.iv.target = {
    revisions: [grant.revision],
    through: grant.revision,
    sources: [grant],
  };
  barrier(o.iv, "grant_complete", {
    revision: grant.revision,
    source: grant.source,
  });
  await signInAs(o.page, o.reader);
  await untilView(o.page, "displaying", undefined, 120_000);
  const done = await until(
    () => stored(o.page, o.reader.account_id, true),
    (s) =>
      s.delta_stage === null &&
      s.staged === 0 &&
      (s.rows ?? []).some((r) => r.id === o.workload.person),
    "the recovery's activation",
    180_000,
  );
  barrier(o.iv, "activation_complete", {
    applied_revision: done.applied_revision,
  });
  const trace = (await traceOf(o.page)).filter((e) => e.at >= fencedAt);
  const cleared = trace.findIndex(
    (e) => e.event === "data.recovery_finish" && e.data?.result === "cleared",
  );
  expect(cleared, "finish cleared the fence").toBeGreaterThan(-1);
  const issued = trace
    .slice(0, cleared)
    .filter((e) => e.event === "request.issued");
  expect(
    issued.some((e) => e.data?.klass === "recovery"),
    "recovery-class reads",
  ).toBe(true);
  expect(
    issued.filter((e) => e.data?.klass === "ordinary"),
    "no ordinary request while fenced",
  ).toEqual([]);
  const verdict = oracle(o.oldRows, done.rows ?? [], {
    add: o.workload,
    sentinel: o.sentinel,
  });
  const record = await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    appliedRevision: done.applied_revision,
    oracle: verdict,
    person: o.workload.person,
  });
  // The pieces the client RECEIVED (the proxy's downstream outcome joined to each tap answer).
  expectSegmented(
    record.requests.filter((r) => reachedClient(r) && r.segment),
    4,
    null,
  );
  expect(verdict.problems).toEqual([]);
});

test("PAIR-L1: the same account's session is REPLACED mid-revision (revoked while piece 3 is held; a real 401 on the next piece; a password sign-in again, a new epoch): the recovery catch-up resumes from the stored continuation or restarts at the boundary, and the revision activates once", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-L1");
  provokes(401);
  const o = await openWReal(context, info, "PAIR-L1", 4);
  let atRevocation: Stored | null = null;
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ piece, before }) => {
      // The server's piece 3 of the target, the valid next piece: never the fourth attempt.
      if (piece?.index !== 3 || !piece.next) return undefined;
      atRevocation = before;
      // Piece 3 was answered under the old session; the session is revoked before the answer is released, so the NEXT request is a 401.
      await revokeSession(o.page, o.reader);
      return {
        stop: true,
        reason:
          "the session was revoked: the recovery catch-up continues under a new epoch",
      };
    },
  });
  expect((atRevocation as Stored | null)?.delta_stage?.next_index).toBe(3);
  await releaseHold(
    o.iv,
    "the hand-off: the replaced session's recovery runs unheld",
  );
  await awaitFence(o.page);
  const fenced = (await stored(o.page, o.reader.account_id)) as Stored;
  const refusedSeq = Math.max(
    0,
    ...syncRecords(await tap.log(o.iv.since))
      .filter((r) => r.label === o.iv.id && r.status === 401)
      .map((r) => r.seq),
  );
  expect(refusedSeq, "a real 401 answered the next piece").toBeGreaterThan(0);
  await signInAs(o.page, o.reader);
  await untilView(o.page, "displaying", undefined, 120_000);
  const done = await until(
    () => stored(o.page, o.reader.account_id, true),
    (s) =>
      s.delta_stage === null &&
      s.staged === 0 &&
      (s.rows ?? []).some((r) => r.id === o.workload.person),
    "the activation after the new epoch",
    180_000,
  );
  barrier(o.iv, "activation_complete", {
    applied_revision: done.applied_revision,
  });
  // The first read after the new epoch asks from what the client stored (the staged chain) or from the boundary (a restart); nothing else.
  const resumed = syncRecords(await tap.log(refusedSeq)).filter(
    (r) => r.label === o.iv.id && r.status === 200,
  )[0];
  // The boundary: the cursor the target's piece 0 was asked from.
  const boundary = run.target.find((r) => r.segment?.index === 0)?.query
    ?.cursor;
  expect([fenced.cursor, boundary]).toContain(resumed?.query?.cursor ?? null);
  const verdict = oracle(o.oldRows, done.rows ?? [], {
    add: o.workload,
    sentinel: o.sentinel,
  });
  await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    appliedRevision: done.applied_revision,
    oracle: verdict,
    person: o.workload.person,
    extra: {
      staged_at_revocation:
        (atRevocation as Stored | null)?.delta_stage ?? null,
      resumed_from:
        resumed?.query?.cursor === fenced.cursor
          ? "stored continuation"
          : "boundary (restart)",
    },
  });
  expect(verdict.problems).toEqual([]);
});

// ---- revision 27 (R27-DIAG.b; design assessment C3): the fenced RECOVERY caller into the real expiry and the real pruning ------------
/**
 * RC1's real fence (a revocation from another session, the page's next request answered by a real 401) with the opening's hold released
 * for it, then a NEW hold armed before the grant, so the recovery caller's catch-up is held from its first answer. The trace window starts
 * here (a count, never a clock).
 */
async function fencedForRecovery(o: Opened, m: Markers) {
  await releaseHold(
    o.iv,
    "the fence: the ordinary engine's next request must meet the revocation (a real 401)",
  );
  await fence(o.page, o.reader);
  await m.mark("fence_recorded");
  const traceStart = await traceLength(o.page);
  const fenced = (await stored(o.page, o.reader.account_id)) as Stored;
  expect(fenced.cache_digest, "the fenced cache is the old one").toBe(
    o.old.cache_digest,
  );
  expect(fenced.delta_stage, "nothing is staged at the fence").toBeNull();
  await rearmHold(o.iv, "the recovery caller's hold, armed before the grant");
  await m.mark("hold_rearmed");
  return { traceStart, fenced };
}
/** The password sign-in, begun after the grant and NOT awaited (it settles while the drive holds the recovery's answers). */
async function beginSignIn(o: Opened, m: Markers) {
  await m.mark("sign_in_begin");
  return signInAs(o.page, o.reader).then(
    () => "settled",
    (error: unknown) => `failed: ${String((error as Error)?.message ?? error)}`,
  );
}
/** The recovery caller's evidence: the trace window from the fence to the finish that cleared it (request classes, the finish). */
async function callerEvidence(page: Page, traceStart: number, signIn: string) {
  let window: Array<{ event: string; data?: Record<string, unknown> }> = [];
  await expect
    .poll(
      async () => {
        window = (await traceFrom(page, traceStart)).filter(
          (e) =>
            e.event === "request.issued" || e.event === "data.recovery_finish",
        );
        return window.some(
          (e) =>
            e.event === "data.recovery_finish" && e.data?.result === "cleared",
        );
      },
      {
        message: "the recovery finished by clearing the fence",
        timeout: 120_000,
      },
    )
    .toBe(true);
  return { trace_window: window, sign_in: signIn };
}

test("PAIR-XR0: REAL EXPIRY of the FENCED RECOVERY caller's catch-up (a real revocation, a real 401, a password sign-in again): its continuation queued at the gate across E−1 and E; the SERVER's 410 abandons the attempt (W24: both stagings cleared, a new generation, a snapshot restart, the job's notice) and the snapshot is observed hidden at held pages until one atomic exposure; the fence clears only after it", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-XR0");
  provokes(401);
  provokes(410);
  const receipt = receiptOf();
  const m = markers("PAIR-XR0");
  const o = await openWReal(context, info, "PAIR-XR0", 4);
  const { traceStart, fenced } = await fencedForRecovery(o, m);
  const controls: Record<string, number> = {};
  const probes: Record<string, unknown> = {};
  let staged: TapRecord | null = null;
  let refused: TapRecord | null = null;
  let held: Awaited<ReturnType<typeof atHeldRefusal>> | null = null;
  let token = "";
  let signIn: Promise<string> | null = null;
  await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: fenced,
    model: { ...o.model, cursor: fenced.cursor as string },
    start: async () => {
      await m.mark("grant_begin");
      const grant = await access(
        o.w,
        "grant",
        o.workload.person,
        o.reader.account_id,
      );
      await m.mark("grant_end");
      signIn = beginSignIn(o, m);
      return grant;
    },
    onHeld: async ({ record, piece, before, release }) => {
      if (staged === null && isScheduledPiece(piece)) {
        staged = record;
        expect(before.delta_stage?.next_index).toBe(2);
        token = (
          await queueContinuation(
            o,
            record,
            release,
            expiryControl(context, m, controls, probes),
          )
        ).token;
        return undefined;
      }
      if (staged !== null && refused === null && record.status === 410) {
        refused = record;
        held = await atHeldRefusal(o, context, record, before, controls);
        return {
          stop: true,
          reason:
            "the server's real 410 (expiry) to the recovery caller: its abandonment and snapshot are observed",
        };
      }
      return undefined;
    },
  });
  const answer = refused as TapRecord | null;
  realRefusal(answer, token);
  await expiryAfter(context, m, token, controls, probes);
  const done = await recoverObserved(
    o,
    held as unknown as NonNullable<typeof held>,
    "recovery",
  );
  const signedIn = await (signIn as unknown as Promise<string>);
  expect(signedIn, "the password sign-in settles").toBe("settled");
  await untilShown(o.page);
  const proof = writeProof("PAIR-XR0", o.iv.engine, {
    schema: PROOF_SCHEMA,
    case: "PAIR-XR0",
    caller: "recovery",
    caller_evidence: await callerEvidence(o.page, traceStart, signedIn),
    interval: o.iv.id,
    attempt: receipt.attempt,
    engine: o.iv.engine,
    reader_account: o.reader.account_id,
    mark_prefix: m.prefix,
    marks: m.marks,
    continuation: { token_sha256: sha256(token), header: tokenHeader(token) },
    staged: { tap_seq: (staged as TapRecord | null)?.seq ?? null },
    refused: { tap_seq: answer?.seq ?? null },
    hand_off_seq: o.iv.handOff?.at_seq ?? null,
    controls,
    probes,
  });
  await finishRecovered(o, done, {
    refused_seq: answer?.seq,
    diagnostic_proof: proof,
  });
});

test("PAIR-XR2: REAL PRUNING of the FENCED RECOVERY caller's catch-up: the fence, then the gate drained and the target batch aged before the sign-in can ask for any of it; with the catch-up's continuation queued, the collector removes exactly that batch while the token is unexpired; the SERVER's 410 abandons the attempt (W24) and the snapshot is observed hidden until one atomic exposure", async ({
  context,
  provokes,
}, info) => {
  caseRow("PAIR-XR2");
  provokes(401);
  provokes(410);
  const receipt = receiptOf();
  const m = markers("PAIR-XR2");
  const ctl = await pruneControlAccount("pair-xr2-control");
  const o = await openWReal(context, info, "PAIR-XR2", 4);
  const reader = o.reader.account_id;
  const { traceStart, fenced } = await fencedForRecovery(o, m);
  const controls: Record<string, number> = {};
  const out: { probe: Probe | null } = { probe: null };
  let staged: TapRecord | null = null;
  let refused: TapRecord | null = null;
  let held: Awaited<ReturnType<typeof atHeldRefusal>> | null = null;
  let token = "";
  let signIn: Promise<string> | null = null;
  let target: {
    account: string;
    revision: number;
    payload_sha256: string;
  } | null = null;
  await drivePieces({
    page: () => o.page,
    account: reader,
    iv: o.iv,
    old: fenced,
    model: { ...o.model, cursor: fenced.cursor as string },
    start: async () => {
      const set = await pruneSetup(o, m, controls);
      target = set.target;
      await tap.gate(false);
      signIn = beginSignIn(o, m);
      return set.grant;
    },
    onHeld: async ({ record, piece, before, release }) => {
      if (staged === null && isScheduledPiece(piece)) {
        staged = record;
        expect(before.delta_stage?.next_index).toBe(2);
        token = (
          await queueContinuation(
            o,
            record,
            release,
            pruneControl(
              m,
              controls,
              reader,
              () => target as { revision: number },
              ctl,
              out,
            ),
          )
        ).token;
        return undefined;
      }
      if (staged !== null && refused === null && record.status === 410) {
        refused = record;
        held = await atHeldRefusal(o, context, record, before, controls);
        return {
          stop: true,
          reason:
            "the server's real 410 (pruning) to the recovery caller: its abandonment and snapshot are observed",
        };
      }
      return undefined;
    },
  });
  const answer = refused as TapRecord | null;
  realRefusal(answer, token);
  const done = await recoverObserved(
    o,
    held as unknown as NonNullable<typeof held>,
    "recovery",
  );
  const signedIn = await (signIn as unknown as Promise<string>);
  expect(signedIn, "the password sign-in settles").toBe("settled");
  await untilShown(o.page);
  const proof = writeProof("PAIR-XR2", o.iv.engine, {
    schema: PROOF_SCHEMA,
    case: "PAIR-XR2",
    caller: "recovery",
    caller_evidence: await callerEvidence(o.page, traceStart, signedIn),
    interval: o.iv.id,
    attempt: receipt.attempt,
    engine: o.iv.engine,
    reader_account: reader,
    mark_prefix: m.prefix,
    marks: m.marks,
    target,
    continuation: { token_sha256: sha256(token), header: tokenHeader(token) },
    staged: { tap_seq: (staged as TapRecord | null)?.seq ?? null },
    refused: { tap_seq: answer?.seq ?? null },
    hand_off_seq: o.iv.handOff?.at_seq ?? null,
    controls,
    control_account: pruneProofPart(ctl, out.probe),
  });
  await finishRecovered(o, done, {
    refused_seq: answer?.seq,
    diagnostic_proof: proof,
  });
});
