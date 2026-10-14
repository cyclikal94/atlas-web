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
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mergeFacts } from "./outcome.mjs";

export const stackKey = (browser, index) => `${browser}-${index}`;
export const stacksDir = (runDir) => join(runDir, "stacks");
export const stackFile = (runDir, browser, index) =>
  join(stacksDir(runDir), `${stackKey(browser, index)}.json`);

/** The phases of a stack's record, in order. A record is complete (`settled`) only after its clean-up. */
export const PHASES = ["started", "launched", "judged", "settled"];

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

/** One stack's committed record, or null when there is none; `{ unreadable }` when a file exists but cannot be read. */
export function readStackRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { unreadable: String(error?.message ?? error) };
  }
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
    else if (record?.key) records.set(record.key, record);
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
