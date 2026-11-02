import {
  act,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { expect } from "vitest";
import {
  type HandoffStore,
  handoffContext,
  prepareHandoffs,
  storageHandoffs,
} from "../../src/lib/form-recovery/handoff";
import { MemoryRecoveryAdapter } from "../../src/lib/form-recovery/memory-adapter";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverableFieldSpec,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import {
  createRecoverableFormRegistry,
  flushDirty,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import {
  createRecoveryTab,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";

/**
 * WEB-14a revision 7: pages of a recoverable form over the REAL hook, session, registry and recovery identity (`createRecoveryTab`), one
 * shared Web Locks double that releases a page's locks when it leaves (as a browser does at unload), a session storage per TAB (a reload keeps
 * it; a duplicated tab copies it) and the memory store (no native write order: the native and worker cases are the browser specs). A page
 * may show several forms (one per form context) in one registry. The same model as `recoverable-form-handoff.test.tsx` (revision 6), which
 * keeps its own copy unchanged.
 */
export const FORM = "task-edit:/tasks/41";
export const TITLE: readonly RecoverableFieldSpec[] = [{ name: "title" }];
export const ORIGINAL = "ORIGINAL UNSENT";
export const THIRD = "THIRD PAGE DIFFERENT";

/** A Web Locks double shared by every page of a test: exclusive locks, `ifAvailable`, `signal`, released when the holder leaves. */
export class Locks {
  readonly held = new Map<string, string>();
  /** The requests waiting for a lock now (name, page). */
  waiting: Array<{ name: string; page: string; wake: () => void }> = [];
  /** Lock names whose requests are refused (the lock manager throws). */
  refuse: (name: string) => boolean = () => false;
  forPage(page: string): Pick<LockManager, "request"> {
    return {
      request: ((
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => this.request(page, name, options, callback)) as never,
    };
  }
  /** Whether `page` is waiting for a lock whose name starts with `prefix`. */
  waits(page: string, prefix: string): boolean {
    return this.waiting.some(
      (entry) => entry.page === page && entry.name.startsWith(prefix),
    );
  }
  private async request(
    page: string,
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<unknown>,
  ): Promise<unknown> {
    if (this.refuse(name))
      throw new DOMException("refused", "InvalidStateError");
    while (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const entry = { name, page, wake: resolve };
        this.waiting.push(entry);
        options.signal?.addEventListener("abort", () => {
          this.waiting = this.waiting.filter((other) => other !== entry);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    this.held.set(name, page);
    const result = callback({ name, mode: "exclusive" } as Lock);
    void Promise.resolve(result).then(
      () => this.release(name, page),
      () => this.release(name, page),
    );
    return result;
  }
  private release(name: string, page: string): void {
    if (this.held.get(name) !== page) return;
    this.held.delete(name);
    const next = this.waiting.find((entry) => entry.name === name);
    if (next) {
      this.waiting = this.waiting.filter((entry) => entry !== next);
      next.wake();
    }
  }
  /** The page goes: every lock it holds is released. */
  leave(page: string): void {
    for (const [name, holder] of [...this.held])
      if (holder === page) this.release(name, page);
  }
}

/** A tab's session storage (a `Storage` double); `failing` makes every write throw, `unreadable` every read. */
export class TabStorage {
  readonly items = new Map<string, string>();
  failing = false;
  unreadable = false;
  /** Reads that throw, one per read, before `unreadable` is consulted. */
  failReads = 0;
  /** Revision 38: the `Storage` enumeration the pre-account store's sweep and list use (reads, as `getItem`'s rules). */
  get length(): number {
    if (this.unreadable) throw new DOMException("unreadable", "SecurityError");
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new DOMException("unreadable", "SecurityError");
    }
    if (this.unreadable) throw new DOMException("unreadable", "SecurityError");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failing) throw new DOMException("full", "QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failing) throw new DOMException("full", "QuotaExceededError");
    this.items.delete(key);
  }
  /** A duplicated (or opener-copied) tab: a copy of this tab's session storage. */
  copy(): TabStorage {
    const twin = new TabStorage();
    for (const [key, value] of this.items) twin.items.set(key, value);
    return twin;
  }
}

/** The memory store, recording every discard asked of it (revision 8, R16: which copy, and the capture it was conditional on). */
export class RecordingStore extends MemoryRecoveryAdapter {
  readonly discards: Array<{
    formContext: string;
    tabInstanceId: string;
    capture: string | undefined;
  }> = [];
  /** Discards of the copies it answers true for fail (the copy stays): one clean-up failing while the others land. */
  failDiscardOf: (formContext: string, tabInstanceId: string) => boolean = () =>
    false;
  override discard(
    formContext: string,
    tabInstanceId: string,
    capture?: string,
  ): Promise<DiscardResult> {
    this.discards.push({ formContext, tabInstanceId, capture });
    if (this.failDiscardOf(formContext, tabInstanceId))
      return Promise.resolve("failed");
    return super.discard(formContext, tabInstanceId, capture);
  }
}

export class World {
  /** Pages whose ports pin to an account database (`ScopedSpyPort`). */
  scoped = false;
  readonly locks = new Locks();
  readonly store = new RecordingStore();
  private pages = 0;
  page(name: string, storage = new TabStorage(), forms = [FORM]): Page {
    this.pages += 1;
    return new Page(this, `${name}-${this.pages}`, storage, forms);
  }
  /** The live copies of `form`, as [where, id, title]: ordinary copies and hand-offs. */
  async rows(
    form = FORM,
  ): Promise<Array<[string, string, string | undefined]>> {
    const all = [
      ...(await this.store.list(form)),
      ...(await this.store.list(handoffContext(form))),
    ];
    return all.map((copy) => [
      copy.formContext === form ? "ordinary" : "handoff",
      copy.tabInstanceId,
      copy.values.title,
    ]);
  }
  async handoffs(form = FORM): Promise<RecoverySnapshot[]> {
    return [...(await this.store.list(handoffContext(form)))];
  }
}

/** A port over the world's store whose hand-off loads are counted and may be held or refused, per page. */
export class SpyPort implements FormRecoveryPort {
  handoffLoads = 0;
  /** Hand-off loads that reject (a read that cannot be made), one per load. */
  failHandoffLoads = 0;
  /** Ordinary lists that reject, one per list. */
  failLists = 0;
  /** Hand-off lists that reject, one per list. */
  failHandoffLists = 0;
  /** When set, a completed hand-off load is HELD (its answer read, not delivered) until `release`. */
  private gate: { promise: Promise<void>; open: () => void } | null = null;
  reached = false;
  constructor(private readonly store: MemoryRecoveryAdapter) {}
  hold(): void {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.gate = { promise, open };
  }
  release(): void {
    this.gate?.open();
    this.gate = null;
  }
  save(snapshot: RecoverySnapshot): Promise<SaveResult> {
    return this.store.save(snapshot);
  }
  discard(formContext: string, id: string, capture?: string) {
    // Revision 8 (R16): a conditional discard reaches the store as asked.
    return capture === undefined
      ? this.store.discard(formContext, id)
      : this.store.discard(formContext, id, capture);
  }
  async load(formContext: string, id: string) {
    if (formContext.startsWith("atlas-update-handoff:")) {
      this.handoffLoads += 1;
      if (this.failHandoffLoads > 0) {
        this.failHandoffLoads -= 1;
        throw new DOMException("injected read abort", "AbortError");
      }
      const answer = await this.store.load(formContext, id);
      const gate = this.gate;
      if (gate) {
        this.reached = true;
        await gate.promise;
      }
      return answer;
    }
    return this.store.load(formContext, id);
  }
  async list(formContext: string) {
    const handoff = formContext.startsWith("atlas-update-handoff:");
    if (!handoff && this.failLists > 0) {
      this.failLists -= 1;
      throw new DOMException("injected read abort", "AbortError");
    }
    if (handoff && this.failHandoffLists > 0) {
      this.failHandoffLists -= 1;
      throw new DOMException("injected read abort", "AbortError");
    }
    return this.store.list(formContext);
  }
}

/** A spy port that pins to an account database (`scope`), as the real port does; change `scope` to model the database re-created. */
export class ScopedSpyPort extends SpyPort {
  scope = "scope-1";
  pin() {
    return { account: "acct", scope: this.scope, port: this };
  }
}

function Forms({ page }: { page: Page }) {
  return (
    <>
      {page.forms.map((context, index) => {
        // Two mounts of one form context are told apart by which occurrence they are.
        const nth = page.forms.slice(0, index).filter((c) => c === context);
        return (
          <Form
            key={`${context}#${nth.length}`}
            page={page}
            context={context}
          />
        );
      })}
    </>
  );
}

function Form({ page, context }: { page: Page; context: string }) {
  const ref = useRef<HTMLFormElement>(null);
  page.handles.set(
    context,
    useRecoverableForm({
      formContext: context,
      allow: TITLE,
      formRef: ref,
      port: page.port,
      registry: page.registry,
      tab: page.tab,
      handoffs: page.handoffs,
    }),
  );
  return (
    <form ref={ref} aria-label={context}>
      <input name="title" aria-label={`Title ${context}`} defaultValue="" />
    </form>
  );
}

export class Page {
  readonly registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  readonly tab: RecoveryTab;
  readonly handoffs: HandoffStore;
  port: FormRecoveryPort;
  readonly spy: SpyPort;
  readonly handles = new Map<string, RecoverableForm>();
  private view: RenderResult | null = null;
  private counter = 0;
  constructor(
    readonly world: World,
    readonly name: string,
    readonly storage: TabStorage,
    public forms: string[],
  ) {
    this.spy = world.scoped
      ? new ScopedSpyPort(world.store)
      : new SpyPort(world.store);
    this.port = this.spy;
    this.tab = createRecoveryTab({
      uuid: () => `${name}-id-${++this.counter}`,
      locks: world.locks.forPage(name),
    });
    this.handoffs = storageHandoffs(() => storage as unknown as Storage);
  }
  /** The (first) form's hook. */
  get handle(): RecoverableForm | undefined {
    return this.handles.get(this.forms[0] ?? FORM);
  }
  /** Renders the forms without waiting. */
  show(): this {
    this.view = render(<Forms page={this} />);
    return this;
  }
  /** Renders the forms and waits until every look has read the store. */
  async mount(timeout = 1_000): Promise<this> {
    this.show();
    await waitFor(
      () =>
        expect(
          this.forms.every((context) => this.handles.get(context)?.ready),
        ).toBe(true),
      { timeout },
    );
    return this;
  }
  /** The forms are rendered again with another list (an unmounted form keeps its session in the page). */
  rerender(forms: string[]): void {
    this.forms = forms;
    act(() => this.view?.rerender(<Forms page={this} />));
  }
  value(context = this.forms[0] ?? FORM): string {
    return (
      within(this.view?.container as HTMLElement).getByLabelText(
        `Title ${context}`,
      ) as HTMLInputElement
    ).value;
  }
  get title(): string {
    return this.value();
  }
  type(value: string, context = this.forms[0] ?? FORM): void {
    act(() => {
      const element = within(
        this.view?.container as HTMLElement,
      ).getByLabelText(`Title ${context}`) as HTMLInputElement;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  /** Types into the `index`-th form shown (two mounts of one form context have the same label). */
  typeAt(index: number, value: string): void {
    act(() => {
      const element = within(this.view?.container as HTMLElement)
        .getAllByRole("textbox")
        .at(index) as HTMLInputElement;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async flush(): Promise<SaveResult[]> {
    let results: SaveResult[] = [];
    await act(async () => {
      results = await flushDirty(this.registry);
    });
    return results;
  }
  /** "Save and reload" as the coordinator makes it: the saves, then the hand-offs. */
  async update(): Promise<SaveResult[]> {
    const saved = await this.flush();
    let handed: SaveResult[] = [];
    await act(async () => {
      handed = await prepareHandoffs(this.registry);
    });
    return [...saved, ...handed];
  }
  /** The page goes (unload): unmounted, and its locks released by the browser. */
  leave(): void {
    this.view?.unmount();
    this.view = null;
    this.world.locks.leave(this.name);
  }
  dirty(): number {
    return this.registry.dirty().length;
  }
}

/** A typed ORIGINAL in every form of A, saved, prepared its update (the hand-offs) and went; the next page of its tab is not loaded yet. */
export async function updated(
  world: World,
  forms = [FORM],
): Promise<{ a: Page; storage: TabStorage }> {
  const storage = new TabStorage();
  const a = await world.page("A", storage, forms).mount();
  for (const context of forms) a.type(ORIGINAL, context);
  expect(await a.update()).toEqual(
    forms.flatMap(() => ["saved"]).concat(forms.map(() => "saved")),
  );
  a.leave();
  return { a, storage };
}
