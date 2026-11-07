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
//
// Re-anchored in revision 36 (Review 43 F43-1; design assessment 4062d86c, section 9 step 4), same id, intent and `expect`: the join
// form's bespoke reserve was replaced by the shared `HeldHeight` primitive that every audience chooser in the task detail is held by
// (`HeldAudience` in Controls.tsx). The defect is the same, the reserve never applied, so the patch now stops the primitive from setting
// the reserve; E-T16 "Join twice" observes it as before (and E-T46, revision 36, for every caller).
import { sub } from "./data-catalogue.mjs";

/** The primitive's reserve value as it is written in its source (split so that this file holds no template-looking plain string). */
const HEIGHT_PX = "`$" + "{height}px`";

const HELD = "src/components/ui/held-height.tsx";

export const ENGINE_13B_R35 = [
  {
    id: "MU-5265",
    title:
      "WEB-13b F42-4 (revision 35): (REAL ENGINE) the join form's audience does not keep its height while a Join is pending (Join moves under a double press)",
    file: HELD,
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T16.*Join twice",
    expect: /Join twice/,
    patch: (t) =>
      sub(
        t,
        `      if (height > 0) element.style.minHeight = ${HEIGHT_PX};\n`,
        "      if (height > 0) void height;\n",
      ),
  },
];
