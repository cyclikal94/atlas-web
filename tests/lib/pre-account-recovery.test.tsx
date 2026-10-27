import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { JoinForm } from "../../src/features/authentication/JoinForm";
import { SignInForm } from "../../src/features/authentication/SignInForm";
import { AddSourceDialog } from "../../src/features/calendars/AddSourceDialog";
import {
  type HandoffStore,
  handoffContext,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import {
  createRecoverableModel,
  type RecoverableModel,
} from "../../src/lib/form-recovery/model";
import {
  createRecoverableFormRegistry,
  flushDirty,
  pageFormRegistry,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type TabSessionRecoveryPort,
  tabSessionRecoveryPort,
} from "../../src/lib/form-recovery/tab-session-port";
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
 * WEB-14a revision 38: Kieran's decision WEB14A-PREACCOUNT-USERNAME-RECOVERY-20261026 (hand-off
 * `delivery/handoffs/web14a-preaccount-username-approved-20261026.md`, SHA-256 e802f52e…ebaec3). The sign-in and join forms' unfinished
 * USERNAME only, in THAT tab's session storage only, across an app-update reload; removed once restored or when the form is left; never a
 * password, never submitted, never an account's store. Model level (the real session, registry, hand-offs and recovery identity over a Web
 * Locks double and a session-storage double): same-tab restore and removal, a second update after it, tab isolation (another tab, a
 * duplicated tab), newer input never replaced, failed and unreadable storage, cancellation. Component level (the production editor bridge
 * and forms): what is written, and where, and its removal.
 */
installMatchMedia({ width: 1440 });
beforeAll(installRecoveryLocks);
afterEach(() => {
  forgetRecoveryWorld();
  window.sessionStorage.clear();
});

const CONTEXT = "sign-in";
const keys = (storage: TabStorage) =>
  [...storage.items.keys()].filter((k) =>
    k.startsWith("atlas-preaccount-recovery:"),
  );
const texts = (storage: TabStorage) =>
  keys(storage).map(
    (k) => JSON.parse(storage.items.get(k) ?? "null").values.model,
  );

describe("the pre-account store (tab-session-port.ts)", () => {
  const port = (storage: TabStorage) =>
    tabSessionRecoveryPort(
      () => storage as unknown as Storage,
      ["sign-in", "join"],
    );
  const copy = (over: Record<string, unknown> = {}) => ({
    formContext: CONTEXT,
    tabInstanceId: "tab-1",
    values: { model: "alice" },
    savedAt: "2026-10-27T10:00:00.000Z",
    capture: "c1",
    ...over,
  });

  test("keeps only one username text of the named forms (and their hand-offs); anything else is refused, nothing written", async () => {
    const storage = new TabStorage();
    const p = port(storage);
    expect(await p.save(copy())).toBe("saved");
    expect(
      await p.save(
        copy({ formContext: handoffContext(CONTEXT), tabInstanceId: "h1" }),
      ),
    ).toBe("saved");
    expect(await p.save(copy({ formContext: "task-form:new" }))).toBe(
      "refused",
    );
    expect(
      await p.save(copy({ values: { model: "alice", password: "secret" } })),
    ).toBe("refused");
    expect(await p.save(copy({ values: { model: "x".repeat(1_001) } }))).toBe(
      "refused",
    );
    expect(await p.save(copy({ controls: { version: 1, entries: {} } }))).toBe(
      "refused",
    );
    expect(texts(storage)).toEqual(["alice", "alice"]);
    expect(JSON.stringify([...storage.items.values()])).not.toContain("secret");
  });

  test("load reads a copy by its exact key; a conditional discard removes it only while it holds that capture; list offers nothing", async () => {
    const storage = new TabStorage();
    const p = port(storage);
    await p.save(copy());
    expect((await p.load(CONTEXT, "tab-1"))?.values.model).toBe("alice");
    expect(await p.load(CONTEXT, "tab-2")).toBeNull();
    expect(await p.list(CONTEXT)).toEqual([]);
    expect(await p.discard(CONTEXT, "tab-1", "another-capture")).toBe(
      "discarded",
    );
    expect(texts(storage)).toEqual(["alice"]);
    expect(await p.discard(CONTEXT, "tab-1", "c1")).toBe("discarded");
    expect(texts(storage)).toEqual([]);
  });

  test("storage that cannot be written fails the save; storage that cannot be read rejects the reads (never an empty answer)", async () => {
    const storage = new TabStorage();
    const p = port(storage);
    storage.failing = true;
    expect(await p.save(copy())).toBe("failed");
    storage.failing = false;
    await p.save(copy());
    storage.unreadable = true;
    await expect(p.load(CONTEXT, "tab-1")).rejects.toBeDefined();
    await expect(p.list(CONTEXT)).rejects.toBeDefined();
  });

  test("sweep removes every copy of the context but those kept; another context's copies stay", async () => {
    const storage = new TabStorage();
    const p = port(storage);
    await p.save(copy({ tabInstanceId: "old-page" }));
    await p.save(
      copy({ tabInstanceId: "this-page", values: { model: "bob" } }),
    );
    await p.save(
      copy({
        formContext: handoffContext(CONTEXT),
        tabInstanceId: "old-handoff",
      }),
    );
    await p.save(copy({ formContext: "join", tabInstanceId: "old-page" }));
    p.sweep(CONTEXT, (tab) => tab === "this-page");
    expect(keys(storage).map((k) => JSON.parse(k.slice(26)))).toEqual([
      [CONTEXT, "this-page"],
      ["join", "old-page"],
    ]);
  });
});

