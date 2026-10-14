// The durable record of each stack of an integration run (WEB-08d review r8 H4d, revision 9).
//
// Revision 8 told the reaper "this stack has ended" (and so let it drop the stack's checkpoint) before the stack's result was written
// anywhere durable: a runner lost in between left the reaper nothing but a summary without that stack, and an established failure
// became `not_run`/`cancelled`. Now each stack's record is the authority, kept in a file of its own (<run dir>/stacks/<browser>-<index>.json)
// that is replaced ATOMICALLY (a sibling is written, flushed and renamed over it, so a reader sees a complete old or new version,
// never a part) every time the stack establishes something: started, launched (with Playwright's start time and report path),
// judged, budget and evidence facts, settled (after its clean-up). Each version has a sequence number, and every version is merged
// with the one before it by the one fact merger (`mergeFacts`), so a fact once committed is never lost by a later version. The
// summary is a projection of these records; the reaper's journal only says which version was committed. Every writer (the stack's
// own end, the runner's finaliser, the reaper) uses this module.
//
// Review r9 H4e (revision 10): an OBSERVATION is different from a committed version. Every attempt to commit a stack's facts is an
// observation with an identity of its own (`obs`, the runner's ordinal of its attempts, increasing whether or not the write
// succeeds); `seq` only counts the successful replacements of the file. A write that fails is still an observation: its facts (and
// the evidence failure of the write itself) are kept as the stack's overlay, journalled with that ordinal, and merged into every
// later attempt, so a durable version with ordinal n covers every observation of its stack up to n. The order of two versions of a
// stack, and whether a durable version covers what was observed, are decided here and nowhere else (`observation`, `joinVersions`,
// `covers`): revision 9's runner ordered a failed write after every committed one while its reaper read the same `seq: null` as 0, kept
// an older sequence beside newer facts and deleted a checkpoint on an older acknowledgement, so an older settled record hid a newer
// failure.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mergeFacts, settleStack } from "./outcome.mjs";

export const stackKey = (browser, index) => `${browser}-${index}`;
export const stacksDir = (runDir) => join(runDir, "stacks");
export const stackFile = (runDir, browser, index) =>
  join(stacksDir(runDir), `${stackKey(browser, index)}.json`);

/** The phases of a stack's record, in order. A record is complete (`settled`) only after its clean-up. */
export const PHASES = ["started", "launched", "judged", "settled"];

/** The observation ordinal of a version of a stack's record (-1 for one that has none: a `not_run` entry, an older runner's). */
export const observation = (record) =>
  Number.isInteger(record?.obs) ? record.obs : -1;

/**
 * Two versions of one stack's record, joined: the newer observation's fields win, every failure fact and earlier clean-up of either is
 * kept (`mergeFacts`). Equal ordinals (two readings of the same version, or versions without one) take `b` as the later.
 */
export function joinVersions(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return observation(b) >= observation(a) ? mergeFacts(a, b) : mergeFacts(b, a);
}

/**
 * Does the durable version `durable` cover the observation `observed` (everything that version of the stack had seen)? Only an
 * explicit ordinal proves it: a version without one covers nothing but "nothing observed" (null).
 */
export function covers(durable, observed) {
  if (!observed) return true;
  if (!durable || durable.unreadable) return false;
  const seen = observation(observed);
  return seen >= 0 && observation(durable) >= seen;
}

/**
 * Review r9 H4e (revision 10): one observation of a stack, committed. `known` is the stack's overlay (everything observed so far,
 * committed or not); `record` what the caller establishes now (possibly built on an older local copy). The overlay and `record` are
 * merged (the new observation's fields win, no fact of either is lost) and committed with ordinal `obs`. A write that fails returns the
 * same merged facts as the new overlay, with the write's own evidence failure added (`describe(error)`), `seq: null`, the last
 * committed sequence beside it and the phase never moved back. Returns { committed, record, reason }.
 */
export function commitObservation({
  store,
  known,
  record,
  phase,
  obs,
  describe,
}) {
  const input = mergeFacts(known ?? null, { ...record, obs });
  try {
    return {
      committed: true,
      record: store.commit(input, phase),
      reason: null,
    };
  } catch (error) {
    const reason = describe(error);
    const at = Math.max(
      PHASES.indexOf(phase),
      PHASES.indexOf(known?.phase ?? "started"),
    );
    return {
      committed: false,
      reason,
      record: {
        ...settleStack(input, { evidenceErrors: [reason] }),
        phase: PHASES[at],
        seq: null,
        committed_seq:
          typeof known?.seq === "number"
            ? known.seq
            : (known?.committed_seq ?? null),
        obs,
      },
    };
  }
}

