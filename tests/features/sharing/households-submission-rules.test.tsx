import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import * as base from "../../../src/features/sharing/copy";
import * as copy from "../../../src/features/sharing/households/copy";
import { forgetHouseholdsMemory } from "../../../src/features/sharing/households/memory";
import {
  flushDirty,
  pageFormRegistry,
} from "../../../src/lib/form-recovery/registry";
import { FLUSH_START_GRACE_MS } from "../../../src/lib/pwa/coordinator";
import { installMatchMedia } from "../../helpers/match-media";
import { FakeOrigin } from "../../pwa/coordinator-world";
import { stubEnv } from "../../support/data/ui-env";
import {
  contextsOf,
  forgetRecoveryWorld,
  freeze,
  installRecoveryLocks,
  left,
  texts,
  unfreeze,
  withRecovery,
} from "../../support/recovery-editors";
import { fakeSharingApi } from "../../support/sharing/fake-api";
import {
  fakeHouseholdApi,
  held,
  ok,
} from "../../support/sharing/fake-households";
import {
  HOME_ID,
  homeOf,
  JAMIE_ID,
  mountHouseholds,
} from "../../support/sharing/households";
import { must, present } from "../../support/sharing/present";

/**
 * WEB-12b revision 2 (Review 3 F-R3-1, finding family `m1-household-submission-rules-without-sensitive-tests`; design assessment of
 * 7 November 2026, Branch B): M-1's SUBMISSION RULES, one test per rule per household input, so that a sibling dialog cannot lose a rule
 * silently. The rules are the ones `households/form-recovery.ts`'s header and `docs/pwa.md` ("WEB-12b's household dialogs") state for all
 * three inputs (New household's name, Rename's name, an invitation's username):
 *
 *  - R1 FROZEN: while an update reload is being prepared, typing (and a directory choice) changes nothing, and Create, Save name and
 *    Invite send nothing (Invite looks nothing up either);
 *  - R2 I7: after a durable success, the draft is cleared only while it is still what was sent: text typed meanwhile stays the draft,
 *    dirty, and an update saves it (O1, its control: nothing typed since, the draft and its saved copy go);
 *  - R3 ONLY A DURABLE SUCCESS COVERS WHAT WAS SENT: an uncertain answer, a definite refusal, or (Invite) a lookup that finds nobody
 *    leaves the input dirty with its saved copy; an accepted update saves it, and after the reload it is restored and NOTHING is resent;
 *  - R4 A RENAME DRAFT'S BASE LIVES AND DIES WITH IT: a restored rename is saved under the version it was composed against (control), and
 *    once that draft is dropped (Escape, "Discard instead") a fresh rename is saved under the household's version of now;
 *  - D-1 (decision reported to the coordinator, not granted; the behaviour as `docs/sharing.md` D-12b-18 is written): a Try again that is
 *    now known to have made the change completes the form as a first-try success does and forgets the input, EVEN text typed since the
 *    lost attempt. Pinned per input, so a change of that decision changes these three tests and their docs, never silently.
 *
 * New household's R1 and R2 cases are in `households-recovery.test.tsx` (MU-6240..MU-6242); the rule-to-test map is in `docs/pwa.md`.
 * Every test title carries its rule and site, and each catalogued mutant (MU-6252..MU-6268) names only its own site's tests.
 *
 * Determinism: held answers (`held()`), the registry's own freeze (`freeze()`/`unfreeze()`), `flushDirty` for "an update saves it" and
 * the PRODUCTION app-update coordinator (worker, clock and reload are doubles) only where the update itself is the subject; no timers
 * beyond zero-delay turns. Every lookup is asserted present first (`present`/`must`), so a mutant fails these tests by an assertion.
 * COMPONENT evidence (jsdom), not a native browser result.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);

/** Every coordinator a test started, disposed after it whatever happened (a frozen registry must never leak into the next test). */
const started: { dispose(): void }[] = [];
afterEach(async () => {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  unfreeze();
  forgetRecoveryWorld();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// Spelt out (not imported), as in `households-recovery.test.tsx`.
const CREATE = "household-create";
const RENAME = `household-rename:${HOME_ID}`;
const INVITE = `household-invite:${HOME_ID}`;
const NEW_PATH = "/sharing/new";
const RENAME_PATH = `/sharing/households/${HOME_ID}/rename`;
const INVITE_PATH = `/sharing/households/${HOME_ID}/invitations`;
const RENAME_TITLE = copy.RENAME_TITLE("Home");
const INVITE_TITLE = copy.INVITATIONS_TITLE_FOR("Home");

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
const newName = () => field(copy.NEW_TITLE, copy.NAME_LABEL);
const renameField = () => field(RENAME_TITLE, copy.NAME_LABEL);
const inviteField = () => field(INVITE_TITLE, copy.USERNAME_LABEL);
async function press(dialogName: string, name: string) {
  const box = await dialog(dialogName);
  fireEvent.click(must(within(box).queryByRole("button", { name })));
}
const create = () => press(copy.NEW_TITLE, copy.CREATE);
const saveName = () => press(RENAME_TITLE, copy.SAVE_NAME);
const invite = () => press(INVITE_TITLE, copy.INVITE);
/** The unresolved attempt's Try again (the banner names the lost change; other Try agains are other reads'). */
async function tryAgain() {
  const banner = await present(() =>
    document.querySelector<HTMLElement>("[data-households-unresolved]"),
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

/** A tab of the production coordinator over the production page registry (worker, clock and reload are doubles). */
async function updatingTab() {
  const origin = new FakeOrigin();
  const tab = origin.tab();
  Object.defineProperty(tab, "forms", { value: pageFormRegistry });
  await tab.start();
  if (tab.coordinator) started.push(tab.coordinator);
  return { origin, tab };
}
/** A new version is installed and the person accepts it ("Save and reload"): the coordinator saves what is dirty and reloads once. */
async function acceptUpdate(): Promise<number> {
  const { origin, tab } = await updatingTab();
  const waiting = await origin.installNew(2);
  await act(async () => {
    tab.actions?.accept();
  });
  let activated = false;
  for (let round = 0; round < 40 && tab.reloads === 0; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await origin.clock.advance(FLUSH_START_GRACE_MS);
    });
    const asked = waiting.messages.some(
      (m) => (m.message as { type?: string }).type === "atlas:skip-waiting",
    );
    if (asked && !activated) {
      activated = true;
      await act(async () => {
        await origin.activate(waiting);
      });
    }
  }
  return tab.reloads;
}
/** The page reloads onto the update at the same URL: its tree, page memory and models are gone; the app mounts again there. */
function reload(w: World) {
  for (const coordinator of started.splice(0)) coordinator.dispose();
  const at = w.t.router().state.location.href;
  w.t.unmount();
  act(() => forgetHouseholdsMemory());
  w.t = mountHouseholds(at, {
    env: w.env,
    api: w.api,
    sharingApi: w.sharingApi,
  });
}

// ---- R1: frozen means nothing sent and nothing changed --------------------------------------------------------------------------
describe("R1 frozen: while an update reload is being prepared", () => {
  test("R1 Rename: while an update reload is being prepared typing changes nothing (and, the freeze over, it is taken again)", async () => {
    world(RENAME_PATH);
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    expect(name.value, "not frozen: the typed name is taken").toBe("Our place");
    freeze();
    fireEvent.change(name, { target: { value: "Zed" } });
    expect(name.value, "the field keeps what it showed").toBe("Our place");
    unfreeze();
    fireEvent.change(name, { target: { value: "Zed" } });
    expect(name.value, "control: unfrozen, taken").toBe("Zed");
  });

  test("R1 Rename: while an update reload is being prepared Save name sends nothing (and, the freeze over, it sends)", async () => {
    const w = world(RENAME_PATH);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    freeze();
    await saveName();
    await settle();
    expect(commands(w.api), "nothing sent while frozen").toEqual([]);
    unfreeze();
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      kind: "rename_household",
      name: "Our place",
    });
  });

  test("R1 Invite: while an update reload is being prepared typing changes nothing (and, the freeze over, it is taken again)", async () => {
    world(INVITE_PATH);
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    expect(username.value, "not frozen: the typed username is taken").toBe(
      "jamie",
    );
    freeze();
    fireEvent.change(username, { target: { value: "zed" } });
    expect(username.value, "the field keeps what it showed").toBe("jamie");
    unfreeze();
    fireEvent.change(username, { target: { value: "zed" } });
    expect(username.value, "control: unfrozen, taken").toBe("zed");
  });

  test("R1 Invite: while an update reload is being prepared Invite looks nothing up and sends nothing (and, the freeze over, it does both)", async () => {
    const w = world(INVITE_PATH);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    freeze();
    await invite();
    await settle();
    expect(w.api.count("lookup"), "nothing looked up while frozen").toBe(0);
    expect(commands(w.api), "nothing sent while frozen").toEqual([]);
    unfreeze();
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(w.api.count("lookup")).toBe(1);
  });

  test("R1 Invite: while an update reload is being prepared an account chosen in the directory lookup changes nothing (control: unfrozen, it replaces the input)", async () => {
    world(INVITE_PATH);
    fireEvent.change(await inviteField(), { target: { value: "someone" } });
    const choose = async () => {
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
    };
    freeze();
    await choose();
    expect((await inviteField()).value, "the field keeps what it showed").toBe(
      "someone",
    );
    unfreeze();
    await choose();
    await waitFor(async () =>
      expect((await inviteField()).value, "control: unfrozen, taken").toBe(
        "jamie",
      ),
    );
  });
});

