import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import * as base from "../../../src/features/sharing/copy";
import * as copy from "../../../src/features/sharing/households/copy";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, SAM } from "../../support/data/sharing";
import { stubEnv } from "../../support/data/ui-env";
import {
  contextsOf,
  forgetRecoveryWorld,
  installRecoveryLocks,
  left,
  texts,
  unfreeze,
  withRecovery,
} from "../../support/recovery-editors";
import { fakeSharingApi } from "../../support/sharing/fake-api";
import { fakeHouseholdApi, ok } from "../../support/sharing/fake-households";
import {
  HOME_ID,
  homeOf,
  JAMIE_ID,
  mountHouseholds,
} from "../../support/sharing/households";
import { must, present } from "../../support/sharing/present";

/**
 * WEB-12b revision 3 (Review 4 F-R4-1, finding family `m1-household-submission-rules-without-sensitive-tests`; second design assessment
 * of 7 November 2026, Branch B′): the CELLS of M-1's submission rules that `households-submission-rules.test.tsx` (26 cases, unchanged:
 * their titles are the `expect` patterns of MU-6252..MU-6268) does not reach. A cell is one rule × one input × one answer class, event
 * or path; every title here BEGINS with its cell id (`<rule>.<input>.<class>:`), and the cell table, the writers, the decision exits and
 * the catalogued mutant that proves each pin are in `tests/static/household-draft-writers.test.ts` (and `docs/pwa.md`).
 *
 *  - R3 (only a durable success covers what was sent), the classes the rules suite does not visit: an answer of kind `closed` and
 *    `offline` (nothing sent, no attempt kept) and `not_sent` after the quiet retries (held back, kept for Try again), for all three
 *    inputs; and Invite's own exits: a lookup that FAILED, and inviting yourself.
 *  - R4 (a rename's base lives and dies with its draft): a restored rename typed into keeps its base (and after Cancel and reopen); a
 *    refusal that is not a conflict keeps it; and N-1, a Try again refused as a conflict, pinned AS THE PRODUCT BEHAVES while decision
 *    D-2 is open (see that test).
 *  - W2 / W4 / W7 / D (the writers): an account chosen from an EMPTY field is the person's input; Invite's "Discard instead" resets the
 *    field; a Try again pressed on the PAGE after Cancel or Close ends the session (`dropped()` with no form shown); a Try again that
 *    is refused completes nothing; a Try again of another dialog's change leaves the Rename dialog open; and a household you no longer
 *    manage binds no Rename model.
 *
 * Decision D-1 is DECIDED (Kieran, 7 November 2026, WEB12B-D1-ANSWER-20261107, `approval/web12b-d1-answer-20261107.json` in the
 * orchestrator): a successful Try again forgets text typed after the lost attempt, as `docs/sharing.md` D-12b-18 is written; I7 stays a
 * first-try rule, and keeping the newer text (with DA-2) is a follow-up card. The cells here assume that rule and do not restate it.
 *
 * Every cell common to the three inputs is written ONCE (a per-input adapter, `INPUTS`) and called with a literal title per input, so
 * the static cell table can find each title. Determinism: held or queued answers, zero-delay turns (`settle`), `flushDirty` for "an
 * update saves it"; the `not_sent` cells alone run the session's quiet retries (2.55 s of `setTimeout`) on Vitest's fake `setTimeout`,
 * with every lookup done before the fake clock is installed. Every lookup is asserted present first (`present`/`must`), so a mutant
 * fails these cells by an assertion. COMPONENT evidence (jsdom), not a native browser result.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(async () => {
  vi.useRealTimers();
  unfreeze();
  forgetRecoveryWorld();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// Spelt out (not imported), as in the rules suite.
const CREATE = "household-create";
const RENAME = `household-rename:${HOME_ID}`;
const INVITE = `household-invite:${HOME_ID}`;
const NEW_PATH = "/sharing/new";
const RENAME_PATH = `/sharing/households/${HOME_ID}/rename`;
const INVITE_PATH = `/sharing/households/${HOME_ID}/invitations`;
const RENAME_TITLE = copy.RENAME_TITLE("Home");
const INVITE_TITLE = copy.INVITATIONS_TITLE_FOR("Home");
const UNRESOLVED = "[data-households-unresolved]";

function world(path: string) {
  const api = fakeHouseholdApi();
  api.defaults.households = ok([homeOf()]);
  const sharingApi = fakeSharingApi();
  sharingApi.defaults.lookup = (username) => ok([{ id: JAMIE_ID, username }]);
  api.defaults.lookup = (username) => ok([{ id: JAMIE_ID, username }]);
  const env = withRecovery(stubEnv());
  const t = mountHouseholds(path, { env, api, sharingApi });
  return { t, api, env, sharingApi };
}
type World = ReturnType<typeof world>;

const dialog = (name: string) =>
  present(() => screen.queryByRole("dialog", { name }));
const closed = (name: string) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
async function field(dialogName: string, label: string) {
  const box = await dialog(dialogName);
  return (await present(() =>
    within(box).queryByLabelText(label),
  )) as HTMLInputElement;
}
const renameField = () => field(RENAME_TITLE, copy.NAME_LABEL);
const inviteField = () => field(INVITE_TITLE, copy.USERNAME_LABEL);
/** The dialog's field shows `value` (a synchronous wait: a field that never shows it fails by this assertion, never by a time-out). */
async function shows(
  dialogName: string,
  label: string,
  value: string,
  message: string,
) {
  const box = await dialog(dialogName);
  await waitFor(() =>
    expect(
      (within(box).queryByLabelText(label) as HTMLInputElement | null)?.value,
      message,
    ).toBe(value),
  );
}
async function button(dialogName: string, name: string) {
  const box = await dialog(dialogName);
  return must(within(box).queryByRole("button", { name }));
}
async function press(dialogName: string, name: string) {
  fireEvent.click(await button(dialogName, name));
}
const saveName = () => press(RENAME_TITLE, copy.SAVE_NAME);
const invite = () => press(INVITE_TITLE, copy.INVITE);
/** The unresolved attempt's Try again, wherever its banner is (a dialog's, or the page's when no dialog is open). */
async function tryAgain() {
  const banner = await present(() =>
    document.querySelector<HTMLElement>(UNRESOLVED),
  );
  fireEvent.click(
    must(within(banner).queryByRole("button", { name: base.TRY_AGAIN })),
  );
}
const commands = (api: World["api"]) =>
  api.sentCommands.map((c) => c.commands[0]);
