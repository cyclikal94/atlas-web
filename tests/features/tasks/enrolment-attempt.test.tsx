/**
 * WEB-10a revision 4 (R11, `task-enrolment-attempt-ownership`; design assessment C4, schedules E1–E4): one enrolment change is ONE attempt
 * with one Idempotency-Key, owned synchronously before the request: a repeated activation while it is pending sends nothing, an uncertain
 * answer keeps the exact command and key for Try again, a remount keeps the pending attempt, another identity never sees it, a read answered
 * while a change is pending is not shown, and a reload (fresh page memory) resends nothing. Composed through the production task detail.
 *
 * ADAPTATION, revision 10 (R22; task `states.md` R2/F1): joining now asks the aggregate-consent question explicitly before Join (the
 * approved interface), so a Join here first chooses "Yes" (`chooseConsent`), the consent these cases' enrolments held; and while the
 * enrolment is not active the consent is that choice, not a checkbox. Each old assertion keeps its intent: a disabled checkbox while pending
 * maps to the disabled consent choice; "the stale read is not shown" is observed on what the read would change on screen (an active
 * enrolment's Leave and checkbox), its stale state now an ACTIVE enrolment so that showing it is visible. Every command now carries the
 * policy that was read (`initial_policy`). The pre-adaptation file and its failing run are kept in
 * `.agtx/evidence/web10a-revision-10/pre-adaptation/`.
 */
import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  EnrolCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import * as copy from "../../../src/features/tasks/copy";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import { forgetAllCorrections } from "../../../src/features/tasks/detail/CorrectionDialog";
import { forgetTaskMemory } from "../../../src/features/tasks/memory";
import type { Enrolment as Full } from "../../../src/features/tasks/model/contract";
import { installMatchMedia } from "../../helpers/match-media";
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

/** The enrolment as these cases vary it (its sharing policy is never part of the change). */
type Enrolment = Omit<Full, "policy">;
const POLICY = { grants: [], exclude_accounts: [] } as Full["policy"];

interface Sent {
  command: EnrolCommand;
  key: string;
  release(result: TasksResult<{ revision: number }>): void;
}

/** An enrolment endpoint: reads answer `current` (a read may be held), every change is recorded and HELD until released. */
function enrolmentApi(initial: Enrolment) {
  let current = initial;
  const sent: Sent[] = [];
  const reads: Array<{ release(): void } | null> = [];
  let holdReads = false;
  const api = fakeApi({
    readEnrolment: async () => {
      if (holdReads) {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        reads.push({ release });
        const asked = current;
        await held;
        return { ok: true, value: { ...asked, policy: POLICY } };
      }
      reads.push(null);
      return { ok: true, value: { ...current, policy: POLICY } };
    },
    enrol: (command, key) =>
      new Promise((resolve) => sent.push({ command, key, release: resolve })),
  });
  return {
    api,
    sent,
    reads,
    set: (next: Enrolment) => {
      current = next;
    },
    holdReads: (on: boolean) => {
      holdReads = on;
    },
  };
}

async function mounted(initial: Enrolment) {
  const task = await seededTask({ definition: { participation: "everyone" } });
  const e = enrolmentApi(initial);
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    api: e.api,
  });
  await t.until(
    () =>
      screen.queryByRole("button", {
        name: initial.active ? CONTROLS_COPY.leave : CONTROLS_COPY.join,
      }) !== null,
  );
  return { task, t, ...e };
}

const settings = () =>
  document.querySelector("[data-enrolment]") as HTMLElement | null;
const consent = () =>
  within(settings() as HTMLElement).getByRole("checkbox", {
    name: CONTROLS_COPY.consent,
  }) as HTMLInputElement;
/** The consent CHECKBOX of an active enrolment, or null (not enrolled: the consent is a choice made with Join). */
const checkbox = () =>
  settings() === null
    ? null
    : (within(settings() as HTMLElement).queryByRole("checkbox", {
        name: CONTROLS_COPY.consent,
      }) as HTMLInputElement | null);
/** The join form's "Yes" consent choice. */
const yes = () =>
  within(settings() as HTMLElement).getByRole("radio", {
    name: CONTROLS_COPY.consentYes,
  }) as HTMLInputElement;
