/**
 * WEB-10a revision 12 (R23 `task-save-acknowledgement-consumes-newer-edits`, R25 `task-enrolment-refusal-discards-input`; design assessment
 * I3/I4, C1-C7, Q2-Q9, Q14, Q15): the enrolment settings' unsaved change belongs to the PAGE, not to the mounted settings, and only a
 * SUCCESS for the exact editor session and revision it submitted (then the current read) ends it.
 *
 * - R23: an accepted later edit survives an ordinary same-identity remount of the protected tree (`Mounted.remount`: the providers keyed
 *   afresh, the router, location, data env and page memory kept; not a reload, not a navigation), in every phase of a change's cycle.
 * - R25: a refused (conflict, operation_conflict, invalid) or uncertain change keeps the submitted values, unsaved, beside the settings read;
 *   nothing is resent, rebased or merged, and the next change waits for an explicit Discard (another version) or a new Save (the same one).
 *
 * Every case has its positive control (an ordinary rerender, a success that ends the draft, a Discard that frees the next action). Composed
 * through the production task detail, its sharing env (the real chooser and directory lookup) and the data env's defaults source; POSTs
 * are held until released, reads where named. These are component/composition checks (jsdom), not native lifecycle evidence.
 */
import { act, cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import * as copy from "../../../src/features/tasks/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  enrolmentAttemptOf,
  enrolmentDraftOf,
  forgetTaskMemory,
} from "../../../src/features/tasks/memory";
import type { Enrolment } from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import {
  button,
  CALLERS,
  type Caller,
  choose,
  chosen,
  click,
  clone,
  consentChoice,
  defaultsReader,
  grantOf,
  initialFor,
  kept,
  mountedFor,
  opened,
  PRIVATE,
  reasonOf,
  SHARED,
  SLOW,
  settings,
  shownFor,
  submitName,
  THIRD,
  withThird,
} from "../../support/tasks/enrolment";
import { ME, OTHER, tasksEnv } from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const IDENTITY = `${ME}:1`;
type World = Awaited<ReturnType<typeof opened>>;
const PURPOSES = ["grant", "exclude"] as const;

/** Every audience chooser shown lies inside the kept draft (none is offered for the version shown). */
function onlyKeptChooser() {
  const box = kept();
  expect(box).not.toBeNull();
  for (const chooser of settings().querySelectorAll("[data-audience-chooser]"))
    expect(box?.contains(chooser)).toBe(true);
}

/** The settings shown again after a remount or rerender (and, with a draft, its editor). */
async function shownAgain(w: World, caller: Caller) {
  await w.t.settle();
  await w.t.until(() => shownFor(caller));
  expect(shownFor(caller)).toBe(true);
}

/** Submits the open draft and answers it `uncertain`; the read that follows (answered at once, unchanged) frees the settings again. */
async function uncertainSubmit(w: World, caller: Caller) {
  await click(button(submitName(caller)));
  expect(w.sent).toHaveLength(1);
  await act(async () => w.sent[0]?.release({ ok: false, kind: "uncertain" }));
  await w.t.settle();
  expect(document.querySelector("[data-enrolment-uncertain]")).not.toBeNull();
  expect(document.querySelector("[data-audience-chooser]")).not.toBeNull();
}

/** Remount or rerender (the control), then wait for the settings. */
async function cycleTree(w: World, caller: Caller, remount: boolean) {
  if (remount) await act(async () => w.t.remount());
  else await act(async () => w.t.rerender(tasksEnv(w.api)));
  await shownAgain(w, caller);
}

/** A newer enrolment written by another device: the next version, consent off, the shared audience, active as given. */
const winnerOf = (caller: Caller, active: boolean): Enrolment => ({
  version: initialFor(caller).version + 1,
  active,
  aggregate_consent: false,
  policy: SHARED,
});

