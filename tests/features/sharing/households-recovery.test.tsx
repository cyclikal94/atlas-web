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
  forgetHouseholdsMemory,
  householdsMemory,
} from "../../../src/features/sharing/households/memory";
import { RESTORED_TEXT } from "../../../src/lib/form-recovery/RecoveryBanner";
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
  store,
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

/**
 * WEB-12b maintenance merge of accepted main 2f42ac35, correction M-1 (Kieran, 6 November 2026: "Fix in the second merge"): WEB-12b's three
 * household editors take part in WEB-14a's app-update recovery (Q4; `docs/pwa.md` "The product's editors"), as the inline forms they
 * replaced did (`HouseholdsMinimal`, WEB-14a revision 37). Over the application's router and the household screens, the page's real form
 * registry, recovery identity and recoverable models (`households/form-recovery.ts`), a memory recovery store and, where an update is
 * accepted, the PRODUCTION app-update coordinator (worker, clock and reload are doubles, `tests/pwa/coordinator-world.ts`):
 *
 *  - an open editor is a registered form (an available update offers "Save and reload") and the person's input makes it dirty;
 *  - accepting the update saves the raw input and reloads once; after the reload the SAME ROUTE's dialog finds the copy and is restored,
 *    never saved: saving stays the person's act;
 *  - a restored rename is saved under the household version it was composed against; the page memory's own rules (a draft kept after
 *    Cancel, dropped on success, another identity) are followed by the models.
 *
 * The form contexts are spelt out here (not imported), so that on the merge without the correction each test fails at an assertion, not
 * at an import. COMPONENT evidence (jsdom), not a native browser result.
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

const CREATE = "household-create";
const RENAME = `household-rename:${HOME_ID}`;
const INVITE = `household-invite:${HOME_ID}`;
const textCopy = (text: string) => JSON.stringify({ v: 1, text });

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
const dialog = (name: string) => screen.findByRole("dialog", { name });
const field = async (dialogName: string, label: string) =>
  (await within(await dialog(dialogName)).findByLabelText(
    label,
  )) as HTMLInputElement;
const newName = () => field(copy.NEW_TITLE, copy.NAME_LABEL);
const renameField = () => field(copy.RENAME_TITLE("Home"), copy.NAME_LABEL);
const inviteField = () =>
  field(copy.INVITATIONS_TITLE_FOR("Home"), copy.USERNAME_LABEL);
const commands = (api: ReturnType<typeof fakeHouseholdApi>) =>
  api.sentCommands.map((c) => c.commands[0]);
async function copies(context: string): Promise<unknown[]> {
  return (await texts(context)).map((text) => JSON.parse(text));
}
const restoredShown = () =>
  document.querySelector('[data-recovery-state="restored"]');

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
function reload(w: ReturnType<typeof world>) {
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

describe("M-1: New household (household-create)", () => {
  test("M-1 New household: registered while open, dirty once typed; the accepted update saves the name and reloads once; after the reload the dialog restores it and nothing is sent", async () => {
    const w = world("/sharing/new");
    const name = await newName();
    expect(contextsOf(pageFormRegistry.all())).toContain(CREATE);
    expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CREATE);
    fireEvent.change(name, { target: { value: "Flat" } });
    expect(contextsOf(pageFormRegistry.dirty())).toContain(CREATE);
    expect(await acceptUpdate(), "the update reloaded the tab once").toBe(1);
    expect(await copies(CREATE)).toContainEqual({ v: 1, text: "Flat" });
    reload(w);
    await waitFor(async () => expect((await newName()).value).toBe("Flat"));
    expect(
      within(await dialog(copy.NEW_TITLE)).queryByText(RESTORED_TEXT),
      "the restored notice",
    ).not.toBeNull();
    expect(commands(w.api), "restored, never sent").toEqual([]);
  });

  test("M-1 a name kept after Cancel stays listed and is saved by an update; after the reload New household restores it when opened again", async () => {
    const w = world("/sharing/new");
    fireEvent.change(await newName(), { target: { value: "Kept flat" } });
    fireEvent.click(
      within(await dialog(copy.NEW_TITLE)).getByRole("button", {
        name: copy.CANCEL_ACTION,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      contextsOf(pageFormRegistry.dirty()),
      "kept in page memory and still dirty",
    ).toContain(CREATE);
    expect(await acceptUpdate()).toBe(1);
    expect(await copies(CREATE)).toContainEqual({ v: 1, text: "Kept flat" });
    reload(w);
    await w.t.navigate("/sharing/new");
    await waitFor(async () =>
      expect((await newName()).value).toBe("Kept flat"),
    );
    expect(commands(w.api)).toEqual([]);
  });

  test("M-1 while an update reload is being prepared typing changes nothing and Create sends nothing", async () => {
    const w = world("/sharing/new");
    const name = await newName();
    fireEvent.change(name, { target: { value: "Flat" } });
    freeze();
    fireEvent.change(name, { target: { value: "Flat 2" } });
    expect(name.value, "the field keeps what it showed").toBe("Flat");
    fireEvent.click(
      within(await dialog(copy.NEW_TITLE)).getByRole("button", {
        name: copy.CREATE,
      }),
    );
    await act(async () => {});
    expect(commands(w.api), "nothing sent while frozen").toEqual([]);
    unfreeze();
  });

  test("M-1 I7: a create answered after a newer name was typed keeps that name as the New household draft, still dirty", async () => {
    const w = world("/sharing/new");
    const answer = held<{ revision: number }>();
    w.api.next.command.push(answer.answer);
    const name = await newName();
    fireEvent.change(name, { target: { value: "Flat 2" } });
    fireEvent.click(
      within(await dialog(copy.NEW_TITLE)).getByRole("button", {
        name: copy.CREATE,
      }),
    );
    await waitFor(() => expect(answer.asked()).toBe(true));
    fireEvent.change(name, { target: { value: "Flat 3" } });
    await act(async () => {
      answer.release(ok({ revision: 2 }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: copy.NEW_TITLE })).toBeNull(),
    );
    expect(contextsOf(pageFormRegistry.dirty())).toContain(CREATE);
    await w.t.navigate("/sharing/new");
    expect((await newName()).value).toBe("Flat 3");
  });

  test("M-1 CONTROL I7 and the drop: a create answered with nothing typed since clears the name, and the copy an update saved is removed", async () => {
    const w = world("/sharing/new");
    fireEvent.change(await newName(), { target: { value: "Flat 2" } });
    expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
    expect(await copies(CREATE)).toContainEqual({ v: 1, text: "Flat 2" });
    fireEvent.click(
      within(await dialog(copy.NEW_TITLE)).getByRole("button", {
        name: copy.CREATE,
      }),
    );
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: copy.NEW_TITLE })).toBeNull(),
    );
    await waitFor(async () => expect(await texts(CREATE)).toEqual([]));
    expect(contextsOf(pageFormRegistry.dirty())).not.toContain(CREATE);
    await w.t.navigate("/sharing/new");
    expect((await newName()).value).toBe("");
  });

  test("M-1 restored only into an untouched dialog: a name typed before the look answered stays, and the closed tab's copy is offered", async () => {
    await left(CREATE, textCopy("Left flat"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store().list.bind(store());
    let entered = false;
    vi.spyOn(store(), "list").mockImplementation(async (context) => {
      if (context === CREATE) {
        entered = true;
        await gate;
      }
      return original(context);
    });
    world("/sharing/new");
    const name = await newName();
    await waitFor(() => expect(entered).toBe(true));
    fireEvent.change(name, { target: { value: "Typed first" } });
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-recovery-alternatives="1"]'),
        "the copy is offered",
      ).not.toBeNull(),
    );
    expect(name.value).toBe("Typed first");
    expect(restoredShown()).toBeNull();
  });

  test("M-1 a copy this build cannot read (a name over 300 characters) is never restored", async () => {
    await left(CREATE, textCopy("x".repeat(301)));
    world("/sharing/new");
    const name = await newName();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-recovery-alternatives="1"]'),
        "offered as it is",
      ).not.toBeNull(),
    );
    expect(name.value).toBe("");
    expect(restoredShown()).toBeNull();
  });
});

describe("M-1: Rename (household-rename:<id>)", () => {
  test("M-1 Rename: the accepted update saves the name with the household version it was composed against; after the reload the dialog restores it once the household is read", async () => {
    const w = world(`/sharing/households/${HOME_ID}/rename`);
    const name = await renameField();
    expect(name.value).toBe("Home");
    expect(contextsOf(pageFormRegistry.all())).toContain(RENAME);
    fireEvent.change(name, { target: { value: "Our place" } });
    expect(contextsOf(pageFormRegistry.dirty())).toContain(RENAME);
    expect(await acceptUpdate()).toBe(1);
    expect(await copies(RENAME)).toContainEqual({
      v: 1,
      text: "Our place",
      base: 4,
    });
    // After the reload the household list answers only once the recovery store has been read: the dialog must not look before it shows.
    const list = held<never>();
    w.api.next.households.push(list.answer as never);
    reload(w);
    await waitFor(() => expect(list.asked()).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      list.release(ok([homeOf()]) as never);
    });
    await waitFor(async () =>
      expect((await renameField()).value).toBe("Our place"),
    );
    expect(restoredShown(), "restored, not merely offered").not.toBeNull();
    expect(commands(w.api)).toEqual([]);
  });

  test("M-1 Rename: a restored rename is saved under the version it was composed against; a household renamed since meets the conflict, and the next Save is against the version read now", async () => {
    await left(RENAME, JSON.stringify({ v: 1, text: "Our place", base: 3 }));
    const w = world(`/sharing/households/${HOME_ID}/rename`);
    await waitFor(async () =>
      expect((await renameField()).value).toBe("Our place"),
    );
    w.api.next.command.push({ ok: false, kind: "conflict" } as never);
    fireEvent.click(screen.getByRole("button", { name: copy.SAVE_NAME }));
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      kind: "rename_household",
      expected_version: 3,
      name: "Our place",
    });
    // Said in the banner (and once to the announcer).
    expect(
      (await screen.findAllByText(copy.CHANGED_ELSEWHERE)).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: copy.SAVE_NAME }));
    await waitFor(() => expect(commands(w.api)).toHaveLength(2));
    expect(commands(w.api)[1]).toMatchObject({
      expected_version: 4,
      name: "Our place",
    });
  });

  test("M-1 Rename: Escape (the dialog's discard) drops the draft, and its recovery session ends: its copy goes and nothing is left for an update", async () => {
    world(`/sharing/households/${HOME_ID}/rename`);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
    expect(await copies(RENAME)).toContainEqual({
      v: 1,
      text: "Our place",
      base: 4,
    });
    fireEvent.keyDown(await renameField(), { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: copy.RENAME_TITLE("Home") }),
      ).toBeNull(),
    );
    await waitFor(async () => expect(await texts(RENAME)).toEqual([]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(contextsOf(pageFormRegistry.dirty())).not.toContain(RENAME);
  });

  test("M-1 CONTROL Rename: a name typed on this page (not restored) is saved with the household's version of now", async () => {
    const w = world(`/sharing/households/${HOME_ID}/rename`);
    fireEvent.change(await renameField(), { target: { value: "Our place" } });
    fireEvent.click(screen.getByRole("button", { name: copy.SAVE_NAME }));
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    expect(commands(w.api)[0]).toMatchObject({
      expected_version: 4,
      name: "Our place",
    });
  });
});

describe("M-1: an invitation's username (household-invite:<id>)", () => {
  test("M-1 Invite: the username typed in the household's Invitations is saved by the accepted update and restored after the reload; nothing is looked up or sent", async () => {
    const w = world(`/sharing/households/${HOME_ID}/invitations`);
    const username = await inviteField();
    expect(contextsOf(pageFormRegistry.all())).toContain(INVITE);
    fireEvent.change(username, { target: { value: "jamie" } });
    expect(contextsOf(pageFormRegistry.dirty())).toContain(INVITE);
    expect(await acceptUpdate()).toBe(1);
    expect(await copies(INVITE)).toContainEqual({ v: 1, text: "jamie" });
    reload(w);
    await waitFor(async () =>
      expect((await inviteField()).value).toBe("jamie"),
    );
    expect(w.api.count("lookup")).toBe(0);
    expect(commands(w.api)).toEqual([]);
  });

  test("M-1 Invite: an account chosen in the directory lookup is the person's input: it replaces what was typed in the model too, and an update saves the chosen account", async () => {
    world(`/sharing/households/${HOME_ID}/invitations`);
    // Typed first, so the session lives across the lookup view (the form is hidden meanwhile).
    fireEvent.change(await inviteField(), { target: { value: "someone" } });
    const box = await dialog(copy.INVITATIONS_TITLE_FOR("Home"));
    fireEvent.click(
      within(box).getByRole("button", { name: copy.FIND_ACCOUNT }),
    );
    fireEvent.change(
      await within(box).findByLabelText(base.LOOKUP_EXACT_LABEL),
      { target: { value: "jamie" } },
    );
    fireEvent.click(
      within(box).getByRole("button", { name: base.LOOKUP_EXACT_BUTTON }),
    );
    fireEvent.click(
      await within(box).findByRole("button", {
        name: `${base.LOOKUP_CHOOSE}: jamie`,
      }),
    );
    await waitFor(async () =>
      expect((await inviteField()).value).toBe("jamie"),
    );
    expect(contextsOf(pageFormRegistry.dirty())).toContain(INVITE);
    expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
    const saved = await copies(INVITE);
    expect(saved, "the chosen account is what the update saves").toContainEqual(
      {
        v: 1,
        text: "jamie",
      },
    );
    expect(saved).not.toContainEqual({ v: 1, text: "someone" });
  });

  test("M-1 Invite: a successful invitation clears the field, and the copy an update saved is removed", async () => {
    const w = world(`/sharing/households/${HOME_ID}/invitations`);
    fireEvent.change(await inviteField(), { target: { value: "jamie" } });
    expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
    expect(await copies(INVITE)).toContainEqual({ v: 1, text: "jamie" });
    fireEvent.click(
      within(await dialog(copy.INVITATIONS_TITLE_FOR("Home"))).getByRole(
        "button",
        { name: copy.INVITE },
      ),
    );
    await waitFor(() => expect(commands(w.api)).toHaveLength(1));
    await waitFor(async () => expect((await inviteField()).value).toBe(""));
    await waitFor(async () => expect(await texts(INVITE)).toEqual([]));
    expect(contextsOf(pageFormRegistry.dirty())).not.toContain(INVITE);
  });
});

describe("M-1: page memory is one identity's", () => {
  test("M-1 another identity: the previous identity's household models leave the page's registry with its page memory", async () => {
    const w = world("/sharing/new");
    fireEvent.change(await newName(), { target: { value: "Flat" } });
    // Kept in page memory with no dialog shown: still dirty, still listed.
    w.t.unmount();
    expect(contextsOf(pageFormRegistry.dirty())).toContain(CREATE);
    act(() => {
      householdsMemory("22222222-2222-4222-8222-222222222222:1");
    });
    expect(contextsOf(pageFormRegistry.all())).not.toContain(CREATE);
  });
});