// ---- R2 (I7) and its control O1 --------------------------------------------------------------------------------------------------
describe("R2 I7 and O1: what a durable first-try success clears", () => {
  test("R2 Rename I7: a name typed while Save name is on its way stays the draft, dirty, and an update saves it", async () => {
    const w = world(RENAME_PATH);
    const answer = held<{ revision: number }>();
    w.api.next.command.push(answer.answer);
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await saveName();
    await waitFor(() => expect(answer.asked()).toBe(true));
    fireEvent.change(name, { target: { value: "Our place 2" } });
    await act(async () => {
      answer.release(ok({ revision: 2 }));
    });
    await closed(RENAME_TITLE);
    await settle();
    expect(dirty(), "the newer name is still dirty").toContain(RENAME);
    await savedNow(RENAME, { v: 1, text: "Our place 2", base: 4 });
    await w.t.navigate(RENAME_PATH);
    expect((await renameField()).value).toBe("Our place 2");
  });

  test("R2 Invite I7: a username typed while the invitation is on its way stays the draft, dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    const answer = held<{ revision: number }>();
    w.api.next.command.push(answer.answer);
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(answer.asked()).toBe(true));
    fireEvent.change(username, { target: { value: "jamie2" } });
    await act(async () => {
      answer.release(ok({ revision: 2 }));
    });
    await settle();
    expect(commands(w.api)).toHaveLength(1);
    expect((await inviteField()).value, "the newer username stays").toBe(
      "jamie2",
    );
    expect(dirty(), "and is still dirty").toContain(INVITE);
    await savedNow(INVITE, { v: 1, text: "jamie2" });
  });

  test("O1 New household (R2's control): a create answered with nothing typed since clears the name and removes the saved copy", async () => {
    const w = world(NEW_PATH);
    fireEvent.change(await newName(), { target: { value: "Flat" } });
    await savedNow(CREATE, { v: 1, text: "Flat" });
    await create();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await closed(copy.NEW_TITLE);
    await waitFor(async () => expect(await texts(CREATE)).toEqual([]));
    expect(dirty()).not.toContain(CREATE);
    await w.t.navigate(NEW_PATH);
    expect((await newName()).value).toBe("");
  });

  test("O1 Rename (R2's control): a rename answered with nothing typed since clears the draft, removes the saved copy and closes the dialog", async () => {
    const w = world(RENAME_PATH);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    await savedNow(RENAME, { v: 1, text: "Our place", base: 4 });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await closed(RENAME_TITLE);
    await waitFor(async () => expect(await texts(RENAME)).toEqual([]));
    expect(dirty()).not.toContain(RENAME);
    await w.t.navigate(RENAME_PATH);
    expect(
      (await renameField()).value,
      "Rename opens on the household's name, not the sent draft",
    ).toBe("Home");
  });

  test("O1 Invite (R2's control): an invitation answered with nothing typed since clears the field and removes the saved copy", async () => {
    const w = world(INVITE_PATH);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    await savedNow(INVITE, { v: 1, text: "jamie" });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await waitFor(async () => expect((await inviteField()).value).toBe(""));
    await waitFor(async () => expect(await texts(INVITE)).toEqual([]));
    expect(dirty()).not.toContain(INVITE);
  });
});

