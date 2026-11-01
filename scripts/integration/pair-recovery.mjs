// WEB-09c revision 27 (R27-DIAG.b, family `segmented-sync-development-pairing`; design assessment C2): the RECOVERY OBSERVER of the real-410
// diagnostic cases, kept apart from the browser (like pair-driver.mjs) so the maintained code itself is qualified with deterministic worlds
// (pair-recovery.test.mjs). tests/pair/support.ts supplies the browser's IO.
//
// Revision 26 released the whole hold at the server's 410 and polled for the final valid cache: a temporary exposure, a partial snapshot or
// an un-abandoned stage followed by correct final content passed. Now the interval's hold STAYS ARMED after the refusal (the driver released
// only the 410 itself), and every snapshot answer of the recovery is held, observed and released one at a time:
//
//   1. the FIRST held snapshot answer proves the client processed the refusal (it committed the invalidation before asking): the leader
//      and an independent follower page (its own connection) read the invalidated state — cache not valid and hidden, cursor null, the
//      delta stage and both stagings empty, a NEW recovery generation, the old live cache physically untouched; for the RECOVERY caller
//      (W24, server restart) also the snapshot phase, the job's own resync_required notice and the fence still in force; an ordinary caller
//      (W18) is not fenced. `recovery_invalidated`.
//   2. at the next held page (one or more pages are staged): both readers see staged rows of that one generation only, the live cache still
//      the old one and still hidden. `recovery_staged_hidden`. Every later held page is checked by the leader (rows never go backwards, the
//      generation and the old cache stand, still hidden).
//   3. the LAST snapshot page (has_more false) held: still hidden, before its release. `recovery_final_held`. A recovery of fewer than two
//      snapshot pages cannot show hidden staging and FAILS (the fixture must produce at least two; nothing is lowered to force it).
//   4. released: the leader's reads until the commit must each be the staged state or the complete one — anything in between (a valid cache
//      with rows still staged, a changed cache before validity) is a SPLIT activation and fails. Then the follower reads the same complete
//      cache, the complete rows are judged by the caller's oracle, and `recovery_exposed` binds the activating page.
// Network barriers show the state BETWEEN transactions; they cannot look inside one. Atomicity inside the W22/W23 transaction remains the
// existing native transaction controls' (qualified separately); this observer requires the evidence a split would leave between them.
import { createHash } from "node:crypto";
import { pickHeld } from "./pair-attempts.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The reader's live cache is not shown to the person: not valid, or the rendered cache gate says refreshing, or the view is elsewhere. */
export const isHidden = (r) =>
  r.cache_status !== "valid" ||
  r.gate === "refreshing" ||
  r.view !== "displaying";

/** The problems of a reader's state right after the refusal was processed (`recovery_invalidated`). */
export function invalidatedProblems(
  r,
  { caller, oldDigest, refusalGeneration },
) {
  const p = [];
  if (r.cache_status === "valid")
    p.push(`${r.reader} still shows a valid cache`);
  if (r.cursor !== null) p.push(`${r.reader} keeps a cursor`);
  if (r.delta_stage !== null || r.staged !== 0)
    p.push(`${r.reader} keeps the abandoned delta stage`);
  if (r.staging_rows !== 0)
    p.push(`${r.reader} holds snapshot rows before the first page`);
  if (!(r.recovery_generation > refusalGeneration))
    p.push(`${r.reader} has no new recovery generation`);
  if (r.cache_digest !== oldDigest)
    p.push(`${r.reader}'s live cache changed before the snapshot`);
  if (!isHidden(r)) p.push(`${r.reader} shows the cache while it is invalid`);
  if (r.reader === "leader") {
    if (caller === "recovery") {
      if (r.phase !== "snapshot")
        p.push("the recovery caller's refusal did not restart the snapshot");
      if (r.notice?.reason !== "resync_required")
        p.push("the recovery job did not record its server restart");
      if (r.fenced !== true) p.push("the recovery caller is no longer fenced");
    } else if (r.fenced === true) p.push("an ordinary caller is fenced");
  }
  return p;
}