describe("Q2 (R23): a later edit after an uncertain change survives a same-identity remount of the protected tree", () => {
  for (const caller of CALLERS)
    for (const purpose of PURPOSES)
      for (const remount of [true, false])
        test(
          `${caller} × ${purpose}: ${remount ? "REMOUNT" : "control: ordinary rerender"}: the accepted ${purpose} and consent stay; the uncertain change's key and body stay; one POST; Save/Join of it is acknowledged and ends it`,
          SLOW,
          async () => {
            const w = await opened(caller);
            await uncertainSubmit(w, caller);
            const first = clone(w.sent[0]);
            await choose(w.t, purpose);
            const before = enrolmentDraftOf(IDENTITY, w.task.taskId);
            expect(before?.revision).toBeGreaterThan(0);
            await cycleTree(w, caller, remount);
            // The later edit is shown again, editable: the chooser for the version read, nothing kept aside.
            expect(chosen(purpose)).not.toBeNull();
            expect(grantOf(OTHER)).toBeNull();
            expect(kept()).toBeNull();
            if (caller !== "enrolled")
              expect(consentChoice(true).checked).toBe(true);
            expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toEqual(before);
            const held = enrolmentAttemptOf(IDENTITY, w.task.taskId);
            expect(held?.phase).toBe("uncertain");
            expect(held?.key).toBe(first?.key);
            expect(held?.command).toEqual(first?.command);
            expect(w.sent).toHaveLength(1);
            expect(w.sent[0]?.command.initial_policy).toEqual(PRIVATE);
            // Control: Save/Join of the retained draft is a new change (its own body and key), and its success ends it.
            await click(button(submitName(caller)));
            expect(w.sent).toHaveLength(2);
            expect(w.sent[1]?.command.initial_policy).toEqual(
              withThird(purpose),
            );
            expect(w.sent[1]?.command.expected_version).toBe(
              initialFor(caller).version,
            );
            expect(w.sent[1]?.key).not.toBe(first?.key);
            await w.ack(w.t, 1);
            expect(
              document.querySelector("[data-audience-chooser]"),
            ).toBeNull();
            expect(kept()).toBeNull();
            expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
            expect(settings().textContent).toContain(
              `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(withThird(purpose))}`,
            );
            expect(settings().textContent).toContain(CONTROLS_COPY.saved);
          },
        );
});

describe("Q4 (R25): a refused change keeps the submitted audience and consent, unsaved, beside the other device's newer settings", () => {
  for (const caller of CALLERS)
    for (const code of ["conflict", "operation_conflict"] as const)
      test(
        `${caller} × ${code}: kept with its grant${caller === "enrolled" ? "" : " and consent"}; the winner shown; nothing resent; Discard, then the next change is made at the winner's version`,
        SLOW,
        async () => {
          const w = await opened(caller);
          await choose(w.t, "grant");
          await click(button(submitName(caller)));
          expect(w.sent).toHaveLength(1);
          expect(w.sent[0]?.command.initial_policy).toEqual(withThird("grant"));
          // Another device's change won first: enrolled, consent off, shared (for both joins the branch shown changes too).
          const winner = winnerOf(caller, true);
          w.set(winner);
          await act(async () =>
            w.sent[0]?.release({ ok: false, kind: code, code }),
          );
          await w.t.settle();
          expect(settings().textContent).toContain(CONTROLS_COPY.enrolRefused);
          expect(enrolmentAttemptOf(IDENTITY, w.task.taskId)).toBeNull();
          // The refused values, exactly, as an unsaved change of the version they were made to.
          const box = kept() as HTMLElement;
          expect(box).not.toBeNull();
          expect(box.textContent).toContain(CONTROLS_COPY.keptDraft);
          expect(chosen("grant", box)).not.toBeNull();
          expect(grantOf(OTHER, box)).toBeNull();
          if (caller !== "enrolled")
            expect(box.textContent).toContain(CONTROLS_COPY.consentYes);
          onlyKeptChooser();
          // The winner, separately: enrolled, consent off, the shared audience.
          expect(settings().textContent).toContain(
            `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(SHARED)}`,
          );
          const checkbox = within(settings()).getByRole("checkbox", {
            name: CONTROLS_COPY.consent,
          }) as HTMLInputElement;
          expect(checkbox.checked).toBe(false);
          // Nothing else changes while it is kept; nothing was resent or merged.
          for (const name of [
            CONTROLS_COPY.leave,
            CONTROLS_COPY.changeAudience,
          ]) {
            const control = button(name) as HTMLButtonElement;
            expect(control.disabled).toBe(true);
            expect(reasonOf(control)).toContain(CONTROLS_COPY.discardFirst);
          }
          expect(checkbox.disabled).toBe(true);
          await click(button(CONTROLS_COPY.leave));
          expect(w.sent).toHaveLength(1);
          // Remounted, it is still kept (control of page ownership for the refused draft).
          await act(async () => w.t.remount());
          await w.t.settle();
          await w.t.until(() => kept() !== null);
          expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
          // Explicit Discard frees the next action, which carries the WINNER's version and audience.
          await click(
            within(kept() as HTMLElement).getByRole("button", {
              name: CONTROLS_COPY.discard,
            }),
          );
          expect(kept()).toBeNull();
          expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
          await click(button(CONTROLS_COPY.leave));
          expect(w.sent).toHaveLength(2);
          expect(w.sent[1]?.command).toEqual({
            kind: "enrol",
            task_id: w.task.taskId,
            expected_version: winner.version,
            active: false,
            aggregate_consent: false,
            initial_policy: SHARED,
          });
          expect(w.sent[1]?.key).not.toBe(w.sent[0]?.key);
        },
      );

  for (const caller of CALLERS)
    test(
      `${caller}: control: the same change answered with success ends the draft and shows the saved audience`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "grant");
        await click(button(submitName(caller)));
        await w.ack(w.t);
        expect(kept()).toBeNull();
        expect(document.querySelector("[data-audience-chooser]")).toBeNull();
        expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
        expect(settings().textContent).toContain(
          `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(withThird("grant"))}`,
        );
        expect(settings().textContent).toContain(CONTROLS_COPY.saved);
      },
    );
});

