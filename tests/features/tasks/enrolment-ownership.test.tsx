/**
 * WEB-10a revision 11 (R23, `task-save-acknowledgement-consumes-newer-edits`; design assessment C1-C3, S1-S9, S13; DA-1): an enrolment
 * change OWNS the settings from the moment it is admitted until a read asked after its answer is accepted. Meanwhile no audience or consent
 * edit is accepted (an already open directory lookup included: its Choose buttons are disabled and say why), nothing else is sent, and an
 * edit is refused when it HAPPENS (a control rendered before the change was sent may still be pressed in the same turn). So neither the
 * answer nor the read that follows can consume an edit that was not sent. A draft with edits not yet sent is never dropped by a read nor
 * moved onto another version; an offline retry is not a definite answer. Composed through the production task detail, over the real data
 * env's defaults source and the sharing env's chooser, with every POST and (where named) every read held until released.
 *
 * Review 11's original probes, run unchanged against this revision, are kept in `.agtx/evidence/web10a-revision-11/r23-reviewer-probes/`:
 * their controls pass and each failing case now stops at its PRECONDITION (the Choose button is disabled; the editor is frozen during the
 * follow-up read), the changed precondition this design intends; the accepted-then-lost input they caught can no longer arise.
 */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Policy } from "../../../src/data";
import * as sharingCopy from "../../../src/features/sharing/copy";
import type {
  EnrolCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import * as copy from "../../../src/features/tasks/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import {
  enrolmentAttemptOf,
  forgetTaskMemory,
} from "../../../src/features/tasks/memory";
import type { Enrolment } from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
import { FLAT, HOME, household, snapshot } from "../../support/data/sharing";
import { fakeSharingApi, ok } from "../../support/sharing/fake-api";
import {
  fakeApi,
  ME,
  type Mounted,
  mountTasks,
  OTHER,
  seededTask,
  tasksEnv,
} from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const SLOW = { timeout: 30_000 };
const THIRD = "33333333-3333-4333-8333-333333333333";
const READER = "review-reader";
const PRIVATE: Policy = { grants: [], exclude_accounts: [] };
const SHARED: Policy = {
  grants: [{ kind: "account", id: OTHER, edit: false }],
  exclude_accounts: [],
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Sent {
  command: EnrolCommand;
  key: string;
  release(result: TasksResult<{ revision: number }>): void;
}
interface Read {
  /** The state when it was asked. */
  asked: Enrolment;
  release(answer?: TasksResult<Enrolment>): void;
  done: boolean;
}

/** One enrolment at a server: every change is recorded and HELD; reads answer at once, or are held while `hold` is on. */
function server(initial: Enrolment) {
  let current = clone(initial);
  let hold = false;
  const sent: Sent[] = [];
  const reads: Read[] = [];
  const api = fakeApi({
    readEnrolment: () => {
      const asked = clone(current);
      if (!hold) {
        reads.push({ asked, release: () => undefined, done: true });
        return Promise.resolve({ ok: true, value: asked });
      }
      return new Promise((resolve) => {
        const read: Read = {
          asked,
          done: false,
          release: (answer) => {
            read.done = true;
            resolve(answer ?? { ok: true, value: asked });
          },
        };
        reads.push(read);
      });
    },
    enrol: (command, key) =>
      new Promise((resolve) =>
        sent.push({ command: clone(command), key, release: resolve }),
      ),
  });
  return {
    api,
    sent,
    reads,
    held: () => reads.filter((r) => !r.done),
    hold(on: boolean) {
      hold = on;
    },
    set(next: Enrolment) {
      current = clone(next);
    },
    /** Commits change `i` (the next version, its body) and answers it. */
    async ack(t: Mounted, i = 0) {
      const command = sent[i]?.command as EnrolCommand;
      current = {
        version: current.version + 1,
        active: command.active,
        aggregate_consent: command.aggregate_consent,
        policy: clone(command.initial_policy),
      };
      await act(async () =>
        sent[i]?.release({ ok: true, value: { revision: 50 + i } }),
      );
      await t.settle();
    },
  };
}

type Caller = "enrolled" | "rejoin" | "first join";
const CALLERS: Caller[] = ["enrolled", "rejoin", "first join"];

const settings = () =>
  document.querySelector("[data-enrolment]") as HTMLElement;
const inSettings = () => within(settings());
const button = (name: string) =>
  settings() === null
    ? null
    : (inSettings().queryByRole("button", {
        name,
      }) as HTMLButtonElement | null);
const chooseButtons = () =>
  settings() === null
    ? []
    : (inSettings().queryAllByRole("button", {
        name: `${sharingCopy.LOOKUP_CHOOSE}: ${READER}`,
      }) as HTMLButtonElement[]);
/** The text a disabled control is described by (its reason first). */
const reasonOf = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    fireEvent.click(element as HTMLElement);
  });
}
const grantOf = (id: string) =>
  settings().querySelector(`[data-grant="account"][data-principal="${id}"]`);
