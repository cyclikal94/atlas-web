// The recoveries of one run, in one order, and what every earlier recovery established (WEB-08d review r12 H4g, revision 13).
//
// Revision 12's reaper read the runner's files before it replaced `summary.json` and `reaper.json`, but not the `reaper.json` an earlier
// recovery of the same run had written, and it published only its own evidence failures there. A failure that only an earlier recovery
// had recorded (its summary republication had failed, so `reaper.json` was the sole witness) was erased by the next recovery, which then
// published a pass and exited 0. Three rules close that:
//
// 1. One order. Each recovery takes the next attempt number with an exclusive claim, `<run dir>/recoveries/<n>.claim` (written aside and
//    linked, so a claim is complete whenever it is visible; claims are never moved, replaced or removed). Before it reads anything it
//    waits until every earlier attempt has ENDED: its claimant (pid and start time) is no longer running (revision 14: a record alone
//    is not that). A claimant that is running, or whose state cannot be known (the process table cannot be read, the claim cannot be
//    read or names another attempt), is never overtaken: when the wait is over the recovery refuses to replace any output
//    (`awaitEarlier`). Two recoveries of one run therefore
//    publish one after the other, and the later one reads everything the earlier one wrote. This needs no kernel lock, so it is the same
//    on every host the reaper runs on.
// 2. Every output that can be the only witness of a failure is read. The previous `reaper.json` and every attempt record are read as
//    absent, present or unreadable (evidence-inputs.mjs); only "not found" is absence, and an unreadable one is an evidence failure of
//    the reading recovery and leaves the earlier clean-up unverified. An earlier attempt that ended without its record is a failure too:
//    what it found is unknown. Their facts are joined into one history (`joinHistory`): every evidence failure, whether any recovery's
//    clean-up was not verified, the run-level failures and an established failure outcome. A join never loses a fact; joining the same
//    record twice changes nothing.
// 3. Nothing is erased. Each attempt finally writes `<run dir>/recoveries/<n>.json` exclusively (also a refused one), which no later
//    attempt replaces, and the previous `reaper.json` is kept beside its successor as `<n>.previous-reaper.json` (a hard link: its bytes
//    whatever they are, readable or not) before it is replaced.
//
// Error lists keep the order in which they were first seen; as sets, joins are commutative, associative and idempotent.
//
// Review r13 H4h (revision 14): revision 13 took an earlier attempt's record pathname, readable or not, as proof that the attempt had
// ended, without asking whether its claimant still ran. A directory (EISDIR) or torn file at `recoveries/<n>.json` while attempt n was
// alive and holding a clean draft let the next attempt publish failed outputs, after which attempt n replaced them with its older
// pass. Now an attempt has ended only when its readable claim (naming that attempt) belongs to a claimant known to be gone: whether a
// record exists, or what it says, never admits a successor. Only then is the record read, because only then is it what that attempt
// finally wrote: absent is "ended without its record" (unknown), unreadable is an evidence failure of the reading recovery
// (readHistory), present is history. Every claim that could not be read while waiting is an evidence failure as well, even when a
// later poll reads it.
import { execFileSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEvidence, SHAPES } from "./evidence-inputs.mjs";
import { processTable } from "./ownership.mjs";
import { publishExclusively } from "./stack-records.mjs";

export const recoveriesDir = (runDir) => join(runDir, "recoveries");
export const claimFile = (runDir, n) =>
  join(recoveriesDir(runDir), `${n}.claim`);
export const attemptFile = (runDir, n) =>
  join(recoveriesDir(runDir), `${n}.json`);
export const previousFile = (runDir, n) =>
  join(recoveriesDir(runDir), `${n}.previous-reaper.json`);

/** Established failure outcomes, the stronger first: a history keeps the strongest it has seen. */
const ESTABLISHED = ["plan_error", "failed"];
const unique = (xs) => [...new Set(xs)];

/** What no recovery has established. */
export const EMPTY = Object.freeze({
  errors: [],
  cleanupNotVerified: false,
  runErrors: [],
  outcome: null,
  attempts: [],
});

const entryKey = (e) => `${e.attempt ?? ""}|${e.at ?? ""}|${e.reason ?? ""}`;
const order = (a, b) =>
  (a.attempt ?? 0) - (b.attempt ?? 0) ||
  String(a.at ?? "").localeCompare(String(b.at ?? ""));
/** Two descriptions of the same attempt (its first and its corrected reaper.json): every failure of either, verified only if both say so. */
function mergeEntry(a, b) {
  return {
    ...a,
    ...b,
    ok:
      a.ok === true && b.ok === true
        ? true
        : a.ok === false || b.ok === false
          ? false
          : null,
    evidence_errors: unique([
      ...(a.evidence_errors ?? []),
      ...(b.evidence_errors ?? []),
    ]),
    ...(a.unknown || b.unknown ? { unknown: true } : {}),
    ...(a.deadline_reached || b.deadline_reached
      ? { deadline_reached: true }
      : {}),
  };
}