describe("Q5 (R25): neither transmission, a version that moved, nor values that look equal acknowledge a change", () => {
  test(
    "invalid at the same version: the draft stays editable (Save can be pressed again), Leave waits; a later version keeps it, unsent",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await choose(w.t, "grant");
      await click(button(CONTROLS_COPY.saveAudience));
      await act(async () =>
        w.sent[0]?.release({ ok: false, kind: "invalid", code: "invalid" }),
      );
      await w.t.settle();
      expect(settings().textContent).toContain(CONTROLS_COPY.enrolRefused);
      expect(kept()).toBeNull();
      expect(grantOf(THIRD)).not.toBeNull();
      const save = button(CONTROLS_COPY.saveAudience) as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      const leave = button(CONTROLS_COPY.leave) as HTMLButtonElement;
      expect(leave.disabled).toBe(true);
      expect(reasonOf(leave)).toContain(CONTROLS_COPY.finishFirst);
      // Another device moves the version; the next read (the connection drops and returns) keeps the refused draft aside.
      w.set({
        ...initialFor("enrolled"),
        version: 8,
        aggregate_consent: false,
      });
      w.t.rerender(tasksEnv(w.api, { online: false }));
      await w.t.settle();
      w.t.rerender(tasksEnv(w.api));
      await w.t.settle();
      expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
      onlyKeptChooser();
      expect(w.sent).toHaveLength(1);
    },
  );

  test(
    "control: invalid, then the same draft saved again at the same version succeeds and ends it",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await choose(w.t, "grant");
      await click(button(CONTROLS_COPY.saveAudience));
      await act(async () =>
        w.sent[0]?.release({ ok: false, kind: "invalid", code: "invalid" }),
      );
      await w.t.settle();
      await click(button(CONTROLS_COPY.saveAudience));
      expect(w.sent).toHaveLength(2);
      expect(w.sent[1]?.command).toEqual(w.sent[0]?.command);
      await w.ack(w.t, 1);
      expect(kept()).toBeNull();
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
    },
  );

  test(
    "uncertain, and another writer commits the SAME audience at version 8: equal values are not this change's success; it is kept",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      // Another device saves "Only me" too, before the uncertain answer's read.
      w.set({ ...initialFor("enrolled"), version: 8, policy: PRIVATE });
      await click(button(CONTROLS_COPY.saveAudience));
      await act(async () =>
        w.sent[0]?.release({ ok: false, kind: "uncertain" }),
      );
      await w.t.settle();
      expect(kept()).not.toBeNull();
      expect(settings().textContent).toContain(
        `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(PRIVATE)}`,
      );
      expect(
        document.querySelector("[data-enrolment-uncertain]"),
      ).not.toBeNull();
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)?.policy).toEqual(
        PRIVATE,
      );
      expect(w.sent).toHaveLength(1);
    },
  );
});