/** Joining asks the consent explicitly (R22 adaptation): "Yes", the consent these cases' enrolments held. */
async function chooseConsent() {
  await act(async () => {
    fireEvent.click(yes());
  });
}
const button = (name: string) => {
  const section = settings();
  return section === null
    ? null
    : (within(section).queryByRole("button", {
        name,
      }) as HTMLButtonElement | null);
};
async function press(_t: Mounted, element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    fireEvent.click(element as HTMLElement);
  });
}

describe("E1: a change while another is pending sends nothing", () => {
  const cases: Array<{
    name: string;
    initial: Enrolment;
    before?(): Promise<void>;
    act(): HTMLElement | null;
    /** The consent control that must be disabled while pending (the join form's choice when not enrolled). */
    consentControl(): HTMLInputElement;
  }> = [
    {
      name: "Join",
      initial: { version: 1, active: false, aggregate_consent: true },
      before: chooseConsent,
      act: () => button(CONTROLS_COPY.join),
      consentControl: yes,
    },
    {
      name: "Leave",
      initial: { version: 1, active: true, aggregate_consent: true },
      act: () => button(CONTROLS_COPY.leave),
      consentControl: consent,
    },
    {
      name: "the consent",
      initial: { version: 1, active: true, aggregate_consent: true },
      act: () => consent(),
      consentControl: consent,
    },
  ];
  for (const c of cases)
    test(
      `${c.name}, activated twice before the first answers`,
      SLOW,
      async () => {
        const { t, sent } = await mounted(c.initial);
        await c.before?.();
        const first = c.act();
        expect(first).not.toBeNull();
        // Twice before any render (a double press: the second one meets the control as it was), then once more as it is now.
        await act(async () => {
          fireEvent.click(first as HTMLElement);
          fireEvent.click(first as HTMLElement);
        });
        await press(t, c.act());
        expect(sent).toHaveLength(1);
        // While pending, Join/Leave and the consent are disabled, with the reason.
        const toggle =
          button(CONTROLS_COPY.join) ?? button(CONTROLS_COPY.leave);
        expect((toggle as HTMLButtonElement).disabled).toBe(true);
        expect(settings()?.textContent).toContain(CONTROLS_COPY.sending);
        expect(c.consentControl().disabled).toBe(true);
        await act(async () =>
          sent[0]?.release({ ok: true, value: { revision: 2 } }),
        );
        await t.settle();
        expect(sent).toHaveLength(1);
      },
    );

  test(
    "control: one activation sends one change with one key; the next change after the answer is a new attempt",
    SLOW,
    async () => {
      const { t, sent, set } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 1,
        active: true,
        aggregate_consent: true,
        initial_policy: POLICY,
      });
      set({ version: 2, active: true, aggregate_consent: true });
      await act(async () =>
        sent[0]?.release({ ok: true, value: { revision: 2 } }),
      );
      await t.until(() => button(CONTROLS_COPY.leave) !== null);
      expect(settings()?.textContent).toContain(CONTROLS_COPY.saved);
      await press(t, button(CONTROLS_COPY.leave));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.key).not.toBe(sent[0]?.key);
      expect(sent[1]?.command.expected_version).toBe(2);
    },
  );
});

describe("E2: an uncertain change is retried exactly", () => {
  test(
    "Try again resends the same body and key, though the enrolment read since shows another version",
    SLOW,
    async () => {
      const { t, sent, set } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      // Meanwhile the change committed elsewhere (or this one did): the next read shows version 2.
      set({ version: 2, active: false, aggregate_consent: false });
      await act(async () => sent[0]?.release({ ok: false, kind: "uncertain" }));
      await t.until(
        () => document.querySelector("[data-enrolment-uncertain]") !== null,
      );
      expect(settings()?.textContent).toContain(CONTROLS_COPY.enrolFailed);
      expect(sent).toHaveLength(1);
      await press(t, button(copy.TRY_AGAIN));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.key).toBe(sent[0]?.key);
      expect(sent[1]?.command).toEqual(sent[0]?.command);
      expect(sent[1]?.command.expected_version).toBe(1);
      await act(async () =>
        sent[1]?.release({ ok: true, value: { revision: 2 } }),
      );
      await t.settle();
      expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
    },
  );

  test(
    "control: a definite refusal ends the attempt; nothing is resent, and the next change has a new key",
    SLOW,
    async () => {
      const { t, sent, set } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      set({ version: 2, active: false, aggregate_consent: true });
      await act(async () =>
        sent[0]?.release({ ok: false, kind: "conflict", code: "conflict" }),
      );
      await t.settle();
      expect(settings()?.textContent).toContain(CONTROLS_COPY.enrolRefused);
      expect(button(copy.TRY_AGAIN)).toBeNull();
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.key).not.toBe(sent[0]?.key);
      expect(sent[1]?.command.expected_version).toBe(2);
    },
  );
});

