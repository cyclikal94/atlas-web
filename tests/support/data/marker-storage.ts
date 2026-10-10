import {
  createWriteFailureMarkers,
  directoryKey,
  type MarkerEvents,
  type MarkerOptions,
  type MarkerStorage,
  markerKey,
  parseMarkerKey,
  type SlotLocks,
  type StopScope,
  type WriteFailureMarkers,
} from "../../../src/data/engine/write-failure-marker";

/** The lifetime (database incarnation) a test world's first database has (`incarnation-1`): the markers of its tests belong to it unless a test names another. */
export const INCARNATION = "incarnation-1";
/** The scope of an account's markers: its account and one lifetime of its database (R56). */
export const scopeOf = (
  account: string,
  incarnationId: string = INCARNATION,
): StopScope => ({ account, incarnationId });
const asScope = (scope: StopScope | string): StopScope =>
  typeof scope === "string" ? scopeOf(scope) : scope;

/**
 * The Web Locks of an origin as the markers use them for their directory slots (`SlotLocks`): a lock is held by one page until it lets
 * go or the page "dies". `page(name)` is the locks of one page; `crash()` of it frees everything that page held, as the browser does
 * when a page goes away. Nothing is ever stolen and nothing is listed (`query`), as in production.
 */
export class FakeSlotLocks {
  readonly held = new Map<string, string>();
  /** Every acquisition attempted, in order: `[page, lock, granted]`. */
  readonly log: Array<[string, string, boolean]> = [];
  /** Locks that are refused whatever their state (the browser refused the request). */
  refuse = false;
  page(name: string): SlotLocks & { crash(): void; holding(): string[] } {
    return {
      tryAcquire: async (lock) => {
        const free = !this.refuse && !this.held.has(lock);
        this.log.push([name, lock, free]);
        if (!free) return null;
        this.held.set(lock, name);
        return {
          release: () => {
            if (this.held.get(lock) === name) this.held.delete(lock);
          },
        };
      },
      crash: () => {
        for (const [lock, holder] of [...this.held])
          if (holder === name) this.held.delete(lock);
      },
      holding: () =>
        [...this.held].filter(([, holder]) => holder === name).map(([l]) => l),
    };
  }
}

/** `localStorage` as ONE page sees it: the same items as every other page, and its own feed of the OTHER pages' changes. */
export interface MarkerPage {
  storage: MarkerStorage;
  events: MarkerEvents;
  /** The directory slot this page owns in tests that do not model the locks (each page of one storage has its own). */
  slot: number;
  /** This page's Web Locks (the origin's lock world is `FakeMarkerStorage.lockWorld`). */
  locks: SlotLocks & { crash(): void; holding(): string[] };
  /** `localStorage.clear()` from this page. */
  clear(): void;
}

/**
 * A `localStorage` double for the write-failure markers: an in-memory map that survives an engine restart in a test (the page
 * "reloads" while the storage stays), and whose writes can be made to fail (blocked site data, a full origin).
 *
 * It models PAGES (tabs), as the browser does: the object itself is the ENGINE's page, `page(name)` is another page over the same
 * items, and a write by one page reaches the `events` of every OTHER page, never its own (the browser's `storage` event). An event is
 * delivered only when the stored value actually changed (a `setItem` of the same value and a `removeItem` of a missing key say
 * nothing, as in a browser). `hold()` keeps the events back and `release()` delivers them, to reproduce a page that hears late.
 */
export class FakeMarkerStorage implements MarkerStorage {
  readonly items = new Map<string, string>();
  /** When true `setItem` throws, as `localStorage` does when it is full or blocked. */
  failWrites = false;
  /**
   * When true the ENUMERATION (`length` and `key`) throws, as a `localStorage` that has become unreadable does (R47, revision 28). Every
   * page's, like `failWrites`; `getItem` is separate (`failGets`), because a page can lose one read and keep the other.
   */
  failEnumeration = false;
  /** When true `getItem` throws (an individual key cannot be read). */
  failGets = false;
  /** When set, `getItem` of a key it accepts throws (one record unreadable while the others can be read). */
  failGetsFor: ((key: string) => boolean) | null = null;
  /** How many times the enumeration (`length`, `key`) was used (the listing is the first witness of a failure since revision 34, R55). */
  enumerations = 0;
  /** When true any use of the enumeration throws a recognisable error: the listing cannot be completed, and a read that needs it says `unknown`. */
  forbidEnumeration = false;
  /** Called with the key before every `getItem` (a hook for an interleaving that changes other keys while a read is under way). */
  onGet: ((page: string, key: string) => void) | null = null;
  /**
   * Called with the index before every `key(index)` of the ENGINE's page (a hook for the interleaving the review of revision 32 used: other
   * keys are removed and added while a listing of the origin is under way, so that the listing's order shifts under it).
   */
  onKey: ((index: number) => void) | null = null;
  /**
   * Called before every SNAPSHOT of the keys (`keys()`, revision 35): the interleaving of another context can act between any two
   * operations of a page, and never inside one (the HTML standard's "get the keys" is one operation on the storage's map).
   */
  onKeys: ((page: string) => void) | null = null;
  /** How many snapshots of the keys (`keys()`) the pages took (revision 35: the authority of a read, R55). */
  snapshots = 0;
  /** The origin's Web Locks, which the pages' directory slots are taken from. */
  readonly lockWorld = new FakeSlotLocks();
  /** The directory slot of the engine's page (test pages that do not model locks own it). */
  readonly slot = 0;
  private nextSlot = 1;
  /** The engine's page locks. */
  readonly locks = this.lockWorld.page("engine");
  /** Every event delivered or held, in order: `[page that wrote, key]`. */
  readonly log: Array<[string, string | null]> = [];
  private readonly feeds = new Set<{
    page: string;
    listener: (key: string | null) => void;
  }>();
  private held: Array<() => void> | null = null;