describe("Q6 (R25): a failed read after a refusal neither consumes the draft nor guesses the settings; a refused enrolment read removes it", () => {
  test(
    "conflict, then the read fails: unavailable, Try again READS (no POST) and shows the kept draft beside the winner",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await choose(w.t, "grant");
      await click(button(CONTROLS_COPY.saveAudience));
      w.set(winnerOf("enrolled", true));
      w.hold(true);
      await act(async () =>
        w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
      );
      await w.t.settle();
      await act(async () =>
        w.held()[0]?.release({ ok: false, kind: "uncertain" }),
      );
      await w.t.settle();
      expect(settings().textContent).toContain(CONTROLS_COPY.enrolUnavailable);
      expect(settings().textContent).not.toContain(
        CONTROLS_COPY.audienceLine(PRIVATE),
      );
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)?.policy).toEqual(
        withThird("grant"),
      );
      w.hold(false);
      await click(button(copy.TRY_AGAIN));
      await w.t.settle();
      expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
      expect(settings().textContent).toContain(
        CONTROLS_COPY.audienceLine(SHARED),
      );
      expect(w.sent).toHaveLength(1);
    },
  );

  for (const kind of ["forbidden", "not_found"] as const)
    test(
      `conflict, then the enrolment read is refused (${kind}): the draft is removed, and a later authorised read does not bring it back`,
      SLOW,
      async () => {
        const w = await opened("enrolled");
        await choose(w.t, "grant");
        await click(button(CONTROLS_COPY.saveAudience));
        w.set(winnerOf("enrolled", true));
        w.hold(true);
        await act(async () =>
          w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
        );
        await w.t.settle();
        await act(async () =>
          w.held()[0]?.release({ ok: false, kind, code: kind }),
        );
        await w.t.settle();
        expect(settings().textContent).toContain(
          CONTROLS_COPY.enrolUnavailable,
        );
        expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
        w.hold(false);
        await click(button(copy.TRY_AGAIN));
        await w.t.settle();
        expect(kept()).toBeNull();
        expect(grantOf(THIRD)).toBeNull();
        expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
        expect(w.sent).toHaveLength(1);
      },
    );
});

describe("Q3 (R23/R25): every phase of a change's cycle survives a remount; an answer that arrives while nothing is mounted is kept too", () => {
  for (const caller of ["enrolled", "first join"] as const) {
    test(
      `${caller}: remounted with an unsent edit (before any send): it is shown again, editable`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "exclude");
        await cycleTree(w, caller, true);
        expect(chosen("exclude")).not.toBeNull();
        expect(kept()).toBeNull();
        if (caller !== "enrolled")
          expect(consentChoice(true).checked).toBe(true);
        expect(w.sent).toHaveLength(0);
      },
    );

    test(
      `${caller}: remounted while the POST is held: frozen, then the refusal answered under the new mount keeps the draft`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "grant");
        await click(button(submitName(caller)));
        await cycleTree(w, caller, true);
        const submit = button(submitName(caller));
        if (submit !== null) {
          expect(submit.disabled).toBe(true);
          expect(reasonOf(submit)).toContain(CONTROLS_COPY.sending);
        }
        w.set(winnerOf(caller, true));
        await act(async () =>
          w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
        );
        await w.t.settle();
        expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
        expect(w.sent).toHaveLength(1);
      },
    );

    test(
      `${caller}: refused, remounted while the read that follows is held: still frozen, then the draft is kept`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "grant");
        await click(button(submitName(caller)));
        w.set(winnerOf(caller, true));
        w.hold(true);
        await act(async () =>
          w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
        );
        await w.t.settle();
        await act(async () => w.t.remount());
        await w.t.settle();
        await w.t.until(() => w.held().length >= 2);
        await act(async () => {
          for (const read of w.held().reverse()) read.release();
        });
        await w.t.settle();
        expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
        expect(w.sent).toHaveLength(1);
      },
    );

    test(
      `${caller}: refused, its read failed, then remounted: the new mount's read shows the kept draft`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "grant");
        await click(button(submitName(caller)));
        w.set(winnerOf(caller, true));
        w.hold(true);
        await act(async () =>
          w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
        );
        await w.t.settle();
        await act(async () =>
          w.held()[0]?.release({ ok: false, kind: "uncertain" }),
        );
        await w.t.settle();
        w.hold(false);
        await act(async () => w.t.remount());
        await w.t.settle();
        await w.t.until(() => kept() !== null);
        expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
        expect(w.sent).toHaveLength(1);
      },
    );

    test(
      `${caller}: answered (refused) while no settings were mounted (another screen shown): coming back shows the kept draft`,
      SLOW,
      async () => {
        const w = await opened(caller);
        await choose(w.t, "grant");
        await click(button(submitName(caller)));
        await act(async () => {
          await w.t.router.navigate({ to: "/tasks" });
        });
        await w.t.settle();
        expect(settings()).toBeNull();
        w.set(winnerOf(caller, true));
        await act(async () =>
          w.sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
        );
        await w.t.settle();
        await act(async () => {
          await w.t.router.navigate({
            to: `/tasks/${w.task.taskId}?occurrence=${w.task.occurrenceId}`,
          });
        });
        await w.t.settle();
        await w.t.until(() => kept() !== null);
        expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
        expect(w.sent).toHaveLength(1);
      },
    );
  }

  test(
    "enrolled: a kept draft (another version) is still kept after a remount, with its Discard",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await choose(w.t, "grant");
      w.set(winnerOf("enrolled", true));
      w.t.rerender(tasksEnv(w.api, { online: false }));
      await w.t.settle();
      w.t.rerender(tasksEnv(w.api));
      await w.t.settle();
      expect(kept()).not.toBeNull();
      await cycleTree(w, "enrolled", true);
      await w.t.until(() => kept() !== null);
      expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
      expect(
        within(kept() as HTMLElement).getByRole("button", {
          name: CONTROLS_COPY.discard,
        }),
      ).not.toBeNull();
    },
  );
});

