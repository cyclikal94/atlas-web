/**
 * WEB-10a revision 13 (R26 `task-enrolment-first-choice-focus`; design assessment C1/C2, I2/I7, M1-M7, Q1/Q3): the first choice of a first
 * Join begins the page's draft (`editEnrolmentDraft`), and the form it was made in stays mounted: the control used is the SAME connected node
 * afterwards and keeps focus, with nothing sent. Before revision 13 the first Join's form (`FirstJoin` > `JoinForm`) was replaced by a
 * `JoinForm` rendered elsewhere once a draft existed, so the focussed control was removed and focus fell to the body.
 *
 * Every first-join case has its structural control (rejoining, whose form never changed place) and the enrolled audience editor as the shared
 * chooser control; an ordinary rerender shows that nothing else here moves focus. Composed through the production task detail, its sharing
 * env (the real chooser and directory lookup) and the data env's defaults source. Focus is given programmatically here (component
 * ACTIVATION controls, jsdom has no Tab traversal); real keyboard traversal and Space in three engines is E-T34 (`fixture.tasks.spec.ts`).
 *
 * The retained-draft protections the correction must keep (R23/R25: remount, refusal, the captured seed whatever the defaults say) are the
 * enrolment-retention, -owner and -ownership suites; F5 here adds that a draft begun asks for no defaults snapshot again.
 */
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as sharingCopy from "../../../src/features/sharing/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  enrolmentDraftOf,
  forgetTaskMemory,
} from "../../../src/features/tasks/memory";
import { installMatchMedia } from "../../helpers/match-media";
import { snapshot } from "../../support/data/sharing";
import {
  button,
  type Caller,
  click,
  consentChoice,
  defaultsReader,
  grantOf,
  inSettings,
  mountedFor,
  PRIVATE,
  SHARED,
  SLOW,
  settings,
  shownFor,
} from "../../support/tasks/enrolment";
import { ME, OTHER, tasksEnv } from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const IDENTITY = `${ME}:1`;
const PRIVATE_ONLY = "Only me (private)";
type World = Awaited<ReturnType<typeof mountedFor>>;

/** Defaults whose progress template is private: the first Private choice changes nothing, and must still keep its control. */
const privateDefaults = () =>
  defaultsReader({
    kind: "ok",
    value: snapshot({ templates: { progress: { kind: "private" } } }),
  });

/** The settings of `caller`, ready to edit: the chooser shown (enrolled: "Change…" opened, nothing chosen in it yet). */
async function editable(
  caller: Caller,
  options: Parameters<typeof mountedFor>[1] = {},
): Promise<World> {
  const w = await mountedFor(caller, options);
  if (caller === "enrolled") await click(button(CONTROLS_COPY.changeAudience));
  await w.t.until(
    () => settings().querySelector("[data-audience-chooser]") !== null,
  );
  expect(settings().querySelector("[data-audience-chooser]")).not.toBeNull();
  return w;
}

/**
 * Focusses `target` (programmatically: an activation control), activates it by click, and asserts the choice kept its control: the node is
 * still connected, it is the control found afterwards, and it has focus. Nothing is sent.
 */
async function activateKeeping(
  w: World,
  target: HTMLElement,
  again: () => HTMLElement | null,
) {
  target.focus();
  expect(document.activeElement).toBe(target);
  const form = settings().querySelector("[data-enrol-audience]");
  await act(async () => {
    fireEvent.click(target);
  });
  await w.t.settle();
  expect(w.sent).toHaveLength(0);
  expect(target.isConnected, "the control used is still in the page").toBe(
    true,
  );
  expect(again(), "it is the control found afterwards").toBe(target);
  expect(
    settings().querySelector("[data-enrol-audience]"),
    "the form it is in was not replaced",
  ).toBe(form);
  expect(
    document.activeElement,
    "the accepted choice leaves focus at its control, not the body",
  ).toBe(target);
}

describe("F1 (R26): the first consent choice of a first Join keeps its radio, and focus", () => {
  for (const value of [true, false])
    for (const caller of ["first join", "rejoin"] as const)
      test(
        `${caller === "first join" ? "" : "control: "}${caller}, consent ${value ? "Yes" : "No"}: the draft begins, the same radio is checked and focussed, nothing sent`,
        SLOW,
        async () => {
          const w = await editable(caller);
          expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
          await activateKeeping(w, consentChoice(value), () =>
            consentChoice(value),
          );
          expect(consentChoice(value).checked).toBe(true);
          expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toMatchObject({
            revision: 1,
            consent: value,
          });
        },
      );
});

describe("F2 (R26): Private as the first choice keeps its button, and focus (a shared seed and one already private)", () => {
  for (const seed of ["shared", "private"] as const)
    for (const caller of ["first join", "rejoin", "enrolled"] as const)
      test(
        `${caller === "first join" ? "" : "control: "}${caller}, ${seed} ${caller === "first join" ? "default" : "audience"}: the audience is Only me, the same button focussed, nothing sent`,
        SLOW,
        async () => {
          const w = await editable(
            caller,
            caller === "first join" && seed === "private"
              ? { defaults: privateDefaults() }
              : {},
          );
          if (caller !== "first join" && seed === "private") {
            // The control's audience made private first (an earlier accepted choice), so this Private changes nothing either.
            await click(button(PRIVATE_ONLY));
            await w.t.settle();
          }
          if (seed === "shared") expect(grantOf(OTHER)).not.toBeNull();
          const target = button(PRIVATE_ONLY) as HTMLButtonElement;
          await activateKeeping(w, target, () => button(PRIVATE_ONLY));
          expect(grantOf(OTHER)).toBeNull();
          expect(enrolmentDraftOf(IDENTITY, w.task.taskId)?.policy).toEqual(
            PRIVATE,
          );
        },
      );
});

