/**
 * WEB-10a revision 10 (R22, `task-enrolment-policy-preservation`; design assessment C1-C5, Q1-Q5, Q8): every enrolment change sends the
 * COMPLETE enrolment, its audience (`initial_policy`) included, because the server reads an omitted policy as "my current progress
 * defaults" and replaces the audience with it (task `states.md` R2/F1). Leave, the consent and an audience edit resend everything they do
 * not change; joining asks the consent explicitly and shows the audience first (the current default the first time, the last audience
 * when rejoining); an uncertain attempt's retry resends the captured body, nested policy included, whatever changed since. Composed
 * through the production task detail, over the real data env's defaults source and the sharing env's chooser.
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
import type { ReadResult } from "../../../src/data/engine/identity-task";
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
import {
  FLAT,
  HOME,
  JAMIE,
  PRIYA,
  SAM,
  snapshot,
} from "../../support/data/sharing";
import { fakeApi, ME, mountTasks, seededTask } from "../../support/tasks/world";

installMatchMedia({ width: 1440 });
afterEach(() => {
  cleanup();
  forgetTaskMemory();
  forgetAllCorrections();
});

const SLOW = { timeout: 30_000 };

const PRIVATE: Policy = { grants: [], exclude_accounts: [] };
const ACCOUNT: Policy = {
  grants: [{ kind: "account", id: SAM, edit: false }],
  exclude_accounts: [],
};
const HOUSEHOLD_EXCLUDING: Policy = {
  grants: [{ kind: "household", id: HOME, edit: true }],
  exclude_accounts: [PRIYA],
};
const MIXED: Policy = {
  grants: [
    { kind: "household", id: FLAT, edit: false },
    { kind: "account", id: SAM, edit: true },
    { kind: "account", id: JAMIE, edit: false },
  ],
  exclude_accounts: [PRIYA],
};
const AUDIENCES: Array<[string, Policy]> = [
  ["private", PRIVATE],
  ["an account grant", ACCOUNT],
  ["a household grant (edit) with an exclusion", HOUSEHOLD_EXCLUDING],
  ["household, account (edit) and account grants with an exclusion", MIXED],
];
/** Progress defaults that differ from every audience above: a change that fell back on them would show. */
const SHARED_DEFAULTS = snapshot({
  primary: HOME,
  templates: {
    progress: {
      kind: "explicit",
      policy: {
        grants: [{ kind: "account", id: JAMIE, edit: true }],
        exclude_accounts: [],
      },
    },
  },
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Sent {
  command: EnrolCommand;
  /** The body as it was handed to the client, serialised at that moment. */
  wire: string;
  key: string;
  release(result: TasksResult<{ revision: number }>): void;
}

/** An enrolment endpoint whose reads answer `current` (a fresh copy each time) and whose changes are recorded and held until released. */
function enrolmentWorld(initial: Enrolment) {
  let current = initial;
  const sent: Sent[] = [];
  let reads = 0;
  const api = fakeApi({
    readEnrolment: async () => {
      reads += 1;
      return { ok: true, value: clone(current) };
    },
    enrol: (command, key) =>
      new Promise((resolve) =>
        sent.push({
          command,
          wire: JSON.stringify(command),
          key,
          release: resolve,
        }),
      ),
  });
  return {
    api,
    sent,
    reads: () => reads,
    set(next: Enrolment) {
      current = next;
    },
  };
}

/** `GET /defaults/snapshot`, counted; `answer` can be changed between reads. */
function defaultsReader(first: ReadResult<unknown>) {
  let answer = first;
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return answer;
    },
    calls: () => calls,
    set(next: ReadResult<unknown>) {
      answer = next;
    },
  };
}

async function mounted(
  initial: Enrolment,
  defaults = defaultsReader({ kind: "ok", value: SHARED_DEFAULTS }),
) {
  const task = await seededTask({ definition: { participation: "everyone" } });
  const e = enrolmentWorld(initial);
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    api: e.api,
    defaultsSnapshot: defaults.read,
  });
  // Enrolled: Leave. Not enrolled: the join form (the first Join's waits for its default audience).
  await t.until(() =>
    initial.active
      ? screen.queryByRole("button", { name: CONTROLS_COPY.leave }) !== null
      : document.querySelector("[data-enrol-consent]") !== null,
  );
  expect(
    initial.active
      ? button(CONTROLS_COPY.leave)
      : document.querySelector("[data-enrol-consent]"),
  ).not.toBeNull();
  return { task, t, defaults, ...e };
}

