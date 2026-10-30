import type { BrowserContext, Page, TestInfo } from "@playwright/test";
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
  access,
  accountFor,
  barrier,
  bodyOf,
  type ChainModel,
  caseRow,
  drivePieces,
  endInterval,
  headOf,
  type Interval,
  insertSyntheticBatch,
  nudge,
  oracle,
  PAIR_BACKEND,
  pairPage,
  preGrant,
  RELEASED_VERSION,
  rawSignInAs,
  rawSyncDirect,
  readerOf,
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
test.afterEach(async () => {
  if (!PAIR_BACKEND) return;
  // Every fault a case armed must have fired; an unfired one is never silently carried into the next case.
  const unfired = (await tap.faults()).filter((f) => f.fired === null);
  await tap.reset();
  expect(unfired, "every armed tap fault fired").toEqual([]);
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

/** The shape of a bounded delivery: every request asked for m, every answer within m, ONE revision in index order ending once. */
function expectSegmented(
  steps: TapRecord[],
  m: number,
  revision: number | null,
) {
  const answers = steps.filter((r) => r.status === 200);
  expect(answers.length, "more than one piece").toBeGreaterThan(1);
  for (const r of answers) {
    expect(r.query?.max_changes, `seq ${r.seq}: the request's budget`).toBe(
      String(m),
    );
    expect(
      r.changes ?? 0,
      `seq ${r.seq}: within the budget`,
    ).toBeLessThanOrEqual(m);
  }
  const pieces = answers.filter(
    (r) => r.segment && (revision === null || r.revision === revision),
  );
  expect(pieces.map((r) => r.segment?.index)).toEqual(pieces.map((_, i) => i));
  expect(
    pieces.filter((r) => r.segment?.last).length,
    "exactly one last piece",
  ).toBe(1);
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
    oracle: verdict,
    barriered: true,
    person: o.workload.person,
    extra,
    ...(injected ? { injectedOutsideTap: injected } : {}),
  });
  expect(verdict.problems).toEqual([]);
  return record;
}

/** After a 410 (real or injected): no holds; the recovery runs by itself to a valid cache holding the workload. */
async function untilRecovered(o: Opened, page: Page): Promise<Stored> {
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
    oracle: verdict,
    barriered: false,
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
  const answer = run.steps.filter((r) => r.status === 200);
  expect(answer).toHaveLength(1);
  expect(answer[0]?.segment ?? null).toBeNull();
  expect(answer[0]?.changes).toBe(200);
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
    expectSegmented(run.steps, m, null);
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
    if (m !== null) expectSegmented(run.steps, m, null);
    else
      expect(
        run.steps.filter((r) => r.status === 200).map((r) => r.changes),
      ).toEqual([800]);
    const final = run.final as Stored;
    expect(final.applied_revision).toBeGreaterThan(
      pre.old.applied_revision as number,
    );
    // The batch re-sends what the reader holds: the cache is the old one, row for row.
    const verdict = oracle(pre.oldRows, final.rows ?? [], { sentinel });
    // Every resource of the batch was delivered (each id at least once across the pieces).
    const ids = new Set<string>();
    for (const r of run.steps.filter((x) => x.status === 200 && x.body_file)) {
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
      oracle: verdict,
      barriered: true,
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
    onHeld: async ({ index, before, release }) => {
      if (index !== 3 || reloaded) return undefined;
      reloaded = true;
      expect(before.delta_stage?.next_index).toBe(3);
      await o.page.goto("about:blank");
      await release();
      await pairPage(context, 4, o.page);
      return { delivered: false };
    },
  });
  expect(reloaded).toBe(true);
  expectSegmented(
    run.steps.filter((r) => !r.client_gone),
    4,
    null,
  );
  await finishAdded(o, run.final as Stored, { reloaded_at_step: 3 });
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
      await access(o.w, "grant", o.workload.person, o.reader.account_id);
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
  const follower = await pairPage(context, 4);
  expect(
    (await follower.evaluate(() => window.__atlasFixture?.session?.leader()))
      ?.attachment,
  ).not.toBe("leader");
  let checkedLast = false;
  const run = await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ record }) => {
      const other = (await stored(follower, o.reader.account_id)) as Stored;
      expect(other.cache_digest, "the follower sees the old live cache").toBe(
        o.old.cache_digest,
      );
      if (seen(record).segment?.last) checkedLast = true;
      return undefined;
    },
  });
  expect(checkedLast).toBe(true);
  const fromFollower = (await stored(follower, o.reader.account_id)) as Stored;
  expect(fromFollower.cache_digest).toBe((run.final as Stored).cache_digest);
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
    onHeld: async ({ index, release }) => {
      if (index !== 2 || closed) return undefined;
      closed = true;
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
  await finishAdded(o, run.final as Stored, { leader_closed_at_step: 2 });
});

