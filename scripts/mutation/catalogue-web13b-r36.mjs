// WEB-13b revision 36's mutants (Review 43 F43-1 `task-detail-pending-layout-shift`, classification `incomplete_fix`; design assessment
// 4062d86c DA-1, I1-I9, Q1-Q3, Q7, Q8), in the form and under the rules of `data-catalogue.mjs`, which spreads `UNIT_13B_R36` into its
// `UNIT` list after `catalogue-web13b-r33.mjs` and `ENGINE_13B_R36` into its `ENGINE` list after `catalogue-web13b-r35.mjs`. Each removes
// ONE part of the correction; `expect` names the case written for it, so only an assertion of that case catches it.
//
// The correction: one primitive, `HeldHeight` (`src/components/ui/held-height.tsx`), keeps the height its content had at the rising edge
// of `held`, read before React changes the page; `HeldAudience` in `Controls.tsx` is the only use of the audience chooser and holds it
// while it is blocked (sending and confirming). MU-5265 (revision 35) is re-anchored to the primitive in `catalogue-web13b-r35.mjs`.
//
// Considered and not selected (recorded for the reviewer):
// - a UNIT mutant over the static guard (`tests/static/held-audience.test.ts`): the runner writes each mutated file into its own work
//   directory and redirects the module import to it, so a test that reads `src/` from disk never sees the patch (the first design of
//   MU-5272 survived for exactly that reason, 6 November 2026). The bypass it restores is the F43-1 defect, so MU-5272 is a real-engine
//   mutant over E-T46's Save sharing case instead, and the guard's own sensitivity is shown in `.agtx/execute.md` on a scratch copy.
// - the wrapper's `data-held-height` attribute removed: it is a test hook (E-T46b and the unit cases locate the wrapper by it), so removing
//   it breaks the tests' set-up, not the behaviour; a set-up error is not a catch.
// - JoinForm or KeptDraft using the chooser directly: the same defect as MU-5272 at another call site, caught by the same static guard;
//   KeptDraft's `blocked` is constant (no rising edge), so no native case could tell its reserve from none.
import { sub } from "./data-catalogue.mjs";

/** The primitive's reserve value as it is written in its source (split so that this file holds no template-looking plain string). */
const HEIGHT_PX = "`$" + "{height}px`";

const HELD = "src/components/ui/held-height.tsx";
const CONTROLS = "src/features/tasks/detail/Controls.tsx";
const T_HELD = "tests/components/held-height.test.tsx";
const GEOMETRY = "tests/e2e/fixture.enrolment-geometry.spec.ts";

const READ = "      const height = element.getBoundingClientRect().height;\n";
const RESERVE = `      if (height > 0) element.style.minHeight = ${HEIGHT_PX};\n`;
const DID_UPDATE =
  "  override componentDidUpdate(previous: { held: boolean }) {\n";
/** The height as the wrapper last saw it at ITS OWN commits (mount, its updates while not held): what a parent-owned measure sees. */
const STALE = (t) =>
  sub(
    sub(t, READ, "      const height = this.stale ?? 0;\n"),
    DID_UPDATE,
    "  override componentDidMount() {\n    this.stale = this.box.current?.getBoundingClientRect().height ?? 0;\n  }\n" +
      DID_UPDATE +
      "    if (!this.props.held)\n      this.stale = this.box.current?.getBoundingClientRect().height ?? 0;\n",
  );

