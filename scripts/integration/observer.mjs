// What the reaper observed, returned to the runner (WEB-08d review r15 H4j, revision 16).
//
// The reaper reads evidence of its own while the run goes on: when a stack's end is journalled it reads that stack's committed record
// (reaper.mjs `committedSettled`), and it parses every journal line. Before revision 16 a failure it observed there (a record it could
// not read, a damaged line) reached a verdict only on a take-over: on a normal release the runner had already published its summary,
// ignored how the reaper ended, and exited 0, so the shared validation driver scheduled its next step.
//
// The return channel is a durable receipt, `<run dir>/observer.json`, published atomically by the reaper and read by the runner:
//
//   { schema: 1, invocation, barrier: n, phase: "barrier" | "released", errors: [...], acknowledged, damaged, at }
//
// The runner journals `{ type: "barrier", id: n, invocation }` after each stack's end and once more before its terminal summary. The
// reaper handles journal lines in order, so when it reaches barrier n it has handled every line before it (each stack-end's read
// included); it then publishes the receipt for n with EVERY failure it has observed so far (cumulative: a later receipt never has
// fewer). On the release it publishes the terminal receipt (`released`) before it exits, and exits 1 when that holds any failure.
// The runner joins the errors through its run-level failure latch and stops before it launches anything else; a receipt that is
// missing past its bound, unreadable, of another invocation or malformed is itself a failure (never a pass). A receipt older than the
// barrier waited for is not yet the answer. A recovery (reaper.mjs `completeSummary`) reads the same file, so what a runner that died
// after reading it had not yet published is still found; a summary that says it covered barrier n beside a missing or older receipt
// is an evidence failure, while a run from before revision 16 simply has none.
import { join } from "node:path";
import { readEvidence, SHAPES } from "./evidence-inputs.mjs";

export const OBSERVER_FILE = "observer.json";

/** The receipt's text (the reaper's). */
export function receiptText({
  invocation,
  barrier,
  phase,
  errors,
  acknowledged = 0,
  damaged = 0,
}) {
  return `${JSON.stringify(
    {
      schema: 1,
      invocation,
      barrier,
      phase,
      errors,
      acknowledged,
      damaged,
      at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
}

/**
 * Has the receipt in `runDir` answered `barrier` of `invocation` (with `phase` "released": the terminal receipt)?
 *   { state: "covered", receipt }   it has: `receipt.errors` is everything the reaper observed up to it
 *   { state: "pending", why }       not yet (none, an older barrier, not yet released)
 *   { state: "failed", error }      it cannot answer: unreadable, malformed, or of another invocation
 */
export function readReceipt(
  runDir,
  { invocation, barrier, phase = "barrier" },
) {
  const input = readEvidence(join(runDir, OBSERVER_FILE), {
    what: "the reaper's observer.json",
    shape: SHAPES.observer,
  });
  if (input.state === "absent")
    return { state: "pending", why: "no receipt yet" };
  if (input.state === "unreadable")
    return { state: "failed", error: input.error };
  const receipt = input.value;
  if (receipt.invocation !== invocation)
    return {
      state: "failed",
      error: `the reaper's observer.json names invocation ${receipt.invocation}, not ${invocation}`,
    };
  if (receipt.barrier < barrier)
    return {
      state: "pending",
      why: `the receipt answers barrier ${receipt.barrier}, not yet ${barrier}`,
    };
  if (phase === "released" && receipt.phase !== "released")
    return { state: "pending", why: "the receipt is not the terminal one yet" };
  return { state: "covered", receipt };
}

/**
 * Wait, at most `ms`, for the receipt of `barrier` (`readReceipt`). `ended` settles when the reaper has ended: one more read, and then
 * no answer is a failure at once. Never a pass by timeout: { state: "covered", receipt } | { state: "failed", error }.
 */
export async function awaitReceipt(
  runDir,
  { invocation, barrier, phase = "barrier", ms, ended = null, pollMs = 20 },
) {
  let gone = false;
  ended?.then(
    () => {
      gone = true;
    },
    () => {
      gone = true;
    },
  );
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    const seen = gone;
    last = readReceipt(runDir, { invocation, barrier, phase });
    if (last.state !== "pending") return last;
    if (seen)
      return {
        state: "failed",
        error: `the reaper ended without answering barrier ${barrier} (${last.why})`,
      };
    if (Date.now() >= deadline)
      return {
        state: "failed",
        error: `the reaper did not answer barrier ${barrier} within ${ms} ms (${last.why})`,
      };
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
}
