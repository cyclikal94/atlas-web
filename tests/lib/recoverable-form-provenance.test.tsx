import {
  act,
  cleanup,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
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
  discardDirty,
  flushDirty,
  type RecoverableFormRegistry,
} from "../../src/lib/form-recovery/registry";
import type { FormSession } from "../../src/lib/form-recovery/session";
import {
  RecoveryIdentityError,
  type RecoveryTab,
} from "../../src/lib/form-recovery/tab-identity";
import {
  type RecoverableForm,
  type SubmissionTicket,
  useRecoverableForm,
} from "../../src/lib/form-recovery/use-recoverable-form";
import {
  ACTIVATION_FALLBACK_MS,
  FLUSH_START_GRACE_MS,
} from "../../src/lib/pwa/coordinator";
import { FakeOrigin } from "../pwa/coordinator-world";

/**
 * WEB-14a revision 5 (review of 11 October 2026: R3 `update-reload-after-capture-edit`, incomplete fix; R13
 * `recovery-shared-source-reload-coverage`, new; design assessment of 11 October 2026, C1-C5 and the qualification matrix Q1-Q15).
 *
 *  - R3 at late binding: a mount with no database yet (no port) that the person types into, even the text of an earlier successful
 *    submission, keeps that edit's provenance when it binds the page's existing session, so the edit stays unfinished until saved.
 *  - R13: a copy restored from a gone tab is shared by every page that restored it, and any of them may discard it; it is never a page's
 *    reload protection. A page is clean only with a copy of its own, saved from what IT holds.
 *  - The diagnosed Chromium precondition (revision 5): a change event that only commits the value the field's last input event reported
 *    (focus leaving the field; Chromium also when a focused edited field is removed) is not an edit, so it never ends a submission's coverage.
 *
 * Several PAGES over ONE store: each page has its own registry and recovery identity; an identity stays OPEN (its owner lock held) until
 * its page LEAVES (a reload or a close), so a live page's copy is never restored by another (live-owner exclusion), and the next page of a
 * tab is a new page after the old one has left. Schedules are forced with gates (held identity grants, held store calls), never with time;
 * the decisive outcomes are public: dirty and pending forms, the rows in the store, and what the next page shows. FIXTURE evidence over the
 * memory adapter; the real store, Web Locks and worker generations in three engines are the revision-5 cases of `fixture.pwa-forms.spec.ts`.
 */
const A = "task-edit:/tasks/51";
const TITLE: readonly RecoverableFieldSpec[] = [{ name: "title" }];
const ORIGINAL = "ORIGINAL UNSENT";

/** A gate a test opens: `reached` once something waits at it. */
class Gate {
  reached = false;
  private release: () => void = () => undefined;
  private readonly opened = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  wait(): Promise<void> {
    this.reached = true;
    return this.opened;
  }
  open(): void {
    this.release();
  }
}

/** The one store every page shares (the account's `form_recovery`), with per-identifier gates and failures. */
class SharedStore extends MemoryRecoveryAdapter {
  readonly saveGates = new Map<string, Gate>();
  readonly discardGates = new Map<string, Gate>();
  readonly failDiscardOf = new Set<string>();
  readonly failSaveOf = new Set<string>();
  readonly discarded: string[] = [];
  override async save(snapshot: RecoverySnapshot): Promise<SaveResult> {
    await this.saveGates.get(snapshot.tabInstanceId)?.wait();
    if (this.failSaveOf.has(snapshot.tabInstanceId)) return "failed";
    return super.save(snapshot);
  }
  override async discard(
    formContext: string,
    tabInstanceId: string,
  ): Promise<DiscardResult> {
    await this.discardGates.get(tabInstanceId)?.wait();
    if (this.failDiscardOf.has(tabInstanceId)) return "failed";
    this.discarded.push(tabInstanceId);
    return super.discard(formContext, tabInstanceId);
  }
  /** The restorable copies of the form: `[identifier, title]`, newest first. */
  async rows(): Promise<[string, string | undefined][]> {
    return (await this.list(A)).map((copy) => [
      copy.tabInstanceId,
      copy.values.title,
    ]);
  }
}