/** A page of one tab: its own registry, recovery identity and hand-off record over the tab's storage, and a pre-account model of `sign-in`. */
class PreAccountPage {
  readonly registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly tab: RecoveryTab;
  readonly handoffs: HandoffStore;
  readonly port: TabSessionRecoveryPort;
  readonly model: RecoverableModel;
  value = "";
  typed = false;
  restored: string[] = [];
  private n = 0;
  constructor(
    readonly locks: Locks,
    readonly name: string,
    readonly storage: TabStorage,
  ) {
    this.tab = createRecoveryTab({
      uuid: () => `${name}-id-${++this.n}`,
      locks: locks.forPage(name),
    });
    this.handoffs = storageHandoffs(() => storage as unknown as Storage);
    this.port = tabSessionRecoveryPort(
      () => storage as unknown as Storage,
      [CONTEXT],
    );
    this.model = createRecoverableModel({
      formContext: CONTEXT,
      start: "",
      restore: (text, chosen) => {
        if (!chosen && this.typed) return false;
        this.value = text;
        this.restored.push(text);
        return true;
      },
      untouched: () => !this.typed,
      preAccount: true,
      registry: this.registry,
      tab: this.tab,
      handoffs: this.handoffs,
    });
  }
  async bound(): Promise<this> {
    this.model.show();
    this.model.bind(this.port);
    await waitFor(() =>
      expect(this.model.view().ready || this.model.view().unavailable).toBe(
        true,
      ),
    );
    return this;
  }
  type(text: string): void {
    expect(this.model.edit(text)).toBe(true);
    this.typed = true;
    this.value = text;
  }
  /** "Save and reload" as the coordinator makes it: the saves, then the hand-offs. */
  async update() {
    return [
      ...(await flushDirty(this.registry)),
      ...(await prepareHandoffs(this.registry)),
    ];
  }
  /** The saves only (an ordinary copy, no hand-off). */
  flushOnly() {
    return flushDirty(this.registry);
  }
  leave(): void {
    this.locks.leave(this.name);
  }
}