describe("F3 (R26): a first change of a grant's permission keeps its choice, and focus", () => {
  for (const caller of ["first join", "rejoin", "enrolled"] as const)
    test(
      `${caller === "first join" ? "" : "control: "}${caller}: Edit chosen for the granted account, the same radio focussed, the policy changed`,
      SLOW,
      async () => {
        const w = await editable(caller);
        const row = () => grantOf(OTHER) as HTMLElement;
        expect(row()).not.toBeNull();
        const edit = () =>
          within(row()).getByRole("radio", {
            name: sharingCopy.EDIT,
          });
        const target = edit();
        await activateKeeping(w, target, edit);
        // A Radix radio (a button with role radio): its state is aria-checked.
        expect(edit().getAttribute("aria-checked")).toBe("true");
        expect(enrolmentDraftOf(IDENTITY, w.task.taskId)?.policy).toEqual({
          ...SHARED,
          grants: [{ kind: "account", id: OTHER, edit: true }],
        });
      },
    );
});

describe("F4 (R26): a first consent choice while the directory lookup is open keeps the lookup and what was typed in it", () => {
  for (const caller of ["first join", "rejoin"] as const)
    test(
      `${caller === "first join" ? "" : "control: "}${caller}: the lookup's field is the same node, still holding its text; the consent radio keeps focus`,
      SLOW,
      async () => {
        const w = await editable(caller);
        await click(button(sharingCopy.ADD_ACCOUNT));
        const field = inSettings().getByLabelText(
          sharingCopy.LOOKUP_SEARCH_LABEL,
        ) as HTMLInputElement;
        await act(async () => {
          fireEvent.change(field, { target: { value: "review" } });
        });
        await activateKeeping(w, consentChoice(true), () =>
          consentChoice(true),
        );
        expect(field.isConnected).toBe(true);
        expect(
          inSettings().getByLabelText(sharingCopy.LOOKUP_SEARCH_LABEL),
        ).toBe(field);
        expect(field.value).toBe("review");
      },
    );
});

/**
 * The defaults snapshots asked for by an ordinary rerender, then a same-identity remount, of `caller`'s settings with a choice made (or none,
 * `begin` false). A remount of the task detail always asks for one (the detail's other defaults readers, `useSharingDefaults` in its
 * actions), whatever the settings show: the rejoin control measures that.
 */
async function readsAcrossRemount(caller: Caller, begin: boolean) {
  const defaults = defaultsReader();
  const w = await editable(caller, { defaults });
  await w.t.settle();
  const asked = defaults.calls();
  expect(asked).toBeGreaterThan(0);
  if (begin) await click(consentChoice(false));
  await act(async () => w.t.rerender(tasksEnv(w.api)));
  await w.t.settle();
  await act(async () => w.t.remount());
  await w.t.settle();
  await w.t.until(() => shownFor(caller));
  await w.t.settle();
  if (begin) {
    expect(consentChoice(false).checked).toBe(true);
    expect(grantOf(OTHER)).not.toBeNull();
  }
  return defaults.calls() - asked;
}

describe("F5 (R26, C2): with a first Join begun, its form neither waits for nor asks the defaults again", () => {
  test(
    "a draft begun, then an ordinary rerender and a same-identity remount: the choice shown, and no snapshot asked for beyond the detail's own",
    SLOW,
    async () => {
      expect(
        await readsAcrossRemount("first join", true),
        "only the detail's own read: the begun form asked for none",
      ).toBe(1);
    },
  );

  test(
    "control: rejoining with a choice made, the same rerender and remount ask for the detail's own snapshot only",
    SLOW,
    async () => {
      expect(await readsAcrossRemount("rejoin", true)).toBe(1);
    },
  );

  test(
    "control: a first Join with nothing begun asks for the defaults again on the remount (the form waits for them)",
    SLOW,
    async () => {
      expect(await readsAcrossRemount("first join", false)).toBeGreaterThan(1);
      expect(consentChoice(true).checked).toBe(false);
      expect(consentChoice(false).checked).toBe(false);
    },
  );
});

describe("F6 (R26): controls — a choice after the first, and an ordinary rerender, move no focus", () => {
  test(
    "first join: Yes, then No (the draft's second revision) keeps the No radio focussed; a rerender after it too",
    SLOW,
    async () => {
      const w = await editable("first join");
      await click(consentChoice(true));
      await activateKeeping(w, consentChoice(false), () =>
        consentChoice(false),
      );
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)?.revision).toBe(2);
      const target = consentChoice(false);
      await act(async () => w.t.rerender(tasksEnv(w.api)));
      await w.t.settle();
      expect(consentChoice(false)).toBe(target);
      expect(document.activeElement).toBe(target);
    },
  );
});