describe("Q7: a first Join already begun keeps its own audience and consent whatever the defaults read says", () => {
  test(
    "consent No and the default audience chosen, remounted while the defaults now fail: shown again (Join enabled) and joined as chosen",
    SLOW,
    async () => {
      const defaults = defaultsReader();
      const w = await mountedFor("first join", { defaults });
      await w.t.until(() => grantOf(OTHER) !== null);
      await click(consentChoice(false));
      defaults.set({ kind: "failure" });
      await cycleTree(w, "first join", true);
      expect(consentChoice(false).checked).toBe(true);
      expect(grantOf(OTHER)).not.toBeNull();
      expect(settings().textContent).not.toContain(CONTROLS_COPY.defaultFailed);
      const join = button(CONTROLS_COPY.join) as HTMLButtonElement;
      expect(join.disabled).toBe(false);
      await click(join);
      expect(w.sent).toHaveLength(1);
      expect(w.sent[0]?.command).toMatchObject({
        expected_version: 0,
        active: true,
        aggregate_consent: false,
        initial_policy: SHARED,
      });
    },
  );

  test(
    "control: a first Join with nothing chosen, its defaults failing: nothing can be joined (never shown as Private)",
    SLOW,
    async () => {
      const defaults = defaultsReader({ kind: "failure" });
      const w = await mountedFor("first join", { defaults, ready: false });
      await w.t.until(
        () =>
          settings()?.textContent?.includes(CONTROLS_COPY.defaultFailed) ===
          true,
      );
      expect(settings().textContent).toContain(CONTROLS_COPY.defaultFailed);
      expect(document.querySelector("[data-enrol-consent]")).toBeNull();
      const join = button(CONTROLS_COPY.join) as HTMLButtonElement;
      expect(join.disabled).toBe(true);
      expect(reasonOf(join)).toContain(CONTROLS_COPY.audienceUnknown);
    },
  );
});

