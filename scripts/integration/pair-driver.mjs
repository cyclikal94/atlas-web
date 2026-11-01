// WEB-09c revision 25 (R24-PAIR.c and DA-PAIR-S, family `segmented-sync-development-pairing`): the development pair's COMMON DRIVER and its
// opening, kept apart from the browser so the maintained code itself is qualified (pair-driver.test.mjs) with deterministic IO stand-ins and
// at the real stand-in backend → tap → holding proxy → client hop. tests/pair/support.ts supplies the browser's IO; nothing here knows of
// Playwright.
//
// R24-PAIR.c: the driver took ANY received 200 with `has_more: false` as the end of the workload. An ordinary poll answered while the grant
// was in flight (an empty live-edge page) ended the drive, removed the hold, and the real revision then arrived unheld. The workload is now
// named INDEPENDENTLY of the feed: the writer's public receipt (`Receipt {revision}`, the revision the reader's batch carries) or the revision
// the synthetic transaction inserted (`start()` returns it). A case that changes the workload again (A1's revocation) adds a later milestone.
// The workload is done only when its last milestone was activated by an answer the client received, the activation was observed durably,
// and an answer the client received then completed the feed. Kept as separate observations (DA-PAIR-S):
//   - the ATTEMPT (the ledger, pair-attempts.mjs) and the logical PIECE (the server's segment of a target revision): a hook acts on a piece,
//     never on a loop turn, so an empty prefix, a lost attempt or a restart cannot move the schedule a case's title promises;
//   - the ROLE of each answer, judged on the SERVER's answer (the tap's upstream record, never an injected copy): `target` (batches of
//     target revisions only), `incidental` (an empty page), `other` (not a 200). A batch of any other revision is a failure, never ignored;
//   - the client's BOOKKEEPING, predicted from validated commits: W1 commits a whole or empty page or a final piece and advances `page_seq`
//     (an empty page may renew the cursor and activates nothing); W27 staging advances nothing; a restart writes no page. The baseline is
//     never re-read to make storage agree;
//   - ACTIVATION (the target revision applied, nothing staged, observed durably while the hold still covers every later answer) and FEED
//     COMPLETION (`has_more: false`). A last piece with `has_more: true` activates without completing; an empty page before the target
//     completes nothing.
// The hold belongs to the OPENING (`openHold`), not to the driver: it is armed before the interval's label, every /sync admitted before it is
// settled (never left to land inside the interval unheld), and it stays in force through the grant, follower set-up and the whole drive. Its
// owner releases it at the end of the interval or at an explicit hand-off.
import {
  createLedger,
  effectOf,
  outcomeOf,
  pickHeld,
  seenOf,
} from "./pair-attempts.mjs";

/** The workload the driver waits for: the receipt's (or the synthetic transaction's) revision, then any later milestone (A1's revoke). */
export function createTarget(first) {
  return addMilestone({ revisions: [], through: null, sources: [] }, first);
}
export function addMilestone(target, milestone) {
  const { revision, source } = milestone ?? {};
  if (!(Number.isInteger(revision) && revision > 0))
    throw new Error(
      `a target revision is a positive integer, not ${JSON.stringify(revision)}`,
    );
  if (target.through !== null && !(revision > target.through))
    throw new Error(
      `milestone ${revision} does not follow the target ${target.through}`,
    );
  if (!(typeof source === "string" && source.length > 0))
    throw new Error(`milestone ${revision} names no source`);
  target.revisions.push(revision);
  target.through = revision;
  target.sources.push({ revision, source });
  return target;
}

/** The SERVER's answer (the tap's upstream record) to the workload: `target`, `incidental`, `other`, or `unrelated` (a failure). */
export function roleOf(record, target) {
  if (record.status !== 200) return "other";
  if (!(Number.isInteger(record.batches) && record.batches > 0))
    return "incidental";
  return [record.revision, record.last_revision].every((v) =>
    target.revisions.includes(v),
  )
    ? "target"
    : "unrelated";
}