describe("E3: the attempt's owner across a remount, another identity and a read that crosses it", () => {
  test(
    "remounted while pending (same identity): still pending, a click sends nothing; its answer is followed by a read",
    SLOW,
    async () => {
      const { task, t, sent, reads } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      // The protected tree is remounted (an ordinary 403 elsewhere does this): the detail mounts again.
      await act(async () => {
        await t.router.navigate({ to: "/tasks" });
      });
      await act(async () => {
        await t.router.navigate({
          to: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        });
      });
      await t.until(() => button(CONTROLS_COPY.join) !== null);
      expect((button(CONTROLS_COPY.join) as HTMLButtonElement).disabled).toBe(
        true,
      );
      await press(t, button(CONTROLS_COPY.join));
      expect(sent).toHaveLength(1);
      const before = reads.length;
      await act(async () =>
        sent[0]?.release({ ok: true, value: { revision: 2 } }),
      );
      await t.settle();
      expect(reads.length).toBeGreaterThan(before);
      expect(
        (button(CONTROLS_COPY.join) ??
          button(CONTROLS_COPY.leave)) as HTMLButtonElement,
      ).not.toBeNull();
    },
  );

  test(
    "another identity never sees the first one's pending attempt, and its late answer changes nothing there",
    SLOW,
    async () => {
      const { t, sent, api } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      t.rerender(tasksEnv(api, { identity: `${OTHER}:1`, accountId: ME }));
      await t.until(() => button(CONTROLS_COPY.join) !== null);
      // Adapted (R22): the other identity's Join waits only for its own consent choice, never for the first identity's attempt.
      expect(settings()?.textContent).not.toContain(CONTROLS_COPY.sending);
      await chooseConsent();
      expect((button(CONTROLS_COPY.join) as HTMLButtonElement).disabled).toBe(
        false,
      );
      await act(async () => sent[0]?.release({ ok: false, kind: "uncertain" }));
      await t.settle();
      expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
    },
  );

  /** Asks the enrolment again (the connection drops and returns); the read is held. */
  async function heldRead(e: Awaited<ReturnType<typeof mounted>>) {
    e.holdReads(true);
    e.t.rerender(tasksEnv(e.api, { online: false }));
    await e.t.settle();
    e.t.rerender(tasksEnv(e.api));
    await e.t.until(() => e.reads[e.reads.length - 1] !== null);
    return e.reads[e.reads.length - 1] as { release(): void };
  }
  const ticks = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  test(
    "a read answered while a change is pending is not shown (it may predate the change)",
    SLOW,
    async () => {
      const e = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(e.t, button(CONTROLS_COPY.join));
      expect(e.sent).toHaveLength(1);
      // Asked while the change is pending, answered while it still is, with another state.
      e.set({ version: 5, active: true, aggregate_consent: false });
      const read = await heldRead(e);
      await act(async () => read.release());
      await e.t.settle();
      expect(button(CONTROLS_COPY.join)).not.toBeNull();
      expect(button(CONTROLS_COPY.leave)).toBeNull();
      // Adapted (R22): not enrolled, so no consent checkbox at all (the stale active enrolment would show one, unchecked).
      expect(checkbox()).toBeNull();
    },
  );

  test(
    "a read asked before a change and answered just after it is not shown either",
    SLOW,
    async () => {
      const e = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      // Asked before the change, with the consent off at the server then. Adapted (R22): an ACTIVE state, so showing it would be seen
      // (a not-enrolled state with another consent looks the same before Join).
      e.set({ version: 1, active: true, aggregate_consent: false });
      const read = await heldRead(e);
      await chooseConsent();
      await press(e.t, button(CONTROLS_COPY.join));
      // The change answers, then (before the screen renders) the old read answers; the read that follows the change stays held.
      await act(async () => {
        e.sent[0]?.release({ ok: true, value: { revision: 2 } });
        await ticks();
        read.release();
        await ticks();
      });
      await e.t.settle();
      // Adapted (R22): still the not-enrolled state shown before the change (the read that follows it is held).
      expect(button(CONTROLS_COPY.leave)).toBeNull();
      expect(checkbox()).toBeNull();
    },
  );

  test(
    "control: a read asked and answered with nothing pending is shown",
    SLOW,
    async () => {
      const e = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      // Adapted (R22): an active state, so that it is visibly shown.
      e.set({ version: 1, active: true, aggregate_consent: false });
      const read = await heldRead(e);
      await act(async () => read.release());
      await e.t.settle();
      expect(button(CONTROLS_COPY.leave)).not.toBeNull();
      expect(consent().checked).toBe(false);
    },
  );
});

