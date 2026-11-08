// WEB-13b revision 9's mutants (review 9 R7c `incomplete_fix`, family task-sync-navigation-draft-loss; design assessment C1, C2, C6 and its
// mutation list; C2 assigned by MORNING-TASK-APPROVALS-20261028), in the form and under the rules of `data-catalogue.mjs`, which spreads them
// into its `UNIT` list after `catalogue-web13b-r8.mjs`. Each restores ONE part of the defect the revision corrected or removes one boundary
// of the correction; `expect` names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): `importContinuity` returning a basis while the session waits is equivalent (a
// waiting session's press stores nothing before the token is read, and its Import is disabled); the park's microtask setting `parked`
// at once (synchronously) is MU-5170's defect seen from the other side, so one is kept; the delivery's `held !== which` check is the
// session's own end (a released session's editor is ended, checked beside it), so removing one alone is equivalent.
import { sub } from "./data-catalogue.mjs";

const KEPT = "src/features/calendars/import-kept.ts";
const DIALOG = "src/features/calendars/ImportDialog.tsx";
const MODEL = "src/data/model/outbox.ts";
const PLANS = "src/data/plans/outbox.ts";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";
const T_RET = "tests/features/calendars/import-retention.test.tsx";
const T_CONT = "tests/data/outbox-continuity.test.ts";