/** A copy left by a tab that has gone. */
const gone = (id: string, title: string, at = "2026-10-11T08:00:00.000Z") => ({
  formContext: A,
  tabInstanceId: id,
  values: { title },
  savedAt: at,
});

class World {
  readonly open = new Set<string>();
  readonly store = new SharedStore();
  private pages = 0;
  page(name: string): Page {
    this.pages += 1;
    return new Page(this, `${name}-${this.pages}`);
  }
}

/** A page's recovery identity: minted at its first save, OPEN once granted, until the page leaves. */
class PageTab implements RecoveryTab {
  private candidate: string | null = null;
  private owned: string | null = null;
  grant: Gate | null = null;
  refusals = 0;
  constructor(
    private readonly world: World,
    private readonly name: string,
  ) {}
  async id(): Promise<string> {
    if (this.owned !== null) return this.owned;
    if (this.refusals > 0) {
      this.refusals -= 1;
      throw new RecoveryIdentityError("refused (test)");
    }
    this.candidate ??= this.name;
    await this.grant?.wait();
    this.owned = this.candidate;
    this.world.open.add(this.owned);
    return this.owned;
  }
  current(): string | null {
    return this.owned;
  }
  async ownerOpen(id: string): Promise<boolean> {
    return (
      id === this.owned || id === this.candidate || this.world.open.has(id)
    );
  }
  leave(): void {
    if (this.owned !== null) this.world.open.delete(this.owned);
  }
}

function Form({
  page,
  port,
  allow = TITLE,
}: {
  page: Page;
  port: FormRecoveryPort | null;
  allow?: readonly RecoverableFieldSpec[];
}) {
  const ref = useRef<HTMLFormElement>(null);
  page.handle = useRecoverableForm({
    formContext: A,
    allow,
    formRef: ref,
    port,
    registry: page.registry,
    tab: page.tab,
  });
  return (
    <form ref={ref} aria-label="Task">
      <input name="title" aria-label="Title" defaultValue="" />
      <input name="password" type="password" aria-label="Password" />
    </form>
  );
}

