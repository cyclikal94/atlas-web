// WEB-09c (R23-PAIR): the EXPLICIT case matrix of the development-pair journey (tests/pair/pair.development.spec.ts) and the rules that
// account for every case. The expected cases are written here, never derived from the listing they are checked against (R22-INV): a case
// added to the spec without a row here, a row whose case is missing, a duplicate title, an empty listing, a missing result, an unexpected
// skip or a failure all stop the verdict short of a complete pass.
//
// `backends` says where a case is EXECUTABLE: `development` is the approved unreleased pair (pair-selection.mjs); `released` is the
// released-backend CONTROL (the version in contract-pin.json, fetched and verified by the unchanged fetch-backend.mjs), which has no
// `max_changes` and so runs the whole-revision cases only. A case not executable on the selected backend must be skipped BY DESIGN, with the
// reason `not applicable to the <backend> backend`; any other skip is a failure.
//
// `UNSUPPORTED` lists what the bounded recipe cannot produce against the exact approved binary. These are reported with their owner as
// UNRUN in every summary. They are never executed, never skipped as a pass and never substituted by a proxy-injected answer (PAIR-X1 is a
// separate, labelled client-only case).
import { reportCases, reportShapeProblems } from "./stacks.mjs";

export const SPEC = "pair.development.spec.ts";
export const BACKENDS = ["development", "released", "diagnostic"];
export const BROWSERS = ["chromium", "firefox", "webkit"];
const BOTH = ["development", "released"];
const DEV = ["development"];
/** Revision 26 (R26-DIAG): the approved diagnostic executable (pair-selection.mjs DIAGNOSTIC_SELECTION), one fresh attempt per case. */
const DIAG = ["diagnostic"];

/**
 * Every executable case. `workload`: W-real (one person + 199 dense checklist fields, revealed by ONE public grant: 200 changes) or
 * W-synthetic (LABELLED SYNTHETIC: 799 fields + their person, one notice batch inserted directly into the disposable database: 800 changes).
 * Neither is the frontend's W1 (800 synthetic checklist changes) or R201 (one person + 200 fields). `m`: the page's starting max_changes
 * (null: the page is told nothing, as production). `injected`: null for unaltered server answers; otherwise who altered what.
 * `driven` (revision 25): how the interval's record must be driven, checked by the runner against the record (never the producer's claim):
 * `full` (every answer through the feed's completion held by the common driver), `prefix` (held until an explicit hand-off: a 410 recovery
 * or a replaced session), `none` (the fenced recovery runs unheld), `rearmed_prefix` (revision 27: the opening's hold is released for the
 * fence, a NEW hold is armed before the grant and before the recovery caller can ask for the target, and the drive holds that caller's
 * answers until the hand-off). `observations`: the named observations the record must bind. `caller`: whose requests the case drives
 * (`ordinary`: the sync engine; `recovery`: the fenced recovery job), checked against the record. `local_work` (revision 27): the case
 * admits named local work and declares it; every other case keeps the zero-draft premise.
 */
/**
 * Revision 27 (R27-DIAG.b, design assessment C2): what every real-410 case must observe of its recovery, at held snapshot pages. Revision 28
 * (R28-DIAG.b, C5): `recovery_activated` (revision 27's `recovery_exposed`, renamed: the atomic DATA activation) and `recovery_rendered`
 * (both pages then SHOW the recovered cache) are separate observations.
 */