const exclusionOf = (id: string) =>
  settings().querySelector(`[data-exclusion="${id}"]`);
const submitName = (caller: Caller) =>
  caller === "enrolled" ? CONTROLS_COPY.saveAudience : CONTROLS_COPY.join;

/**
 * The caller's audience editor, opened, with "Only me" chosen (a change from the shared audience it starts from): enrolled, "Change…";
 * rejoining, the last audience; the first Join, the current default (an account grant here), the consent "Yes" chosen in both joins.
 */
async function opened(caller: Caller, options: { households?: boolean } = {}) {
  const task = await seededTask({ definition: { participation: "everyone" } });
  const s = server(
    caller === "first join"
      ? { version: 0, active: false, aggregate_consent: false, policy: PRIVATE }
      : {
          version: 7,
          active: caller === "enrolled",
          aggregate_consent: true,
          policy: SHARED,
        },
  );
  // The directory and (when asked) two households, answered from the first read of the chooser on.
  const sharing = fakeSharingApi();
  sharing.defaults.lookup = () => ok([{ id: THIRD, username: READER }]);
  if (options.households)
    sharing.defaults.households = ok([
      household({ id: HOME, name: "Home" }),
      household({ id: FLAT, name: "Flat" }),
    ]);
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    api: s.api,
    sharing,
    defaultsSnapshot: async () => ({
      kind: "ok",
      value: snapshot({
        templates: { progress: { kind: "explicit", policy: SHARED } },
      }),
    }),
  });
  await t.until(() =>
    caller === "enrolled"
      ? button(CONTROLS_COPY.leave) !== null
      : document.querySelector("[data-enrol-consent]") !== null,
  );
  if (caller === "enrolled") await click(button(CONTROLS_COPY.changeAudience));
  else
    await click(
      inSettings().getByRole("radio", { name: CONTROLS_COPY.consentYes }),
    );
  await t.until(
    () => document.querySelector("[data-audience-chooser]") !== null,
  );
  await click(button("Only me (private)"));
  expect(grantOf(OTHER)).toBeNull();
  return { task, t, ...s };
}

/** Opens the directory lookup for `purpose` and finds the account in BOTH result lists (search and exact username). */
async function lookup(t: Mounted, purpose: "grant" | "exclude") {
  await click(
    button(
      purpose === "grant" ? sharingCopy.ADD_ACCOUNT : sharingCopy.ADD_EXCLUSION,
    ),
  );
  await act(async () => {
    fireEvent.change(
      inSettings().getByLabelText(sharingCopy.LOOKUP_SEARCH_LABEL),
      { target: { value: "review" } },
    );
    fireEvent.change(
      inSettings().getByLabelText(sharingCopy.LOOKUP_EXACT_LABEL),
      { target: { value: READER } },
    );
  });
  await click(button(sharingCopy.LOOKUP_SEARCH_BUTTON));
  await click(button(sharingCopy.LOOKUP_EXACT_BUTTON));
  await t.until(() => chooseButtons().length === 2);
  expect(chooseButtons()).toHaveLength(2);
  for (const choose of chooseButtons()) expect(choose.disabled).toBe(false);
}

const chosen = (purpose: "grant" | "exclude") =>
  purpose === "grant" ? grantOf(THIRD) : exclusionOf(THIRD);