/** The join of two histories: nothing either established is lost. */
export function joinHistory(a, b) {
  const attempts = new Map();
  for (const e of [...a.attempts, ...b.attempts]) {
    const key = entryKey(e);
    const was = attempts.get(key);
    attempts.set(key, was ? mergeEntry(was, e) : e);
  }
  return {
    errors: unique([...a.errors, ...b.errors]),
    cleanupNotVerified: a.cleanupNotVerified || b.cleanupNotVerified,
    runErrors: unique([...a.runErrors, ...b.runErrors]),
    outcome:
      ESTABLISHED.find((o) => o === a.outcome || o === b.outcome) ?? null,
    attempts: [...attempts.values()].sort(order),
  };
}

/** One recovery's description of itself (a line of `recovery_history.attempts`). */
export function entryOf(record) {
  return {
    attempt: Number.isInteger(record.attempt) ? record.attempt : null,
    at: record.at ?? null,
    reason: record.reason ?? null,
    ok: typeof record.ok === "boolean" ? record.ok : null,
    ...(record.deadline_reached === true ? { deadline_reached: true } : {}),
    ...(record.refused ? { refused: record.refused } : {}),
    evidence_errors: record.evidence_errors ?? [],
  };
}

/**
 * What a recovery record (a `reaper.json`, or an attempt record) establishes: its own evidence failures and clean-up, the history it
 * carried, the run-level failures and outcome it published. A record from before revision 13 has no history fields; it still says
 * what it found itself. A clean-up is verified only when the record says `ok: true` (a deadline leaves it unsaid).
 */
export function historyOf(record) {
  const carried = record.recovery_history ?? {};
  const before = {
    errors: carried.evidence_errors ?? [],
    cleanupNotVerified:
      carried.cleanup_not_verified === true ||
      (carried.attempts ?? []).some((e) => e.ok !== true || e.unknown),
    runErrors: [],
    outcome: null,
    attempts: carried.attempts ?? [],
  };
  const own = {
    errors: record.evidence_errors ?? [],
    cleanupNotVerified: record.ok !== true,
    runErrors: record.run_evidence_errors ?? [],
    outcome: ESTABLISHED.includes(record.run_outcome)
      ? record.run_outcome
      : null,
    attempts: [entryOf(record)],
  };
  return joinHistory(before, own);
}

/** An earlier attempt that ended (its claimant is gone) without writing its record: what it found and did is unknown. */
export function unknownAttempt(attempt, claim) {
  return {
    errors: [
      `recovery attempt ${attempt} ended without its record${claim ? ` (pid ${claim.pid})` : ""}: what it found and did is unknown`,
    ],
    cleanupNotVerified: true,
    runErrors: [],
    outcome: null,
    attempts: [
      {
        attempt,
        at: claim?.at ?? null,
        reason: null,
        ok: null,
        unknown: true,
        evidence_errors: [],
      },
    ],
  };
}

/** The history as `reaper.json` carries it. */
export const serialise = (h) => ({
  evidence_errors: h.errors,
  cleanup_not_verified: h.cleanupNotVerified,
  attempts: h.attempts,
});

