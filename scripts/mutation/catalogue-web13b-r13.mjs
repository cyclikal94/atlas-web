// WEB-13b revision 13's mutants (review 14 R11 `new`, family calendar-anchor-observation-admission; design assessment M26–M35 and its
// mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r12.mjs`. Each restores ONE part of the defect the revision corrected (an anchor change written without a read of the
// task, so its version check adopted one nobody saw) or removes one boundary the R11 tests rely on; `expect` names the tests written for
// it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): dropping only the resource-ID comparison has no reachable schedule (the
// section's read is keyed by its own task's ID and a session by the task's panel key), so it is an equivalent mutant kept as defence in
// depth; recapturing a read when a kept session is shown again needs an editor API that does not exist (a session's context changes only
// by its own settlement), so there is nothing to restore; making the builder's `observed` optional again changes types only (MU-5187
// restores the runtime defect it allowed).
import { sub } from "./data-catalogue.mjs";

const SECTION = "src/features/tasks/detail/AnchorSection.tsx";
const PLANS = "src/data/plans/outbox.ts";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";

const GUARD =
  "    if (observed === null || observed.resourceId !== task.id)\n      return {\n        refused: ANCHOR_NOT_SAVED_UNCHECKED,\n        context: { ...context, renewed: true },\n      };\n";
const CHOICE =
  "    const observed = context.renewed ? observedNow : context.observed;\n";
const REQUEST =
  "    const request = setAnchorRequest(task, next, observed, key);\n";

export const UNIT_13B_R13 = [
  {
    id: "MU-5187",
    title:
      "WEB-13b R11 (revision 13): the original defect — a session with no read of the task saves anyway, its request stating none (written on whatever version the transaction finds)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /R11 save \(ADAPTED|R11 remove \(ADAPTED|R11: the task's read still|R11 Review of a conflicted change|R11 retained|R11 Enter/,
    patch: (t) =>
      sub(
        sub(t, GUARD, ""),
        REQUEST,
        "    const request = setAnchorRequest(task, next, observed ?? (undefined as never), key);\n",
      ),
  },
  {
    id: "MU-5188",
    title:
      "WEB-13b R11 (revision 13): a session opened before the task's read takes the read shown at its first press (its opening read silently filled in)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R11 save \(ADAPTED|R11 remove \(ADAPTED|R11 retained|R11 Enter/,
    patch: (t) =>
      sub(
        t,
        CHOICE,
        "    const observed = context.renewed ? observedNow : (context.observed ?? observedNow);\n",
      ),
  },
  {
    id: "MU-5189",
    title:
      "WEB-13b R11 (revision 13): every press is checked against the task as shown at the press, not the read its session was opened on",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /R11 control: a change of the task shown after the panel opened|R11 retained/,
    patch: (t) => sub(t, CHOICE, "    const observed = observedNow;\n"),
  },
  {
    id: "MU-5190",
    title:
      "WEB-13b R11 (revision 13): a renewed session whose task is not readable now falls back to the read it was opened on",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /R11 after a done save that kept newer input|R11 after a changed refusal/,
    patch: (t) =>
      sub(
        t,
        CHOICE,
        "    const observed = context.renewed ? (observedNow ?? context.observed) : context.observed;\n",
      ),
  },
  {
    id: "MU-5191",
    title:
      "WEB-13b R11 (revision 13): the refusal without a read keeps the session as it was (never renewed: its input can never be saved)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /R11 save \(ADAPTED|R11 remove \(ADAPTED|R11: the task's read still|R11 Review of a conflicted change|R11 retained|R11 Enter/,
    patch: (t) =>
      sub(
        t,
        "        refused: ANCHOR_NOT_SAVED_UNCHECKED,\n        context: { ...context, renewed: true },\n",
        "        refused: ANCHOR_NOT_SAVED_UNCHECKED,\n        context,\n",
      ),
  },
  {
    id: "MU-5192",
    title:
      "WEB-13b R11 (revision 13): Remove anchor states no read of the task (the removal written on a version nobody saw)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R11 remove \(ADAPTED/,
    patch: (t) =>
      sub(
        t,
        REQUEST,
        "    const request =\n      next === null\n        ? { ...setAnchorRequest(task, next, observed, key), observed: undefined as never }\n        : setAnchorRequest(task, next, observed, key);\n",
      ),
  },
  {
    id: "MU-5193",
    title:
      "WEB-13b R11 (revision 13): Review's replacement of a conflicted change states no read of the task",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R11 Review of a conflicted change/,
    patch: (t) =>
      sub(
        t,
        "          : await outbox.supersede(context.supersede, request);\n",
        "          : await outbox.supersede(context.supersede, { ...request, observed: undefined as never });\n",
      ),
  },
  {
    id: "MU-5194",
    title:
      "WEB-13b R11 (revision 13): a refusal without a read retires the identities of the changes pressed (the retry becomes a new operation)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /R11 after a changed refusal/,
    patch: (t) =>
      sub(
        t,
        GUARD,
        "    if (observed === null || observed.resourceId !== task.id) {\n      context.keys.clear();\n      return {\n        refused: ANCHOR_NOT_SAVED_UNCHECKED,\n        context: { ...context, renewed: true },\n      };\n    }\n",
      ),
  },
  {
    id: "MU-5195",
    title:
      "WEB-13b R11 (revision 13): the enqueue transaction does not check the read an anchor change states (MU-1362's defect, judged by the anchor tests)",
    file: PLANS,
    tests: [T_SECTION],
    expect:
      /R11 save \(ADAPTED|R11 remove \(ADAPTED|R11 controls: opened on a ready read|R11 after a changed refusal|R11 control: a change of the task shown/,
    patch: (t) =>
      sub(
        t,
        '    // After the duplicate: a retry of a save that was made is recognised, although its own write changed what its caller saw.\n    if (!stillObserved(input.request, reads.observed))\n      return { result: { kind: "refused", reason: "changed" } };\n',
        "",
      ),
  },
  {
    id: "MU-5196",
    title:
      "WEB-13b R11 (revision 13): the supersede transaction does not check the read Review's replacement states (MU-1363's defect, judged by the anchor tests)",
    file: PLANS,
    tests: [T_SECTION],
    expect: /R11 Review of a conflicted change/,
    patch: (t) =>
      sub(
        t,
        '    // Only a supersession that would be written is checked: a retry of one already made, or a refusal, says what it said before.\n    if (!stillObserved(input.request, reads.observed))\n      return { result: { kind: "refused", reason: "changed" } };\n',
        "",
      ),
  },
];