/** After the cycle: the submitted private audience is shown and nothing chosen afterwards exists anywhere. */
function reconciledPrivate() {
  expect(document.querySelector("[data-audience-chooser]")).toBeNull();
  expect(settings().textContent).toContain(
    `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(PRIVATE)}`,
  );
  expect(grantOf(THIRD)).toBeNull();
  expect(exclusionOf(THIRD)).toBeNull();
  expect(document.querySelector("[data-enrol-kept]")).toBeNull();
}

describe("S1/S2 controls: with no later edit, each caller's change completes and the settings can be edited again", () => {
  for (const caller of CALLERS)
    test(
      `${caller}: the submitted private audience is saved and shown; afterwards a lookup choice is accepted`,
      SLOW,
      async () => {
        const { t, sent, ack } = await opened(caller);
        await click(button(submitName(caller)));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.command.initial_policy).toEqual(PRIVATE);
        await ack(t);
        reconciledPrivate();
        expect(settings().textContent).toContain(CONTROLS_COPY.saved);
        // Not locked for ever: the next edit is possible, a lookup choice included.
        await click(button(CONTROLS_COPY.changeAudience));
        await lookup(t, "grant");
        await click(chooseButtons()[0] as HTMLElement);
        expect(grantOf(THIRD)).not.toBeNull();
        expect(sent).toHaveLength(1);
      },
    );
});

describe("S1: while the change is being sent, an open lookup's Choose is disabled with why; nothing later is accepted or sent", () => {
  for (const caller of CALLERS)
    for (const purpose of ["grant", "exclude"] as const)
      test(
        `${caller} × ${purpose}: Save/Join with the lookup open; both result lists' Choose are disabled until the change is confirmed`,
        SLOW,
        async () => {
          const { t, sent, ack } = await opened(caller);
          await lookup(t, purpose);
          await click(button(submitName(caller)));
          expect(sent).toHaveLength(1);
          expect(sent[0]?.command.initial_policy).toEqual(PRIVATE);
          expect(chooseButtons()).toHaveLength(2);
          for (const choose of chooseButtons()) {
            expect(choose.disabled).toBe(true);
            expect(reasonOf(choose)).toContain(CONTROLS_COPY.sending);
            await click(choose);
          }
          expect(chosen(purpose)).toBeNull();
          await ack(t);
          reconciledPrivate();
          expect(sent).toHaveLength(1);
        },
      );
});

describe("S2: after the answer and until the read that follows it is accepted, the settings stay frozen", () => {
  for (const caller of CALLERS)
    for (const purpose of ["grant", "exclude"] as const)
      test(
        `${caller} × ${purpose}: the POST answered, its read held: Choose stays disabled (checking), Back leads to a frozen editor; the read ends it`,
        SLOW,
        async () => {
          const { t, sent, ack, hold, held } = await opened(caller);
          await lookup(t, purpose);
          await click(button(submitName(caller)));
          hold(true);
          await ack(t);
          expect(held()).toHaveLength(1);
          for (const choose of chooseButtons()) {
            expect(choose.disabled).toBe(true);
            expect(reasonOf(choose)).toContain(CONTROLS_COPY.confirming);
          }
          // Back to the editor: nothing in it can be added, removed or reset, and Save/Join waits too.
          await click(button(`‹ ${sharingCopy.LOOKUP_BACK}`));
          expect(button(sharingCopy.ADD_ACCOUNT)).toBeNull();
          expect(button(sharingCopy.ADD_EXCLUSION)).toBeNull();
          expect(button("Only me (private)")).toBeNull();
          const submit = button(submitName(caller)) as HTMLButtonElement;
          expect(submit.disabled).toBe(true);
          expect(reasonOf(submit)).toContain(CONTROLS_COPY.confirming);
          await click(submit);
          expect(chosen(purpose)).toBeNull();
          await act(async () => held()[0]?.release());
          await t.settle();
          reconciledPrivate();
          expect(sent).toHaveLength(1);
        },
      );
});

