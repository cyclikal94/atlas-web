// WEB-13b revision 10's mutants (review 10 R7d `regression` and R7e `incomplete_fix`, family task-sync-navigation-draft-loss; design
// assessment C1, C2, C5 and its mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT`
// list after `catalogue-web13b-r9.mjs`. Each restores ONE part of a defect the revision corrected or removes one boundary of the correction;
// `expect` names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): comparing an old read's witness with `>` instead of `!==` against the basis it
// was asked for is equivalent (a read is made after the basis it is asked for was fixed, and one database's witness only grows, so it never
// reads less); the delivery's `which.ticket === ticket` reset of `verifying` is MU-5164's; `importStatus` deriving from `importAuthority`
// is one function, so a mutant of either is one of the mutants below.
//
// Retired after it ran (its survival preserved in `.agtx/evidence/WEB-13b/revision-10/mutants-new-1`): MU-2713, the press-time check
// letting an `acquiring` session through. It SURVIVED, and is equivalent: `submit` first returns on the enablement its last render
// computed, which already said `acquiring`, and a session never becomes `acquiring` again once its history is known, so no submission
// reaches that check while it is. The check stays: it is what gives the captured `continuity` its type. MU-2713 is not reused.
import { sub } from "./data-catalogue.mjs";

const KEPT = "src/features/calendars/import-kept.ts";
const DIALOG = "src/features/calendars/ImportDialog.tsx";
const COMMANDS = "src/features/calendars/model/commands.ts";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";
const T_RET = "tests/features/calendars/import-retention.test.tsx";
const T_COMMANDS = "tests/features/calendars/commands.test.ts";

export const UNIT_13B_R10 = [
  // ---- R7d: a read is judged against the basis it was asked for --------------------------------------------------------------------
  {
    id: "MU-5181",
    title:
      "WEB-13b R7d (revision 10): a showing's read is judged against the basis as it is when it lands (an earlier showing's read of the old witness expires a later, verified showing that followed a refresh)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /R7d \((?:row|chooser)\): an earlier showing's read of its own basis, delivered after the later showing's, after a refresh|R7d \((?:row|chooser)\): an earlier showing's read delivered after the later showing's, after W18 and a refill/,
    patch: (t) =>
      sub(
        t,
        "      (basis !== null &&\n        now.invalidations !== null &&\n        now.invalidations !== basis)\n",
        "      (which.basis !== null &&\n        now.invalidations !== null &&\n        now.invalidations !== which.basis)\n",
      ),
  },
  {
    id: "MU-5182",
    title:
      "WEB-13b R7d (revision 10): a read asked for an earlier showing is discarded whatever it says (genuine evidence of that showing's interval lost)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /R7d \(M2\): an earlier showing's read that says/,
    patch: (t) =>
      sub(
        t,
        "    if (held !== which || which.editor.ended() || now === null) return;\n",
        "    if (held !== which || which.editor.ended() || now === null) return;\n    if (which.ticket !== ticket) return;\n",
      ),
  },
  {
    id: "MU-2710",
    title:
      "WEB-13b R7d (revision 10): a showing's read asked before its basis was known is not followed by another read (the session waits for good)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /asks again with that basis, and that read verifies it/,
    patch: (t) =>
      sub(
        t,
        "    if (which.basis !== basis) {\n      verify(which);\n      return;\n    }\n",
        "    if (which.basis !== basis) return;\n",
      ),
  },
  // ---- R7e: no import without an established history -------------------------------------------------------------------------------
  {
    id: "MU-2711",
    title:
      "WEB-13b R7e (revision 10): a new session that does not know its history yet is ready and states none (the optional-token path restored)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /R7e \(row\): a new session is acquiring|R7e: no reading of its own database|R7e \(row, witness \d\): a new import before its cache history is known/,
    patch: (t) =>
      sub(
        t,
        '    return { status: "acquiring" };\n',
        '    return { status: "ready", continuity: undefined };\n',
      ),
  },
  {
    id: "MU-2712",
    title:
      "WEB-13b R7e (revision 10): the dialog offers Import while its new session is acquiring (only the press refuses it)",
    file: DIALOG,
    tests: [T_RET],
    expect:
      /R7e \(row, witness \d\): a new import before its cache history is known/,
    patch: (t) =>
      sub(
        t,
        '          : state.kind === "waiting" || status === "acquiring"\n',
        '          : state.kind === "waiting"\n',
      ),
  },
  {
    id: "MU-2714",
    title:
      "WEB-13b R7e (revision 10): the import request leaves out the history its press captured (W2 then compares nothing)",
    file: COMMANDS,
    tests: [T_COMMANDS, T_RET],
    expect:
      /the import recipe for WEB-13b|R7e \(row, witness \d\): a new import before its cache history is known|another page's W18 and refill committed: Import stores NOTHING/,
    patch: (t) => sub(t, "    continuity,\n  };\n}\n", "  };\n}\n"),
  },
];