describe("the username across an app-update reload of the same tab (model level)", () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("restored into the untouched form of the tab's next page, never submitted; then the tab keeps NO copy, and the input is still unsaved input", async () => {
    const locks = new Locks();
    const storage = new TabStorage();
    const a = await new PreAccountPage(locks, "A", storage).bound();
    a.type("alice");
    expect(await a.update()).toEqual(["saved", "saved"]);
    expect(texts(storage)).toEqual(["alice", "alice"]);
    a.leave();
    const b = await new PreAccountPage(locks, "B", storage).bound();
    expect(b.restored).toEqual(["alice"]);
    expect(b.value).toBe("alice");
    await waitFor(() => expect(keys(storage)).toEqual([]));
    // Restored input is still the person's: dirty, saved again by a second update.
    expect(b.registry.dirty()).toHaveLength(1);
    expect(await b.update()).toEqual(["saved", "saved"]);
    expect(texts(storage)).toEqual(["alice", "alice"]);
  });

  test("cancellation: leaving the form (end) removes its copies", async () => {
    const storage = new TabStorage();
    const a = await new PreAccountPage(new Locks(), "A", storage).bound();
    a.type("alice");
    await a.update();
    expect(keys(storage)).toHaveLength(2);
    expect(await a.model.end()).toBe("discarded");
    await settled();
    expect(keys(storage)).toEqual([]);
  });

  test("another tab (its own session storage) sees nothing of it", async () => {
    const locks = new Locks();
    const a = await new PreAccountPage(locks, "A", new TabStorage()).bound();
    a.type("alice");
    await a.update();
    a.leave();
    const other = await new PreAccountPage(
      locks,
      "B",
      new TabStorage(),
    ).bound();
    expect(other.restored).toEqual([]);
    expect(other.model.view().alternatives).toEqual([]);
  });

  test("a duplicated tab's copy of the storage restores nothing while the tab it was copied from is open, and offers nothing", async () => {
    const locks = new Locks();
    const storage = new TabStorage();
    const a = await new PreAccountPage(locks, "A", storage).bound();
    a.type("alice");
    await a.flushOnly();
    const duplicate = await new PreAccountPage(
      locks,
      "D",
      storage.copy(),
    ).bound();
    expect(duplicate.restored).toEqual([]);
    expect(duplicate.model.view().alternatives).toEqual([]);
  });

  test("newer input is never replaced: typed before the next page's look answers, the hand-off is not restored", async () => {
    const locks = new Locks();
    const storage = new TabStorage();
    const a = await new PreAccountPage(locks, "A", storage).bound();
    a.type("alice");
    await a.update();
    a.leave();
    const b = new PreAccountPage(locks, "B", storage);
    b.model.begin("");
    b.type("bob");
    await b.bound();
    expect(b.restored).toEqual([]);
    expect(b.value).toBe("bob");
  });

  test("binding the pre-account form leaves an account's kept input in the page's registry (another scope is not retired)", async () => {
    const locks = new Locks();
    const storage = new TabStorage();
    const page = new PreAccountPage(locks, "A", storage);
    // An account editor's kept input: bound to the account's (scoped) store, unshown, dirty.
    const account = createRecoverableModel({
      formContext: "task-form:new",
      start: "",
      restore: () => false,
      untouched: () => true,
      registry: page.registry,
      tab: page.tab,
      handoffs: page.handoffs,
    });
    account.bind(new ScopedSpyPort(new MemoryRecoveryAdapter()));
    account.begin("");
    expect(account.edit("{kept task}")).toBe(true);
    expect(page.registry.dirty().map((h) => h.formContext)).toEqual([
      "task-form:new",
    ]);
    await page.bound();
    expect(page.registry.dirty().map((h) => h.formContext)).toContain(
      "task-form:new",
    );
  });

  test("storage that cannot be written: the update's save fails (retry or an explicit discard), the input stays", async () => {
    const storage = new TabStorage();
    const a = await new PreAccountPage(new Locks(), "A", storage).bound();
    a.type("alice");
    storage.failing = true;
    expect(await flushDirty(a.registry)).toEqual(["failed"]);
    expect(a.value).toBe("alice");
    expect(a.registry.dirty()).toHaveLength(1);
  });

  test("storage that cannot be read: the look is unavailable, nothing restored or removed, the input stays", async () => {
    const locks = new Locks();
    const storage = new TabStorage();
    const a = await new PreAccountPage(locks, "A", storage).bound();
    a.type("alice");
    await a.update();
    a.leave();
    storage.unreadable = true;
    const b = await new PreAccountPage(locks, "B", storage).bound();
    expect(b.model.view().unavailable).toBe(true);
    expect(b.restored).toEqual([]);
    storage.unreadable = false;
    expect(keys(storage)).toHaveLength(2);
  });
});