class Page {
  readonly tab: PageTab;
  registry: RecoverableFormRegistry = createRecoverableFormRegistry();
  handle: RecoverableForm | null = null;
  private view: RenderResult | null = null;
  constructor(
    readonly world: World,
    readonly name: string,
  ) {
    this.tab = new PageTab(world, name);
  }
  /** Mounts the form (bound to the store, or with no database yet), and waits for the look when bound. */
  async mount(bound = true): Promise<this> {
    this.view = render(
      <Form page={this} port={bound ? this.world.store : null} />,
    );
    if (bound) await this.ready();
    return this;
  }
  /** The form gets its database (the port), and waits for the look. */
  async bind(): Promise<void> {
    this.view?.rerender(<Form page={this} port={this.world.store} />);
    await this.ready();
  }
  ready(): Promise<void> {
    return waitFor(() => expect(this.handle?.ready).toBe(true));
  }
  /** The form unmounts (another page's boot remounts the tree): the page stays. */
  unmount(): void {
    this.view?.unmount();
    this.view = null;
    this.handle = null;
  }
  /** The page goes (a reload or a close): its form unmounts and its identity's lock is released. */
  leave(): void {
    this.unmount();
    this.tab.leave();
  }
  field(label = "Title"): HTMLInputElement {
    if (!this.view) throw new Error(`${this.name} shows no form`);
    return within(this.view.container).getByLabelText(
      label,
    ) as HTMLInputElement;
  }
  value(): string {
    return this.field().value;
  }
  /** The person types (the value changes and an input event says so, as a browser does). */
  type(value: string, label = "Title"): void {
    act(() => {
      const element = this.field(label);
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  /** Focus leaves the field: the browser commits its value with a change event. */
  commit(label = "Title"): void {
    act(() => {
      this.field(label).dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  dirty(): number {
    return this.registry.dirty().length;
  }
  async flush(): Promise<SaveResult[]> {
    let results: SaveResult[] = [];
    await act(async () => {
      results = await flushDirty(this.registry);
    });
    return results;
  }
  ticket(): SubmissionTicket {
    const ticket = this.handle?.submitting();
    if (!ticket) throw new Error("no ticket");
    return ticket;
  }
  async succeed(ticket: SubmissionTicket): Promise<string> {
    let result = "";
    await act(async () => {
      result = await ticket.succeeded();
    });
    return result;
  }
  /** The page's form session (internal provenance, a supplement to the public outcomes). */
  session(): FormSession {
    return this.registry.session(A) as FormSession;
  }
}

/** The next page of a tab: a new page after the old one has left. Returns what it shows. */
const nextPage = async (world: World): Promise<Page> =>
  world.page("next").mount();

afterEach(() => {
  cleanup();
});

describe("R3 at late binding (Q1): an edit typed before the form had a database keeps its provenance", () => {
  /** The page submitted SENT A (unchanged, successful); the form unmounts: its session is detached, clean and unlisted. */
  const submittedThenUnmounted = async (world: World) => {
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    page.unmount();
    // The exact precondition: detached, clean, unlisted, nothing outstanding, nothing stored.
    expect(page.session().attached).toBeNull();
    expect(page.registry.all()).toHaveLength(0);
    expect(page.registry.pending()).toBe(0);
    expect(await world.store.rows()).toEqual([]);
    return page;
  };

  test("unbound remount, the person types the SAME text as the earlier submission, then the form binds: dirty, saved, restored", async () => {
    const world = new World();
    const page = await submittedThenUnmounted(world);
    await page.mount(false);
    // Only the new mount's provisional handle is listed, and it is clean until typed into.
    expect(page.registry.all()).toHaveLength(1);
    expect(page.dirty()).toBe(0);
    page.type("SENT A");
    expect(page.dirty()).toBe(1);
    await page.bind();
    expect(page.value()).toBe("SENT A");
    expect(page.dirty()).toBe(1);
    expect(page.registry.pending()).toBe(0);
    expect(await page.flush()).toEqual(["saved"]);
    expect(await world.store.rows()).toEqual([[page.name, "SENT A"]]);
    expect(page.dirty()).toBe(0);
    page.leave();
    expect((await nextPage(world)).value()).toBe("SENT A");
  });

  test("control: the same edit in a remount bound BEFORE it is typed is dirty, saved and restored the same way", async () => {
    const world = new World();
    const page = await submittedThenUnmounted(world);
    await page.mount(true);
    page.type("SENT A");
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("SENT A");
  });

  test("control: an unbound remount that is never typed into shows the submitted text again, needs no copy, writes nothing", async () => {
    const world = new World();
    const page = await submittedThenUnmounted(world);
    await page.mount(false);
    await page.bind();
    expect(page.value()).toBe("SENT A");
    expect(page.dirty()).toBe(0);
    expect(await page.flush()).toEqual([]);
    expect(await world.store.rows()).toEqual([]);
  });

  test("a distinct text typed before binding is dirty and restored too (the old submission does not cover it)", async () => {
    const world = new World();
    const page = await submittedThenUnmounted(world);
    await page.mount(false);
    page.type("SOMETHING ELSE");
    await page.bind();
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("SOMETHING ELSE");
  });

  test("the provenance is translated, not invented: the new mount's edit is newer than the old coverage in the session's order", async () => {
    const world = new World();
    const page = await submittedThenUnmounted(world);
    const before = page.session().fields;
    const coveredAt = before.covered.get("title")?.at ?? -1;
    const base = before.input;
    await page.mount(false);
    page.type("x");
    page.type("SENT A");
    await page.bind();
    const after = page.session().fields;
    // Two edits in the new mount (revisions 1 and 2) are the session's base + 1 and base + 2.
    expect(after.input).toBe(base + 2);
    expect(after.edited.get("title")).toBe(base + 2);
    expect(after.edited.get("title")).toBeGreaterThan(coveredAt);
  });
});

describe("Q2: what a resumed session takes from a new mount", () => {
  /** The page typed UNSENT X and never saved it; the form unmounts (the session stays dirty and listed). */
  const unsavedThenUnmounted = async (world: World) => {
    const page = await world.page("A").mount();
    page.type("UNSENT X");
    page.unmount();
    expect(page.dirty()).toBe(1);
    return page;
  };

  test("typed away and back to where the field starts, before binding: the person's empty field stays; the unsaved text is owed", async () => {
    const world = new World();
    const page = await unsavedThenUnmounted(world);
    await page.mount(false);
    page.type("x");
    page.type("");
    await page.bind();
    // Not overwritten by the session's text: the person cleared it on purpose.
    expect(page.value()).toBe("");
    expect(page.dirty()).toBe(1);
    // The unsaved text cannot be captured from an empty field: saves fail (an update stops with retry or discard, Q4).
    expect(await page.flush()).toEqual(["failed"]);
    expect(await page.handle?.discard()).toBe("discarded");
    expect(page.dirty()).toBe(0);
  });

  test("control: untouched, the session's unsaved text comes back into the field and is saved and restored", async () => {
    const world = new World();
    const page = await unsavedThenUnmounted(world);
    await page.mount(false);
    await page.bind();
    expect(page.value()).toBe("UNSENT X");
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("UNSENT X");
  });

  test("the same text as the session's unsaved one, typed before binding: one value, nothing owed, saved and restored", async () => {
    const world = new World();
    const page = await unsavedThenUnmounted(world);
    await page.mount(false);
    page.type("UNSENT X");
    await page.bind();
    expect(page.value()).toBe("UNSENT X");
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("UNSENT X");
  });
});

describe("Q3: tickets taken before binding keep their own place in the session's order", () => {
  /** A clean session (SENT A submitted); an unbound remount where NEW is typed and sent before the form binds. */
  const sentBeforeBinding = async (world: World) => {
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    page.unmount();
    await page.mount(false);
    page.type("NEW");
    return { page, sent: page.ticket() };
  };

  test("control: completed after binding with nothing typed since: it covers the form; nothing is dirty or stored", async () => {
    const world = new World();
    const { page, sent } = await sentBeforeBinding(world);
    await page.bind();
    expect(await page.succeed(sent)).toBe("discarded");
    expect(page.dirty()).toBe(0);
    expect(await world.store.rows()).toEqual([]);
  });

  test("an edit after binding back to the EARLIER submission's text is not covered by either: kept, saved, restored", async () => {
    const world = new World();
    const { page, sent } = await sentBeforeBinding(world);
    await page.bind();
    page.type("SENT A");
    expect(await page.succeed(sent)).toBe("kept");
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("SENT A");
  });

  test("two tickets before binding, answered newest first: the newest covers; the older answers the same and changes nothing", async () => {
    const world = new World();
    const { page, sent: first } = await sentBeforeBinding(world);
    page.type("NEWER");
    const second = page.ticket();
    await page.bind();
    expect(await page.succeed(second)).toBe("discarded");
    expect(await page.succeed(first)).toBe("discarded");
    expect(page.dirty()).toBe(0);
  });

  test("two tickets before binding, answered oldest first: the older covers nothing newer; the newest then covers the form", async () => {
    const world = new World();
    const { page, sent: first } = await sentBeforeBinding(world);
    page.type("NEWER");
    const second = page.ticket();
    await page.bind();
    expect(await page.succeed(first)).toBe("kept");
    expect(page.dirty()).toBe(1);
    expect(await page.succeed(second)).toBe("discarded");
    expect(page.dirty()).toBe(0);
  });

  test("a ticket that failed before binding covers nothing: the sent text is still unfinished after binding, saved and restored", async () => {
    const world = new World();
    const { page, sent } = await sentBeforeBinding(world);
    sent.failed();
    await page.bind();
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("NEW");
  });

  test("a ticket whose translated revision an older acknowledgement already reaches answers for itself, not with the old answer", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    page.unmount();
    await page.mount(false);
    // Sent from the untouched new mount (an empty title), before it binds: its revision is the session's acknowledged one.
    const empty = page.ticket();
    await page.bind();
    expect(page.value()).toBe("SENT A");
    // The form shows SENT A again, not the empty title that was sent: the change stays the form's (`kept`), never "discarded" by
    // the earlier submission's answer.
    expect(await page.succeed(empty)).toBe("kept");
    expect(page.dirty()).toBe(0);
    expect(await world.store.rows()).toEqual([]);
  });

  test("a ticket of the OLD mount answered after the new mount bound, with an edit typed in the new mount: the edit stays", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SEND");
    const old = page.ticket();
    page.unmount();
    await page.mount(false);
    page.type("LATER");
    await page.bind();
    expect(await page.succeed(old)).toBe("kept");
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["saved"]);
    page.leave();
    expect((await nextPage(world)).value()).toBe("LATER");
  });

  test("the OLD mount's text typed again AFTER its send, then typed over in the new mount: the send's success does not cover it", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SEND");
    const old = page.ticket();
    page.type("x");
    page.type("SEND");
    page.unmount();
    await page.mount(false);
    page.type("LATER");
    await page.bind();
    expect(await page.succeed(old)).toBe("kept");
    // The re-typed SEND is an edit after the send (R3): still owed, so the save cannot be made without it (Q4: retry or discard).
    expect(page.dirty()).toBe(1);
    expect(await page.flush()).toEqual(["failed"]);
  });

  test("control: the OLD mount's ticket answered after an untouched remount bound: unchanged since the send, it covers the form", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SEND");
    const old = page.ticket();
    page.unmount();
    await page.mount(false);
    await page.bind();
    expect(page.value()).toBe("SEND");
    expect(await page.succeed(old)).toBe("discarded");
    expect(page.dirty()).toBe(0);
  });
});

describe("a change event that only commits the last input is not an edit (the diagnosed Chromium precondition)", () => {
  test("focus leaves the field AFTER the submission: still covered; the form unmounts clean and unlisted; nothing is stored", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    page.commit();
    expect(page.dirty()).toBe(0);
    page.unmount();
    expect(page.registry.all()).toHaveLength(0);
    expect(await world.store.rows()).toEqual([]);
  });

  test("control: a change event reporting a value no input event reported is an edit (the submission does not cover it)", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    act(() => {
      page.field().value = "CHANGED SILENTLY";
    });
    page.commit();
    expect(page.dirty()).toBe(1);
    act(() => {
      page.field().value = "SENT A";
    });
    page.commit();
    // Back to the submitted text by a change event: an edit after the submission, unfinished (R3).
    expect(page.dirty()).toBe(1);
  });

