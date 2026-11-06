// WEB-13b revision 35's mutant (review 42 F42-4 `task-detail-pending-layout-shift`, classification `regression`), in the form and under
// the rules of `data-catalogue.mjs`, which spreads it into its `ENGINE` list after `catalogue-web13b-r24.mjs`. It removes the correction:
// the join form's audience no longer keeps its editable height while a Join is pending, so the controls above Join collapse when it is
// pressed and Join moves under the pointer. Only a real engine lays the page out (jsdom measures every element as 0 px), so the case
// that observes it is the native E-T16 "Join twice" on the task detail with the calendar section after the enrolment section; on this
// branch it failed in all three engines before the correction (Review 42) and passes after it.
//
// Considered and not selected (recorded for the reviewer):
// - a unit mutant of the measurement (`offsetHeight` never recorded): jsdom reports 0, so a unit test cannot tell it from the healthy
//   form; the real-engine mutant above removes the whole reserve, which is what the defect is.
import { sub } from "./data-catalogue.mjs";

const CONTROLS = "src/features/tasks/detail/Controls.tsx";

export const ENGINE_13B_R35 = [
  {
    id: "MU-5265",
    title:
      "WEB-13b F42-4 (revision 35): (REAL ENGINE) the join form's audience does not keep its height while a Join is pending (Join moves under a double press)",
    file: CONTROLS,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T16.*Join twice",
    expect: /Join twice/,
    patch: (t) =>
      sub(
        t,
        "            ? { minHeight: editableHeight }\n",
        "            ? {}\n",
      ),
  },
];