/** The problems of a reader's state while the snapshot is staged (`recovery_staged_hidden`, `recovery_final_held`, every later page). */
export function stagedProblems(
  r,
  { caller, oldDigest, generation, rowsAtLeast = 1 },
) {
  const p = [];
  if (!(Number.isInteger(r.staging_rows) && r.staging_rows >= rowsAtLeast))
    p.push(
      `${r.reader} holds ${r.staging_rows} staged rows, expected at least ${rowsAtLeast}`,
    );
  if (
    !(
      r.staging_generations?.length === 1 &&
      r.staging_generations[0] === generation
    )
  )
    p.push(`${r.reader}'s staged rows are not all of generation ${generation}`);
  if (r.recovery_generation !== generation)
    p.push(`${r.reader} moved to generation ${r.recovery_generation}`);
  if (r.cache_digest !== oldDigest)
    p.push(`${r.reader}'s live cache changed before the activation`);
  if (r.cache_status === "valid")
    p.push(`${r.reader} shows a valid cache before the last page`);
  if (!isHidden(r))
    p.push(`${r.reader} shows the cache while the snapshot is staged`);
  if (caller === "recovery" && r.reader === "leader" && r.fenced !== true)
    p.push("the fence was cleared before the snapshot was complete");
  return p;
}

/** The complete state after the activation. */
export function exposedProblems(r, { oldDigest }) {
  const p = [];
  if (r.cache_status !== "valid")
    p.push(`${r.reader} does not show a valid cache`);
  if (r.staging_rows !== 0 || r.delta_stage !== null || r.staged !== 0)
    p.push(`${r.reader} still holds staged rows after the activation`);
  if (r.cache_digest === oldDigest)
    p.push(`${r.reader} still shows the old cache`);
  return p;
}

/**
 * Observes one recovery to its exposure. `io`: held(ruleId) → proxy ids; records() → the interval's tap /sync records; release(ruleId,
 * proxyId) → {released, outcomes}; read(reader, {rows}) → state (reader "leader" | "follower"); recordRelease({proxy_id, outcome,
 * reason}); observe(kind, atSeq, cacheDigest, detail); onPage?(kind, record, leader) (the case's own per-barrier checks, e.g. its local
 * work; it may throw); now(); sleep(ms). `o`: ruleId, caller ("ordinary" | "recovery"), refusal {seq, generation} (the hand-off's
 * exchange and the generation stored when the refusal was held), oldDigest, expectFinal(rows) → problems, bounds.
 * Resolves with {pages, final}; throws with a diagnosis on the first violation (the interval is then kept incomplete by its owner).
 */