// ---- per-response authorisation --------------------------------------------------------------------------------------------------
test("PAIR-A1: the person is REVOKED while piece 2 is held: no later answer discloses a field never sent before the revocation, and the cache converges to the old state without the workload", async ({
  context,
}, info) => {
  caseRow("PAIR-A1");
  const o = await openWReal(context, info, "PAIR-A1", 4);
  const delivered = new Set<string>();
  let revokedAt: number | null = null;
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
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ index, record }) => {
      if (record.status === 200 && record.body_file && revokedAt === null)
        for (const id of upserts(record)) delivered.add(id);
      if (index === 2 && revokedAt === null) {
        await access(o.w, "revoke", o.workload.person, o.reader.account_id);
        revokedAt = record.seq;
      }
      return undefined;
    },
  });
  expect(revokedAt).not.toBeNull();
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
    oracle: verdict,
    barriered: true,
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
      await access(o.w, "grant", o.workload.person, o.reader.account_id);
      await prepare();
      await arm(o);
    },
    onHeld: async ({ record }) => {
      if (record.status !== 410) return undefined;
      refused = record;
      return { stop: true };
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
        await access(o.w, "grant", o.workload.person, o.reader.account_id);
      },
    });
    expect(run.model.restarted, "one restart at the boundary").toBe(1);
    const faulted = run.steps.findIndex((r) => r.delivered);
    expect(faulted).toBeGreaterThanOrEqual(2);
    expect(
      run.steps[faulted + 1]?.query?.cursor,
      "the request after the broken piece asks from the boundary",
    ).toBe(o.old.cursor);
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
      await access(o.w, "grant", o.workload.person, o.reader.account_id);
    },
    onHeld: async ({ record }) => {
      if (seen(record).status !== 410) return undefined;
      injected = record;
      return { stop: true };
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
  await fence(o.page, o.reader);
  const fencedAt = Date.now();
  await access(o.w, "grant", o.workload.person, o.reader.account_id);
  barrier(o.iv, "grant_complete");
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
  const steps = syncRecords(await tap.log(o.iv.since)).filter(
    (r) => r.label === o.iv.id && r.status === 200,
  );
  expectSegmented(
    steps.filter((r) => r.segment),
    4,
    null,
  );
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
  await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    oracle: verdict,
    barriered: false,
    person: o.workload.person,
  });
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
  await drivePieces({
    page: () => o.page,
    account: o.reader.account_id,
    iv: o.iv,
    old: o.old,
    model: o.model,
    start: () => access(o.w, "grant", o.workload.person, o.reader.account_id),
    onHeld: async ({ index, before }) => {
      if (index !== 3) return undefined;
      atRevocation = before;
      // Piece 3 was answered under the old session; the session is revoked before the answer is released, so the NEXT request is a 401.
      await revokeSession(o.page, o.reader);
      return { stop: true };
    },
  });
  expect((atRevocation as Stored | null)?.delta_stage?.next_index).toBe(3);
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
  expect([fenced.cursor, o.old.cursor]).toContain(
    resumed?.query?.cursor ?? null,
  );
  const verdict = oracle(o.oldRows, done.rows ?? [], {
    add: o.workload,
    sentinel: o.sentinel,
  });
  await endInterval(o.page, o.iv, {
    backend: PAIR_BACKEND,
    workload: "W-real",
    preGrantCursor: o.old.cursor as string,
    terminal: "activated",
    oracle: verdict,
    barriered: false,
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