/**
 * Write `text` to `path` so a reader sees the old file or the new one, never a part: a fresh sibling is written, flushed and renamed
 * over it. A failure leaves the old file as it was (and no sibling) and throws. (A crash of this process cannot tear it; a loss of
 * the host's power is not claimed: the directory itself is not flushed.)
 */
export function publishAtomically(path, text, { fail = null } = {}) {
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    const out = openSync(temporary, "r");
    try {
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    fail?.();
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Write `text` to `path` as `publishAtomically` does, but only when `path` does not exist yet (EEXIST otherwise): the complete sibling is
 * LINKED to its name, which fails when the name is taken, then the sibling is removed. Review r10 H4f (revision 11): the run's
 * write-once files (invocation.json, plan.json) a reader takes as evidence are never seen in part.
 */
export function publishExclusively(path, text) {
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: "wx" });
    const out = openSync(temporary, "r");
    try {
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * One stack's committed record, or null when there is none; `{ unreadable }` when a file exists but cannot be read. Review r10 H4f
 * (revision 11): or when what it holds is not a record (`null`, a list, a value without its key): that is not "no record".
 */
export function readStackRecord(path) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { unreadable: String(error?.message ?? error) };
  }
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record.key !== "string"
  )
    return { unreadable: "it is not a stack record" };
  return record;
}

/** Every committed stack record of the run: { records: Map(key -> record), errors: [unreadable record: why] }. */
export function readStackRecords(runDir) {
  const records = new Map();
  const errors = [];
  let names = [];
  try {
    names = readdirSync(stacksDir(runDir));
  } catch (error) {
    if (error?.code !== "ENOENT")
      errors.push(`stack records: ${String(error?.message ?? error)}`);
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // a sibling still being written is not a record
    const record = readStackRecord(join(stacksDir(runDir), name));
    if (record?.unreadable) errors.push(`${name}: ${record.unreadable}`);
    else if (record) records.set(record.key, record);
  }
  return { records, errors };
}

/**
 * The stack records of one run, as one writer sees them. `commit(record, phase)` merges `record` with the latest version committed
 * (by this writer or, read from the file, by an earlier one), gives it the next sequence number and publishes it; it throws when it
 * cannot be written, and nothing is then claimed as committed. `fail(phase)` is a qualification seam (faults.mjs).
 */
export function createStackStore(runDir, { fail = () => undefined } = {}) {
  mkdirSync(stacksDir(runDir), { recursive: true });
  const latest = new Map();
  let version = 0;
  const current = (browser, index) => {
    const key = stackKey(browser, index);
    if (!latest.has(key)) {
      const found = readStackRecord(stackFile(runDir, browser, index));
      if (found?.unreadable)
        throw new Error(
          `the record of ${key} cannot be read (${found.unreadable}); nothing is committed over it`,
        );
      if (found) latest.set(key, found);
    }
    return latest.get(key) ?? null;
  };
  return {
    get version() {
      return version;
    },
    latest: current,
    commit(record, phase) {
      const { browser, index } = record;
      const before = current(browser, index);
      // What the stack is (its name, report path, launch time) stays with every later version.
      const carried = {};
      for (const field of ["stack", "report", "launched_at", "started_at"])
        if (before?.[field] !== undefined) carried[field] = before[field];
      const merged = mergeFacts(before, { ...carried, ...record });
      const at = Math.max(
        PHASES.indexOf(phase),
        PHASES.indexOf(before?.phase ?? "started"),
      );
      const out = {
        ...merged,
        key: stackKey(browser, index),
        phase: PHASES[at],
        seq: (before?.seq ?? 0) + 1,
        committed_at: new Date().toISOString(),
        // A committed version is not an overlay: the sequence an earlier failed write kept beside its facts does not describe it.
        committed_seq: undefined,
      };
      publishAtomically(
        stackFile(runDir, browser, index),
        `${JSON.stringify(out, null, 2)}\n`,
        { fail: () => fail(phase) },
      );
      latest.set(out.key, out);
      version += 1;
      return out;
    },
  };
}