// ---- R3: only a durable success covers what was sent -----------------------------------------------------------------------------
/** After a non-durable answer: the input is shown, still dirty (the ticket covered nothing), and what an update saves is that input. */
async function stillCovered(
  context: string,
  shown: HTMLInputElement,
  text: string,
  value: unknown,
) {
  expect(shown.value, "the input is still shown").toBe(text);
  expect(dirty(), "still dirty: no success covered it").toContain(context);
  await savedNow(context, value);
}

describe("R3: an answer that is not a durable success covers nothing", () => {
  test("R3 New household, uncertain: the name stays dirty, and an update saves it", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const name = await newName();
    fireEvent.change(name, { target: { value: "Flat" } });
    await create();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await present(() => document.querySelector("[data-households-unresolved]"));
    await settle();
    await stillCovered(CREATE, name, "Flat", { v: 1, text: "Flat" });
  });

  test("R3 New household, a definite refusal (your 32 households): the name stays dirty, and an update saves it", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "capacity" } as never);
    const name = await newName();
    fireEvent.change(name, { target: { value: "Flat" } });
    await create();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await settle();
    await stillCovered(CREATE, name, "Flat", { v: 1, text: "Flat" });
  });

  test("R3 New household, uncertain then an accepted update: the name is saved, restored after the reload, and nothing is resent", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    fireEvent.change(await newName(), { target: { value: "Flat" } });
    await create();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await settle();
    expect(await acceptUpdate(), "the update reloaded the tab once").toBe(1);
    expect(await copies(CREATE)).toContainEqual({ v: 1, text: "Flat" });
    reload(w);
    await waitFor(async () => expect((await newName()).value).toBe("Flat"));
    await settle();
    expect(commands(w.api), "restored, never resent").toHaveLength(1);
  });

  test("R3 Rename, uncertain: the name stays dirty, and an update saves it", async () => {
    const w = world(RENAME_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await present(() => document.querySelector("[data-households-unresolved]"));
    await settle();
    await stillCovered(RENAME, name, "Our place", {
      v: 1,
      text: "Our place",
      base: 4,
    });
  });

  test("R3 Rename, a definite refusal (changed elsewhere): the name stays dirty, and an update saves it", async () => {
    const w = world(RENAME_PATH);
    w.api.next.command.push({ ok: false, kind: "conflict" } as never);
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(
      (await present(() => screen.queryAllByText(copy.CHANGED_ELSEWHERE)))
        .length,
    ).toBeGreaterThan(0);
    await settle();
    await stillCovered(RENAME, name, "Our place", {
      v: 1,
      text: "Our place",
      base: 4,
    });
  });

  test("R3 Rename, uncertain then an accepted update: the name is saved, restored after the reload, and nothing is resent", async () => {
    const w = world(RENAME_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await settle();
    expect(await acceptUpdate(), "the update reloaded the tab once").toBe(1);
    expect(await copies(RENAME)).toContainEqual({
      v: 1,
      text: "Our place",
      base: 4,
    });
    reload(w);
    await waitFor(async () =>
      expect((await renameField()).value).toBe("Our place"),
    );
    await settle();
    expect(commands(w.api), "restored, never resent").toHaveLength(1);
  });

  test("R3 Invite, uncertain: the username stays dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await present(() => document.querySelector("[data-households-unresolved]"));
    await settle();
    await stillCovered(INVITE, username, "jamie", { v: 1, text: "jamie" });
  });

  test("R3 Invite, a definite refusal (the recipient's waiting invitations): the username stays dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    w.api.next.command.push({ ok: false, kind: "capacity" } as never);
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await settle();
    await stillCovered(INVITE, username, "jamie", { v: 1, text: "jamie" });
  });

  test("R3 Invite, the lookup finds nobody: nothing is sent and the username stays dirty, and an update saves it", async () => {
    const w = world(INVITE_PATH);
    w.api.next.lookup.push(ok([]));
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(w.api.count("lookup")).toBe(1));
    expect(
      (await present(() => screen.queryAllByText(base.INVITE_NOT_FOUND)))
        .length,
    ).toBeGreaterThan(0);
    await settle();
    expect(commands(w.api), "nothing sent").toEqual([]);
    await stillCovered(INVITE, username, "jamie", { v: 1, text: "jamie" });
  });

  test("R3 Invite, uncertain then an accepted update: the username is saved, restored after the reload, and nothing is looked up or resent", async () => {
    const w = world(INVITE_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await settle();
    expect(await acceptUpdate(), "the update reloaded the tab once").toBe(1);
    expect(await copies(INVITE)).toContainEqual({ v: 1, text: "jamie" });
    reload(w);
    await waitFor(async () =>
      expect((await inviteField()).value).toBe("jamie"),
    );
    await settle();
    expect(w.api.count("lookup"), "only the first try looked up").toBe(1);
    expect(commands(w.api), "restored, never resent").toHaveLength(1);
  });
});