  test("control: input events always count, even with the same text (R3)", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("SENT A");
    expect(await page.succeed(page.ticket())).toBe("discarded");
    page.type("SENT A");
    expect(page.dirty()).toBe(1);
  });

  test("a sensitive or not admitted field's value is never kept for this rule", async () => {
    const world = new World();
    const page = await world.page("A").mount();
    page.type("secret", "Password");
    page.commit("Password");
    const fields = page.session().fields;
    expect(fields.evented.has("password")).toBe(false);
    expect(fields.ledger.password).toBeUndefined();
    expect(await page.flush()).toEqual([]);
  });
});

describe("R13 (Q5): a restored copy is shared; each page that restored it saves a copy of its own", () => {
  /** Two live pages A and B have restored the gone copy S holding ORIGINAL. */
  const twoRestorers = async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL));
    const a = await world.page("A").mount();
    const b = await world.page("B").mount();
    expect(a.value()).toBe(ORIGINAL);
    expect(b.value()).toBe(ORIGINAL);
    return { world, a, b };
  };

  for (const peerEdits of [true, false])
    test(`${peerEdits ? "B saves different input (deleting S)" : "control: B changes nothing"}; A's update save keeps ORIGINAL; A's next page restores it with B still open`, async () => {
      const { world, a, b } = await twoRestorers();
      if (peerEdits) {
        b.type("PEER NEW INPUT");
        expect(await b.flush()).toEqual(["saved"]);
        expect(await world.store.rows()).toEqual([[b.name, "PEER NEW INPUT"]]);
      }
      // A restored S and has no copy of its own: dirty, whatever happened to S.
      expect(a.dirty()).toBe(1);
      expect(a.value()).toBe(ORIGINAL);
      expect(await a.flush()).toEqual(["saved"]);
      expect(a.dirty()).toBe(0);
      const rows = await world.store.rows();
      expect(rows).toContainEqual([a.name, ORIGINAL]);
      expect(rows.map(([id]) => id)).not.toContain("S");
      a.leave();
      const next = await nextPage(world);
      expect(next.value()).toBe(ORIGINAL);
      // B's copy is B's (B is still open): never taken over.
      if (peerEdits) {
        expect(b.value()).toBe("PEER NEW INPUT");
        expect(next.handle?.alternatives ?? []).toEqual([]);
      }
    });

  test("a restored form that unmounts (no mount shows it) stays listed and dirty, and is saved from what it left", async () => {
    const { world, a, b } = await twoRestorers();
    a.unmount();
    expect(a.registry.all()).toHaveLength(1);
    expect(a.dirty()).toBe(1);
    b.type("PEER NEW INPUT");
    expect(await b.flush()).toEqual(["saved"]);
    expect(await a.flush()).toEqual(["saved"]);
    a.leave();
    expect((await nextPage(world)).value()).toBe(ORIGINAL);
  });
});