describe("E4: a reload resends nothing", () => {
  test(
    "pending or uncertain before a reload: after it (fresh page memory) nothing is sent, and the next act is a new attempt",
    SLOW,
    async () => {
      const first = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(first.t, button(CONTROLS_COPY.join));
      await act(async () =>
        first.sent[0]?.release({ ok: false, kind: "uncertain" }),
      );
      await first.t.settle();
      first.t.unmount();
      cleanup();
      // A reload: the page's memory starts empty.
      forgetTaskMemory();
      const second = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await second.t.settle();
      expect(second.sent).toHaveLength(0);
      expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
      await chooseConsent();
      await press(second.t, button(CONTROLS_COPY.join));
      expect(second.sent).toHaveLength(1);
      expect(second.sent[0]?.key).not.toBe(first.sent[0]?.key);
    },
  );
});

describe("E4b: after a reload, a failed read of the enrolment is not permission to guess or resend (RECOVERY-NAVIGATION-ENROLMENT-20261014 D4)", () => {
  test(
    "the reload's read fails: no change can be made and nothing is sent; Try again reads (never sends), and only then a fresh change is offered",
    SLOW,
    async () => {
      const first = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(first.t, button(CONTROLS_COPY.join));
      await act(async () =>
        first.sent[0]?.release({ ok: false, kind: "uncertain" }),
      );
      await first.t.settle();
      first.t.unmount();
      cleanup();
      forgetTaskMemory();
      // The reloaded page's first read fails.
      const task = await seededTask({
        definition: { participation: "everyone" },
      });
      let failing = true;
      let reads = 0;
      const sent: string[] = [];
      const api = fakeApi({
        readEnrolment: async () => {
          reads += 1;
          return failing
            ? { ok: false, kind: "uncertain" }
            : {
                ok: true,
                value: {
                  version: 2,
                  active: true,
                  aggregate_consent: true,
                  policy: POLICY,
                },
              };
        },
        enrol: async (_command, key) => {
          sent.push(key);
          return { ok: true, value: { revision: 3 } };
        },
      });
      const t = await mountTasks({
        path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
        rows: task.rows,
        api,
      });
      await t.until(
        () =>
          settings()?.textContent?.includes(CONTROLS_COPY.enrolUnavailable) ===
          true,
      );
      expect(settings()?.textContent).toContain(CONTROLS_COPY.enrolUnavailable);
      expect(button(CONTROLS_COPY.join)).toBeNull();
      expect(button(CONTROLS_COPY.leave)).toBeNull();
      expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
      expect(sent).toEqual([]);
      failing = false;
      const before = reads;
      await press(t, button(copy.TRY_AGAIN));
      await t.until(() => button(CONTROLS_COPY.leave) !== null);
      expect(reads).toBeGreaterThan(before);
      expect(sent).toEqual([]);
      // Reconciled: the current state (version 2, active) is shown and a fresh, explicit change is possible.
      await press(t, button(CONTROLS_COPY.leave));
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toBe(first.sent[0]?.key);
    },
  );
});

describe("X2: the pending change is accessible (jsdom layer; no manual assistive-technology claim)", () => {
  test(
    "the disabled control is described by its reason, and the section has no axe violations",
    SLOW,
    async () => {
      const { axe } = await import("jest-axe");
      const { t, sent } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
      });
      await chooseConsent();
      await press(t, button(CONTROLS_COPY.join));
      const join = button(CONTROLS_COPY.join) as HTMLButtonElement;
      expect(join.disabled).toBe(true);
      const described = (join.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toContain(CONTROLS_COPY.sending);
      expect((await axe(settings() as HTMLElement)).violations).toEqual([]);
      await act(async () =>
        sent[0]?.release({ ok: true, value: { revision: 2 } }),
      );
      await t.settle();
    },
  );
});