describe("S5: a choice made in the same turn as Save/Join (before anything re-renders) is refused when it happens", () => {
  for (const caller of CALLERS)
    test(
      `${caller}: Save/Join then Choose, one turn: the change sent is the captured one and the choice is not accepted`,
      SLOW,
      async () => {
        const { t, sent, ack } = await opened(caller);
        await lookup(t, "grant");
        const submit = button(submitName(caller)) as HTMLButtonElement;
        const choose = chooseButtons()[0] as HTMLButtonElement;
        await act(async () => {
          fireEvent.click(submit);
          // Still the enabled Choose rendered before the change was sent.
          fireEvent.click(choose);
        });
        expect(sent).toHaveLength(1);
        expect(sent[0]?.command.initial_policy).toEqual(PRIVATE);
        // The stale Choose handler ran (it returned to the editor), but the edit it carried was refused.
        expect(button(`‹ ${sharingCopy.LOOKUP_BACK}`)).toBeNull();
        expect(document.querySelector("[data-grants-editor]")).not.toBeNull();
        expect(grantOf(THIRD)).toBeNull();
        await ack(t);
        reconciledPrivate();
        expect(sent).toHaveLength(1);
      },
    );

  test(
    "enrolled: Save pressed twice in one turn and again after: one change, one key",
    SLOW,
    async () => {
      const { t, sent, ack } = await opened("enrolled");
      const save = button(CONTROLS_COPY.saveAudience) as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(save);
        fireEvent.click(save);
      });
      await click(button(CONTROLS_COPY.saveAudience));
      expect(sent).toHaveLength(1);
      await ack(t);
      expect(sent).toHaveLength(1);
    },
  );
});

describe("S3: every editing control is frozen while the change is sent and while it is confirmed", () => {
  /** Every writer of the audience/consent in the section is absent or disabled, with the lock's reason on the actions. */
  function frozen(reason: string, caller: Caller) {
    for (const name of [
      "Only me (private)",
      sharingCopy.ADD_ACCOUNT,
      sharingCopy.ADD_HOUSEHOLD,
      sharingCopy.ADD_EXCLUSION,
      "Home",
      "Flat",
    ])
      expect(button(name)).toBeNull();
    expect(
      inSettings().queryAllByRole("button", {
        name: new RegExp(
          `^(${sharingCopy.REMOVE}|${sharingCopy.REMOVE_EXCLUSION}):`,
        ),
      }),
    ).toEqual([]);
    for (const radio of settings().querySelectorAll<HTMLInputElement>(
      "[data-grants-editor] input",
    ))
      expect(radio.disabled).toBe(true);
    for (const input of settings().querySelectorAll<HTMLInputElement>(
      "[data-enrol-consent] input, input[type=checkbox]",
    ))
      expect(input.disabled).toBe(true);
    const actions =
      caller === "enrolled"
        ? [
            CONTROLS_COPY.leave,
            CONTROLS_COPY.cancel,
            CONTROLS_COPY.saveAudience,
          ]
        : [CONTROLS_COPY.join];
    for (const name of actions) {
      const control = button(name) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      expect(reasonOf(control)).toContain(reason);
    }
  }

  for (const caller of ["enrolled", "rejoin"] as const)
    test(
      `${caller}: grants (account, household), Read/Edit, removal, exclusion, household picker, consent and Cancel`,
      SLOW,
      async () => {
        const { t, sent, ack, hold, held } = await opened(caller, {
          households: true,
        });
        // A household grant, an account grant with Edit, an exclusion: every kind of row and control exists before the change.
        await click(button(sharingCopy.ADD_HOUSEHOLD));
        await t.until(() => button("Home") !== null);
        await click(button("Home"));
        await lookup(t, "grant");
        await click(chooseButtons()[0] as HTMLElement);
        const row = grantOf(THIRD) as HTMLElement;
        await click(within(row).getByRole("radio", { name: sharingCopy.EDIT }));
        await lookup(t, "exclude");
        await click(chooseButtons()[1] as HTMLElement);
        expect(exclusionOf(THIRD)).not.toBeNull();
        // The household picker open when the change is sent.
        await click(button(sharingCopy.ADD_HOUSEHOLD));
        expect(button("Flat")).not.toBeNull();
        await click(button(submitName(caller)));
        expect(sent).toHaveLength(1);
        const expected: Policy = {
          grants: [
            { kind: "household", id: HOME, edit: false },
            { kind: "account", id: THIRD, edit: true },
          ],
          exclude_accounts: [THIRD],
        };
        expect(sent[0]?.command.initial_policy).toEqual(expected);
        frozen(CONTROLS_COPY.sending, caller);
        hold(true);
        await ack(t);
        frozen(CONTROLS_COPY.confirming, caller);
        await act(async () => held()[0]?.release());
        await t.settle();
        // Confirmed: the audience saved is shown, and the settings can be changed again.
        expect(document.querySelector("[data-audience-chooser]")).toBeNull();
        expect(settings().textContent).toContain(
          CONTROLS_COPY.audienceLine(expected),
        );
        expect(
          (button(CONTROLS_COPY.changeAudience) as HTMLButtonElement).disabled,
        ).toBe(false);
        expect(sent).toHaveLength(1);
      },
    );
});