export const RECOVERY_OBSERVATIONS = Object.freeze([
  "reader_old_at_refusal",
  "recovery_invalidated",
  "recovery_staged_hidden",
  "recovery_final_held",
  "recovery_activated",
  "recovery_rendered",
]);
export const CASES = Object.freeze([
  {
    id: "PAIR-P0",
    backends: [...BOTH, ...DIAG],
    workload: null,
    m: null,
    caller: "none",
    driven: null,
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-W1",
    backends: BOTH,
    workload: "W-real",
    m: null,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-W2",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-W3",
    backends: DEV,
    workload: "W-real",
    m: 100,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-S1",
    backends: DEV,
    workload: "W-synthetic",
    m: 100,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "synthetic notice row inserted into the disposable database",
  },
  {
    id: "PAIR-S2",
    backends: DEV,
    workload: "W-synthetic",
    m: null,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "synthetic notice row inserted into the disposable database",
  },
  {
    id: "PAIR-R1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-R2",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "PROXY: connection dropped after the backend answered",
  },
  {
    id: "PAIR-T1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [
      "follower_old_at_last_piece",
      "follower_new_after_activation",
    ],
    injected: null,
  },
  {
    id: "PAIR-T2",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-A1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-B1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: [],
    injected: "TAP: next_cursor tampered (the server's 410 is real)",
  },
  {
    id: "PAIR-B2",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: [],
    injected:
      "TAP: next_cursor replaced by another device's real continuation (the server's 410 is real)",
  },
  {
    id: "PAIR-B3",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: [],
    injected:
      "TAP: next_cursor replaced by another account's real continuation (the server's 410 is real)",
  },
  {
    id: "PAIR-G1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "TAP: segment index +1 (a gap)",
  },
  {
    id: "PAIR-G2",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "TAP: the previous piece answered again at the current cursor",
  },
  {
    id: "PAIR-G3",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "full",
    observations: [],
    injected: "TAP: batch revision +1",
  },
  {
    id: "PAIR-X1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: [],
    injected:
      "TAP: 410 resync_required answered in place of a real piece (client-only; NOT server expiry or pruning)",
  },
  // Revision 26 (R26-DIAG): REAL expiry and REAL pruning, executable only on the diagnostic selection (its private stdin controls; no
  // synthetic SQL writer, no tap-injected answer, no host-clock change). Each runs in its own fresh fixture attempt (the clock is
  // irreversible and the first clock step or collection ends setup). On the development and released backends they are designed skips:
  // neither executable has a supported control that reaches expiry or pruning (the capability limit recorded before revision 26).
  {
    id: "PAIR-X0",
    backends: DIAG,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: RECOVERY_OBSERVATIONS,
    injected: null,
    diagnostic:
      "advance_clock (E−1, E, E+1) with the continuation queued at the request gate; no collection, no ageing",
  },
  {
    id: "PAIR-X2",
    backends: DIAG,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: RECOVERY_OBSERVATIONS,
    injected: null,
    diagnostic:
      "age_history of the target batch before any of it is requested, then collect at the sync start with the continuation queued; no clock step",
  },
  // Revision 27 (R27-DIAG.b; design assessment C3/C4): the finite caller and local-work variants. XR0/XR2 drive the FENCED RECOVERY
  // caller (RC1's real revocation, real 401 and password sign-in) into the same real expiry/pruning, so its refusal is W24's (server
  // restart: both stagings cleared, a new generation, a snapshot restart), never the ordinary W18. XL0 is X0 with one named admitted
  // command of the reader (production outbox, receipted before the clock steps) and a reload after E.
  {
    id: "PAIR-XR0",
    backends: DIAG,
    workload: "W-real",
    m: 4,
    caller: "recovery",
    driven: "rearmed_prefix",
    observations: RECOVERY_OBSERVATIONS,
    injected: null,
    diagnostic:
      "fence (revoke, real 401), re-armed hold, grant, sign-in; advance_clock (E−1, E, E+1) with the recovery catch-up's continuation queued at the gate",
  },
  {
    id: "PAIR-XR2",
    backends: DIAG,
    workload: "W-real",
    m: 4,
    caller: "recovery",
    driven: "rearmed_prefix",
    observations: RECOVERY_OBSERVATIONS,
    injected: null,
    diagnostic:
      "fence (revoke, real 401), re-armed hold, gate drained, grant, age_history of the target batch, sign-in; collect at the sync start with the recovery catch-up's continuation queued",
  },
  {
    id: "PAIR-XL0",
    backends: DIAG,
    workload: "W-real",
    m: 4,
    caller: "ordinary",
    driven: "prefix",
    observations: RECOVERY_OBSERVATIONS,
    injected: null,
    local_work: true,
    diagnostic:
      "X0's clock steps with one named admitted create_person of the reader (production outbox, receipted before the steps) and a reload after E",
  },
  {
    id: "PAIR-RC1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "recovery",
    driven: "none",
    observations: [],
    injected: null,
  },
  {
    id: "PAIR-L1",
    backends: DEV,
    workload: "W-real",
    m: 4,
    caller: "recovery",
    driven: "prefix",
    observations: [],
    injected: null,
  },
]);