const dirty = () => contextsOf(pageFormRegistry.dirty());
async function copies(context: string): Promise<unknown[]> {
  return (await texts(context)).map((text) => JSON.parse(text));
}
/** A few zero-delay turns: every continuation of an answer already released has run (no wall-clock wait). */
async function settle() {
  for (let turn = 0; turn < 4; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
/** What an update would save now is saved (the coordinator's flush), and the store holds `value` for `context`. */
async function savedNow(context: string, value: unknown) {
  expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
  expect(await copies(context)).toContainEqual(value);
}
/** An update would save nothing for `context` now: not dirty, and after a flush no copy of it is left. */
async function nothingToSave(context: string) {
  expect(dirty(), "nothing left to save").not.toContain(context);
  expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
  expect(await copies(context), "no stale copy").toEqual([]);
}

/**
 * The form is back where it starts, after a copy was saved: WEB-14a's rule keeps the model dirty until its own copy matches what the
 * form shows (`session.ts` `isDirty`), and the next save discards the copies once nothing is unfinished. So: an update's save leaves no
 * copy, and then nothing is dirty.
 */
async function resolvedBySave(context: string) {
  expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
  expect(await copies(context), "the save discarded the copy").toEqual([]);
  expect(dirty(), "then nothing is left to save").not.toContain(context);
}

/** The per-input adapter: what differs between New household, Rename and an invitation's username for a cell common to all three. */
interface Input {
  readonly path: string;
  readonly title: string;
  readonly context: string;
  /** What the person types. */
  readonly text: string;
  /** The saved copy of `text` (Rename's carries the household's version, 4). */
  readonly saved: unknown;
  /** The submit button's name. */
  readonly submit: string;
  /** The button that closes the dialog keeping the draft (Cancel; Close for Invitations). */
  readonly leave: string;
  field(): Promise<HTMLInputElement>;
}
const INPUTS = {
  create: {
    path: NEW_PATH,
    title: copy.NEW_TITLE,
    context: CREATE,
    text: "Flat",
    saved: { v: 1, text: "Flat" },
    submit: copy.CREATE,
    leave: copy.CANCEL_ACTION,
    field: () => field(copy.NEW_TITLE, copy.NAME_LABEL),
  },
  rename: {
    path: RENAME_PATH,
    title: RENAME_TITLE,
    context: RENAME,
    text: "Our place",
    saved: { v: 1, text: "Our place", base: 4 },
    submit: copy.SAVE_NAME,
    leave: copy.CANCEL_ACTION,
    field: renameField,
  },
  invite: {
    path: INVITE_PATH,
    title: INVITE_TITLE,
    context: INVITE,
    text: "jamie",
    saved: { v: 1, text: "jamie" },
    submit: copy.INVITE,
    leave: copy.CLOSE,
    field: inviteField,
  },
} satisfies Record<string, Input>;

/** The input typed and submitted once; resolves when its command was sent. */
async function typedAndSent(w: World, input: Input) {
  fireEvent.change(await input.field(), { target: { value: input.text } });
  await press(input.title, input.submit);
  await waitFor(() => expect(commands(w.api)).toHaveLength(1));
}
/**
 * Presses `target` with Vitest's fake `setTimeout` installed (every lookup done before), and runs the session's quiet retries of a
 * `not_sent` answer (`untilSent`: 2.55 s in all) to their end; the real clock is back before any later wait.
 */
async function quietRetries(target: HTMLElement) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(target);
    for (let step = 0; step < 12; step += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
  } finally {
    vi.useRealTimers();
  }
  await settle();
}
const NOT_SENT_ANSWERS = 7;
/** After an answer that is not a durable success: the input is still shown, still dirty, and an update saves it. */
async function stillCovered(input: Input) {
  expect((await input.field()).value, "the input is still shown").toBe(
    input.text,
  );
  expect(dirty(), "still dirty: no success covered it").toContain(
    input.context,
  );
  await savedNow(input.context, input.saved);
}

// ---- R3: the answer classes the rules suite does not visit ------------------------------------------------------------------------
/** R3 × an answer class with no attempt kept (`closed`: the session closed the request; `offline`): nothing was sent, nothing covered. */
async function notSentAtAll(input: Input, kind: "closed" | "offline") {
  const w = world(input.path);
  w.api.next.command.push({ ok: false, kind } as never);
  await typedAndSent(w, input);
  await settle();
  expect(
    document.querySelector(UNRESOLVED),
    "no attempt is kept (it was never sent)",
  ).toBeNull();
  // An offline answer says so on the form's surface; a closed one (the session closed the request) says nothing.
  expect(
    screen.queryAllByText(base.SAVE_OFFLINE_REASON).length > 0,
    kind === "offline"
      ? "the offline answer is said"
      : "a closed answer says nothing",
  ).toBe(kind === "offline");
  await stillCovered(input);
}
/**
 * R3 × `not_sent` after the quiet retries (`untilSent`: 50, 100, 200, 400, 800 and 1,000 ms, then the seventh answer is final): the
 * attempt is held back and kept for Try again, and the input is not covered. Only `setTimeout` is faked, after every lookup is done.
 */
async function heldBack(input: Input) {
  const w = world(input.path);
  for (let answer = 0; answer < NOT_SENT_ANSWERS; answer += 1)
    w.api.next.command.push({ ok: false, kind: "not_sent" } as never);
  fireEvent.change(await input.field(), { target: { value: input.text } });
  await quietRetries(await button(input.title, input.submit));
  expect(commands(w.api), "the quiet retries: seven tries").toHaveLength(7);
  const banner = await present(() =>
    document.querySelector<HTMLElement>(UNRESOLVED),
  );
  expect(banner.textContent, "kept for Try again, said as not sent").toContain(
    base.NOT_SENT,
  );
  await stillCovered(input);
}

describe("R3 × the answer classes closed, offline and not_sent", () => {
  test("R3.create.closed: an answer of kind closed (nothing sent, no attempt kept) covers nothing: the name stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.create, "closed");
  });
  test("R3.rename.closed: an answer of kind closed (nothing sent, no attempt kept) covers nothing: the name stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.rename, "closed");
  });
  test("R3.invite.closed: an answer of kind closed (nothing sent, no attempt kept) covers nothing: the username stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.invite, "closed");
  });
  test("R3.create.offline: an answer of kind offline (nothing sent) covers nothing: the name stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.create, "offline");
  });
  test("R3.rename.offline: an answer of kind offline (nothing sent) covers nothing: the name stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.rename, "offline");
  });
  test("R3.invite.offline: an answer of kind offline (nothing sent) covers nothing: the username stays dirty, and an update saves it", async () => {
    await notSentAtAll(INPUTS.invite, "offline");
  });
  test("R3.create.not-sent: held back after the quiet retries (kept for Try again) covers nothing: the name stays dirty, and an update saves it", async () => {
    await heldBack(INPUTS.create);
  });
  test("R3.rename.not-sent: held back after the quiet retries (kept for Try again) covers nothing: the name stays dirty, and an update saves it", async () => {
    await heldBack(INPUTS.rename);
  });
  test("R3.invite.not-sent: held back after the quiet retries (kept for Try again) covers nothing: the username stays dirty, and an update saves it", async () => {
    await heldBack(INPUTS.invite);
  });
});