export const UNIT_13B_R9 = [
  // ---- R7c: only a read made for the showing verifies it -------------------------------------------------------------------------
  {
    id: "MU-5161",
    title:
      "WEB-13b R7c (revision 9): a publication that agrees with the basis verifies a waiting session (the old shortcut restored)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /an old publication that agrees does not make it ready|old agreeing publication and its read held/,
    patch: (t) =>
      sub(
        t,
        "  if (which.pending && which.shown) verify(which);\n}\n",
        "  if (which.pending && all.some((r) => r.invalidations === basis)) {\n    which.pending = false;\n    changed();\n    return;\n  }\n  if (which.pending && which.shown) verify(which);\n}\n",
      ),
  },
  {
    id: "MU-5162",
    title:
      "WEB-13b R7c (revision 9): with no basis, any witness the showing's read finds verifies it (a later history adopted)",
    file: KEPT,
    tests: [T_KEPT],
    expect:
      /another value keeps it waiting|is no basis: another witness keeps it waiting/,
    // Re-anchored in revision 10 (R7d): the same check, after the read asked without a basis is told to ask again.
    patch: (t) =>
      sub(
        t,
        "    if (basis === null && now.invalidations !== 0) return;\n",
        "",
      ),
  },
  {
    id: "MU-5163",
    title:
      "WEB-13b R7c (revision 9): a read whose service ended before it landed verifies the showing",
    file: KEPT,
    tests: [T_KEPT],
    expect: /a read whose service ended before it landed verifies nothing/,
    patch: (t) =>
      sub(
        t,
        "      !which.shown ||\n      !serves(which, service) ||\n",
        "      !which.shown ||\n",
      ),
  },
  {
    id: "MU-5164",
    title:
      "WEB-13b R7c (revision 9): a read that failed is never asked again (the session waits for good)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /a later publication asks again, one read at a time/,
    patch: (t) =>
      sub(t, "    if (which.ticket === ticket) which.verifying = false;\n", ""),
  },
  {
    id: "MU-5165",
    title:
      "WEB-13b R7c (revision 9): the showing's read that finds the cache known invalid does not end it (its witness alone compared)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /read ends it when it says the cache is invalid|its durable streak/,
    patch: (t) =>
      sub(
        t,
        "    if (\n      now.invalidated ||\n      (basis !== null &&\n",
        "    if (\n      (basis !== null &&\n",
      ),
  },
  {
    id: "MU-5166",
    title:
      "WEB-13b R7c (revision 9): the showing's read accepts a witness below its basis (another history taken for the same)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /a witness BELOW its basis/,
    patch: (t) =>
      sub(
        t,
        "        now.invalidations !== basis)\n    ) {\n",
        "        now.invalidations > basis)\n    ) {\n",
      ),
  },
  {
    id: "MU-5167",
    title:
      "WEB-13b R7c (revision 9): the read delivered while the session is hidden again verifies it (its showing is over)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /agreeing verifies nothing; the next showing's read does/,
    patch: (t) =>
      sub(
        t,
        "      !which.pending ||\n      !which.shown ||\n",
        "      !which.pending ||\n",
      ),
  },
  {
    id: "MU-5168",
    title:
      "WEB-13b R7c (revision 9): its dialog remounted after it was really hidden shows it ready (no read for the showing)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /remounted after it was really hidden waits for its read/,
    patch: (t) =>
      sub(
        t,
        "  if (!which.parked) return;\n  resume(which, which.context);\n",
        "  return;\n",
      ),
  },
  {
    id: "MU-5169",
    title:
      "WEB-13b R7c (revision 9): Strict Mode's hide and show in one turn is a hiding (every dialog waits at its own mount)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /Strict Mode's hide and show in one turn is no hiding/,
    patch: (t) => sub(t, "  if (!which.parked) return;\n", ""),
  },
  {
    id: "MU-5170",
    title:
      "WEB-13b R7c (revision 9, C3): a session whose observed service ended never observes the page's next service of its database",
    file: KEPT,
    tests: [T_KEPT],
    expect:
      /it observes that one; another database's service is neither read nor observed/,
    patch: (t) => sub(t, "  rebind(which, context.service ?? null);\n", ""),
  },
  {
    id: "MU-5171",
    title:
      "WEB-13b R7c (revision 9, C3): the opening read of an observation begun after the hiding is taken as its basis",
    file: KEPT,
    tests: [T_KEPT],
    expect: /the observation begun at a later showing is no basis/,
    patch: (t) =>
      sub(
        t,
        "  // Its opening read is made after the hiding: never a basis.\n  which.opening = false;\n",
        "",
      ),
  },
  // ---- C2: the enqueue's own transaction compares the history ---------------------------------------------------------------------
  {
    id: "MU-5172",
    title:
      "WEB-13b C2 (revision 9): W2 does not compare the history a request states (a peer's invalidation before the enqueue is missed)",
    file: PLANS,
    tests: [T_CONT, T_RET],
    expect:
      /an invalidation committed before the transaction|another page's invalidation commits before|a fence's retry compares it again|another page's W18 and refill committed/,
    patch: (t) =>
      sub(
        t,
        '    if (!sameHistory(input.request, sync))\n      return { result: { kind: "refused", reason: "expired" } };\n',
        "",
      ),
  },
  {
    id: "MU-5173",
    title:
      "WEB-13b C2 (revision 9): W2 compares the history before recognising a duplicate (an admitted save's retry refused)",
    file: PLANS,
    tests: [T_CONT],
    expect: /admitted BEFORE the invalidation/,
    patch: (t) =>
      sub(
        sub(
          t,
          '    if (!sameHistory(input.request, sync))\n      return { result: { kind: "refused", reason: "expired" } };\n',
          "",
        ),
        '    if (planned.kind === "refused" || planned.kind === "invalid")\n      return { result: planned };\n',
        '    if (planned.kind === "refused" || planned.kind === "invalid")\n      return { result: planned };\n    if (!sameHistory(input.request, sync))\n      return { result: { kind: "refused", reason: "expired" } };\n',
      ),
  },
  {
    id: "MU-5174",
    title:
      "WEB-13b C2 (revision 9): the history compares only the witness (another incarnation's equal number passes)",
    file: PLANS,
    tests: [T_CONT],
    expect: /another incarnation named/,
    patch: (t) =>
      sub(
        t,
        "  (request.continuity.incarnationId === sync.incarnation_id &&\n",
        "  (true &&\n",
      ),
  },
  {
    id: "MU-5175",
    title:
      "WEB-13b C2 (revision 9): a witness the singleton cannot establish is taken for the stated one",
    file: PLANS,
    tests: [T_CONT],
    expect: /a witness the singleton cannot establish/,
    patch: (t) =>
      sub(
        t,
        "    request.continuity.invalidations === invalidationsOf(sync));\n",
        "    request.continuity.invalidations ===\n      (invalidationsOf(sync) ?? request.continuity.invalidations));\n",
      ),
  },
  {
    id: "MU-5176",
    title:
      "WEB-13b C2 (revision 9): the request's snapshot drops the history (no attempt compares it)",
    file: MODEL,
    tests: [T_CONT, T_RET],
    expect:
      /another page's invalidation commits before|snapshotRequest copies it|another page's W18 and refill committed/,
    patch: (t) =>
      sub(
        t,
        "    ...(request.continuity === undefined\n      ? {}\n      : {\n          continuity: {\n",
        "    ...(true\n      ? {}\n      : {\n          continuity: {\n",
      ),
  },
  {
    id: "MU-5177",
    title:
      "WEB-13b C2 (revision 9): the request's snapshot shares the caller's history object (a later change of it is compared)",
    file: MODEL,
    tests: [T_CONT],
    expect:
      /a caller changing its object afterwards changes nothing|snapshotRequest copies it/,
    patch: (t) =>
      sub(
        t,
        "          continuity: {\n            incarnationId: request.continuity.incarnationId,\n            invalidations: request.continuity.invalidations,\n          },\n",
        "          continuity: request.continuity,\n",
      ),
  },
  {
    id: "MU-5178",
    title:
      "WEB-13b C2 (revision 9): a malformed history is accepted as the caller's (validateRequest does not check it)",
    file: MODEL,
    tests: [T_CONT],
    expect: /a malformed history is the caller's mistake/,
    patch: (t) =>
      sub(
        t,
        '    throw new OutboxRequestError("continuity");\n',
        "    void 0;\n",
      ),
  },
  {
    id: "MU-5179",
    title:
      "WEB-13b C2 (revision 9): Import does not state the history its session was verified against",
    file: DIALOG,
    tests: [T_RET],
    expect: /another page's W18 and refill committed: Import stores NOTHING/,
    // Re-anchored in revision 10 (R7e): the history now comes with the authority asked at the press; the same omission.
    patch: (t) =>
      sub(
        t,
        "    const { continuity } = authority;\n",
        "    const continuity = undefined;\n",
      ),
  },
  {
    id: "MU-5180",
    title:
      "WEB-13b C2 (revision 9): an `expired` refusal leaves the session and its dialog open (a dead session's input offered again)",
    file: DIALOG,
    tests: [T_RET],
    expect:
      /another page's W18 and refill committed: Import stores NOTHING \(expired\), closes and says why/,
    // ADAPTED in WEB-13b's maintenance merge of accepted main, correction M-13b-1 (7 November 2026): the import's store moved into
    // its own `store` (so that the recovery ticket wraps it), and the line sits two spaces further out; the same defect.
    patch: (t) =>
      sub(
        t,
        '        if (outcome.reason === "expired") expireImport(editor);\n',
        "",
      ),
  },
];
