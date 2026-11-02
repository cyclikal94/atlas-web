import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { JoinForm } from "../../src/features/authentication/JoinForm";
import { SignInForm } from "../../src/features/authentication/SignInForm";
import { AddSourceDialog } from "../../src/features/calendars/AddSourceDialog";
import {
  dismissalsDecided,
  settlePreAccountInput,
} from "../../src/lib/form-recovery/editor";
import {
  handoffContext,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import { createRecoverableModel } from "../../src/lib/form-recovery/model";
import {
  createRecoverableFormRegistry,
  flushDirty,
  pageFormRegistry,
} from "../../src/lib/form-recovery/registry";
import { createRecoveryTab } from "../../src/lib/form-recovery/tab-identity";
import { installMatchMedia } from "../helpers/match-media";
import {
  forgetRecoveryWorld,
  installRecoveryLocks,
  protectedTree,
  store,
} from "../support/recovery-editors";
import { Locks, ScopedSpyPort, TabStorage } from "../support/recovery-pages";
import { ME } from "../support/tasks/world";

/**
 * WEB-14a revision 39 (LABELLED ADAPTATION of revision 38's file; the original is
 * `.agtx/evidence/revision-r39-20261027/removed/pre-account-recovery.test.tsx.HEAD`). Kieran's decision
 * WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026 (hand-off sha256 e802f52e…ebaec3) PERMITS keeping only the unfinished username in that tab's
 * session storage, and REQUIRES that the input be preserved when saving or restoration cannot be provided. The review of revision 38
 * (R40-COMPOSITION) and its design assessment (C1/C3, DA-TAB-HANDOFF, DA-AUTH-HOSTS, I1/I2/I7) found that restoration cannot be provided:
 * Join's and the transient hosts' readers live in page memory, and a cloned tab's session storage carries the same hand-off reference, so
 * holding a lock proves no same-tab continuation. Revision 39 therefore takes the decision's preservation branch: the username is written
 * NOWHERE, its model says no reload brings it back, and its unfinished input stops an update reload (`tests/pwa/coordinator-restorable.test.ts`,
 * `tests/features/authentication-update.test.tsx`).
 *
 * Original intents → what is asserted now:
 *  - only the username, never a password/secret, never the account's store → nothing of either form is written anywhere (both storages,
 *    the account's store, the port a model is offered);
 *  - same-tab restore after an update, then removal → no restore at all: an earlier page's session-storage copy or hand-off (as revision 38
 *    wrote) is never read, restored or offered; the input is kept on the page instead;
 *  - another tab / a duplicated tab sees nothing → no page restores anything;
 *  - newer input never replaced → nothing ever replaces it (kept);
 *  - an account's kept input is not retired by the pre-account form → kept (the model never binds, so never retires a scope);
 *  - failed / unreadable storage keeps the input → the input never depends on storage: the update's save of it fails at once (no store),
 *    and the page keeps it;
 *  - cancellation removes its copies → there are none; leaving the form leaves nothing registered (revision 40, R40-GATE: an unmount is no
 *    longer the end of the username: it stays the journey's, written nowhere, until an account displays, Back or another journey ends it).
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const PASSWORD = "NeverPersistTheSecret1!";
const username = () =>
  screen.getByRole("textbox", { name: /username/i }) as HTMLInputElement;

function model(storage = new TabStorage()) {
  const registry = createRecoverableFormRegistry();
  const locks = new Locks();
  let restored = 0;
  const instance = createRecoverableModel({
    formContext: "sign-in",
    start: "",
    restore: () => {
      restored += 1;
      return true;
    },
    untouched: () => true,
    preAccount: true,
    registry,
    tab: createRecoveryTab({
      uuid: () => `page-${Math.random()}`,
      locks: locks.forPage("A"),
    }),
    handoffs: storageHandoffs(() => storage as unknown as Storage),
  });
  return { registry, model: instance, storage, restored: () => restored };
}

describe("the pre-account model (model level)", () => {
  test("never binds to a store: a port offered to it is never read or written, and its look never runs", async () => {
    const { registry, model: m } = model();
    const adapter = new MemoryRecoveryAdapter();
    const port = new ScopedSpyPort(adapter);
    const used = [
      vi.spyOn(port, "save"),
      vi.spyOn(port, "load"),
      vi.spyOn(port, "list"),
      vi.spyOn(port, "discard"),
      vi.spyOn(port, "pin"),
    ];
    m.show();
    m.bind(port);
    m.begin("");
    expect(m.edit("alice")).toBe(true);
    expect(await flushDirty(registry)).toEqual(["failed"]);
    await prepareHandoffs(registry);
    for (const spy of used) expect(spy).not.toHaveBeenCalled();
    expect(await adapter.list("sign-in")).toEqual([]);
    expect(m.view().ready).toBe(false);
    expect(m.view().restored).toBeNull();
  });

  test("its handle says no reload brings it back, and it is dirty exactly while the input is unfinished", () => {
    const { registry, model: m } = model();
    m.show();
    m.begin("");
    const [handle] = registry.all();
    expect(handle?.restorable?.()).toBe(false);
    expect(handle?.isDirty()).toBe(false);
    m.edit("alice");
    expect(handle?.isDirty()).toBe(true);
    m.edit("");
    expect(handle?.isDirty()).toBe(false);
  });

  test("an earlier page's copy and hand-off in this tab's session storage (as revision 38 wrote them) are never restored or offered", async () => {
    const storage = new TabStorage();
    const legacy = {
      formContext: "sign-in",
      tabInstanceId: "earlier-page",
      values: { model: "from-earlier-page" },
      savedAt: "2026-10-27T10:00:00.000Z",
      capture: "c1",
    };
    storage.setItem(
      `atlas-preaccount-recovery:${JSON.stringify(["sign-in", "earlier-page"])}`,
      JSON.stringify(legacy),
    );
    storage.setItem(
      `atlas-preaccount-recovery:${JSON.stringify([handoffContext("sign-in"), "h1"])}`,
      JSON.stringify({ ...legacy, formContext: handoffContext("sign-in") }),
    );
    const { model: m, restored } = model(storage);
    m.show();
    m.bind(new ScopedSpyPort(new MemoryRecoveryAdapter()));
    m.begin("");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restored()).toBe(0);
    expect(m.view().alternatives).toEqual([]);
  });

  test("binding an account's kept input beside it: the pre-account model retires no scope", () => {
    const { registry, model: m } = model();
    const account = createRecoverableModel({
      formContext: "task-form:new",
      start: "",
      restore: () => false,
      untouched: () => true,
      registry,
    });
    account.bind(new ScopedSpyPort(new MemoryRecoveryAdapter()));
    account.begin("");
    expect(account.edit("{kept task}")).toBe(true);
    m.show();
    m.bind(new ScopedSpyPort(new MemoryRecoveryAdapter()));
    m.begin("");
    expect(m.edit("alice")).toBe(true);
    expect(
      registry
        .dirty()
        .map((h) => h.formContext)
        .sort(),
    ).toEqual(["sign-in", "task-form:new"]);
  });
});

describe("the sign-in and join forms (the production editor bridge)", () => {
  test.each(["sign-in", "join"] as const)(
    "%s: the typed username and the password are written nowhere; the update's save fails at once (the page keeps the input)",
    async (kind) => {
      render(
        protectedTree(
          kind === "join" ? (
            <JoinForm online submitLabel="Create account" onSubmit={vi.fn()} />
          ) : (
            <SignInForm
              online
              initialUsername=""
              onSubmit={vi.fn()}
              onSso={vi.fn()}
            />
          ),
        ),
      );
      fireEvent.change(username(), { target: { value: "alice" } });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: PASSWORD },
      });
      expect(pageFormRegistry.dirty().map((h) => h.formContext)).toEqual([
        kind,
      ]);
      expect(await flushDirty(pageFormRegistry)).toEqual(["failed"]);
      expect(await prepareHandoffs(pageFormRegistry)).not.toContain("failed");
      expect(username().value).toBe("alice");
      expect(Object.keys(window.sessionStorage)).toEqual([]);
      expect(Object.keys(window.localStorage)).toEqual([]);
      expect(await store().list(kind)).toEqual([]);
      expect(await store().list(handoffContext(kind))).toEqual([]);
    },
  );

  test("an account's editor shown meanwhile neither retires the sign-in form's model nor receives its input; leaving the form keeps it until an account displays", async () => {
    const signIn = render(
      protectedTree(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={vi.fn()}
        />,
      ),
    );
    fireEvent.change(username(), { target: { value: "alice" } });
    // An account's editor (another identity) mounts while the sign-in form is shown, as a switch over the displayed account does.
    render(
      protectedTree(
        <AddSourceDialog
          online
          identity={`${ME}:1`}
          onClose={() => undefined}
        />,
      ),
    );
    fireEvent.change(username(), { target: { value: "alice2" } });
    expect(username().value).toBe("alice2");
    expect(
      pageFormRegistry
        .dirty()
        .map((h) => h.formContext)
        .includes("sign-in"),
    ).toBe(true);
    expect(await store().list("sign-in")).toEqual([]);
    signIn.unmount();
    // Revision 40 adaptation (review of revision 39, R40-GATE; design assessment C1): was "leaving the form leaves nothing registered"; now
    // the unmount is no dismissal (a gate removes the form while its attempt resolves): the unfinished username stays the journey's, still
    // written nowhere, until an authoritative end (here an account displayed: `settlePreAccountInput`), which leaves nothing.
    await act(async () => dismissalsDecided());
    expect(
      pageFormRegistry
        .dirty()
        .map((h) => h.formContext)
        .includes("sign-in"),
    ).toBe(true);
    expect(await store().list("sign-in")).toEqual([]);
    act(() => settlePreAccountInput((context) => context === "sign-in"));
    await waitFor(() =>
      expect(pageFormRegistry.all().map((h) => h.formContext)).not.toContain(
        "sign-in",
      ),
    );
  });
});