/** Where the drive is: before any target piece, receiving one, between milestones, or after the last milestone's activation. */
export function phaseOf(model, target, activations) {
  if (activations.some((a) => a.revision === target.through))
    return "after_activation";
  if (model.stage && target.revisions.includes(model.stage.revision))
    return "receiving";
  return activations.length > 0 ? "between_milestones" : "awaiting";
}

/**
 * What the client must store after receiving `r` (BE-Q23 contract §4.3; W27/W1): a model kept from the tap's records, against which the
 * stored state is checked at every barrier. `pages` counts the client's W1 commits since the interval began (the expected `page_seq` is the
 * baseline's plus `pages`); `restarted` counts broken chains (a gap, a repeat, another revision, a whole page during a stage): the stage is
 * discarded and the cursor goes back to the boundary, and no page is committed.
 */
export function advance(model, r) {
  const s = seenOf(r);
  if (s.status !== 200) return model;
  const pages = model.pages ?? 0;
  const segment = s.segment;
  if (!segment) {
    if (model.stage)
      return {
        ...model,
        stage: null,
        cursor: model.boundary ?? model.cursor,
        boundary: null,
        restarted: model.restarted + 1,
      };
    // A whole page commits (W1). An empty live-edge page activates nothing (it names no revision), and its cursor may be a renewed one.
    return {
      ...model,
      cursor: s.next_cursor ?? model.cursor,
      activated: s.last_revision ?? model.activated,
      pages: pages + 1,
    };
  }
  const broken =
    model.stage === null
      ? segment.index !== 0
      : s.revision !== model.stage.revision ||
        segment.index !== model.stage.next_index ||
        (!segment.last && s.has_more !== true);
  if (broken) {
    if (model.stage === null)
      return { ...model, restarted: model.restarted + 1 };
    return {
      ...model,
      stage: null,
      cursor: model.boundary ?? model.cursor,
      boundary: null,
      restarted: model.restarted + 1,
    };
  }
  if (segment.last)
    return {
      ...model,
      stage: null,
      boundary: null,
      cursor: s.next_cursor ?? model.cursor,
      activated: s.revision,
      pages: pages + 1,
    };
  return {
    ...model,
    boundary: model.stage === null ? model.cursor : model.boundary,
    stage: { revision: s.revision, next_index: segment.index + 1 },
    cursor: s.next_cursor ?? model.cursor,
  };
}

const isSyncEntry = (e) =>
  e?.method === "GET" && new URL(e.path, "http://x").pathname.endsWith("/sync");

/**
 * The OPENING: the hold is armed (acknowledged) BEFORE the interval's label, then, in bounded rounds: every /sync the proxy admitted before
 * the rule existed is waited for until it settled; every answer the rule already holds belongs to no interval and is released (recorded);
 * the client must be idle at its complete state (`io.quietNow`); only then is the tap labelled. A request that had already reached the tap
 * when the label was set, under the hold, would be held outside the window: the round is repeated. Returns the rule, the label's sequence
 * number (the window's start) and every answer released before it. Never pauses or shortens a production timer.
 *
 * io: addRule() → {id}; proxyLog(); held(ruleId) → entry ids; releaseOne(ruleId, id) → {outcomes}; label(label|null) → seq; tapRecords();
 *     quietNow() → the complete idle state or null; now(); sleep(ms).
 */