/** The start time of `pid` as `ps` gives it (C locale, as ownership.mjs's process table), or null when it cannot be read. */
export function startedOf(pid) {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Is the process `pid` (started at `started`, when known) still running? true, false, or null when the process table cannot be read. */
export function running(pid, started) {
  let rows;
  try {
    rows = processTable();
  } catch {
    return null;
  }
  return rows.some(
    (r) =>
      r.pid === pid && !r.zombie && (started === null || r.started === started),
  );
}

/** Take the next attempt number of the run: an exclusive, complete claim. Throws when no claim can be written. */
export function claimAttempt(runDir, identity) {
  mkdirSync(recoveriesDir(runDir), { recursive: true });
  for (let n = 1; n <= 100_000; n += 1) {
    try {
      publishExclusively(
        claimFile(runDir, n),
        `${JSON.stringify({ attempt: n, ...identity })}\n`,
      );
      return n;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("no recovery attempt number is left");
}

/**
 * Wait until every attempt before `attempt` has ended: its claimant is known to be gone (revision 14: a record pathname, readable or
 * not, is never taken as that). Returns { ready: true, ended, errors } (`ended`: the attempts whose claimant is gone without a record)
 * or, once `waitMs` has passed, { ready: false, waiting: { attempt, why }, errors }. `errors` are the claims that could not be read
 * while waiting, each once (this recovery's evidence failures, also when a later poll could read it). `sleep(ms)` blocks;
 * `live(pid, started)` answers true, false or null (unknown, never taken as "gone").
 */
export function awaitEarlier(
  runDir,
  attempt,
  { waitMs, pollMs = 100, sleep, live = running },
) {
  const deadline = Date.now() + waitMs;
  const errors = [];
  const saw = (error) => {
    if (!errors.includes(error)) errors.push(error);
  };
  for (;;) {
    const ended = [];
    let waiting = null;
    for (let k = 1; k < attempt && waiting === null; k += 1) {
      const claim = readEvidence(claimFile(runDir, k), {
        what: `recovery attempt ${k}'s claim`,
        shape: SHAPES.claim,
      });
      if (claim.state !== "present") {
        if (claim.state === "unreadable") saw(claim.error);
        waiting = {
          attempt: k,
          why:
            claim.state === "absent"
              ? "its claim is missing, so who holds it is unknown"
              : claim.error,
        };
        break;
      }
      if (claim.value.attempt !== k) {
        const error = `recovery attempt ${k}'s claim names attempt ${JSON.stringify(claim.value.attempt ?? null)}, so who holds it is unknown`;
        saw(error);
        waiting = { attempt: k, why: error };
        break;
      }
      const state = live(claim.value.pid, claim.value.started ?? null);
      if (state !== false) {
        waiting = {
          attempt: k,
          why:
            state === null
              ? `whether its claimant (pid ${claim.value.pid}) is running cannot be known`
              : `its claimant (pid ${claim.value.pid}) is running`,
        };
        break;
      }
      // Its claimant is gone, so nothing more can be added to its record: only now is the record what it finally wrote. Absent: it
      // ended without one (unknown). Present or unreadable: readHistory reads it (an unreadable record is a failure, never clean).
      const record = readEvidence(attemptFile(runDir, k), {
        what: `recovery attempt ${k}'s record`,
        shape: SHAPES.recovery,
      });
      if (record.state === "absent")
        ended.push({ attempt: k, claim: claim.value });
    }
    if (waiting === null) return { ready: true, ended, errors };
    if (Date.now() >= deadline) return { ready: false, waiting, errors };
    sleep(pollMs);
  }
}

/** The attempt numbers that have a record (or a name like one), from the listing; null when it cannot be listed. */
function recordedAttempts(runDir) {
  try {
    return readdirSync(recoveriesDir(runDir))
      .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    return null;
  }
}

/**
 * Everything earlier recoveries of the run established, for attempt `attempt` (null: it holds no attempt number), with `ended` from
 * awaitEarlier. Returns { history, errors }: `errors` are this recovery's own evidence failures (what it could not read).
 */
export function readHistory(runDir, attempt, ended = []) {
  const errors = [];
  let history = EMPTY;
  const take = (input) => {
    if (input.state === "present")
      history = joinHistory(history, historyOf(input.value));
    else if (input.state === "unreadable") {
      errors.push(input.error);
      history = joinHistory(history, { ...EMPTY, cleanupNotVerified: true });
    }
  };
  take(
    readEvidence(join(runDir, "reaper.json"), {
      what: "the previous recovery's reaper.json",
      shape: SHAPES.recovery,
    }),
  );
  const listed = recordedAttempts(runDir);
  if (listed === null)
    errors.push(
      `the run's recovery records (${recoveriesDir(runDir)}) could not be listed`,
    );
  const numbers = new Set(listed ?? []);
  for (let k = 1; k < (attempt ?? 1); k += 1) numbers.add(k);
  numbers.delete(attempt);
  for (const k of [...numbers].sort((a, b) => a - b)) {
    const input = readEvidence(attemptFile(runDir, k), {
      what: `recovery attempt ${k}'s record`,
      shape: SHAPES.recovery,
    });
    // Review r13 H4h (revision 14): a record naming another attempt says nothing certain about this one: unusable, never clean.
    take(
      input.state === "present" && input.value.attempt !== k
        ? {
            state: "unreadable",
            error: `recovery attempt ${k}'s record is not valid evidence: it names attempt ${JSON.stringify(input.value.attempt ?? null)}`,
          }
        : input,
    );
  }
  for (const { attempt: k, claim } of ended)
    history = joinHistory(history, unknownAttempt(k, claim));
  return { history, errors };
}

/** Keep the previous `reaper.json` (any regular file, readable or not) beside attempt `attempt` before it is replaced. Throws on failure. */
export function keepPrevious(runDir, attempt) {
  const path = join(runDir, "reaper.json");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  // Anything else (a directory) cannot be replaced by a publication either: it stays where it is.
  if (!stat.isFile()) return false;
  linkSync(path, previousFile(runDir, attempt));
  return true;
}

/** Write attempt `attempt`'s record, exclusively: no attempt's record is ever replaced. */
export function recordAttempt(runDir, attempt, text) {
  publishExclusively(attemptFile(runDir, attempt), text);
}
