// The run files a recovery reads, each with an explicit state (WEB-08d review r10 H4f, revision 11).
//
// Revision 10's reaper read the run's files through one helper that returned `null` both when a file did not exist and when it existed
// but could not be read or parsed (the failure only went into a list beside it). Its terminal shortcut then took that `null` for
// "absent": a finished, quiescent summary beside a `summary-error.json` that could not be read was kept as a pass, and a plan that could
// not be read became "nothing was planned". Here a read has three results, and only "not found" is absence:
//
//   { state: "absent" }                 the file does not exist (ENOENT)
//   { state: "present", value }         read, parsed, and of the shape the recovery relies on
//   { state: "unreadable", error }      anything else: a read error, a parse error, or a value of another shape (`null`, a list, a
//                                       field of the wrong type). `error` names the file and why; it is an evidence failure of the
//                                       run, never a smaller or an empty run.
//
// The shapes check only what a recovery decides with (which stacks, which errors, whether the runner finished); they are not a schema
// of the files.
import { readFileSync } from "node:fs";

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const listOf = (v, item) => Array.isArray(v) && v.every(item);
const isString = (v) => typeof v === "string";
/** The first problem of `checks` ([ok, problem] pairs), or null. */
const first = (checks) => checks.find(([ok]) => !ok)?.[1] ?? null;

/** What each run file must be for a recovery to rely on it: a function of the parsed value, returning the problem or null. */
export const SHAPES = {
  summary: (v) =>
    first([
      [isObject(v), "it is not a JSON object"],
      [
        v?.invocation === undefined || isObject(v.invocation),
        "`invocation` is not an object",
      ],
      [
        v?.terminal === undefined ||
          v.terminal === null ||
          isObject(v.terminal),
        "`terminal` is not an object",
      ],
      [
        v?.stacks === undefined || listOf(v.stacks, isObject),
        "`stacks` is not a list of records",
      ],
      [
        v?.evidence_errors === undefined || listOf(v.evidence_errors, isString),
        "`evidence_errors` is not a list of reasons",
      ],
    ]),
  summaryError: (v) =>
    first([
      [isObject(v), "it is not a JSON object"],
      [
        v?.stacks === undefined || listOf(v.stacks, isObject),
        "`stacks` is not a list of records",
      ],
      [
        v?.evidence_errors === undefined || listOf(v.evidence_errors, isString),
        "`evidence_errors` is not a list of reasons",
      ],
    ]),
  plan: (v) =>
    first([
      [isObject(v), "it is not a JSON object"],
      [listOf(v?.browsers, isString), "`browsers` is not a list of names"],
      [
        listOf(
          v?.stacks,
          (s) =>
            isObject(s) && (s.cases === undefined || Array.isArray(s.cases)),
        ),
        "`stacks` is not a list of planned stacks",
      ],
    ]),
  invocation: (v) => (isObject(v) ? null : "it is not a JSON object"),
  // Revision 13 (review r12 H4g): a recovery's record (`reaper.json`, `recoveries/<n>.json`; recovery-history.mjs). Every field is
  // optional (a record from before revision 13 has no history), but a field that is there must be of its type.
  recovery: (v) =>
    first([
      [isObject(v), "it is not a JSON object"],
      [
        v?.evidence_errors === undefined || listOf(v.evidence_errors, isString),
        "`evidence_errors` is not a list of reasons",
      ],
      [
        v?.ok === undefined || typeof v.ok === "boolean",
        "`ok` is not true or false",
      ],
      [
        v?.attempt === undefined ||
          v.attempt === null ||
          Number.isInteger(v.attempt),
        "`attempt` is not an attempt number",
      ],
      [
        v?.run_evidence_errors === undefined ||
          listOf(v.run_evidence_errors, isString),
        "`run_evidence_errors` is not a list of reasons",
      ],
      [
        v?.run_outcome === undefined ||
          v.run_outcome === null ||
          isString(v.run_outcome),
        "`run_outcome` is not an outcome",
      ],
      [
        v?.recovery_history === undefined ||
          (isObject(v.recovery_history) &&
            (v.recovery_history.evidence_errors === undefined ||
              listOf(v.recovery_history.evidence_errors, isString)) &&
            (v.recovery_history.cleanup_not_verified === undefined ||
              typeof v.recovery_history.cleanup_not_verified === "boolean") &&
            (v.recovery_history.attempts === undefined ||
              listOf(
                v.recovery_history.attempts,
                (e) =>
                  isObject(e) &&
                  (e.evidence_errors === undefined ||
                    listOf(e.evidence_errors, isString)),
              ))),
        "`recovery_history` is not a recovery history",
      ],
    ]),
  // Revision 13: a recovery attempt's claim (who holds the attempt number).
  claim: (v) =>
    first([
      [isObject(v), "it is not a JSON object"],
      [Number.isInteger(v?.pid) && v.pid > 0, "`pid` is not a process id"],
      [
        v?.started === undefined || v.started === null || isString(v.started),
        "`started` is not a start time",
      ],
    ]),
};

const reason = (error) => String(error?.message ?? error);

/** One run file, read as { state: "absent" | "present" | "unreadable", value?, error? } (`what` names it in the error). */
export function readEvidence(path, { what, shape = SHAPES.invocation }) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", path };
    return {
      state: "unreadable",
      path,
      error: `${what} could not be read: ${reason(error)}`,
    };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      state: "unreadable",
      path,
      error: `${what} could not be read: ${reason(error)}`,
    };
  }
  const problem = shape(value);
  if (problem !== null)
    return {
      state: "unreadable",
      path,
      error: `${what} is not valid evidence: ${problem}`,
    };
  return { state: "present", path, value };
}