export async function openHold(io, { label, maxWaitMs = 30_000 }) {
  const { id: ruleId } = await io.addRule();
  const released = [];
  const deadline = io.now() + maxWaitMs;
  const late = (round, what) =>
    new Error(
      `the opening did not become quiet within ${maxWaitMs} ms (round ${round}): ${what}`,
    );
  for (let round = 1; ; round += 1) {
    if (round > 1) await io.label(null);
    let quiet = null;
    for (;;) {
      const preArm = (await io.proxyLog())
        .filter(
          (e) =>
            isSyncEntry(e) && e.rule !== ruleId && outcomeOf(e) === "pending",
        )
        .map((e) => e.id);
      for (const id of await io.held(ruleId)) {
        const r = await io.releaseOne(ruleId, id);
        released.push({
          round,
          proxy_id: id,
          outcome: r.outcomes?.[0]?.outcome ?? null,
        });
      }
      if (preArm.length === 0) quiet = await io.quietNow();
      if (quiet) break;
      if (io.now() > deadline)
        throw late(
          round,
          `/sync admitted before the hold still open: ${preArm.join(",") || "none"}`,
        );
      await io.sleep(25);
    }
    const since = await io.label(label);
    const underRule = new Set(
      (await io.proxyLog())
        .filter(
          (e) =>
            isSyncEntry(e) && e.rule === ruleId && outcomeOf(e) === "pending",
        )
        .map((e) => e.id),
    );
    const early = (await io.tapRecords())
      .filter((r) => underRule.has(r.proxy_id) && r.seq <= since)
      .map((r) => r.seq);
    if (early.length === 0)
      return { ruleId, since, rounds: round, released, quiet };
    if (io.now() > deadline)
      throw late(round, `held before the label: ${early.join(",")}`);
  }
}

/**
 * The per-piece barrier driver. At EVERY held answer (the oldest held proxy entry, joined exactly to its tap record; pair-attempts.mjs) it
 * reads the stored state in one transaction and checks it against the chain model and the predicted live state (cursor, stage, page_seq,
 * applied revision, cache digest, composition, no local work); counts the persistence of the previously received staged piece ONCE; lets the
 * case act on the PIECE (`onHeld`); releases that one entry and keeps its outcome. A held answer the hook made unreachable (`delivered:
 * false`) is a LOST attempt; an answer the tap dropped never reaches the hold and is kept as `dropped`. An activation of a target revision is
 * observed durably at once (the hold still covers every later answer). The drive ends at the first received feed completion AFTER the last
 * milestone's activation; an earlier completion is incidental (the engine is nudged and the drive continues). `stop` hands the case over
 * (a recovery, a replaced session); the hold is then its owner's to release.
 *
 * io: held(ruleId); records() (the interval's sync records); read(); release(ruleId, proxyId) → {released, outcomes}; nudge();
 *     waitFor(predicate, what, {rows}) → the stored state once it holds; barrier(name, detail); now(); sleep(ms).
 */