const settings = () =>
  document.querySelector("[data-enrolment]") as HTMLElement;
const button = (name: string) =>
  within(settings()).queryByRole("button", {
    name,
  }) as HTMLButtonElement | null;
const consentBox = () =>
  within(settings()).getByRole("checkbox", {
    name: CONTROLS_COPY.consent,
  }) as HTMLInputElement;
const radio = (name: string) =>
  within(settings()).getByRole("radio", { name }) as HTMLInputElement;
async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    fireEvent.click(element as HTMLElement);
  });
}
const audience = () =>
  settings().querySelector("[data-audience]") as HTMLElement | null;

describe("Q1: Leave, the consent and an audience edit resend the complete enrolment, its audience as it was read", () => {
  for (const [name, policy] of AUDIENCES) {
    test(
      `${name}: Leave keeps the audience and the consent`,
      SLOW,
      async () => {
        const { t, sent } = await mounted({
          version: 4,
          active: true,
          aggregate_consent: false,
          policy,
        });
        await click(button(CONTROLS_COPY.leave));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.command).toEqual({
          kind: "enrol",
          task_id: expect.any(String),
          expected_version: 4,
          active: false,
          aggregate_consent: false,
          initial_policy: policy,
        });
        await act(async () =>
          sent[0]?.release({ ok: true, value: { revision: 9 } }),
        );
        await t.settle();
        // Leave never needs the defaults (they differ from the audience, and are not what it keeps).
      },
    );

    test(
      `${name}: the consent alone changes; the audience is kept`,
      SLOW,
      async () => {
        const { sent } = await mounted({
          version: 2,
          active: true,
          aggregate_consent: true,
          policy,
        });
        await click(consentBox());
        expect(sent).toHaveLength(1);
        expect(sent[0]?.command).toEqual({
          kind: "enrol",
          task_id: expect.any(String),
          expected_version: 2,
          active: true,
          aggregate_consent: false,
          initial_policy: policy,
        });
      },
    );

    test(
      `${name}: rejoining shows that audience and sends it unchanged, with the version read and the consent chosen`,
      SLOW,
      async () => {
        const { sent } = await mounted({
          version: 3,
          active: false,
          aggregate_consent: true,
          policy,
        });
        expect(audience()).not.toBeNull();
        // The consent is asked again: no choice is implied, and Join waits for it.
        expect(radio(CONTROLS_COPY.consentYes).checked).toBe(false);
        expect(radio(CONTROLS_COPY.consentNo).checked).toBe(false);
        expect(button(CONTROLS_COPY.join)?.disabled).toBe(true);
        expect(settings().textContent).toContain(CONTROLS_COPY.chooseConsent);
        await click(button(CONTROLS_COPY.join));
        expect(sent).toHaveLength(0);
        await click(radio(CONTROLS_COPY.consentNo));
        await click(button(CONTROLS_COPY.join));
        expect(sent).toHaveLength(1);
        expect(sent[0]?.command).toEqual({
          kind: "enrol",
          task_id: expect.any(String),
          expected_version: 3,
          active: true,
          aggregate_consent: false,
          initial_policy: policy,
        });
      },
    );
  }

  test(
    "an audience edit changes only the audience: Private is an explicit empty policy; active and the consent are resent",
    SLOW,
    async () => {
      const { sent } = await mounted({
        version: 6,
        active: true,
        aggregate_consent: true,
        policy: MIXED,
      });
      await click(button(CONTROLS_COPY.changeAudience));
      // Unchanged, Save says so and sends nothing.
      expect(button(CONTROLS_COPY.saveAudience)?.disabled).toBe(true);
      await click(button("Only me (private)"));
      await click(button(CONTROLS_COPY.saveAudience));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 6,
        active: true,
        aggregate_consent: true,
        initial_policy: { grants: [], exclude_accounts: [] },
      });
    },
  );

  test(
    "an audience edit of one grant's access keeps every other grant and the exclusion",
    SLOW,
    async () => {
      const { sent } = await mounted({
        version: 6,
        active: true,
        aggregate_consent: false,
        policy: MIXED,
      });
      await click(button(CONTROLS_COPY.changeAudience));
      const row = settings().querySelector(
        `[data-principal="${JAMIE}"]`,
      ) as HTMLElement;
      await click(within(row).getByRole("radio", { name: "Edit" }));
      await click(button(CONTROLS_COPY.saveAudience));
      expect(sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 6,
        active: true,
        aggregate_consent: false,
        initial_policy: {
          grants: [
            { kind: "household", id: FLAT, edit: false },
            { kind: "account", id: SAM, edit: true },
            { kind: "account", id: JAMIE, edit: true },
          ],
          exclude_accounts: [PRIYA],
        },
      });
    },
  );

  test(
    "control: Cancel discards the audience edit and sends nothing; what is shown is the audience read",
    SLOW,
    async () => {
      const { t, sent } = await mounted({
        version: 6,
        active: true,
        aggregate_consent: true,
        policy: ACCOUNT,
      });
      const line = `${CONTROLS_COPY.audienceHeading}: ${CONTROLS_COPY.audienceLine(ACCOUNT)}`;
      expect(settings().textContent).toContain(line);
      await click(button(CONTROLS_COPY.changeAudience));
      await click(button("Only me (private)"));
      await click(button(CONTROLS_COPY.cancel));
      await t.settle();
      expect(sent).toHaveLength(0);
      expect(audience()).toBeNull();
      expect(settings().textContent).toContain(line);
    },
  );
});