describe("R13 (Q6): every way another page discards S leaves A's input safe", () => {
  type Deleter = {
    name: string;
    run: (b: Page) => Promise<void>;
    /** Whether S is gone afterwards. */
    deletes: boolean;
  };
  const deleters: Deleter[] = [
    {
      name: "B's successful submission",
      deletes: true,
      run: async (b) => {
        expect(await b.succeed(b.ticket())).toBe("discarded");
      },
    },
    {
      name: "B's 'Discard instead'",
      deletes: true,
      run: async (b) => {
        let result = "";
        await act(async () => {
          result = (await b.handle?.discard()) ?? "";
        });
        expect(result).toBe("discarded");
      },
    },
    {
      name: "B cleared back to empty and flushed (nothing unfinished: its copies are discarded)",
      deletes: true,
      run: async (b) => {
        b.type("");
        expect(await b.flush()).toEqual(["saved"]);
      },
    },
    {
      name: "B's 'Discard and reload anyway'",
      deletes: true,
      run: async (b) => {
        let results: DiscardResult[] = [];
        await act(async () => {
          results = await discardDirty(b.registry);
        });
        expect(results).toEqual(["discarded"]);
      },
    },
    {
      name: "control: B's failed submission",
      deletes: false,
      run: async (b) => {
        b.ticket().failed();
      },
    },
    {
      name: "control: B's submission whose clean-up fails",
      deletes: false,
      run: async (b) => {
        b.world.store.failDiscardOf.add("S");
        expect(await b.succeed(b.ticket())).toBe("failed");
      },
    },
  ];

  for (const deleter of deleters)
    for (const ownedFirst of [false, true])
      test(`${deleter.name}${ownedFirst ? ", after A already saved its own copy" : ""}: A's next page restores ORIGINAL`, async () => {
        const world = new World();
        await world.store.save(gone("S", ORIGINAL));
        const a = await world.page("A").mount();
        const b = await world.page("B").mount();
        if (ownedFirst) {
          world.store.failDiscardOf.add("S");
          expect(await a.flush()).toEqual(["saved"]);
          world.store.failDiscardOf.delete("S");
          expect(a.dirty()).toBe(0);
        }
        await deleter.run(b);
        const ids = (await world.store.rows()).map(([id]) => id);
        expect(ids.includes("S")).toBe(!deleter.deletes);
        world.store.failDiscardOf.clear();
        // Never discarded by B: A's input is A's, whatever B did.
        expect(a.value()).toBe(ORIGINAL);
        expect(a.dirty()).toBe(ownedFirst ? 0 : 1);
        expect(await a.flush()).toEqual(ownedFirst ? [] : ["saved"]);
        a.leave();
        expect((await nextPage(world)).value()).toBe(ORIGINAL);
      });
});