describe("S4: Leave and the consent wait while an audience edit is unsaved", () => {
  test(
    "an unsaved edit: Leave and the consent are disabled with why; Cancel discards it and Leave sends the audience read",
    SLOW,
    async () => {
      const { t, sent } = await opened("enrolled");
      const leave = button(CONTROLS_COPY.leave) as HTMLButtonElement;
      expect(leave.disabled).toBe(true);
      expect(reasonOf(leave)).toContain(CONTROLS_COPY.finishFirst);
      expect(
        (
          inSettings().getByRole("checkbox", {
            name: CONTROLS_COPY.consent,
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true);
      await click(leave);
      expect(sent).toHaveLength(0);
      await click(button(CONTROLS_COPY.cancel));
      await click(button(CONTROLS_COPY.leave));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.command).toMatchObject({
        expected_version: 7,
        active: false,
        initial_policy: SHARED,
      });
      await t.settle();
    },
  );

  test(
    "control: the editor open but not edited: Leave is one action, and its answer closes the editor",
    SLOW,
    async () => {
      const task = await seededTask({
        definition: { participation: "everyone" },
      });
      const s = server({
        version: 7,
        active: true,
        aggregate_consent: true,
        policy: SHARED,
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        api: s.api,
      });
      await t.until(() => button(CONTROLS_COPY.leave) !== null);
      await click(button(CONTROLS_COPY.changeAudience));
      await click(button(CONTROLS_COPY.leave));
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0]?.command.initial_policy).toEqual(SHARED);
      await s.ack(t);
      // The rejoin form, from the audience read; nothing of the editor that was open is carried over or kept.
      expect(button(CONTROLS_COPY.join)).not.toBeNull();
      expect(document.querySelector("[data-enrol-kept]")).toBeNull();
      expect(
        (
          inSettings().getByRole("radio", {
            name: CONTROLS_COPY.consentYes,
          }) as HTMLInputElement
        ).checked,
      ).toBe(false);
      expect(grantOf(OTHER)).not.toBeNull();
    },
  );
});

describe("S6: a read asked before the change was answered neither shows nor ends anything", () => {
  /** Enrolled, a read asked BEFORE the change (by the connection dropping and returning) with another state, held. */
  async function early() {
    const w = await opened("enrolled");
    w.set({
      version: 7,
      active: true,
      aggregate_consent: false,
      policy: SHARED,
    });
    w.hold(true);
    w.t.rerender(tasksEnv(w.api, { online: false }));
    await w.t.settle();
    w.t.rerender(tasksEnv(w.api));
    await w.t.until(() => w.held().length === 1);
    expect(w.held()).toHaveLength(1);
    w.set({
      version: 7,
      active: true,
      aggregate_consent: true,
      policy: SHARED,
    });
    // Back to the editor: the remount of the hidden section kept the draft.
    expect(document.querySelector("[data-audience-chooser]")).not.toBeNull();
    await click(button(CONTROLS_COPY.saveAudience));
    await w.ack(w.t);
    expect(w.held()).toHaveLength(2);
    return w;
  }
  const consentBox = () =>
    inSettings().getByRole("checkbox", {
      name: CONTROLS_COPY.consent,
    }) as HTMLInputElement;

  test(
    "the early read answers first: not shown, the settings stay frozen; the read after the answer ends the cycle",
    SLOW,
    async () => {
      const { t, held, sent } = await early();
      const [before, after] = held();
      await act(async () => before?.release());
      await t.settle();
      expect(consentBox().checked).toBe(true);
      expect(button(CONTROLS_COPY.cancel)?.disabled).toBe(true);
      await act(async () => after?.release());
      await t.settle();
      reconciledPrivate();
      expect(consentBox().checked).toBe(true);
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
      expect(sent).toHaveLength(1);
    },
  );

  test(
    "the early read answers last: what the later read showed stays",
    SLOW,
    async () => {
      const { t, held } = await early();
      const [before, after] = held();
      await act(async () => after?.release());
      await t.settle();
      reconciledPrivate();
      await act(async () => before?.release());
      await t.settle();
      reconciledPrivate();
      expect(consentBox().checked).toBe(true);
    },
  );

  test(
    "control: a read asked and answered with nothing pending is shown",
    SLOW,
    async () => {
      const task = await seededTask({
        definition: { participation: "everyone" },
      });
      const s = server({
        version: 7,
        active: true,
        aggregate_consent: true,
        policy: SHARED,
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        api: s.api,
      });
      await t.until(() => button(CONTROLS_COPY.leave) !== null);
      s.set({
        version: 8,
        active: true,
        aggregate_consent: false,
        policy: PRIVATE,
      });
      t.rerender(tasksEnv(s.api, { online: false }));
      await t.settle();
      t.rerender(tasksEnv(s.api));
      await t.settle();
      expect(consentBox().checked).toBe(false);
      reconciledPrivate();
    },
  );
});

