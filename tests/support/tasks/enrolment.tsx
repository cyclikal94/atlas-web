/**
 * The enrolment settings' test world (WEB-10a revision 12, R23/R25): one enrolment at a scripted server, the production task detail over it
 * (`mountTasks`), and the queries the enrolment suites share. The same helpers as `enrolment-ownership.test.tsx` (revision 11), kept here
 * for the revision 12 suites; that file keeps its own copy unchanged.
 */
import { act, fireEvent, within } from "@testing-library/react";
import { expect } from "vitest";
import type { Policy } from "../../../src/data";
import type { ReadResult } from "../../../src/data/engine/identity-task";
import * as sharingCopy from "../../../src/features/sharing/copy";
import type {
  EnrolCommand,
  TasksResult,
} from "../../../src/features/tasks/api";
import { CONTROLS_COPY } from "../../../src/features/tasks/detail/Controls";
import type { Enrolment } from "../../../src/features/tasks/model/contract";
import { FLAT, HOME, household, snapshot } from "../data/sharing";
import { fakeSharingApi, ok } from "../sharing/fake-api";
import { fakeApi, type Mounted, mountTasks, OTHER, seededTask } from "./world";

export const SLOW = { timeout: 30_000 };
export const THIRD = "33333333-3333-4333-8333-333333333333";
export const READER = "review-reader";
export const PRIVATE: Policy = { grants: [], exclude_accounts: [] };
export const SHARED: Policy = {
  grants: [{ kind: "account", id: OTHER, edit: false }],
  exclude_accounts: [],
};
export const clone = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

export interface Sent {
  command: EnrolCommand;
  key: string;
  release(result: TasksResult<{ revision: number }>): void;
}
export interface Read {
  /** The state when it was asked. */
  asked: Enrolment;
  release(answer?: TasksResult<Enrolment>): void;
  done: boolean;
}

/** One enrolment at a server: every change is recorded and HELD; reads answer at once, or are held while `hold` is on. */
export function server(initial: Enrolment) {
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
    current: () => clone(current),
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

export type Caller = "enrolled" | "rejoin" | "first join";
export const CALLERS: Caller[] = ["enrolled", "rejoin", "first join"];

export const settings = () =>
  document.querySelector("[data-enrolment]") as HTMLElement;
export const inSettings = () => within(settings());
export const button = (name: string) =>
  settings() === null
    ? null
    : (inSettings().queryByRole("button", {
        name,
      }) as HTMLButtonElement | null);
export const chooseButtons = () =>
  settings() === null
    ? []
    : (inSettings().queryAllByRole("button", {
        name: `${sharingCopy.LOOKUP_CHOOSE}: ${READER}`,
      }) as HTMLButtonElement[]);
/** The text a disabled control is described by (its reason first). */
export const reasonOf = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
export async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    fireEvent.click(element as HTMLElement);
  });
}
export const grantOf = (id: string, within: ParentNode = settings()) =>
  within.querySelector(`[data-grant="account"][data-principal="${id}"]`);
export const exclusionOf = (id: string, within: ParentNode = settings()) =>
  within.querySelector(`[data-exclusion="${id}"]`);
export const submitName = (caller: Caller) =>
  caller === "enrolled" ? CONTROLS_COPY.saveAudience : CONTROLS_COPY.join;
/** The kept (unsaved, not sendable) draft, or null. */
export const kept = () =>
  settings()?.querySelector<HTMLElement>("[data-enrol-kept]") ?? null;
/** The join form's consent choice for `value` (only while not enrolled). */
export const consentChoice = (value: boolean) =>
  inSettings().getByRole("radio", {
    name: value ? CONTROLS_COPY.consentYes : CONTROLS_COPY.consentNo,
  }) as HTMLInputElement;
/** The settings are shown for `caller`: Leave (enrolled) or the join form's consent. */
export const shownFor = (caller: Caller) =>
  settings() !== null &&
  (caller === "enrolled"
    ? button(CONTROLS_COPY.leave) !== null
    : settings().querySelector("[data-enrol-consent]") !== null);

/** `GET /defaults/snapshot`, scripted: its answer can be changed between reads. */
export function defaultsReader(
  first: ReadResult<unknown> = {
    kind: "ok",
    value: snapshot({
      templates: { progress: { kind: "explicit", policy: SHARED } },
    }),
  },
) {
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

export const initialFor = (caller: Caller): Enrolment =>
  caller === "first join"
    ? { version: 0, active: false, aggregate_consent: false, policy: PRIVATE }
    : {
        version: 7,
        active: caller === "enrolled",
        aggregate_consent: true,
        policy: SHARED,
      };

/** The caller's settings mounted (nothing chosen yet). */
export async function mountedFor(
  caller: Caller,
  options: {
    households?: boolean;
    defaults?: ReturnType<typeof defaultsReader>;
    /** false: do not wait for the settings to be editable (a case where they never are). */
    ready?: boolean;
  } = {},
) {
  const task = await seededTask({ definition: { participation: "everyone" } });
  const s = server(initialFor(caller));
  // The directory and (when asked) two households, answered from the first read of the chooser on.
  const sharing = fakeSharingApi();
  sharing.defaults.lookup = () => ok([{ id: THIRD, username: READER }]);
  if (options.households)
    sharing.defaults.households = ok([
      household({ id: HOME, name: "Home" }),
      household({ id: FLAT, name: "Flat" }),
    ]);
  const defaults = options.defaults ?? defaultsReader();
  const t = await mountTasks({
    path: `/tasks/${task.taskId}?occurrence=${task.occurrenceId}`,
    rows: task.rows,
    api: s.api,
    sharing,
    defaultsSnapshot: defaults.read,
  });
  if (options.ready !== false) {
    await t.until(() => shownFor(caller));
    expect(shownFor(caller)).toBe(true);
  }
  return { task, t, defaults, ...s };
}

/**
 * The caller's audience editor, opened, with "Only me" chosen (a change from the shared audience it starts from): enrolled, "Change…";
 * rejoining, the last audience; the first Join, the current default (an account grant here), the consent "Yes" chosen in both joins.
 */
export async function opened(
  caller: Caller,
  options: Parameters<typeof mountedFor>[1] = {},
) {
  const w = await mountedFor(caller, options);
  if (caller === "enrolled") await click(button(CONTROLS_COPY.changeAudience));
  else await click(consentChoice(true));
  await w.t.until(
    () => document.querySelector("[data-audience-chooser]") !== null,
  );
  await click(button("Only me (private)"));
  expect(grantOf(OTHER)).toBeNull();
  return w;
}

/** Opens the directory lookup for `purpose` and finds the account in BOTH result lists (search and exact username). */
export async function lookup(t: Mounted, purpose: "grant" | "exclude") {
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

/** Chooses the looked-up account for `purpose` and asserts it is accepted. */
export async function choose(t: Mounted, purpose: "grant" | "exclude") {
  await lookup(t, purpose);
  await click(chooseButtons()[0] ?? null);
  expect(chosen(purpose)).not.toBeNull();
}

export const chosen = (
  purpose: "grant" | "exclude",
  within: ParentNode = settings(),
) =>
  purpose === "grant" ? grantOf(THIRD, within) : exclusionOf(THIRD, within);

/** "Only me" plus the looked-up account for `purpose`: the policy a later edit makes. */
export const withThird = (purpose: "grant" | "exclude"): Policy =>
  purpose === "grant"
    ? {
        grants: [{ kind: "account", id: THIRD, edit: false }],
        exclude_accounts: [],
      }
    : { grants: [], exclude_accounts: [THIRD] };