describe("R13 (Q7, Q10): S discarded while A prepares its save", () => {
  test("S discarded after A's capture, while A's identity grant is held: A's save lands with ORIGINAL", async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL));
    const a = await world.page("A").mount();
    const b = await world.page("B").mount();
    a.tab.grant = new Gate();
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = flushDirty(a.registry);
    });
    await waitFor(() => expect(a.tab.grant?.reached).toBe(true));
    expect(await b.succeed(b.ticket())).toBe("discarded");
    expect(await world.store.rows()).toEqual([]);
    a.tab.grant.open();
    await act(async () => {
      expect(await saving).toEqual(["saved"]);
    });
    expect(await world.store.rows()).toEqual([[a.name, ORIGINAL]]);
    a.leave();
    expect((await nextPage(world)).value()).toBe(ORIGINAL);
  });

  test("S discarded while A's save itself is held in the store: the landed copy is ORIGINAL and A is clean only after it lands", async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL));
    const a = await world.page("A").mount();
    const b = await world.page("B").mount();
    const held = new Gate();
    world.store.saveGates.set(a.name, held);
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = flushDirty(a.registry);
    });
    await waitFor(() => expect(held.reached).toBe(true));
    b.type("PEER NEW INPUT");
    expect(await b.flush()).toEqual(["saved"]);
    // Not landed yet: still dirty (an update's checkpoint would not reload).
    expect(a.dirty()).toBe(1);
    held.open();
    await act(async () => {
      expect(await saving).toEqual(["saved"]);
    });
    expect(a.dirty()).toBe(0);
    a.leave();
    expect((await nextPage(world)).value()).toBe(ORIGINAL);
  });

  test("A unmounts and mounts again while its save waits for the identity; S is discarded after the save lands: still restored", async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL));
    const a = await world.page("A").mount();
    const b = await world.page("B").mount();
    a.tab.grant = new Gate();
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = flushDirty(a.registry);
    });
    await waitFor(() => expect(a.tab.grant?.reached).toBe(true));
    a.unmount();
    await a.mount();
    expect(a.value()).toBe(ORIGINAL);
    a.tab.grant.open();
    await act(async () => {
      expect(await saving).toEqual(["saved"]);
    });
    expect(a.dirty()).toBe(0);
    expect(await b.succeed(b.ticket())).toBe("discarded");
    a.leave();
    expect((await nextPage(world)).value()).toBe(ORIGINAL);
  });
});