describe("S7: the cycle belongs to the page, not to the mounted screen", () => {
  async function remount(t: Mounted, path: string) {
    await act(async () => {
      await t.router.navigate({ to: "/tasks" });
    });
    await act(async () => {
      await t.router.navigate({ to: path });
    });
    await t.settle();
  }

  test(
    "remounted between the answer and its read: still frozen, nothing more sent; the remount's read ends the cycle once",
    SLOW,
    async () => {
      const { task, t, sent, ack, hold, held } = await opened("enrolled");
      await click(button(CONTROLS_COPY.saveAudience));
      hold(true);
      await ack(t);
      expect(held()).toHaveLength(1);
      const path = `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`;
      await remount(t, path);
      // (StrictMode mounts the screen twice, so its read may be asked twice: one is ignored.)
      await t.until(() => held().length >= 2);
      const change = button(CONTROLS_COPY.changeAudience);
      // The remounted screen's own read is held: it shows nothing yet, or (had it a state to show) nothing it can change.
      if (change !== null) {
        expect(change.disabled).toBe(true);
        expect(reasonOf(change)).toContain(CONTROLS_COPY.confirming);
      } else expect(settings().textContent).toContain(CONTROLS_COPY.loading);
      const [first, ...remounted] = held();
      await act(async () => {
        for (const read of remounted.reverse()) read.release();
      });
      await t.settle();
      reconciledPrivate();
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
      await act(async () => first?.release());
      await t.settle();
      reconciledPrivate();
      expect(sent).toHaveLength(1);
    },
  );

  test(
    "answered while no settings screen was mounted: the next mount is frozen until its own read, then free",
    SLOW,
    async () => {
      const { task, t, sent, ack, hold, held } = await opened("enrolled");
      await click(button(CONTROLS_COPY.saveAudience));
      await act(async () => {
        await t.router.navigate({ to: "/tasks" });
      });
      await t.settle();
      hold(true);
      await ack(t);
      await act(async () => {
        await t.router.navigate({
          to: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        });
      });
      await t.until(() => held().length >= 1);
      expect(button(CONTROLS_COPY.changeAudience)).toBeNull();
      await act(async () => {
        for (const read of held().reverse()) read.release();
      });
      await t.settle();
      reconciledPrivate();
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
      expect(sent).toHaveLength(1);
    },
  );
});