  /** The engine's page: what the engine and the world's own `markers` write through. */
  readonly events: MarkerEvents = this.eventsOf("engine");

  get length(): number {
    return this.listed().size;
  }
  key(index: number): string | null {
    this.onKey?.(index);
    return [...this.listed().keys()][index] ?? null;
  }
  /** Every key, in ONE operation (the store's own list of its keys; the browser's `Object.keys(localStorage)`). */
  keys(): string[] {
    return this.snapshot("engine");
  }
  getItem(key: string): string | null {
    return this.read("engine", key);
  }
  /** A read that no failure switch affects: the test's own look at the items (and how a writer reads its own directory back). */
  peek(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.write("engine", key, value);
  }
  removeItem(key: string): void {
    this.write("engine", key, null);
  }
  /** `localStorage.clear()` from the engine's page. */
  clear(): void {
    this.wipe("engine");
  }

  /** How many feeds are subscribed (a controller that is disposed leaves none behind). */
  get listening(): number {
    return this.feeds.size;
  }

  /** Another page over the same items. Its `setItem` throws while `failWrites` is set, like every page's. */
  page(name: string): MarkerPage {
    const listed = (): Map<string, string> => this.listed();
    const read = (key: string): string | null => this.read(name, key);
    const page: MarkerPage = {
      slot: this.nextSlot++,
      locks: this.lockWorld.page(name),
      events: this.eventsOf(name),
      storage: {
        get length() {
          return listed().size;
        },
        key: (index) => [...listed().keys()][index] ?? null,
        keys: () => this.snapshot(name),
        getItem: read,
        setItem: (key, value) => this.write(name, key, value),
        removeItem: (key) => this.write(name, key, null),
      },
      clear: () => this.wipe(name),
    };
    (
      page.storage as MarkerStorage & { peek(key: string): string | null }
    ).peek = (key) => this.items.get(key) ?? null;
    return page;
  }

  /** From now on events are kept back; `release()` delivers them in order. */
  hold(): void {
    this.held ??= [];
  }
  release(): void {
    const pending = this.held ?? [];
    this.held = null;
    for (const deliver of pending) deliver();
  }

  /** The items, unless the enumeration is made to fail (an unreadable storage throws a `SecurityError` on the first read). */
  private listed(): Map<string, string> {
    this.enumerations += 1;
    if (this.forbidEnumeration)
      throw new Error("the origin's keys were listed (R55)");
    if (this.failEnumeration)
      throw new DOMException("read refused", "SecurityError");
    return this.items;
  }

  private snapshot(page: string): string[] {
    this.onKeys?.(page);
    this.snapshots += 1;
    return [...this.listed().keys()];
  }

  private read(page: string, key: string): string | null {
    this.onGet?.(page, key);
    if (this.failGets || this.failGetsFor?.(key) === true)
      throw new DOMException("read refused", "SecurityError");
    return this.items.get(key) ?? null;
  }

  private eventsOf(page: string): MarkerEvents {
    return {
      subscribe: (listener) => {
        const feed = { page, listener };
        this.feeds.add(feed);
        return () => {
          this.feeds.delete(feed);
        };
      },
    };
  }

  private wipe(page: string): void {
    this.items.clear();
    this.emit(page, null);
  }

  private write(page: string, key: string, value: string | null): void {
    if (value === null) {
      if (!this.items.has(key)) return;
      this.items.delete(key);
    } else {
      if (this.failWrites)
        throw new DOMException("quota", "QuotaExceededError");
      if (this.items.get(key) === value) return;
      this.items.set(key, value);
    }
    this.emit(page, key);
  }