describe("R13 (Q8): A's own save fails: A stays dirty and S is not touched; the retry saves", () => {
  for (const failure of ["identity refused", "store write failed"] as const)
    test(`${failure}: the flush fails, S stays, A is dirty; the retry lands ORIGINAL`, async () => {
      const world = new World();
      await world.store.save(gone("S", ORIGINAL));
      const a = await world.page("A").mount();
      if (failure === "identity refused") a.tab.refusals = 1;
      else world.store.failSaveOf.add(a.name);
      expect(await a.flush()).toEqual(["failed"]);
      expect(a.dirty()).toBe(1);
      expect(world.store.discarded).toEqual([]);
      expect(await world.store.rows()).toEqual([["S", ORIGINAL]]);
      world.store.failSaveOf.clear();
      expect(await a.flush()).toEqual(["saved"]);
      expect(await world.store.rows()).toEqual([[a.name, ORIGINAL]]);
      a.leave();
      expect((await nextPage(world)).value()).toBe(ORIGINAL);
    });
});

describe("R13 (Q9): saving and cleaning up are separate facts", () => {
  test("A's save lands but S's clean-up fails: A is clean (its own copy protects it), S stays; the next page restores A's copy", async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL, "2026-10-11T07:00:00.000Z"));
    const a = await world.page("A").mount();
    world.store.failDiscardOf.add("S");
    expect(await a.flush()).toEqual(["saved"]);
    expect(a.dirty()).toBe(0);
    expect((await world.store.rows()).map(([id]) => id).sort()).toEqual(
      [a.name, "S"].sort(),
    );
    world.store.failDiscardOf.clear();
    a.leave();
    const next = await nextPage(world);
    expect(next.value()).toBe(ORIGINAL);
    expect(next.handle?.restored?.tabInstanceId).toBe(a.name);
  });

  test("an older clean-up held across choosing another copy never clears the newer choice", async () => {
    const world = new World();
    await world.store.save(gone("T", "OLDER TEXT", "2026-10-11T06:00:00.000Z"));
    await world.store.save(gone("S", ORIGINAL, "2026-10-11T07:00:00.000Z"));
    const a = await world.page("A").mount();
    expect(a.value()).toBe(ORIGINAL);
    const cleanup = new Gate();
    world.store.discardGates.set("S", cleanup);
    let saving: Promise<SaveResult[]> = Promise.resolve([]);
    act(() => {
      saving = flushDirty(a.registry);
    });
    await waitFor(() => expect(cleanup.reached).toBe(true));
    // Revision 7 (DA-B): the choice reads the copy again before it is shown; awaited.
    await act(async () => {
      await a.handle?.restoreAlternative("T");
    });
    expect(a.value()).toBe("OLDER TEXT");
    cleanup.open();
    await act(async () => {
      expect(await saving).toEqual(["saved"]);
    });
    // The chosen copy is still the source: A is dirty, and its next save keeps OLDER TEXT and discards T.
    expect(a.dirty()).toBe(1);
    expect(await a.flush()).toEqual(["saved"]);
    expect(await world.store.rows()).toEqual([[a.name, "OLDER TEXT"]]);
    a.leave();
    const next = await nextPage(world);
    expect(next.value()).toBe("OLDER TEXT");
    expect(next.handle?.alternatives ?? []).toEqual([]);
  });
});