describe("Q2: the first Join shows the current default audience and asks the consent; Private and No are independent", () => {
  test(
    "version 0: the default audience is read for the purpose, shown, and sent explicitly with the consent chosen",
    SLOW,
    async () => {
      const defaults = defaultsReader({
        kind: "ok",
        value: snapshot({ primary: HOME }),
      });
      const { sent } = await mounted(
        {
          version: 0,
          active: false,
          aggregate_consent: false,
          policy: PRIVATE,
        },
        defaults,
      );
      expect(defaults.calls()).toBeGreaterThan(0);
      expect(settings().textContent).toContain(CONTROLS_COPY.defaultAudience);
      // The primary household's members are not listed here (no membership read answered), but the household is shown, not "nobody".
      expect(audience()?.querySelector("[data-audience-nobody]")).toBeNull();
      await click(radio(CONTROLS_COPY.consentYes));
      await click(button(CONTROLS_COPY.join));
      expect(sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 0,
        active: true,
        aggregate_consent: true,
        initial_policy: {
          grants: [{ kind: "household", id: HOME, edit: false }],
          exclude_accounts: [],
        },
      });
    },
  );

  test(
    "No and Only me: consent false and an actual empty policy, each chosen on its own",
    SLOW,
    async () => {
      const { sent } = await mounted({
        version: 0,
        active: false,
        aggregate_consent: false,
        policy: PRIVATE,
      });
      await click(radio(CONTROLS_COPY.consentNo));
      await click(button("Only me (private)"));
      expect(
        audience()?.querySelector("[data-audience-nobody]"),
      ).not.toBeNull();
      await click(button(CONTROLS_COPY.join));
      expect(sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 0,
        active: true,
        aggregate_consent: false,
        initial_policy: { grants: [], exclude_accounts: [] },
      });
    },
  );

  test(
    "No with the shared default kept: leaving the shared total never narrows who can read progress",
    SLOW,
    async () => {
      const { sent } = await mounted({
        version: 0,
        active: false,
        aggregate_consent: false,
        policy: PRIVATE,
      });
      await click(radio(CONTROLS_COPY.consentNo));
      await click(button(CONTROLS_COPY.join));
      expect(sent[0]?.command.aggregate_consent).toBe(false);
      expect(sent[0]?.command.initial_policy).toEqual({
        grants: [{ kind: "account", id: JAMIE, edit: true }],
        exclude_accounts: [],
      });
    },
  );

  for (const failure of [
    { kind: "failure" },
    { kind: "unrecognised" },
  ] as ReadResult<unknown>[])
    test(
      `the default can't be read (${failure.kind}): nothing is shown as the audience, Join can't send; Try again reads again`,
      SLOW,
      async () => {
        const defaults = defaultsReader(failure);
        const task = await seededTask({
          definition: { participation: "everyone" },
        });
        const e = enrolmentWorld({
          version: 0,
          active: false,
          aggregate_consent: false,
          policy: PRIVATE,
        });
        const t = await mountTasks({
          path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
          rows: task.rows,
          api: e.api,
          defaultsSnapshot: defaults.read,
        });
        await t.until(
          () =>
            settings()?.textContent?.includes(CONTROLS_COPY.defaultFailed) ===
            true,
        );
        expect(audience()).toBeNull();
        expect(button(CONTROLS_COPY.join)?.disabled).toBe(true);
        expect(settings().textContent).toContain(CONTROLS_COPY.audienceUnknown);
        await click(button(CONTROLS_COPY.join));
        expect(e.sent).toHaveLength(0);
        const before = defaults.calls();
        defaults.set({ kind: "ok", value: SHARED_DEFAULTS });
        await click(button(copy.TRY_AGAIN));
        await t.until(() => audience() !== null);
        expect(defaults.calls()).toBeGreaterThan(before);
        expect(e.sent).toHaveLength(0);
      },
    );
});