  private emit(writer: string, key: string | null): void {
    this.log.push([writer, key]);
    const deliver = () => {
      for (const feed of [...this.feeds])
        if (feed.page !== writer && this.feeds.has(feed)) feed.listener(key);
    };
    if (this.held === null) deliver();
    else this.held.push(deliver);
  }
}

/**
 * What the page's global `localStorage` does when its markers are built (R47, revision 29): `throws` (blocked site data: the getter
 * itself throws a `SecurityError`), `absent` (no `localStorage` at all) or the storage it returns.
 */
export type GlobalStorage = "throws" | "absent" | MarkerStorage;

/** Runs `build` with the global `localStorage` as `behaviour` says, and puts the global back as it was found. */
export function withGlobalStorage<T>(
  behaviour: GlobalStorage,
  build: () => T,
): T {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  try {
    if (behaviour === "absent")
      Reflect.deleteProperty(globalThis, "localStorage");
    else
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          if (behaviour === "throws")
            throw new DOMException("injected blocked access", "SecurityError");
          return behaviour;
        },
      });
    return build();
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

/**
 * The global `localStorage` in force until the returned function is called, for a test of what a page does when the storage is
 * obtained AFTER its markers were built (access restored, or lost).
 */
export function setGlobalStorage(behaviour: GlobalStorage): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  if (behaviour === "absent")
    Reflect.deleteProperty(globalThis, "localStorage");
  else
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        if (behaviour === "throws")
          throw new DOMException("injected blocked access", "SecurityError");
        return behaviour;
      },
    });
  return () => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

/**
 * The keys of the markers that stand for ONE operation of a scope in `storage`: read from the raw items, by the key each failure has,
 * NOT through the directories (an independent oracle for the tests of the markers' own discovery, R55).
 */
export function markerKeys(
  storage: { readonly items: ReadonlyMap<string, string> },
  scope: StopScope | string,
  operation: string,
): string[] {
  const want = asScope(scope);
  return [...storage.items.keys()].filter((key) => {
    const parsed = parseMarkerKey(key);
    return (
      parsed !== null &&
      parsed.account === want.account &&
      parsed.incarnationId === want.incarnationId &&
      parsed.operation === operation
    );
  });
}

/** Whether any marker stands for the operation. */
export const markerStands = (
  storage: { readonly items: ReadonlyMap<string, string> },
  scope: StopScope | string,
  operation: string,
): boolean => markerKeys(storage, scope, operation).length > 0;

/** The instance names of the markers that stand for the operation, sorted. */
export function markerInstances(
  storage: { readonly items: ReadonlyMap<string, string> },
  scope: StopScope | string,
  operation: string,
): string[] {
  return markerKeys(storage, scope, operation)
    .map((key) => parseMarkerKey(key)?.instance ?? "")
    .sort();
}

/**
 * Records a failure of the operation the way ANOTHER page does: its directory first (the slot `slot` is that page's), then its own key
 * (named `name`), the fixed value. Answers the key. A name is `<page>.<count>`; give a different one for each failure, as a page's
 * count does.
 */
export function plantMarker(
  storage: MarkerStorage,
  scope: StopScope | string,
  operation: string,
  name = "planted.1",
  slot = 31,
): string {
  const want = asScope(scope);
  const directory = directoryKey(want, slot);
  // A plant is made by another page and is not subject to what makes THIS page's reads fail.
  const peek = (storage as { peek?: (key: string) => string | null }).peek;
  const raw =
    peek === undefined
      ? storage.getItem(directory)
      : peek.call(storage, directory);
  const entries: Array<[string, string]> =
    raw === null ? [] : (JSON.parse(raw) as { e: Array<[string, string]> }).e;
  entries.push([operation, name]);
  storage.setItem(directory, JSON.stringify({ v: 1, e: entries }));
  const key = markerKey(want, operation, name);
  storage.setItem(key, "1");
  return key;
}

/**
 * The markers of ONE page over a `FakeMarkerStorage` (or one of its pages): it owns the page's directory slot without asking for a
 * lock, which is how the contract tests of everything above the markers stay synchronous. `events: false` is a page with no feed.
 */
export function pageMarkers(
  owner: FakeMarkerStorage | MarkerPage,
  options: MarkerOptions & { events?: boolean } = {},
): WriteFailureMarkers {
  const storage = owner instanceof FakeMarkerStorage ? owner : owner.storage;
  const { events, ...rest } = options;
  return createWriteFailureMarkers(
    storage,
    events === false ? undefined : owner.events,
    { ownSlot: owner.slot, ...rest },
  );
}
