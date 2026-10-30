import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import {
  reachedClient,
  segmentedProblems,
} from "../../scripts/integration/pair-attempts.mjs";
import { PAIR_SELECTION } from "../../scripts/integration/pair-selection.mjs";
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
  drivePieces,
  endInterval,
  headOf,
  type Interval,
  insertSyntheticBatch,
  type Milestone,
  nudge,
  observe,
  oracle,
  PAIR_BACKEND,
  pairPage,
  preGrant,
  RELEASED_VERSION,
  rawSignInAs,
  rawSyncDirect,
  readerOf,
  releaseHold,
  SELECTION_SHA256,
  type Seeded,
  type Stored,
  seedPerson,
  seedSentinel,
  seedWReal,
  seen,
  signInAs,
  stored,
  syncRecords,
  type TapRecord,
  tap,
  until,
  type Writer,
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
 * Not here: real expiry and pruning (no bounded control on the approved executable: pair-matrix.mjs UNSUPPORTED, owner named), a retired own
 * device and the composed Keep/Delete lifecycle (WEB-09d), device memory, tuning (the 150-sample sweep is a separate obligation).
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
) {
  const verdict = oracle(o.oldRows, done.rows ?? [], {
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
  // pairPage verifies what each page told its production leader.
  await pairPage(context, 4);
  await pairPage(context, null);
});

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