export async function observeRecovery(io, o) {
  const {
    ruleId,
    caller,
    refusal,
    oldDigest,
    expectFinal,
    maxPages = 2000,
    heldTimeoutMs = 120_000,
    settleTimeoutMs = 120_000,
  } = o;
  if (!["ordinary", "recovery"].includes(caller))
    throw new Error(`unknown caller ${caller}`);
  const fail = (what) => {
    throw new Error(`recovery observation: ${what}`);
  };
  const handled = new Set();
  const pages = [];
  let generation = null;
  let rows = 0;
  let stagedSeen = false;
  const nextHeld = async () => {
    const deadline = io.now() + heldTimeoutMs;
    for (;;) {
      const held = (await io.held(ruleId)).filter((id) => !handled.has(id));
      const records = (await io.records()).filter((r) => r.seq > refusal.seq);
      const picked = pickHeld(held, records);
      if (picked) return picked;
      if (io.now() > deadline)
        fail(
          `no recovery answer was held within ${heldTimeoutMs} ms (after ${pages.length} pages)`,
        );
      await io.sleep(25);
    }
  };
  const release = async (proxyId, reason) => {
    handled.add(proxyId);
    const released = await io.release(ruleId, proxyId);
    if (released.released !== 1)
      fail(`releasing proxy entry ${proxyId} released ${released.released}`);
    const outcome = released.outcomes?.[0]?.outcome ?? null;
    await io.recordRelease({ proxy_id: proxyId, outcome, reason });
    if (outcome !== "delivered")
      fail(`the snapshot answer ${proxyId} was ${outcome}, not delivered`);
  };
  const both = async () => [await io.read("leader"), await io.read("follower")];
  const require = (problems, what) => {
    if (problems.length > 0) fail(`${what}: ${problems.join("; ")}`);
  };
  for (;;) {
    const { record, proxyId } = await nextHeld();
    if (!(record.status === 200 && record.phase === "snapshot"))
      fail(
        `answer ${record.seq} held during the recovery is ${record.status} ${record.phase}, not a snapshot page`,
      );
    pages.push(record.seq);
    if (pages.length > maxPages) fail(`more than ${maxPages} snapshot pages`);
    const last = record.has_more === false;
    if (pages.length === 1) {
      const [leader, follower] = await both();
      for (const r of [leader, follower])
        require(invalidatedProblems(r, {
          caller,
          oldDigest,
          refusalGeneration: refusal.generation,
        }), `at the first snapshot page ${record.seq}`);
      if (follower.recovery_generation !== leader.recovery_generation)
        fail("the follower does not read the leader's generation");
      generation = leader.recovery_generation;
      await io.observe(
        "recovery_invalidated",
        record.seq,
        leader.cache_digest,
        {
          leader,
          follower,
          generation_at_refusal: refusal.generation,
        },
      );
      await io.onPage?.("recovery_invalidated", record, leader);
      if (last)
        fail(
          "the recovery has fewer than two snapshot pages: its hidden staging cannot be observed",
        );
    } else {
      const leader = await io.read("leader");
      require(stagedProblems(leader, {
        caller,
        oldDigest,
        generation,
        rowsAtLeast: Math.max(1, rows),
      }), `at snapshot page ${record.seq}`);
      rows = leader.staging_rows;
      if (!stagedSeen) {
        stagedSeen = true;
        const follower = await io.read("follower");
        require(stagedProblems(follower, {
          caller,
          oldDigest,
          generation,
        }), `the follower at snapshot page ${record.seq}`);
        await io.observe(
          "recovery_staged_hidden",
          record.seq,
          leader.cache_digest,
          {
            leader,
            follower,
          },
        );
        await io.onPage?.("recovery_staged_hidden", record, leader);
      }
      if (last) {
        const follower = await io.read("follower");
        require(stagedProblems(follower, {
          caller,
          oldDigest,
          generation,
          rowsAtLeast: rows,
        }), `the follower at the last snapshot page ${record.seq}`);
        await io.observe(
          "recovery_final_held",
          record.seq,
          leader.cache_digest,
          {
            leader,
            follower,
          },
        );
        await io.onPage?.("recovery_final_held", record, leader);
      }
    }
    if (!last) {
      await release(
        proxyId,
        `recovery observation: snapshot page ${pages.length}`,
      );
      continue;
    }
    await release(proxyId, "recovery observation: the last snapshot page");
    // The activation: every read until it commits is the staged state or the complete one, never a mixture.
    const deadline = io.now() + settleTimeoutMs;
    let final = null;
    for (;;) {
      const r = await io.read("leader");
      const complete = r.cache_status === "valid" && r.staging_rows === 0;
      if (complete) {
        require(exposedProblems(r, {
          oldDigest,
        }), "after the last snapshot page");
        final = r;
        break;
      }
      const staged = stagedProblems(r, {
        caller,
        oldDigest,
        generation,
        rowsAtLeast: rows,
      });
      if (staged.length > 0)
        fail(
          `a split activation: neither the staged nor the complete state (${staged.join("; ")})`,
        );
      if (io.now() > deadline)
        fail(`the activation did not commit within ${settleTimeoutMs} ms`);
      await io.sleep(25);
    }
    const follower = await io.read("follower");
    require(exposedProblems(follower, {
      oldDigest,
    }), "the follower after the activation");
    if (follower.cache_digest !== final.cache_digest)
      fail("the follower does not read the activated cache");
    const withRows = await io.read("leader", { rows: true });
    if (withRows.cache_digest !== final.cache_digest)
      fail("the cache changed between the activation and its rows");
    const verdict = expectFinal(withRows.rows ?? []);
    require(verdict, "the exposed cache against the oracle");
    const { rows: content, ...leader } = withRows;
    await io.observe("recovery_exposed", record.seq, final.cache_digest, {
      leader,
      follower,
      rows_sha256: sha256(JSON.stringify(content ?? [])),
    });
    await io.onPage?.("recovery_exposed", record, leader);
    return { pages, final: withRows };
  }
}