describe("S8/DA-1: an uncertain change stays uncertain until a definite answer; an offline retry is not one", () => {
  async function uncertainLeave() {
    const task = await seededTask({
      definition: { participation: "everyone" },
    });
    const s = server({
      version: 7,
      active: true,
      aggregate_consent: true,
      policy: SHARED,
    });
    const t = await mountTasks({
      path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
      rows: task.rows,
      api: s.api,
    });
    await t.until(() => button(CONTROLS_COPY.leave) !== null);
    await click(button(CONTROLS_COPY.leave));
    await act(async () => s.sent[0]?.release({ ok: false, kind: "uncertain" }));
    await t.settle();
    expect(document.querySelector("[data-enrolment-uncertain]")).not.toBeNull();
    return { task, t, ...s };
  }

  test(
    "Try again finds the page offline: the attempt keeps its body and key, no refusal is claimed; the next Try again resends them",
    SLOW,
    async () => {
      const { task, t, sent } = await uncertainLeave();
      await click(button(copy.TRY_AGAIN));
      expect(sent).toHaveLength(2);
      await act(async () => sent[1]?.release({ ok: false, kind: "offline" }));
      await t.settle();
      const held = enrolmentAttemptOf(`${ME}:1`, task.taskId);
      expect(held?.phase).toBe("uncertain");
      expect(held?.key).toBe(sent[0]?.key);
      expect(
        document.querySelector("[data-enrolment-uncertain]"),
      ).not.toBeNull();
      expect(settings().textContent).not.toContain(CONTROLS_COPY.enrolRefused);
      await click(button(copy.TRY_AGAIN));
      expect(sent).toHaveLength(3);
      expect(sent[2]?.key).toBe(sent[0]?.key);
      expect(sent[2]?.command).toEqual(sent[0]?.command);
    },
  );

  test(
    "control: a definite refusal of the retry ends the attempt",
    SLOW,
    async () => {
      const { task, t, sent } = await uncertainLeave();
      await click(button(copy.TRY_AGAIN));
      await act(async () =>
        sent[1]?.release({ ok: false, kind: "conflict", code: "conflict" }),
      );
      await t.settle();
      expect(enrolmentAttemptOf(`${ME}:1`, task.taskId)).toBeNull();
      expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
      expect(settings().textContent).toContain(CONTROLS_COPY.enrolRefused);
    },
  );

  for (const kind of ["not_sent", "closed"] as const)
    test(`control: ${kind} keeps the attempt too`, SLOW, async () => {
      const { task, t, sent } = await uncertainLeave();
      await click(button(copy.TRY_AGAIN));
      await act(async () => sent[1]?.release({ ok: false, kind }));
      await t.settle();
      expect(enrolmentAttemptOf(`${ME}:1`, task.taskId)?.key).toBe(
        sent[0]?.key,
      );
    });
});

describe("S8: a draft with edits after the one sent is kept, unsaved, when a later read shows another version", () => {
  /** Enrolled: "Only me" saved, answered uncertain; the read shows it did not commit (yet). */
  async function uncertainSave() {
    const w = await opened("enrolled");
    await click(button(CONTROLS_COPY.saveAudience));
    await act(async () => w.sent[0]?.release({ ok: false, kind: "uncertain" }));
    await w.t.settle();
    expect(document.querySelector("[data-audience-chooser]")).not.toBeNull();
    return w;
  }
  /** The earlier change committed after all; the next read (the connection drops and returns) shows it. */
  async function lateCommit(w: Awaited<ReturnType<typeof uncertainSave>>) {
    w.set({
      version: 8,
      active: true,
      aggregate_consent: true,
      policy: PRIVATE,
    });
    w.t.rerender(tasksEnv(w.api, { online: false }));
    await w.t.settle();
    w.t.rerender(tasksEnv(w.api));
    await w.t.settle();
  }

  test(
    "a choice after the uncertain save is kept as an unsaved change of version 7, never sent onto 8; Discard is explicit",
    SLOW,
    async () => {
      const w = await uncertainSave();
      await lookup(w.t, "grant");
      await click(chooseButtons()[0] as HTMLElement);
      expect(grantOf(THIRD)).not.toBeNull();
      await lateCommit(w);
      const kept = document.querySelector("[data-enrol-kept]") as HTMLElement;
      expect(kept).not.toBeNull();
      expect(kept.textContent).toContain(CONTROLS_COPY.keptDraft);
      expect(kept.querySelector(`[data-principal="${THIRD}"]`)).not.toBeNull();
      // It cannot be sent, and nothing else changes while it is kept.
      expect(
        within(kept).queryByRole("button", {
          name: CONTROLS_COPY.saveAudience,
        }),
      ).toBeNull();
      for (const name of [CONTROLS_COPY.leave, CONTROLS_COPY.changeAudience]) {
        const control = button(name) as HTMLButtonElement;
        expect(control.disabled).toBe(true);
        expect(reasonOf(control)).toContain(CONTROLS_COPY.discardFirst);
      }
      expect(settings().textContent).toContain(
        `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(PRIVATE)}`,
      );
      expect(w.sent).toHaveLength(1);
      await click(
        within(kept).getByRole("button", { name: CONTROLS_COPY.discard }),
      );
      expect(document.querySelector("[data-enrol-kept]")).toBeNull();
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
      expect(w.sent).toHaveLength(1);
    },
  );

  test(
    "control: with no edit after the save, the read that shows its version ends the draft",
    SLOW,
    async () => {
      const w = await uncertainSave();
      await lateCommit(w);
      reconciledPrivate();
      expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
    },
  );
});