describe("the sign-in and join forms (the production editor bridge)", () => {
  test("sign-in: the update saves the username only, in this tab's session storage; never the password, never the account's store", async () => {
    render(
      protectedTree(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={vi.fn()}
        />,
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /username/i }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "PASSWORD-SENTINEL" },
    });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const held = Object.keys(window.sessionStorage)
      .filter((k) => k.startsWith("atlas-preaccount-recovery:"))
      .map((k) => window.sessionStorage.getItem(k) ?? "");
    expect(held.map((text) => JSON.parse(text).values)).toEqual([
      { model: "alice" },
    ]);
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain(
      "PASSWORD-SENTINEL",
    );
    expect(await store().list("sign-in")).toEqual([]);
  });

  test("join: leaving the form removes its copy (cancellation)", async () => {
    const view = render(
      protectedTree(<JoinForm online submitLabel="Join" onSubmit={vi.fn()} />),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /username/i }), {
      target: { value: "newcomer" },
    });
    expect(await flushDirty(pageFormRegistry)).toEqual(["saved"]);
    const copies = () =>
      Object.keys(window.sessionStorage).filter((k) =>
        k.startsWith("atlas-preaccount-recovery:"),
      );
    expect(copies()).toHaveLength(1);
    view.unmount();
    await waitFor(() => expect(copies()).toEqual([]));
  });

  test("a copy an earlier page of the tab left is removed once the form's look has read the store (nothing outlives the restore)", async () => {
    window.sessionStorage.setItem(
      `atlas-preaccount-recovery:${JSON.stringify(["sign-in", "earlier-page"])}`,
      JSON.stringify({
        formContext: "sign-in",
        tabInstanceId: "earlier-page",
        values: { model: "stale" },
        savedAt: "2026-10-27T09:00:00.000Z",
      }),
    );
    render(
      protectedTree(
        <SignInForm
          online
          initialUsername=""
          onSubmit={vi.fn()}
          onSso={vi.fn()}
        />,
      ),
    );
    await waitFor(() =>
      expect(
        Object.keys(window.sessionStorage).filter((k) =>
          k.startsWith("atlas-preaccount-recovery:"),
        ),
      ).toEqual([]),
    );
    expect(
      (screen.getByRole("textbox", { name: /username/i }) as HTMLInputElement)
        .value,
    ).toBe("");
  });

  test("an account's editor shown meanwhile neither retires the sign-in form's model nor receives its input; leaving the form removes its copy", async () => {
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
    const username = () =>
      screen.getByRole("textbox", { name: /username/i }) as HTMLInputElement;
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
    expect(await flushDirty(pageFormRegistry)).not.toContain("failed");
    const copies = () =>
      Object.keys(window.sessionStorage).filter((k) =>
        k.startsWith("atlas-preaccount-recovery:"),
      );
    expect(
      copies().map(
        (k) => JSON.parse(window.sessionStorage.getItem(k) ?? "").values.model,
      ),
    ).toEqual(["alice2"]);
    expect(await store().list("sign-in")).toEqual([]);
    signIn.unmount();
    await waitFor(() => expect(copies()).toEqual([]));
  });
});