describe("Q3/Q8: one attempt, one captured body; nothing changed afterwards reaches a retry", () => {
  test(
    "the sent command, the source it came from and the defaults all change; Try again resends the original body and key",
    SLOW,
    async () => {
      const { t, task, sent, set, defaults } = await mounted({
        version: 5,
        active: true,
        aggregate_consent: true,
        policy: MIXED,
      });
      await click(consentBox());
      expect(sent).toHaveLength(1);
      const original = sent[0] as Sent;
      // Whatever holds a reference to the command, and the server's state since, change.
      original.command.initial_policy.grants.push({
        kind: "account",
        id: ME,
        edit: true,
      });
      original.command.initial_policy.exclude_accounts.length = 0;
      set({
        version: 9,
        active: true,
        aggregate_consent: true,
        policy: ACCOUNT,
      });
      defaults.set({ kind: "ok", value: snapshot({ primary: FLAT }) });
      // The captured attempt itself cannot be changed.
      const held = enrolmentAttemptOf(`${ME}:1`, task.taskId);
      expect(Object.isFrozen(held?.command.initial_policy.grants)).toBe(true);
      expect(Object.isFrozen(held?.command.initial_policy.grants[0])).toBe(
        true,
      );
      expect(
        Object.isFrozen(held?.command.initial_policy.exclude_accounts),
      ).toBe(true);
      await act(async () => original.release({ ok: false, kind: "uncertain" }));
      await t.until(
        () => document.querySelector("[data-enrolment-uncertain]") !== null,
      );
      await click(button(copy.TRY_AGAIN));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.key).toBe(original.key);
      expect(sent[1]?.wire).toBe(original.wire);
      expect(JSON.parse(sent[1]?.wire ?? "null")).toEqual({
        kind: "enrol",
        task_id: task.taskId,
        expected_version: 5,
        active: true,
        aggregate_consent: false,
        initial_policy: MIXED,
      });
    },
  );

  test(
    "control: a new explicit change after an uncertain one is a new attempt (new key) with the audience now shown",
    SLOW,
    async () => {
      const { t, sent, set } = await mounted({
        version: 5,
        active: true,
        aggregate_consent: true,
        policy: MIXED,
      });
      await click(consentBox());
      set({
        version: 5,
        active: true,
        aggregate_consent: true,
        policy: HOUSEHOLD_EXCLUDING,
      });
      await act(async () => sent[0]?.release({ ok: false, kind: "uncertain" }));
      await t.until(
        () =>
          settings().textContent?.includes(
            CONTROLS_COPY.audienceLine(HOUSEHOLD_EXCLUDING),
          ) === true,
      );
      await click(button(CONTROLS_COPY.leave));
      expect(sent).toHaveLength(2);
      expect(sent[1]?.key).not.toBe(sent[0]?.key);
      expect(sent[1]?.command.initial_policy).toEqual(HOUSEHOLD_EXCLUDING);
    },
  );

  test(
    "the first Join keeps the default it showed: defaults that change before Join, and before a retry, change nothing sent",
    SLOW,
    async () => {
      const defaults = defaultsReader({
        kind: "ok",
        value: snapshot({ primary: HOME }),
      });
      const { t, sent } = await mounted(
        {
          version: 0,
          active: false,
          aggregate_consent: false,
          policy: PRIVATE,
        },
        defaults,
      );
      defaults.set({ kind: "ok", value: SHARED_DEFAULTS });
      await click(radio(CONTROLS_COPY.consentYes));
      await click(button(CONTROLS_COPY.join));
      const shown = {
        grants: [{ kind: "household", id: HOME, edit: false }],
        exclude_accounts: [],
      };
      expect(sent[0]?.command.initial_policy).toEqual(shown);
      await act(async () => sent[0]?.release({ ok: false, kind: "uncertain" }));
      await t.until(
        () => document.querySelector("[data-enrolment-uncertain]") !== null,
      );
      await click(button(copy.TRY_AGAIN));
      expect(sent[1]?.key).toBe(sent[0]?.key);
      expect(sent[1]?.wire).toBe(sent[0]?.wire);
    },
  );
});