describe("Q8: a submitted revision that was not saved still holds Leave and the consent until it is saved or cancelled", () => {
  test(
    "invalid: Leave and the consent wait (finish first); Cancel, then Leave sends the settings read",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await click(button(CONTROLS_COPY.saveAudience));
      await act(async () =>
        w.sent[0]?.release({ ok: false, kind: "invalid", code: "invalid" }),
      );
      await w.t.settle();
      const leave = button(CONTROLS_COPY.leave) as HTMLButtonElement;
      expect(leave.disabled).toBe(true);
      expect(reasonOf(leave)).toContain(CONTROLS_COPY.finishFirst);
      expect(
        (
          within(settings()).getByRole("checkbox", {
            name: CONTROLS_COPY.consent,
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true);
      await click(leave);
      expect(w.sent).toHaveLength(1);
      await click(button(CONTROLS_COPY.cancel));
      await click(button(CONTROLS_COPY.leave));
      expect(w.sent).toHaveLength(2);
      expect(w.sent[1]?.command).toMatchObject({
        expected_version: 7,
        active: false,
        aggregate_consent: true,
        initial_policy: SHARED,
      });
    },
  );
});

describe("Q9: a retry submits what it submitted; a later revision or another editor session is never ended by its success", () => {
  test(
    "a later edit after the uncertain save, then Try again: the old body and key are resent; their success leaves the later draft kept",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await uncertainSubmit(w, "enrolled");
      await choose(w.t, "grant");
      const later = enrolmentDraftOf(IDENTITY, w.task.taskId);
      await click(
        within(
          document.querySelector("[data-enrolment-uncertain]") as HTMLElement,
        ).getByRole("button", { name: copy.TRY_AGAIN }),
      );
      expect(w.sent).toHaveLength(2);
      expect(w.sent[1]?.key).toBe(w.sent[0]?.key);
      expect(w.sent[1]?.command).toEqual(w.sent[0]?.command);
      expect(w.sent[1]?.command.initial_policy).toEqual(PRIVATE);
      await w.ack(w.t, 1);
      expect(settings().textContent).toContain(CONTROLS_COPY.saved);
      expect(settings().textContent).toContain(
        `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(PRIVATE)}`,
      );
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toEqual(later);
      expect(chosen("grant", kept() as HTMLElement)).not.toBeNull();
      expect(w.sent).toHaveLength(2);
    },
  );

  test(
    "Cancel and reopen after the uncertain save, the SAME audience chosen again: the old change's success does not end the new session",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await uncertainSubmit(w, "enrolled");
      const old = enrolmentDraftOf(IDENTITY, w.task.taskId);
      await click(button(CONTROLS_COPY.cancel));
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
      // The uncertain change is not forgotten by Cancel.
      expect(enrolmentAttemptOf(IDENTITY, w.task.taskId)?.phase).toBe(
        "uncertain",
      );
      await click(button(CONTROLS_COPY.changeAudience));
      await click(button("Only me (private)"));
      const reopened = enrolmentDraftOf(IDENTITY, w.task.taskId);
      expect(reopened?.session).not.toBe(old?.session);
      expect(reopened?.revision).toBe(old?.revision);
      expect(reopened?.policy).toEqual(old?.policy);
      await click(
        within(
          document.querySelector("[data-enrolment-uncertain]") as HTMLElement,
        ).getByRole("button", { name: copy.TRY_AGAIN }),
      );
      await w.ack(w.t, 1);
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toEqual(reopened);
      expect(kept()).not.toBeNull();
    },
  );
});

describe("Q14: another identity never inherits or revives a draft, an attempt or a lock", () => {
  test(
    "the POST held, the identity replaced, the other identity edits; the old answer then arrives: nothing of it reaches the new owner",
    SLOW,
    async () => {
      const w = await opened("enrolled");
      await click(button(CONTROLS_COPY.saveAudience));
      w.t.rerender(tasksEnv(w.api, { identity: `${OTHER}:1`, accountId: ME }));
      await w.t.until(() => button(CONTROLS_COPY.changeAudience) !== null);
      await click(button(CONTROLS_COPY.changeAudience));
      await click(button("Only me (private)"));
      const theirs = enrolmentDraftOf(`${OTHER}:1`, w.task.taskId);
      expect(theirs?.revision).toBe(1);
      await act(async () =>
        w.sent[0]?.release({ ok: true, value: { revision: 9 } }),
      );
      await w.t.settle();
      // The other identity's draft and freedom are untouched by the late answer (it found no owner).
      expect(enrolmentDraftOf(`${OTHER}:1`, w.task.taskId)).toEqual(theirs);
      expect(button(CONTROLS_COPY.cancel)?.disabled).toBe(false);
      // And the first identity, shown again, starts with nothing of its own (no draft, attempt or lock).
      w.t.rerender(tasksEnv(w.api));
      await w.t.until(() => button(CONTROLS_COPY.changeAudience) !== null);
      expect(document.querySelector("[data-audience-chooser]")).toBeNull();
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
      expect(enrolmentAttemptOf(IDENTITY, w.task.taskId)).toBeNull();
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
      expect(w.sent).toHaveLength(1);
    },
  );
});

describe("Q15: a full page refuses a NEW draft or change with why, and never drops one it holds", () => {
  test(
    "no room: Change… and Leave are disabled with why and nothing is sent; control: room again, both work",
    SLOW,
    async () => {
      forgetTaskMemory(0);
      const w = await mountedFor("enrolled");
      for (const name of [CONTROLS_COPY.changeAudience, CONTROLS_COPY.leave]) {
        const control = button(name) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(reasonOf(control)).toContain(CONTROLS_COPY.full);
        await click(control);
      }
      expect(enrolmentDraftOf(IDENTITY, w.task.taskId)).toBeNull();
      expect(w.sent).toHaveLength(0);
      forgetTaskMemory();
      await act(async () => w.t.remount());
      await shownAgain(w as World, "enrolled");
      await click(button(CONTROLS_COPY.changeAudience));
      expect(document.querySelector("[data-audience-chooser]")).not.toBeNull();
    },
  );
});