/**
 * What this recipe does not execute, UNRUN with its owner, never a pass: `transferred`, a schedule outside this recipe, named with where it
 * belongs. (Before revision 26 PAIR-X0 and PAIR-X2 were listed here as `capability` limits of the normal executables; they are now cases of
 * the diagnostic selection, and remain designed skips, never passes, on the development and released backends.)
 */
export const UNSUPPORTED = Object.freeze([
  {
    id: "PAIR-B4",
    kind: "transferred",
    what: "a continuation of the browser's OWN device after that device is retired",
    reason:
      "retiring the browser's own device ends its session (the composed retirement lifecycle); the server's device binding itself is exercised by PAIR-B2",
    owner: "WEB-09d (composed lifecycle with the paired backend)",
  },
  {
    id: "PAIR-L2",
    kind: "transferred",
    what: "an ACCOUNT SWITCH or a confirmed Keep/Delete logout while a revision is staged, against the paired backend",
    reason:
      "the composed consent lifecycle is not scripted in this recipe; the same-account epoch replacement mid-revision is PAIR-L1, the cross-account server binding PAIR-B3, and the client rules stay covered by the fixture lifecycle and segmented specs (fixture evidence only)",
    owner: "WEB-09d (composed lifecycle with the paired backend)",
  },
]);

/**
 * The disposable accounts one stack creates with the backend's own `account` command: one writer, one reader per case (no case inherits
 * another's grants, sessions, devices or sign-in budget) and the foreign account PAIR-B3 takes a continuation from.
 */
export const accountNames = () => [
  "pair-writer",
  ...CASES.map((c) => `pair-${c.id.toLowerCase()}`),
  "pair-b3-foreign",
];
/** The accounts ONE diagnostic attempt creates (its `add_account` setup commands): the writer, the case's reader, X2's untouched control. */
export const diagnosticAccounts = (caseId) => [
  "pair-writer",
  `pair-${caseId.toLowerCase()}`,
  ...(caseId === "PAIR-X2" || caseId === "PAIR-XR2"
    ? [`pair-${caseId.slice(5).toLowerCase()}-control`]
    : []),
];
/** The diagnostic cases, in the order the runner gives each its own attempt. */
export const diagnosticCases = (cases = CASES) =>
  cases.filter((c) => c.backends.includes("diagnostic")).map((c) => c.id);

export const titleId = (title) =>
  /^(PAIR-[A-Z]+[0-9]+):/.exec(title)?.[1] ?? null;
export const applicable = (row, backend) => row.backends.includes(backend);
export const designedSkipReason = (backend) =>
  `not applicable to the ${backend} backend`;

/**
 * Discovery: the listing (Playwright's JSON `--list` report) holds every matrix case exactly once per selected browser project, nothing
 * else, and at least one case. Returns the problems (empty: the listing is exactly the matrix).
 */