describe("R13 (Q15): the update coordinator over the real form", () => {
  const settle = async (origin: FakeOrigin) => {
    for (let i = 0; i < 5; i += 1)
      await act(async () => {
        await origin.clock.advance(FLUSH_START_GRACE_MS);
      });
  };
  /** A on an update-coordinated tab and B on a plain page, both restored from S. */
  const coordinated = async () => {
    const world = new World();
    await world.store.save(gone("S", ORIGINAL));
    const origin = new FakeOrigin();
    const tab = await origin.tab().start();
    const a = world.page("A");
    a.registry = tab.forms;
    await a.mount();
    const b = await world.page("B").mount();
    return { world, origin, tab, a, b };
  };

  for (const peerEdits of [true, false])
    test(`${peerEdits ? "B saved different input first" : "control: B changes nothing"}; A accepts the update: A's copy is saved before the reload`, async () => {
      const { world, origin, tab, a, b } = await coordinated();
      if (peerEdits) {
        b.type("PEER NEW INPUT");
        expect(await b.flush()).toEqual(["saved"]);
      }
      const waiting = await origin.installNew(2);
      act(() => tab.actions?.accept());
      await settle(origin);
      await act(async () => {
        await origin.activate(waiting);
      });
      await act(async () => {
        await origin.clock.advance(ACTIVATION_FALLBACK_MS);
      });
      expect(tab.reloads).toBe(1);
      expect(await world.store.rows()).toContainEqual([a.name, ORIGINAL]);
      a.leave();
      expect((await nextPage(world)).value()).toBe(ORIGINAL);
    });

  test("S discarded by B while A's save waits for its identity during the reload's preparation: no reload before A's copy lands", async () => {
    const { world, origin, tab, a, b } = await coordinated();
    a.tab.grant = new Gate();
    const waiting = await origin.installNew(2);
    act(() => tab.actions?.accept());
    await waitFor(() => expect(a.tab.grant?.reached).toBe(true));
    expect(await b.succeed(b.ticket())).toBe("discarded");
    await act(async () => {
      await origin.activate(waiting);
    });
    await act(async () => {
      await origin.clock.advance(ACTIVATION_FALLBACK_MS);
    });
    expect(tab.reloads).toBe(0);
    a.tab.grant.open();
    await settle(origin);
    await act(async () => {
      await origin.clock.advance(ACTIVATION_FALLBACK_MS);
    });
    expect(tab.reloads).toBe(1);
    expect(await world.store.rows()).toEqual([[a.name, ORIGINAL]]);
    a.leave();
    expect((await nextPage(world)).value()).toBe(ORIGINAL);
  });

  test("A's save fails: the update stops with save_failed and does not reload; 'Retry save' saves ORIGINAL, then the tab reloads", async () => {
    const { world, origin, tab, a } = await coordinated();
    world.store.failSaveOf.add(a.name);
    const waiting = await origin.installNew(2);
    act(() => tab.actions?.accept());
    await settle(origin);
    await act(async () => {
      await origin.activate(waiting);
    });
    expect(tab.state.kind).toBe("save_failed");
    expect(tab.reloads).toBe(0);
    expect(await world.store.rows()).toEqual([["S", ORIGINAL]]);
    world.store.failSaveOf.clear();
    act(() => tab.actions?.retrySave());
    await settle(origin);
    await act(async () => {
      await origin.clock.advance(ACTIVATION_FALLBACK_MS);
    });
    expect(tab.reloads).toBe(1);
    expect(await world.store.rows()).toEqual([[a.name, ORIGINAL]]);
  });
});