export async function drive(io, o) {
  const { ruleId, base } = o;
  const ledger = o.ledger ?? createLedger();
  const maxSteps = o.maxSteps ?? 600;
  const heldTimeoutMs = o.heldTimeoutMs ?? 90_000;
  let model = { pages: 0, ...o.model };
  let live = {
    applied_revision: base.applied_revision,
    cache_digest: base.cache_digest,
    composition_seq: base.composition_seq,
  };
  const activations = [];
  const steps = [];
  const handled = new Set();
  let localWork = { drafts: 0, reason: null };
  const started = await o.start();
  const target = createTarget(started);
  await io.barrier("grant_complete", {
    revision: target.through,
    source: started.source,
  });
  await io.nudge();
  const phase = () => phaseOf(model, target, activations);
  const diagnose = (what) =>
    `${what} [phase ${phase()}; target ${target.revisions.join(",")}; activated ${
      activations.map((a) => `${a.revision}@${a.seq}`).join(",") || "none"
    }; last attempts ${
      ledger.attempts
        .slice(-3)
        .map((a) => `${a.seq}:${a.role}:${a.client}:${a.effect}`)
        .join(" ") || "none"
    }]`;
  const check = (ok, what) => {
    if (!ok) throw new Error(diagnose(what));
  };
  const result = (extra) => ({
    model,
    steps,
    target: steps.filter((r) => roleOf(r, target) === "target"),
    incidental: steps.filter((r) => roleOf(r, target) === "incidental"),
    attempts: ledger.attempts,
    goal: { revisions: [...target.revisions], through: target.through },
    sources: [...target.sources],
    activations: [...activations],
    ...extra,
  });

  for (let index = 0; index < maxSteps; index += 1) {
    // The next held answer: the oldest held proxy entry and the one tap record that carries its id; a dropped answer is kept as it is seen.
    let picked = null;
    const deadline = io.now() + heldTimeoutMs;
    for (;;) {
      const held = await io.held(ruleId);
      const records = await io.records();
      for (const r of records)
        if (r.dropped && !handled.has(r.seq)) {
          handled.add(r.seq);
          check(
            roleOf(r, target) !== "unrelated",
            `dropped answer ${r.seq} carries revision ${r.revision}`,
          );
          ledger.unheld(r, "not held (the tap destroyed the connection)", {
            role: roleOf(r, target),
            phase: phase(),
          });
        }
      picked = pickHeld(held, records);
      if (picked) break;
      if (io.now() > deadline)
        throw new Error(
          diagnose(
            `no /sync answer was held within ${heldTimeoutMs} ms (after attempt ${index})`,
          ),
        );
      await io.sleep(25);
    }
    const { record, proxyId } = picked;
    handled.add(record.seq);
    const role = roleOf(record, target);
    check(
      role !== "unrelated",
      `answer ${record.seq} carries revision ${record.revision}..${record.last_revision}, not a target revision`,
    );
    const before = await io.read();
    // The client asks from the cursor it stored, and has stored what the model says.
    check(
      (record.query?.cursor ?? null) === model.cursor,
      `attempt ${index}: the request carries the stored cursor`,
    );
    check(before.cursor === model.cursor, `attempt ${index}: stored cursor`);
    check(
      (before.delta_stage?.next_index ?? null) ===
        (model.stage?.next_index ?? null),
      `attempt ${index}: stored stage next index ${before.delta_stage?.next_index ?? null}, the model ${model.stage?.next_index ?? null}`,
    );
    // The live state is the one the validated commits predict: nothing of an unfinished revision is visible (I3); W27 advances nothing.
    // Revision 27 (C4): the zero-draft premise stands for every case except one that DECLARED its local work (its matrix row), and then
    // the driver holds the count and composition the case declared after admitting it: nothing else may change them.
    check(
      before.drafts === localWork.drafts,
      localWork.reason === null
        ? `attempt ${index}: the reader holds no local work (the fixture's premise)`
        : `attempt ${index}: the reader holds ${before.drafts} drafts, the declared local work ${localWork.drafts} (${localWork.reason})`,
    );
    check(
      before.page_seq === base.page_seq + model.pages,
      `attempt ${index}: page_seq ${before.page_seq}, predicted ${base.page_seq + model.pages}`,
    );
    check(
      before.applied_revision === live.applied_revision,
      `attempt ${index}: applied revision ${before.applied_revision}, predicted ${live.applied_revision}`,
    );
    check(
      before.cache_digest === live.cache_digest,
      `attempt ${index}: the live cache is not the predicted one`,
    );
    check(
      before.composition_seq === live.composition_seq,
      `attempt ${index}: composition ${before.composition_seq}, predicted ${live.composition_seq}`,
    );
    // The previously RECEIVED, staged piece is persisted (witnessed now, at this request): counted once, never per observation.
    const persisted = ledger.observe({
      atSeq: record.seq,
      stage: before.delta_stage,
    });
    if (persisted) await io.barrier("piece_persisted", persisted);
    const attempt = ledger.open({
      step: index,
      record,
      proxyId,
      role,
      phase: phase(),
    });
    // The proxy's outcome of releasing THIS entry (a socket write, or the client already gone).
    const delivery = { outcome: null };
    const release = async () => {
      if (delivery.outcome !== null) return;
      const released = await io.release(ruleId, proxyId);
      if (released.released !== 1)
        throw new Error(
          `attempt ${index}: releasing proxy entry ${proxyId} released ${released.released}`,
        );
      delivery.outcome = released.outcomes?.[0]?.outcome ?? "unknown";
    };
    // The case acts on the PIECE: the server's own segment of a target revision, and whether it is the valid next piece of the chain.
    const piece =
      role === "target" && record.segment
        ? {
            revision: record.revision,
            index: record.segment.index,
            last: record.segment.last,
            next:
              record.segment.index ===
              (model.stage?.revision === record.revision
                ? model.stage.next_index
                : 0),
          }
        : null;
    const answer =
      (await o.onHeld?.({
        record,
        model,
        before,
        index,
        piece,
        role,
        phase: phase(),
        target: { revisions: [...target.revisions], through: target.through },
        release,
        addMilestone: (m) => {
          addMilestone(target, m);
        },
        // Revision 27 (C4): the case's own admitted local work, declared with the state it reads once the work is admitted.
        declareLocalWork: ({ drafts, composition_seq, reason }) => {
          if (o.localWork !== true)
            throw new Error(
              "this case declared no local work: the zero-draft premise stands",
            );
          if (!(Number.isInteger(drafts) && drafts > 0) || !reason)
            throw new Error("local work is declared with a count and a reason");
          localWork = { drafts, reason };
          live.composition_seq = composition_seq;
        },
      })) ?? {};
    await release();
    const reached = answer.delivered !== false;
    const next = reached ? advance(model, record) : model;
    const effect = effectOf(model, next);
    ledger.settle(attempt, {
      reached,
      downstream: delivery.outcome ?? "unknown",
      effect,
    });
    if (reached && effect === "activated") {
      // One durable, atomic activation per target revision, observed now (the next answer is held, so nothing else can move the state).
      const revision = next.activated;
      check(
        target.revisions.includes(revision),
        `answer ${record.seq} activates revision ${revision}, not a target revision`,
      );
      check(
        activations.every((a) => a.revision < revision),
        `answer ${record.seq} activates revision ${revision} again or out of order`,
      );
      const pageSeq = base.page_seq + next.pages;
      const s = await io.waitFor(
        (x) =>
          x.applied_revision === revision &&
          x.delta_stage === null &&
          x.staged === 0 &&
          x.page_seq === pageSeq,
        `the durable activation of revision ${revision} (answer ${record.seq})`,
      );
      check(
        s.cursor === next.cursor,
        `after the activation of ${revision}: the stored cursor is not the answer's`,
      );
      live = {
        applied_revision: s.applied_revision,
        cache_digest: s.cache_digest,
        composition_seq: s.composition_seq,
      };
      activations.push({ revision, seq: record.seq });
      await io.barrier("target_activated", {
        revision,
        activated_by_seq: record.seq,
        page_seq: s.page_seq,
        cache_digest: s.cache_digest,
        cache_count: s.cache_count,
      });
    }
    model = next;
    if (reached) steps.push(record);
    if (answer.stop)
      return result({
        final: null,
        stoppedAt: record,
        handOff: {
          at_seq: record.seq,
          reason: answer.reason ?? "the case continues by itself",
        },
        terminal: null,
      });
    const seen = seenOf(record);
    if (reached && seen.status === 200 && seen.has_more === false) {
      const through = activations.find((a) => a.revision === target.through);
      if (through) {
        await io.barrier("final_released", {
          seq: record.seq,
          proxy_id: proxyId,
          outcome: delivery.outcome,
        });
        const final = await io.waitFor(
          (x) =>
            x.applied_revision === target.through &&
            x.delta_stage === null &&
            x.staged === 0 &&
            x.page_seq === base.page_seq + model.pages,
          "the end state of the target",
          { rows: true },
        );
        check(
          final.cache_digest === live.cache_digest,
          "the feed's completion changed the activated cache",
        );
        await io.barrier("activation_complete", {
          applied_revision: final.applied_revision,
          activated_by_seq: through.seq,
        });
        return result({
          final,
          stoppedAt: null,
          handOff: null,
          terminal: { final_seq: record.seq, activated_by_seq: through.seq },
        });
      }
      // The feed is complete, but not with the target (a poll answered before its publication, or between milestones): ask again.
      await io.nudge();
    }
  }
  throw new Error(
    diagnose(`the target did not finish within the step bound (${maxSteps})`),
  );
}