// ---- R4: a rename draft's base lives and dies with the draft ---------------------------------------------------------------------
describe("R4: a restored rename's base", () => {
  const restored = async () => {
    await left(RENAME, JSON.stringify({ v: 1, text: "Our place", base: 3 }));
    const w = world(RENAME_PATH);
    await waitFor(async () =>
      expect((await renameField()).value).toBe("Our place"),
    );
    return w;
  };

  test("R4 Rename CONTROL: a restored rename is saved under the version it was composed against (3)", async () => {
    const w = await restored();
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      kind: "rename_household",
      expected_version: 3,
      name: "Our place",
    });
  });

  test("R4 Rename Escape: the restored draft dropped, a fresh rename is saved under the household's version of now (4)", async () => {
    const w = await restored();
    fireEvent.keyDown(await renameField(), { key: "Escape" });
    await closed(RENAME_TITLE);
    await w.t.navigate(RENAME_PATH);
    const name = await renameField();
    expect(name.value, "opens on the household's name").toBe("Home");
    fireEvent.change(name, { target: { value: "Fresh name" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      expected_version: 4,
      name: "Fresh name",
    });
  });

  test("R4 Rename Discard instead: the restored draft reset, a fresh rename is saved under the household's version of now (4)", async () => {
    const w = await restored();
    const box = await dialog(RENAME_TITLE);
    fireEvent.click(
      must(within(box).queryByRole("button", { name: "Discard instead" })),
    );
    const name = await renameField();
    await waitFor(() =>
      expect(name.value, "the form shows its start").toBe("Home"),
    );
    fireEvent.change(name, { target: { value: "Fresh name" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      expected_version: 4,
      name: "Fresh name",
    });
  });
});