export const UNIT_13B_R36 = [
  {
    id: "MU-5266",
    title:
      "WEB-13b F43-1 (revision 36): the reserve is measured AFTER the update is applied (componentDidUpdate), so it is the collapsed height",
    file: HELD,
    tests: [T_HELD],
    expect: /Q1: the rising edge reserves the height read BEFORE the update/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    if (element !== null && !previous.held && this.props.held) {\n",
          "    if (element !== null && false) {\n",
        ),
        DID_UPDATE,
        `${DID_UPDATE}    {\n      const element = this.box.current;\n      if (element !== null && !previous.held && this.props.held) {\n        const height = element.getBoundingClientRect().height;\n        if (height > 0) element.style.minHeight = ${HEIGHT_PX};\n      }\n    }\n`,
      ),
  },
  {
    id: "MU-5267",
    title:
      "WEB-13b DA-1 (revision 36): the reserve is the height at the wrapper's own last commit (a parent-owned measure), not at the edge",
    file: HELD,
    tests: [T_HELD],
    expect: /Q2: a height the content reached ON ITS OWN/,
    patch: STALE,
  },
  {
    id: "MU-5268",
    title:
      "WEB-13b F43-1 (revision 36): the falling edge never releases the reserve",
    file: HELD,
    tests: [T_HELD],
    expect: /Q3a: the falling edge releases the reserve/,
    patch: (t) =>
      sub(t, '      element.style.minHeight = "";\n', "      void element;\n"),
  },
  {
    id: "MU-5269",
    title:
      "WEB-13b F43-1 (revision 36): content that mounts already held reserves its (collapsed) height",
    file: HELD,
    tests: [T_HELD],
    expect: /Q3b: content that mounts already held reserves nothing/,
    patch: (t) =>
      sub(
        t,
        DID_UPDATE,
        "  override componentDidMount() {\n    const element = this.box.current;\n    if (element !== null && this.props.held) {\n      const height = element.getBoundingClientRect().height;\n      if (height > 0) element.style.minHeight = " +
          HEIGHT_PX +
          ";\n    }\n  }\n" +
          DID_UPDATE,
      ),
  },
  {
    id: "MU-5270",
    title:
      'WEB-13b F43-1 (revision 36): every held update measures again ("Sending…" to "Checking…" takes the collapsed height)',
    file: HELD,
    tests: [T_HELD],
    expect: /Q3c: staying held keeps the FIRST height/,
    patch: (t) =>
      sub(
        t,
        "    if (element !== null && !previous.held && this.props.held) {\n",
        "    if (element !== null && this.props.held) {\n",
      ),
  },
  {
    id: "MU-5271",
    title:
      "WEB-13b F43-1 (revision 36): a height of 0 at the edge is reserved (an empty wrapper gets a style)",
    file: HELD,
    tests: [T_HELD],
    expect: /Q3d: a height of 0 at the edge reserves nothing/,
    patch: (t) =>
      sub(
        t,
        RESERVE,
        `      if (height >= 0) element.style.minHeight = ${HEIGHT_PX};\n`,
      ),
  },
];

export const ENGINE_13B_R36 = [
  {
    id: "MU-5272",
    title:
      "WEB-13b F43-1 (revision 36): (REAL ENGINE) the enrolled person's audience editor uses the chooser directly again (the F43-1 defect at its call site: Save sharing moves under a double press)",
    file: CONTROLS,
    spec: GEOMETRY,
    grep: "E-T46:.*save \\(plain, everyone, natural",
    expect: /save \(plain, everyone, natural/,
    patch: (t) =>
      sub(
        t,
        "            <HeldAudience\n              policy={draft.policy}\n              onChange={edit}\n",
        "            <AudienceChooser\n              policy={draft.policy}\n              onChange={edit}\n",
      ),
  },
  {
    id: "MU-5273",
    title:
      'WEB-13b F43-1 (revision 36): (REAL ENGINE) the reserve is released when the answer arrives ("Checking…" is not held), so the control moves while the read is pending',
    file: CONTROLS,
    spec: GEOMETRY,
    grep: "E-T46b.*follow-up read held",
    expect: /follow-up read held/,
    patch: (t) =>
      sub(
        t,
        "    <HeldHeight held={props.blocked !== null}>\n",
        "    <HeldHeight held={props.blocked === CONTROLS_COPY.sending}>\n",
      ),
  },
  {
    id: "MU-5274",
    title:
      "WEB-13b F43-1 (revision 36): (REAL ENGINE) the enrolled editor's reserve is on the audience block, around Cancel and Save sharing, instead of on the chooser",
    file: CONTROLS,
    spec: GEOMETRY,
    grep: "E-T46:.*save \\(plain, everyone",
    expect: /save \(plain, everyone/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "            <HeldAudience\n              policy={draft.policy}\n              onChange={edit}\n",
            "            <AudienceChooser\n              policy={draft.policy}\n              onChange={edit}\n",
          ),
          '      <div className="flex flex-col gap-2" data-enrol-audience="">\n        <p className="text-[13px] text-ink-1">\n          {CONTROLS_COPY.audienceHeading}:{" "}\n',
          '      <HeldHeight held={blocked !== null}><div className="flex flex-col gap-2" data-enrol-audience="">\n        <p className="text-[13px] text-ink-1">\n          {CONTROLS_COPY.audienceHeading}:{" "}\n',
        ),
        "        )}\n      </div>\n    </>\n  );\n}\n\n/** A draft with unsent edits",
        "        )}\n      </div></HeldHeight>\n    </>\n  );\n}\n\n/** A draft with unsent edits",
      ),
  },
  {
    id: "MU-5275",
    title:
      "WEB-13b DA-1 (revision 36): (REAL ENGINE) the reserve is the height at the wrapper's own last commit, so a picker opened or households answered since are missed",
    file: HELD,
    spec: GEOMETRY,
    grep: "E-T46:.*(join|save) \\((picker|late), everyone, natural",
    expect: /\((picker|late), everyone, natural/,
    patch: STALE,
  },
];