describe("Q4: a definite refusal is the answer; nothing is resent and no policy is substituted", () => {
  for (const kind of [
    "conflict",
    "operation_conflict",
    "forbidden",
    "not_found",
    "invalid",
  ] as const)
    test(
      `${kind}: refused, the enrolment read again, nothing more sent`,
      SLOW,
      async () => {
        const { t, sent, reads } = await mounted({
          version: 2,
          active: true,
          aggregate_consent: true,
          policy: HOUSEHOLD_EXCLUDING,
        });
        const before = reads();
        await click(button(CONTROLS_COPY.leave));
        await act(async () =>
          sent[0]?.release({ ok: false, kind, code: kind }),
        );
        await t.settle();
        expect(settings().textContent).toContain(CONTROLS_COPY.enrolRefused);
        expect(document.querySelector("[data-enrolment-uncertain]")).toBeNull();
        expect(reads()).toBeGreaterThan(before);
        expect(sent).toHaveLength(1);
      },
    );

  test(
    "control: an uncertain answer is not a refusal: Try again is offered, nothing is sent on its own",
    SLOW,
    async () => {
      const { t, sent } = await mounted({
        version: 2,
        active: true,
        aggregate_consent: true,
        policy: HOUSEHOLD_EXCLUDING,
      });
      await click(button(CONTROLS_COPY.leave));
      await act(async () => sent[0]?.release({ ok: false, kind: "uncertain" }));
      await t.settle();
      expect(
        document.querySelector("[data-enrolment-uncertain]"),
      ).not.toBeNull();
      expect(sent).toHaveLength(1);
    },
  );
});

describe("Q5: after a reload the next change carries the audience the fresh read returned", () => {
  test(
    "uncertain before the reload; the fresh page sends nothing until asked, then the policy read now",
    SLOW,
    async () => {
      const first = await mounted({
        version: 2,
        active: true,
        aggregate_consent: true,
        policy: MIXED,
      });
      await click(consentBox());
      await act(async () =>
        first.sent[0]?.release({ ok: false, kind: "uncertain" }),
      );
      await first.t.settle();
      first.t.unmount();
      cleanup();
      forgetTaskMemory();
      const second = await mounted({
        version: 3,
        active: true,
        aggregate_consent: false,
        policy: ACCOUNT,
      });
      await second.t.settle();
      expect(second.sent).toHaveLength(0);
      await click(button(CONTROLS_COPY.leave));
      expect(second.sent[0]?.command).toEqual({
        kind: "enrol",
        task_id: expect.any(String),
        expected_version: 3,
        active: false,
        aggregate_consent: false,
        initial_policy: ACCOUNT,
      });
      expect(second.sent[0]?.key).not.toBe(first.sent[0]?.key);
    },
  );
});

describe("X3: the join form and the audience editor are accessible (jsdom layer; no manual assistive-technology claim)", () => {
  test(
    "the consent choice is a labelled group, Join's reason describes it, and neither form has axe violations",
    SLOW,
    async () => {
      const { axe } = await import("jest-axe");
      const { t } = await mounted({
        version: 1,
        active: false,
        aggregate_consent: true,
        policy: ACCOUNT,
      });
      const group = within(settings()).getByRole("group", {
        name: CONTROLS_COPY.joinConsent,
      });
      expect(within(group).getAllByRole("radio")).toHaveLength(2);
      const join = button(CONTROLS_COPY.join) as HTMLButtonElement;
      const described = (join.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toContain(CONTROLS_COPY.chooseConsent);
      expect((await axe(settings())).violations).toEqual([]);
      t.unmount();
      cleanup();
      const enrolled = await mounted({
        version: 1,
        active: true,
        aggregate_consent: true,
        policy: ACCOUNT,
      });
      await click(button(CONTROLS_COPY.changeAudience));
      expect(audience()).not.toBeNull();
      expect((await axe(settings())).violations).toEqual([]);
      await enrolled.t.settle();
    },
  );
});
