// WEB-13b revision 22's mutants (review 26 F26-1 `new`, family anchor-rejection-cause-attribution; design assessment C1 and A1–A7), in
// the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r15.mjs`. Each
// restores ONE way a refused anchor change could be explained by something other than what its refusal recorded (the defect: the old
// binding's seconds offset turned a generic `422` into "seconds offsets need a timed event"), or breaks one part of the refusal's
// handling the revision keeps (the supported `403`/`404` reason, the refused draft alone being dismissed); `expect` names the tests
// written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): restoring the `422` + the task's CURRENT recurrence → "it repeats on its own
// schedule" branch has no reachable schedule on the screen (the section is not rendered while the task repeats: "a task that repeats on
// its own schedule has no anchor section and reads nothing"), so it is an equivalent mutant; its copy is guarded by MU-2760 instead.
import { sub } from "./data-catalogue.mjs";

const SECTION = "src/features/tasks/detail/AnchorSection.tsx";
const COPY = "src/features/calendars/copy-anchor.ts";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";

const SHOWN =
  "          <span>{anchorRejected(anchorRefusal(rejected))}</span>\n";
const SUPPORTED =
  '  if (status === 403 || status === 404) return ANCHOR_REASONS.unavailable ?? "";\n';

export const UNIT_13B_R22 = [
  {
    id: "MU-2755",
    title:
      "WEB-13b F26-1 (revision 22): the original defect — a refused change's 422 is explained from the OLD binding's seconds offset",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /F26-1 (old binding \(seconds|transitions: (event series → person date|seconds → days|seconds → other|removal)|binding states|reload)/,
    patch: (t) =>
      sub(
        t,
        SHOWN,
        '          <span>{anchorRejected(rejected.last_error?.status === 422 && anchor?.offset.kind === "elapsed_seconds" ? "seconds offsets need a timed event" : anchorRefusal(rejected))}</span>\n',
      ),
  },
  {
    id: "MU-2756",
    title:
      "WEB-13b F26-1 (revision 22): a refused change's 422 is explained from the REFUSED body's own seconds offset (what was asked, not why it was refused)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /F26-1 (transitions: (person date → event series in seconds|days → seconds|seconds → other|no binding → event in seconds)|binding states|several changes)/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  const conflictBody = useDraftWithCommand(conflicted?.local_id ?? null);\n",
          "  const conflictBody = useDraftWithCommand((conflicted ?? rejected)?.local_id ?? null);\n",
        ),
        SHOWN,
        '          <span>{anchorRejected(rejected.last_error?.status === 422 && conflictBody.status === "ready" && conflictBody.value !== null && anchorOfCommand(conflictBody.value.command)?.offset.kind === "elapsed_seconds" ? "seconds offsets need a timed event" : anchorRefusal(rejected))}</span>\n',
      ),
  },
  {
    id: "MU-2757",
    title:
      "WEB-13b F26-1 (revision 22): a 403/404 refusal loses its supported reason (shown as the generic one)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /F26-1 supported reason/,
    patch: (t) => sub(t, SUPPORTED, ""),
  },
  {
    id: "MU-2758",
    title:
      "WEB-13b F26-1 (revision 22): a 422 is given the 403/404 reason (a cause its refusal does not record)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /F26-1 (old binding|transitions|binding states|reload|several changes)/,
    patch: (t) =>
      sub(
        t,
        SUPPORTED,
        '  if (status === 403 || status === 404 || status === 422) return ANCHOR_REASONS.unavailable ?? "";\n',
      ),
  },
  {
    id: "MU-2759",
    title:
      "WEB-13b F26-1 (revision 22): Dismiss discards the task's newest anchor change instead of the refused one",
    file: SECTION,
    tests: [T_SECTION],
    expect: /F26-1 several changes/,
    patch: (t) =>
      sub(
        t,
        "              void actions.discard(rejected.local_id).then(\n",
        "              void actions.discard((drafts[drafts.length - 1] ?? rejected).local_id).then(\n",
      ),
  },
  {
    id: "MU-2760",
    title:
      "WEB-13b F26-1 (revision 22): an unsupported server diagnosis returns to the refusal reasons (seconds need a timed event)",
    file: COPY,
    tests: [T_SECTION],
    expect: /F26-1 the refusal reasons are only those/,
    patch: (t) =>
      sub(
        t,
        "export const ANCHOR_REASONS: Readonly<Record<string, string>> = {\n",
        'export const ANCHOR_REASONS: Readonly<Record<string, string>> = {\n  untimed: "seconds offsets need a timed event",\n',
      ),
  },
];

/**
 * Real-engine mutant (one isolated whole-mutant job, all three browsers, its own unmutated control): the original F26-1 defect again (the
 * same patch as MU-2755), judged by E-ANC3's revision-22 case, whose binding is a timed event series with a seconds offset.
 */
export const ENGINE_13B_R22 = [
  {
    id: "MU-2761",
    title:
      "WEB-13b F26-1 (revision 22): (REAL ENGINE) the original defect — a refused change's 422 is explained from the OLD binding's seconds offset",
    file: SECTION,
    spec: "tests/e2e/fixture.calendar-anchors.spec.ts",
    grep: "revision 22 \\(review 26 F26-1\\)",
    expect: /revision 22 \(review 26 F26-1\)/,
    patch: (t) =>
      sub(
        t,
        SHOWN,
        '          <span>{anchorRejected(rejected.last_error?.status === 422 && anchor?.offset.kind === "elapsed_seconds" ? "seconds offsets need a timed event" : anchorRefusal(rejected))}</span>\n',
      ),
  },
];