// ---- D-1: the Try again path, pinned as D-12b-18 is written ----------------------------------------------------------------------
describe("D-1 (reported decision; D-12b-18 as written): a successful Try again completes the form", () => {
  test("D-1 New household: a successful Try again of a lost create forgets the name, even one typed since; it was resent byte for byte", async () => {
    const w = world(NEW_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const name = await newName();
    fireEvent.change(name, { target: { value: "Flat" } });
    await create();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    fireEvent.change(name, { target: { value: "Flat 2" } });
    expect(name.value, "the field stays editable").toBe("Flat 2");
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(w.api.sentCommands[1], "the same attempt").toEqual(
      w.api.sentCommands[0],
    );
    await closed(copy.NEW_TITLE);
    await settle();
    expect(dirty(), "the form completed").not.toContain(CREATE);
    await w.t.navigate(NEW_PATH);
    expect((await newName()).value, "D-1: the newer name is forgotten").toBe(
      "",
    );
  });

  test("D-1 Rename: a successful Try again of a lost rename forgets the name, even one typed since; it was resent byte for byte", async () => {
    const w = world(RENAME_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const name = await renameField();
    fireEvent.change(name, { target: { value: "Our place" } });
    await saveName();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    fireEvent.change(name, { target: { value: "Our place 2" } });
    expect(name.value, "the field stays editable").toBe("Our place 2");
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(w.api.sentCommands[1], "the same attempt").toEqual(
      w.api.sentCommands[0],
    );
    await closed(RENAME_TITLE);
    await settle();
    expect(dirty(), "the form completed").not.toContain(RENAME);
    await w.t.navigate(RENAME_PATH);
    expect(
      (await renameField()).value,
      "D-1: the newer name is forgotten",
    ).toBe("Home");
  });

  test("D-1 Invite: a successful Try again of a lost invitation forgets the username, even one typed since; it was resent byte for byte", async () => {
    const w = world(INVITE_PATH);
    w.api.next.command.push({ ok: false, kind: "uncertain" });
    const username = await inviteField();
    fireEvent.change(username, { target: { value: "jamie" } });
    await invite();
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    fireEvent.change(username, { target: { value: "jamie2" } });
    expect(username.value, "the field stays editable").toBe("jamie2");
    await tryAgain();
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(w.api.sentCommands[1], "the same attempt").toEqual(
      w.api.sentCommands[0],
    );
    await settle();
    expect(
      (await inviteField()).value,
      "D-1: the newer username is forgotten",
    ).toBe("");
    expect(dirty(), "the form completed").not.toContain(INVITE);
  });
});