describe("S9: a failed read after the answer leaves the change unconfirmed, with a read retry that never sends", () => {
  for (const kind of ["uncertain", "forbidden", "not_found"] as const)
    test(
      `the follow-up read fails (${kind}): unavailable with Try again; Try again reads, then the settings are free`,
      SLOW,
      async () => {
        const { t, sent, ack, hold, held } = await opened("enrolled");
        await click(button(CONTROLS_COPY.saveAudience));
        hold(true);
        await ack(t);
        await act(async () =>
          held()[0]?.release(
            kind === "uncertain"
              ? { ok: false, kind }
              : { ok: false, kind, code: kind },
          ),
        );
        await t.settle();
        expect(settings().textContent).toContain(
          CONTROLS_COPY.enrolUnavailable,
        );
        expect(button(CONTROLS_COPY.changeAudience)).toBeNull();
        expect(settings().textContent).not.toContain(
          CONTROLS_COPY.saveAudience,
        );
        hold(false);
        await click(button(copy.TRY_AGAIN));
        await t.settle();
        reconciledPrivate();
        expect(button(CONTROLS_COPY.changeAudience)?.disabled).toBe(false);
        expect(sent).toHaveLength(1);
      },
    );

  test(
    "the follow-up read is closed: the settings stay frozen (never shown as saved and free); the next read ends the cycle",
    SLOW,
    async () => {
      const { t, sent, ack, hold, held } = await opened("enrolled");
      await click(button(CONTROLS_COPY.saveAudience));
      hold(true);
      await ack(t);
      await act(async () => held()[0]?.release({ ok: false, kind: "closed" }));
      await t.settle();
      const cancel = button(CONTROLS_COPY.cancel) as HTMLButtonElement;
      expect(cancel.disabled).toBe(true);
      expect(reasonOf(cancel)).toContain(CONTROLS_COPY.confirming);
      hold(false);
      t.rerender(tasksEnv(t.api, { online: false }));
      await t.settle();
      t.rerender(tasksEnv(t.api));
      await t.settle();
      reconciledPrivate();
      expect(sent).toHaveLength(1);
    },
  );
});

describe("S13: a draft belongs to its identity", () => {
  test(
    "another identity never sees the first one's unsaved audience edit",
    SLOW,
    async () => {
      const { t, sent, api } = await opened("enrolled");
      expect(document.querySelector("[data-audience-chooser]")).not.toBeNull();
      t.rerender(tasksEnv(api, { identity: `${OTHER}:1`, accountId: ME }));
      await t.until(() => button(CONTROLS_COPY.changeAudience) !== null);
      expect(document.querySelector("[data-audience-chooser]")).toBeNull();
      expect(button(CONTROLS_COPY.leave)?.disabled).toBe(false);
      expect(sent).toHaveLength(0);
    },
  );
});

describe("X4: the frozen lookup is accessible (jsdom layer; no manual assistive-technology claim)", () => {
  test(
    "each disabled Choose is described by its reason; the section has no axe violations",
    SLOW,
    async () => {
      const { axe } = await import("jest-axe");
      const { t, ack } = await opened("enrolled");
      await lookup(t, "grant");
      await click(button(CONTROLS_COPY.saveAudience));
      for (const choose of chooseButtons())
        expect(reasonOf(choose)).toContain(CONTROLS_COPY.sending);
      expect((await axe(settings())).violations).toEqual([]);
      await ack(t);
      void screen;
    },
  );
});