describe("R3 × Invite's own exits", () => {
  test("R3.invite.lookup-failed: a lookup that FAILED sends nothing and covers nothing: the username stays dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    w.api.next.lookup.push({ ok: false, kind: "uncertain" } as never);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(w.api.count("lookup")).toBe(1));
    expect(
      (await present(() => screen.queryAllByText(base.LOOKUP_FAILED))).length,
    ).toBeGreaterThan(0);
    await settle();
    expect(commands(w.api), "nothing sent").toEqual([]);
    await stillCovered(INPUTS.invite);
  });

  test("R3.invite.self: inviting yourself sends nothing and covers nothing: the username stays dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    w.api.defaults.lookup = (username) => ok([{ id: ME, username }]);
    fireEvent.change(await inviteField(), { target: { value: "me" } });
    await invite();
    await waitFor(() => expect(w.api.count("lookup")).toBe(1));
    expect(
      (await present(() => screen.queryAllByText(copy.INVITE_SELF))).length,
    ).toBeGreaterThan(0);
    await settle();
    expect(commands(w.api), "nothing sent").toEqual([]);
    expect((await inviteField()).value, "the username stays").toBe("me");
    expect(dirty(), "still dirty").toContain(INVITE);
    await savedNow(INVITE, { v: 1, text: "me" });
  });
});