export function discoveryProblems(report, { browsers, cases = CASES }) {
  const shape = reportShapeProblems(report);
  if (shape.length > 0) return shape.map((p) => `listing: ${p}`);
  const problems = [];
  const listed = reportCases(report);
  if (listed.length === 0) return ["the listing holds no case"];
  const seen = new Map();
  for (const entry of listed) {
    const project = entry.project;
    const browser = /^pair-(chromium|firefox|webkit)$/.exec(project)?.[1];
    if (!browser || !browsers.includes(browser)) {
      problems.push(`unexpected project ${project}`);
      continue;
    }
    if (entry.file !== SPEC)
      problems.push(`unexpected file ${entry.file} in ${project}`);
    const title = entry.key.split(" › ").at(-1);
    const id = titleId(title);
    if (!id || !cases.some((c) => c.id === id)) {
      problems.push(`unassigned case "${title}" in ${project}`);
      continue;
    }
    const key = `${browser} ${id}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const browser of browsers)
    for (const row of cases) {
      const n = seen.get(`${browser} ${row.id}`) ?? 0;
      if (n === 0) problems.push(`missing ${row.id} in pair-${browser}`);
      if (n > 1) problems.push(`duplicate ${row.id} in pair-${browser} (${n})`);
    }
  return problems;
}

/**
 * What ONE case's own test record proves (the maintained runner's rule, stacks.mjs `caseOutcome`): a pass is exactly one terminal `passed`
 * result at retry 0 under status `expected` / expectedStatus `passed`; a designed skip is the reporter's skip shape (status and
 * expectedStatus `skipped`, one `skipped` result) with the designed reason, for a case not executable on this backend. Returns
 * [outcome, reason].
 */
function caseOutcome(test, should, backend) {
  const results = Array.isArray(test.results) ? test.results : [];
  const shown = `status ${test.status}, expected ${test.expectedStatus}, results [${results.map((r) => `${r.status}@${r.retry}`).join(", ")}]`;
  if (results.some((r) => r.status === "interrupted"))
    return ["interrupted", shown];
  if (results.length === 0) return ["unrun", shown];
  if (results.length > 1 || results.some((r) => r.retry !== 0))
    return ["failed", `retried (no retry is allowed): ${shown}`];
  const [only] = results;
  if (
    test.status === "expected" &&
    test.expectedStatus === "passed" &&
    only.status === "passed"
  )
    return should
      ? ["passed", shown]
      : ["failed", `passed although not applicable: ${shown}`];
  if (
    test.status === "skipped" &&
    test.expectedStatus === "skipped" &&
    only.status === "skipped"
  ) {
    const reasons = [...(test.annotations ?? []), ...(only.annotations ?? [])]
      .filter((a) => a.type === "skip")
      .map((a) => a.description);
    if (!should && reasons.includes(designedSkipReason(backend)))
      return ["designed_skip", shown];
    return [
      "failed",
      `an undesigned skip (${reasons.join("; ") || "no reason"}): ${shown}`,
    ];
  }
  return ["failed", shown];
}

/**
 * Judges one browser's results. Every matrix case gets exactly one outcome: `passed`, `designed_skip` (not executable on this backend, with
 * the designed reason), `failed` (a failure, a time-out, a retry, an undesigned skip or a pass of a case that should have been skipped),
 * `interrupted`, or `unrun` (no result). `complete` only when every applicable case passed, every other one is a designed skip and nothing else
 * happened. The unsupported rows are always carried as `unrun`, whatever the verdict.
 */
export function judgeResults(
  report,
  {
    browser,
    backend,
    cases = CASES,
    unsupported = UNSUPPORTED,
    narrowed = false,
  },
) {
  const problems = [];
  const outcomes = {};
  const shape = reportShapeProblems(report);
  if (shape.length > 0) problems.push(...shape.map((p) => `report: ${p}`));
  const listed = shape.length > 0 ? [] : reportCases(report);
  const byId = new Map();
  for (const entry of listed) {
    if (entry.project !== `pair-${browser}`) continue;
    const id = titleId(entry.key.split(" › ").at(-1));
    if (!id) {
      problems.push(`unassigned result ${entry.key}`);
      continue;
    }
    if (byId.has(id)) problems.push(`duplicate result ${id}`);
    byId.set(id, entry.test);
  }
  for (const row of cases) {
    const test = byId.get(row.id);
    const should = applicable(row, backend);
    // A narrowed run (`--grep`) reports only the cases it selected: an absent one is `not_selected`, never a pass and never complete.
    const [outcome, why] = test
      ? caseOutcome(test, should, backend)
      : narrowed
        ? ["not_selected", "not selected by the narrowed run"]
        : ["unrun", "no result"];
    outcomes[row.id] = outcome;
    if (!["passed", "designed_skip", "not_selected"].includes(outcome))
      problems.push(
        `${row.id}: ${outcome}: ${why}${should ? "" : " (the case is not applicable here)"}`,
      );
  }
  for (const id of byId.keys())
    if (!cases.some((c) => c.id === id))
      problems.push(`result for a case outside the matrix: ${id}`);
  const counts = {
    passed: 0,
    designed_skip: 0,
    failed: 0,
    interrupted: 0,
    unrun: 0,
    not_selected: 0,
  };
  for (const outcome of Object.values(outcomes)) counts[outcome] += 1;
  const clean =
    problems.length === 0 &&
    counts.failed === 0 &&
    counts.interrupted === 0 &&
    counts.unrun === 0;
  return {
    // `complete`: the whole matrix, every case accounted for. `selected_ok`: every SELECTED case passed or was skipped by design (the
    // verdict of a narrowed run, which is never complete); at least one selected case must have PASSED (a skip proves nothing).
    complete: clean && counts.not_selected === 0,
    selected_ok: clean && counts.passed > 0,
    counts,
    outcomes,
    problems,
    unsupported: unsupported.map((u) => ({ ...u, outcome: "unrun" })),
  };
}