// ---- R3 × refusal kinds, and the presses a dialog refuses ---------------------------------------------------------------------
/** Two definite refusals of other kinds, one after the other: neither covers the input. */
async function refusedTwice(input: Input, kinds: [string, string]) {
  const w = world(input.path);
  for (const [n, kind] of kinds.entries()) {
    w.api.next.command.push({ ok: false, kind } as never);
    if (n === 0)
      fireEvent.change(await input.field(), {
        target: { value: input.text },
      });
    await press(input.title, input.submit);
    await waitFor(() => expect(commands(w.api)).toHaveLength(n + 1));
    await settle();
    expect(dirty(), `still dirty after the ${kind} refusal`).toContain(
      input.context,
    );
  }
  await stillCovered(input);
}
/** The form submitted (Enter in its field: with no enabled submit button attached, the field's form submits) while its press is refused. */
async function submitRefused(input: Input) {
  const field = await input.field();
  const form = must(field.closest("form"));
  fireEvent.submit(form);
  await settle();
  return form;
}

describe("R3 × refusal kinds, and G × a refused press", () => {
  test("R3.create.refused-other-kinds: refused as forbidden, then as changed elsewhere: neither covers the name, still dirty, and an update saves it", async () => {
    await refusedTwice(INPUTS.create, ["forbidden", "conflict"]);
  });
  test("R3.rename.refused-other-kinds: refused as forbidden, then as a limit: neither covers the name, still dirty, and an update saves it", async () => {
    await refusedTwice(INPUTS.rename, ["forbidden", "capacity"]);
  });
  test("R3.invite.refused-other-kinds: refused as changed elsewhere, then as forbidden: neither covers the username, still dirty, and an update saves it", async () => {
    await refusedTwice(INPUTS.invite, ["conflict", "forbidden"]);
  });

  test("G.create.refused-press: the form submitted with no name (Create refused) sends nothing; control: with a name it sends", async () => {
    const w = world(NEW_PATH);
    const form = await submitRefused(INPUTS.create);
    expect(commands(w.api), "nothing sent").toEqual([]);
    fireEvent.change(await INPUTS.create.field(), {
      target: { value: "Flat" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
  });
  test("G.rename.refused-press: the form submitted with the household's own name (Save name refused) sends nothing; control: a new name sends", async () => {
    const w = world(RENAME_PATH);
    const form = await submitRefused(INPUTS.rename);
    expect(commands(w.api), "nothing sent").toEqual([]);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    fireEvent.submit(form);
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
  });
  test("G.invite.empty-press: the form submitted with no username (Invite refused) looks nothing up and sends nothing; control: a username is looked up", async () => {
    const w = world(INVITE_PATH);
    const form = await submitRefused(INPUTS.invite);
    expect(w.api.count("lookup"), "nothing looked up").toBe(0);
    expect(commands(w.api), "nothing sent").toEqual([]);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    fireEvent.submit(form);
    await waitFor(() => expect(w.api.count("lookup")).toBe(1));
  });
});

// ---- R4: a restored rename's base -------------------------------------------------------------------------------------------------
describe("R4 × a restored rename's base, beyond Save, Escape and Discard instead", () => {
  const restored = async () => {
    await left(RENAME, JSON.stringify({ v: 1, text: "Our place", base: 3 }));
    const w = world(RENAME_PATH);
    await shows(RENAME_TITLE, copy.NAME_LABEL, "Our place", "restored");
    return w;
  };

  test("R4.rename.typed-control: a rename composed on this page (no restore) is saved, and copied, under the household's version of now (4)", async () => {
    const w = world(RENAME_PATH);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    await savedNow(RENAME, { v: 1, text: "Our place", base: 4 });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({ expected_version: 4 });
  });

  test("R4.rename.typed-after-restore: a restored rename (3) typed into keeps its base: the update's copy says 3, and Save name is sent under 3", async () => {
    const w = await restored();
    fireEvent.change(await renameField(), { target: { value: "Our place 2" } });
    await savedNow(RENAME, { v: 1, text: "Our place 2", base: 3 });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      expected_version: 3,
      name: "Our place 2",
    });
  });

  test("R4.rename.typed-after-restore-reopened: restored (3), typed into, Cancel, Rename opened again and typed into: the copy still says 3", async () => {
    const w = await restored();
    fireEvent.change(await renameField(), { target: { value: "Our place 2" } });
    await press(RENAME_TITLE, copy.CANCEL_ACTION);
    await closed(RENAME_TITLE);
    await w.t.navigate(RENAME_PATH);
    const name = await renameField();
    expect(name.value, "the kept draft").toBe("Our place 2");
    fireEvent.change(name, { target: { value: "Our place 3" } });
    await savedNow(RENAME, { v: 1, text: "Our place 3", base: 3 });
  });

  test("R4.rename.keep-on-refusal: a restored rename (3) refused for a reason other than a conflict (forbidden) keeps its base: the next Save is still under 3", async () => {
    const w = await restored();
    w.api.next.command.push({ ok: false, kind: "forbidden" } as never);
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(
      (await present(() => screen.queryAllByText(copy.FORBIDDEN))).length,
    ).toBeGreaterThan(0);
    await settle();
    fireEvent.change(await renameField(), { target: { value: "Our place 2" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(commands(w.api)[1]).toMatchObject({ expected_version: 3 });
  });

  test("R4.rename.keep-when-not-sent: a restored rename (3) answered closed, then offline, then not_sent after the quiet retries keeps its base: typed into, it is still copied under 3", async () => {
    const w = await restored();
    for (const [n, kind] of (["closed", "offline"] as const).entries()) {
      w.api.next.command.push({ ok: false, kind } as never);
      await saveName();
      await waitFor(() => expect(commands(w.api)).toHaveLength(n + 1));
      await settle();
    }
    fireEvent.change(await renameField(), { target: { value: "Our place 2" } });
    await savedNow(RENAME, { v: 1, text: "Our place 2", base: 3 });
    for (let answer = 0; answer < NOT_SENT_ANSWERS; answer += 1)
      w.api.next.command.push({ ok: false, kind: "not_sent" } as never);
    await quietRetries(await button(RENAME_TITLE, copy.SAVE_NAME));
    expect(commands(w.api), "two answers, then seven tries").toHaveLength(9);
    fireEvent.change(await renameField(), { target: { value: "Our place 3" } });
    await savedNow(RENAME, { v: 1, text: "Our place 3", base: 3 });
  });

  // N-1 (second design assessment, class `new`, low): the dialog's first try forgets a restored base on a conflict (`renameConflict` in
  // `households-recovery.test.tsx`, this cell's control); `operations.retry()` has no such writer. Whether to change that is decision D-2
  // (open: the coordinator's / Kieran's). Until it is decided this cell pins the behaviour AS IT IS, so a change is deliberate: a fix
  // turns this cell red (catalogued mutant MU-6282) and must change it and `docs/pwa.md`. Not a waiver: a review may still raise N-1.
  test("R4.rename.retry-conflict-keeps-stale-base: N-1, decision D-2 open, pinned as the product behaves: a restored rename (3) lost, its Try again refused as changed elsewhere, the next Save is still sent under 3 (the server's guard refuses it again: never an overwrite)", async () => {
    const w = await restored();
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    w.api.next.command.push({ ok: false, kind: "conflict" } as never);
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(commands(w.api)[1], "the same attempt").toEqual(commands(w.api)[0]);
    await settle();
    fireEvent.change(await renameField(), { target: { value: "Our place 2" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(3));
    expect(commands(w.api)[2]).toMatchObject({
      expected_version: 3,
      name: "Our place 2",
    });
  });
});

// ---- W2 / W4 / D: the writers of a choice, a reset and a binding -----------------------------------------------------------------
describe("W2, W4 and D × Invite's choice and reset, Rename's binding", () => {
  test("W2.invite.choice-from-empty-field: an account chosen in the lookup from an EMPTY field is the person's input: shown, dirty, and an update saves it", async () => {
    world(INVITE_PATH);
    expect((await inviteField()).value, "the field starts empty").toBe("");
    expect(dirty(), "nothing typed yet").not.toContain(INVITE);
    const box = await dialog(INVITE_TITLE);
    fireEvent.click(
      must(within(box).queryByRole("button", { name: copy.FIND_ACCOUNT })),
    );
    fireEvent.change(
      await present(() =>
        within(box).queryByLabelText(base.LOOKUP_EXACT_LABEL),
      ),
      { target: { value: "jamie" } },
    );
    fireEvent.click(
      must(
        within(box).queryByRole("button", { name: base.LOOKUP_EXACT_BUTTON }),
      ),
    );
    fireEvent.click(
      await present(() =>
        within(box).queryByRole("button", {
          name: `${base.LOOKUP_CHOOSE}: jamie`,
        }),
      ),
    );
    await shows(
      INVITE_TITLE,
      copy.USERNAME_LABEL,
      "jamie",
      "the chosen account shows",
    );
    expect(dirty(), "the chosen account is unfinished input").toContain(INVITE);
    await savedNow(INVITE, { v: 1, text: "jamie" });
  });

  test("W4.invite.discard-instead: a restored username, then Discard instead: the field returns to its start and an update saves nothing", async () => {
    await left(INVITE, JSON.stringify({ v: 1, text: "jamie" }));
    world(INVITE_PATH);
    await shows(
      INVITE_TITLE,
      copy.USERNAME_LABEL,
      "jamie",
      "control: restored",
    );
    await press(INVITE_TITLE, "Discard instead");
    await shows(
      INVITE_TITLE,
      copy.USERNAME_LABEL,
      "",
      "the field shows its start",
    );
    await nothingToSave(INVITE);
  });

  test("D.rename.non-manager-not-bound: a saved rename copy for a household you no longer manage is not restored or listed (no form shows it); the copy stays in its store", async () => {
    await left(RENAME, JSON.stringify({ v: 1, text: "Our place", base: 3 }));
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf({ role: "member" })]);
    mountHouseholds(RENAME_PATH, {
      env: withRecovery(stubEnv()),
      api,
      sharingApi: fakeSharingApi(),
    });
    const box = await dialog(RENAME_TITLE);
    await present(() => within(box).queryByText(copy.INVITE_MANAGERS_ONLY));
    await settle();
    expect(
      within(box).queryByLabelText(copy.NAME_LABEL),
      "no name field",
    ).toBeNull();
    expect(dirty(), "nothing restored into a form nobody sees").not.toContain(
      RENAME,
    );
    expect(await copies(RENAME), "the copy is not discarded").toContainEqual({
      v: 1,
      text: "Our place",
      base: 3,
    });
  });
});

// ---- W1 / O1 × a form's start ------------------------------------------------------------------------------------------------
describe("W1 and O1 × what the form shows untouched", () => {
  test("W1.rename.typed-back-to-start: a name typed, then the household's own name typed back: the next save discards the copy and nothing is left to save", async () => {
    world(RENAME_PATH);
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await savedNow(RENAME, { v: 1, text: "Our place", base: 4 });
    fireEvent.change(name, { target: { value: "Home" } });
    await resolvedBySave(RENAME);
  });

  test("W1.rename.reopened-after-rename-elsewhere: Rename closed untouched, the household renamed elsewhere and read again: opened again, its start is the new name (typed back, the next save discards the copy)", async () => {
    const w = world(RENAME_PATH);
    await renameField();
    await press(RENAME_TITLE, copy.CANCEL_ACTION);
    await closed(RENAME_TITLE);
    await settle();
    // Read again BEFORE Rename opens again: a successful command (a member promoted on the detail) reads the list again (R7).
    w.api.defaults.households = ok([homeOf({ name: "Cabin", version: 5 })]);
    await w.t.navigate(`/sharing/households/${HOME_ID}`);
    const sam = await present(() =>
      document.querySelector<HTMLElement>(`[data-member="${SAM}"]`),
    );
    fireEvent.click(
      must(within(sam).queryByRole("button", { name: `${copy.PROMOTE}: sam` })),
    );
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await present(() => screen.queryAllByText("Cabin")[0] ?? null);
    await settle();
    await w.t.navigate(RENAME_PATH);
    const renamed = copy.RENAME_TITLE("Cabin");
    await shows(renamed, copy.NAME_LABEL, "Cabin", "the name read again");
    const name = await field(renamed, copy.NAME_LABEL);
    fireEvent.change(name, { target: { value: "Our place" } });
    await savedNow(RENAME, { v: 1, text: "Our place", base: 5 });
    fireEvent.change(name, { target: { value: "Cabin" } });
    await resolvedBySave(RENAME);
  });

  test("O1.invite.typed-after-success: after a successful invitation (the field cleared), the session goes on: a username typed is dirty and saved, and a later lost invitation's successful Try again forgets it", async () => {
    const w = world(INVITE_PATH);
    await typedAndSent(w, INPUTS.invite);
    await shows(
      INVITE_TITLE,
      copy.USERNAME_LABEL,
      "",
      "control: the field cleared",
    );
    await settle();
    fireEvent.change(await inviteField(), { target: { value: "sam2" } });
    expect(dirty(), "the new username is unfinished input").toContain(INVITE);
    await savedNow(INVITE, { v: 1, text: "sam2" });
    // ... and that session is still the form's: a lost invitation of it, newer text typed, then its successful Try again (no ticket:
    // only page memory's drop reaches the model, decision D-1) forgets the field and leaves nothing to save.
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    fireEvent.change(await inviteField(), { target: { value: "sam3" } });
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(3));
    await shows(
      INVITE_TITLE,
      copy.USERNAME_LABEL,
      "",
      "D-1: the field forgotten",
    );
    await settle();
    await nothingToSave(INVITE);
  });
});

describe("D × Invite's binding", () => {
  test("D.invite.non-manager-not-bound: a saved invitation copy for a household you no longer manage is not restored or listed (no form shows it); the copy stays in its store", async () => {
    await left(INVITE, JSON.stringify({ v: 1, text: "jamie" }));
    const api = fakeHouseholdApi();
    api.defaults.households = ok([homeOf({ role: "member" })]);
    mountHouseholds(INVITE_PATH, {
      env: withRecovery(stubEnv()),
      api,
      sharingApi: fakeSharingApi(),
    });
    const box = await dialog(INVITE_TITLE);
    await present(() => within(box).queryByText(copy.INVITE_MANAGERS_ONLY));
    await settle();
    expect(
      within(box).queryByLabelText(copy.USERNAME_LABEL),
      "no username field",
    ).toBeNull();
    expect(dirty(), "nothing restored into a form nobody sees").not.toContain(
      INVITE,
    );
    expect(await copies(INVITE), "the copy is not discarded").toContainEqual({
      v: 1,
      text: "jamie",
    });
  });
});

// ---- W7: the Try again paths -----------------------------------------------------------------------------------------------------
/**
 * An uncertain first try; the dialog left with the draft kept (Cancel / Close); the PAGE's Try again succeeds: the session ends, and the
 * dialog opened again begins a NEW one from what it then shows. For Rename the retried change lands (the list read after it has the new
 * name and version), so the new session's start is that name: typed back, the next save resolves it.
 */
async function pageTryAgain(
  input: Input,
  landed?: { name: string; version: number },
) {
  const w = world(input.path);
  w.api.next.command.push({ ok: false, kind: "uncertain" });
  await typedAndSent(w, input);
  await present(() => document.querySelector(UNRESOLVED));
  await press(input.title, input.leave);
  await closed(input.title);
  expect(dirty(), "control: the kept draft is still listed").toContain(
    input.context,
  );
  if (landed) w.api.defaults.households = ok([homeOf(landed)]);
  await tryAgain();
  await waitFor(() => expect(commands(w.api)).toHaveLength(2));
  expect(commands(w.api)[1], "the same attempt").toEqual(commands(w.api)[0]);
  await settle();
  await nothingToSave(input.context);
  // The ended session is not resumed: the dialog opened again begins a new one, and typing is unfinished input again.
  if (landed) {
    const title = copy.RENAME_TITLE(landed.name);
    await w.t.navigate(input.path);
    await shows(title, copy.NAME_LABEL, landed.name, "the landed name");
    const name = await field(title, copy.NAME_LABEL);
    fireEvent.change(name, { target: { value: "Cabin" } });
    await savedNow(input.context, {
      v: 1,
      text: "Cabin",
      base: landed.version,
    });
    fireEvent.change(name, { target: { value: landed.name } });
    await resolvedBySave(input.context);
    return;
  }
  await w.t.navigate(input.path);
  fireEvent.change(await input.field(), { target: { value: input.text } });
  expect(dirty(), "the dialog opened again takes new input").toContain(
    input.context,
  );
  await savedNow(input.context, input.saved);
}
/** An uncertain first try, then its Try again REFUSED (changed elsewhere): nothing is completed, the input stays, dirty. */
async function refusedTryAgain(input: Input) {
  const w = world(input.path);
  w.api.next.command.push({ ok: false, kind: "uncertain" });
  await typedAndSent(w, input);
  w.api.next.command.push({ ok: false, kind: "conflict" } as never);
  await tryAgain();
  await waitFor(() => expect(commands(w.api)).toHaveLength(2));
  await settle();
  expect(
    document.querySelector(UNRESOLVED),
    "the refusal ended the attempt",
  ).toBeNull();
  expect(
    screen.queryByRole("dialog", { name: input.title }),
    "the dialog stays open",
  ).not.toBeNull();
  expect(w.t.router().state.location.pathname, "nothing is shown as made").toBe(
    input.path,
  );
  await stillCovered(input);
}

describe("W7 × where Try again is pressed, and what it is answered", () => {
  test("W7.create.page-after-cancel: an uncertain create, Cancel (the name kept), then the PAGE's Try again succeeds: the session ends, nothing is dirty, no copy", async () => {
    await pageTryAgain(INPUTS.create);
  });
  test("W7.rename.page-after-cancel: an uncertain rename, Cancel (the name kept), then the PAGE's Try again succeeds: the session ends, nothing is dirty, no copy; opened again it begins from the landed name", async () => {
    await pageTryAgain(INPUTS.rename, { name: "Our place", version: 5 });
  });
  test("W7.invite.page-after-close: an uncertain invitation, Close (the username kept), then the PAGE's Try again succeeds: the session ends, nothing is dirty, no copy", async () => {
    await pageTryAgain(INPUTS.invite);
  });
  test("W7.create.refused-completes-nothing: a Try again refused (changed elsewhere) completes nothing: the dialog stays, the name stays dirty, no household is shown", async () => {
    await refusedTryAgain(INPUTS.create);
  });
  test("W7.rename.refused-completes-nothing: a Try again refused (changed elsewhere) completes nothing: the dialog stays, the name stays dirty", async () => {
    await refusedTryAgain(INPUTS.rename);
  });
  test("W7.invite.refused-completes-nothing: a Try again refused (changed elsewhere) completes nothing: the dialog stays, the username stays dirty", async () => {
    await refusedTryAgain(INPUTS.invite);
  });
  test("W7.create.try-again-not-sent: a Try again answered closed (not sent this time) completes nothing: the attempt is kept as it was, the dialog stays, the name stays dirty", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    await typedAndSent(w, INPUTS.create);
    w.api.next.command.push({ ok: false, kind: "closed" } as never);
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    await settle();
    const banner = await present(() =>
      document.querySelector<HTMLElement>(UNRESOLVED),
    );
    expect(
      banner.textContent,
      "the earlier attempt is kept, as it was",
    ).toContain(base.UNCERTAIN);
    expect(
      screen.queryByRole("dialog", { name: copy.NEW_TITLE }),
      "the dialog stays open",
    ).not.toBeNull();
    expect(
      w.t.router().state.location.pathname,
      "nothing is shown as made",
    ).toBe(NEW_PATH);
    await stillCovered(INPUTS.create);
  });
  test("W7.create.try-again-other-answers: Try again answered uncertain, then offline, then not_sent after the quiet retries, then forbidden: none completes the create (the dialog stays, the name stays dirty, no household is shown)", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    await typedAndSent(w, INPUTS.create);
    const stays = async (after: string) => {
      expect(
        screen.queryByRole("dialog", { name: copy.NEW_TITLE }),
        `the dialog stays open after ${after}`,
      ).not.toBeNull();
      expect(w.t.router().state.location.pathname, after).toBe(NEW_PATH);
      expect(dirty(), `still dirty after ${after}`).toContain(CREATE);
    };
    for (const [n, kind] of (["uncertain", "offline"] as const).entries()) {
      w.api.next.command.push({ ok: false, kind } as never);
      await tryAgain();
      await waitFor(() => expect(commands(w.api)).toHaveLength(n + 2));
      await settle();
      await stays(kind);
      // Not sent this time: the earlier attempt stays exactly as it was (R8), never said as a fresh offline refusal.
      expect(
        screen.queryAllByText(base.SAVE_OFFLINE_REASON),
        `no fresh refusal is said after ${kind}`,
      ).toHaveLength(0);
    }
    for (let answer = 0; answer < NOT_SENT_ANSWERS; answer += 1)
      w.api.next.command.push({ ok: false, kind: "not_sent" } as never);
    const banner = await present(() =>
      document.querySelector<HTMLElement>(UNRESOLVED),
    );
    await quietRetries(
      must(within(banner).queryByRole("button", { name: base.TRY_AGAIN })),
    );
    expect(commands(w.api)).toHaveLength(3 + NOT_SENT_ANSWERS);
    await stays("not_sent");
    w.api.next.command.push({ ok: false, kind: "forbidden" } as never);
    await tryAgain();
    await waitFor(() =>
      expect(commands(w.api)).toHaveLength(4 + NOT_SENT_ANSWERS),
    );
    await settle();
    await stays("forbidden");
    await stillCovered(INPUTS.create);
  });
  test("W7.invite.detail-action-keeps-draft: a username kept after Close, then a lost member promotion on the household's detail retried there: the invitation's draft is not the retried change's, it stays", async () => {
    const w = world(INVITE_PATH);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    await press(INVITE_TITLE, copy.CLOSE);
    await closed(INVITE_TITLE);
    await w.t.navigate(`/sharing/households/${HOME_ID}`);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const sam = await present(() =>
      document.querySelector<HTMLElement>(`[data-member="${SAM}"]`),
    );
    fireEvent.click(
      must(within(sam).queryByRole("button", { name: `${copy.PROMOTE}: sam` })),
    );
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    await waitFor(() =>
      expect(
        document.querySelector(UNRESOLVED),
        "control: the retried promotion completed",
      ).toBeNull(),
    );
    await settle();
    expect(dirty(), "the kept username is still unfinished input").toContain(
      INVITE,
    );
    await w.t.navigate(INVITE_PATH);
    expect((await inviteField()).value, "the kept username").toBe("jamie");
  });
  test("W7.invite.retried-in-rename-dialog: a lost invitation retried from the Rename dialog's banner completes the invitation, not the rename: the Rename dialog stays open with the person's text", async () => {
    const w = world(INVITE_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    await typedAndSent(w, INPUTS.invite);
    await present(() => document.querySelector(UNRESOLVED));
    await w.t.navigate(RENAME_PATH);
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(commands(w.api)[1], "the invitation was retried").toMatchObject({
      kind: "invite_to_household",
    });
    await waitFor(() =>
      expect(
        document.querySelector(UNRESOLVED),
        "control: the retried invitation completed",
      ).toBeNull(),
    );
    await settle();
    expect(
      screen.queryByRole("dialog", { name: RENAME_TITLE }),
      "the Rename dialog is still open",
    ).not.toBeNull();
    expect((await renameField()).value, "with the person's text").toBe(
      "Our place",
    );
  });
});
