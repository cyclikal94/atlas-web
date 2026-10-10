import type { BrowserContext, Page } from "@playwright/test";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import {
  ACCOUNT,
  bootSession,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
} from "./data-sync-helpers";

/**
 * The faults the native local-write specs install in the page (E-O8 and E-O9), and the page they run on. A named transaction is
 * ABORTED by a call of `IDBObjectStore.put` or `delete` that throws for the draft the case is about, the write that counts a failure
 * (a `put` of `sync_state` that carries a failure streak) can be made to throw too, and the write of a fallback marker to the page's
 * REAL `localStorage` can be refused (a `setItem` of an `atlas-write-failing:` key throws), so that a stop is held by nothing but the
 * page's memory. Every one is a fault the spec installs in the page, as the earlier specs fail a write; nothing here produces a real
 * failing disk, which this machine's browsers cannot be made to have.
 */
export interface Fault {
  id: string;
  delete: boolean;
  armed: number;
  counter: number;
  queue: number;
  /** The next writes of a fallback marker to `localStorage` that are refused. */
  markers: number;
  hits: string[];
}

/** A version-checked edit of `id`, under a fixed key; `$base` is the base the transaction read for `id`. */
export const edit = (
  id: string,
  localId: string,
  label: string = localId,
): HarnessEnqueue => ({
  endpoint: "/commands",
  localId,
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  command: { kind: "edit", id, base: { $base: id }, label },
});

export const streaks = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(
    async (acct) =>
      (
        (await window.__atlasData?.syncState(acct)) as {
          local_write_streaks?: Record<string, number>;
        } | null
      )?.local_write_streaks ?? {},
    ACCOUNT,
  );
/**
 * A marker's key as the page's REAL `localStorage` holds it (R55 and R56, revision 33):
 * `atlas-write-failing:<account>:<incarnation>:<operation>#<page>.<count>`, and the directory that lists it,
 * `atlas-write-dir:<account>:<incarnation>:<slot>`. These helpers READ THE RAW KEYS and parse them themselves: they are the independent
 * oracle for what the page's markers say, and share no code with the product module that answers.
 */
const MARKER_KEY =
  /^atlas-write-failing:([^:]*):([^:]*):(.*?)#([0-9a-z-]{1,64}\.[0-9]+)$/;

/**
 * The incarnation every database created in a context has once `fixIncarnation` ran (R56, revision 33). A marker's key names the lifetime
 * of the database it belongs to, which a spec can otherwise learn only after the database exists; fixing it lets a spec name the key of a
 * marker before the page that creates the database has started. FIXTURE only: production composes `crypto.randomUUID()`.
 */
export const FIXED_INCARNATION = "fixture-incarnation-1";
/** Fixes the incarnation of the databases the pages of `context` create from now on (call it BEFORE the pages exist). */
export const fixIncarnation = (context: BrowserContext) =>
  context.addInitScript((id) => {
    (globalThis as { __fixtureIncarnation?: string }).__fixtureIncarnation = id;
  }, FIXED_INCARNATION);
/** The key prefix of ONE operation's markers in the lifetime `fixIncarnation` fixed: `atlas-write-failing:<account>:<incarnation>:<operation>`. */
export const fixedOperationKey = (
  operation: string,
  account: string = ACCOUNT,
): string =>
  `atlas-write-failing:${encodeURIComponent(account)}:${encodeURIComponent(FIXED_INCARNATION)}:${operation}`;
/**
 * The key prefix of ONE operation's markers in the lifetime of the database the page has open (the lifetime is asked of the page).
 */
export const operationKeyOf = async (
  page: Page,
  operation: string,
  account: string = ACCOUNT,
): Promise<string> =>
  `atlas-write-failing:${encodeURIComponent(account)}:${encodeURIComponent(await incarnationOf(page, account))}:${operation}`;

/** The lifetime (the database's incarnation) the page's open database of `account` has. */
export const incarnationOf = (
  page: Page,
  account: string = ACCOUNT,
): Promise<string> =>
  page.evaluate(async (acct) => {
    const state = (await window.__atlasData?.syncState(acct)) as {
      incarnation_id?: string;
    } | null;
    if (!state?.incarnation_id)
      throw new Error(`no incarnation is known for ${acct} on this page`);
    return state.incarnation_id;
  }, account);

/**
 * The operations that carry a fallback marker in the page's REAL `localStorage`, each once however many instances stand and whichever
 * lifetime they belong to (`atlas-write-failing:<account>:<incarnation>:<operation>#<page>.<count>`; this strips the failure's name).
 * `markerInstances` answers the names.
 */
export const markers = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const parse =
      /^atlas-write-failing:([^:]*):([^:]*):(.*?)#([0-9a-z-]{1,64}\.[0-9]+)$/;
    return [
      ...new Set(
        Object.keys(localStorage)
          .map((key) => parse.exec(key)?.[3])
          .filter((operation): operation is string => operation !== undefined),
      ),
    ].sort();
  });
/** The raw keys of the markers that stand for ONE operation of an account (whichever lifetime), sorted. */
export const markerKeysOf = (
  page: Page,
  account: string,
  operation: string,
): Promise<string[]> =>
  page.evaluate(
    ([acct, op]) => {
      const parse =
        /^atlas-write-failing:([^:]*):([^:]*):(.*?)#([0-9a-z-]{1,64}\.[0-9]+)$/;
      return Object.keys(localStorage)
        .filter((key) => {
          const m = parse.exec(key);
          return (
            m !== null && decodeURIComponent(m[1] ?? "") === acct && m[3] === op
          );
        })
        .sort();
    },
    [account, operation] as const,
  );
/** The names of the failures whose markers stand for ONE operation of an account (the part of the key after `#`), sorted. */
export const markerInstances = async (
  page: Page,
  account: string,
  operation: string,
): Promise<string[]> =>
  (await markerKeysOf(page, account, operation))
    .map((key) => MARKER_KEY.exec(key)?.[4] ?? "")
    .sort();
/** The key a marker of `operation` has in the page's own lifetime, for a name (what a planted or expected marker is called). */
export const markerKeyFor = async (
  page: Page,
  account: string,
  operation: string,
  name: string,
): Promise<string> =>
  `atlas-write-failing:${encodeURIComponent(account)}:${encodeURIComponent(await incarnationOf(page, account))}:${operation}#${name}`;
/**
 * Records a failure of `operation` as ANOTHER page would, in this page's real `localStorage`: the failure is listed in the directory of
 * a slot no running page owns (`slot`, 31 by default) FIRST, and its own key is written second. Answers the key.
 */
export async function plantMarkerOn(
  page: Page,
  account: string,
  operation: string,
  name = "planted.1",
  options: { slot?: number; incarnation?: string } = {},
): Promise<string> {
  // The lifetime is the database's: asked of the page that has it open unless the caller names it (a writer page that only writes
  // `localStorage` has no database of its own to ask).
  const incarnation =
    options.incarnation ?? (await incarnationOf(page, account));
  return page.evaluate(
    ([acct, inc, op, instance, at]) => {
      const scope = `${encodeURIComponent(acct)}:${encodeURIComponent(inc)}`;
      const directory = `atlas-write-dir:${scope}:${at}`;
      const raw = localStorage.getItem(directory);
      const entries: Array<[string, string]> =
        raw === null
          ? []
          : (JSON.parse(raw) as { e: Array<[string, string]> }).e;
      entries.push([op, instance]);
      localStorage.setItem(directory, JSON.stringify({ v: 1, e: entries }));
      const key = `atlas-write-failing:${scope}:${op}#${instance}`;
      localStorage.setItem(key, "1");
      return key;
    },
    [account, incarnation, operation, name, options.slot ?? 31] as const,
  );
}
/** Removes every marker key that stands for the operation (whatever its page and lifetime), as the page that wrote them would. */
export const removeMarkerKeys = (
  page: Page,
  account: string,
  operation: string,
): Promise<number> =>
  page.evaluate(
    ([acct, op]) => {
      const parse =
        /^atlas-write-failing:([^:]*):([^:]*):(.*?)#([0-9a-z-]{1,64}\.[0-9]+)$/;
      let removed = 0;
      for (const key of Object.keys(localStorage)) {
        const m = parse.exec(key);
        if (
          m !== null &&
          decodeURIComponent(m[1] ?? "") === acct &&
          m[3] === op
        ) {
          localStorage.removeItem(key);
          removed += 1;
        }
      }
      return removed;
    },
    [account, operation] as const,
  );
export const warning = (page: Page) =>
  page.evaluate(() => window.__atlasData?.outboxStorage() ?? null);
export const queue = (page: Page) =>
  page.evaluate((a) => window.__atlasData?.queue(a), ACCOUNT);
export const statusOf = async (page: Page, id: string) =>
  (await queue(page))?.find((row) => row.local_id === id)?.status;
export const outboxState = (page: Page) =>
  page.evaluate(() => window.__atlasData?.outboxState() ?? null);

/**
 * Installs the fault the page's writes go through. The NEXT `armed` calls of `put` of a `drafts` row (or of `delete` of one, for a
 * discard) named `id` throw, the NEXT `counter` writes of `sync_state` that carry a failure streak throw (so the stop goes to the
 * marker), and the NEXT `markers` writes of a fallback marker throw (so the stop is held in memory). Throwing inside the transaction
 * aborts it. Installed once per page; `arm` sets the counts.
 */
export async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fault?: Fault };
    if (w.__fault) return;
    w.__fault = {
      id: "",
      delete: false,
      armed: 0,
      counter: 0,
      queue: 0,
      markers: 0,
      hits: [],
    };
    const proto = IDBObjectStore.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    for (const name of ["put", "delete"] as const) {
      const original = proto[name] as (...a: unknown[]) => unknown;
      proto[name] = function (this: IDBObjectStore, ...args: unknown[]) {
        const fault = w.__fault;
        if (fault && this.name === "drafts" && fault.armed > 0) {
          const key =
            name === "put"
              ? (args[0] as { local_id?: string } | undefined)?.local_id
              : (args[0] as string | undefined);
          if (key === fault.id && (name === "delete") === fault.delete) {
            fault.armed -= 1;
            fault.hits.push(`${name} drafts ${key}`);
            throw new DOMException("injected fault", "DataError");
          }
        }
        if (
          fault &&
          name === "put" &&
          this.name === "sync_state" &&
          fault.counter > 0
        ) {
          const row = args[0] as { local_write_streaks?: object };
          if (Object.keys(row?.local_write_streaks ?? {}).length > 0) {
            fault.counter -= 1;
            fault.hits.push("put sync_state (a failure's counter)");
            throw new DOMException("injected fault", "DataError");
          }
        }
        return original.apply(this, args);
      };
    }
    const storage = Storage.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const setItem = storage.setItem as (...a: unknown[]) => unknown;
    storage.setItem = function (this: Storage, ...args: unknown[]) {
      const fault = w.__fault;
      // ADAPTED, revision 34. The fault counted the writes of the failure's key AND of its directory entry, because revision 33 wrote the
      // directory first and gave the failure up when it could not be written. The failure is recorded by its KEY now, and a directory
      // that cannot be written costs the second witness and not the record (header of the marker module, obligation 3), so "the marker
      // cannot be written" (the stop is held in memory) is a refused write of the KEY.
      if (
        fault &&
        fault.markers > 0 &&
        typeof args[0] === "string" &&
        args[0].startsWith("atlas-write-failing:")
      ) {
        fault.markers -= 1;
        fault.hits.push(`setItem ${args[0]} (a marker)`);
        throw new DOMException("injected fault", "QuotaExceededError");
      }
      return setItem.apply(this, args);
    };
  });
}

/**
 * The page's REAL `localStorage` made unreadable (R47, revision 28): the enumeration (`length` and `key`) and the individual read of a
 * fallback marker's key (`getItem` of an `atlas-write-failing:` key) each throw a `SecurityError` while `set` says so, independently of
 * one another, because a page can lose one and keep the other. The writes and the removals are the browser's own. Installed once per page.
 */
export interface MarkerReads {
  /** The origin's listing (`length`, `key`): since revision 33 nothing is read through it, so refusing it changes no answer. */
  enumeration: boolean;
  /** Every read of a marker key AND of a directory (the markers cannot be read at all). */
  getItem: boolean;
  /** Only the reads of a directory (a listed failure's own key can still be read). */
  directory?: boolean;
  /** Only the reads of a failure's own key (the directories can still be read): that failure's operation, and no other, is unknown. */
  key?: boolean;
}
/** Every marker read works (what a case restores when the store "comes back"). */
export const NO_READ_FAULTS: MarkerReads = {
  enumeration: false,
  getItem: false,
  directory: false,
  key: false,
};
export async function installMarkerReadFaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __markerReads?: MarkerReads };
    if (w.__markerReads) return;
    const reads: MarkerReads = {
      enumeration: false,
      getItem: false,
      directory: false,
      key: false,
    };
    w.__markerReads = reads;
    const proto = Storage.prototype as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    const refuse = (): never => {
      throw new DOMException("injected read fault", "SecurityError");
    };
    const getItem = proto.getItem as (...a: unknown[]) => unknown;
    proto.getItem = function (this: Storage, ...args: unknown[]) {
      if (
        reads.getItem &&
        typeof args[0] === "string" &&
        (args[0].startsWith("atlas-write-failing:") ||
          args[0].startsWith("atlas-write-dir:"))
      )
        return refuse();
      if (
        reads.directory &&
        typeof args[0] === "string" &&
        args[0].startsWith("atlas-write-dir:")
      )
        return refuse();
      if (
        reads.key &&
        typeof args[0] === "string" &&
        args[0].startsWith("atlas-write-failing:")
      )
        return refuse();
      return getItem.apply(this, args);
    };
    const key = proto.key as (...a: unknown[]) => unknown;
    proto.key = function (this: Storage, ...args: unknown[]) {
      if (reads.enumeration) return refuse();
      return key.apply(this, args);
    };
    const length = Object.getOwnPropertyDescriptor(Storage.prototype, "length");
    if (length?.get)
      Object.defineProperty(Storage.prototype, "length", {
        ...length,
        get(this: Storage) {
          if (reads.enumeration) return refuse();
          return (length.get as () => number).call(this);
        },
      });
  });
}
export const markerReads = (page: Page, reads: Partial<MarkerReads>) =>
  page.evaluate((next) => {
    const state = (window as unknown as { __markerReads: MarkerReads })
      .__markerReads;
    Object.assign(state, next);
  }, reads);

/**
 * A page that hears of another page's marker LATE (R47, revision 30): the browser's `storage` event for an `atlas-write-failing:` key
 * (or for a cleared storage) is kept back from the page's own listeners, and re-delivered by `releaseStorageEvents`, exactly as a busy or
 * suspended page hears. Only another page's writes are held (a page is never told of its own), and only marker keys: the session's own
 * coordination is untouched.
 *
 * The listener must be the FIRST the page registers for `storage`: for an event whose target is the window, Chromium runs the listeners
 * in the order they were registered, capture or not (measured in Chromium 153; Firefox 155 and WebKit 26.6 run a capture listener first),
 * so one that is installed after the page has booted does not hold the events from the listeners the page already has, and a "held"
 * schedule would be a delivered one without saying so. `storageHoldInit` is therefore an init script (`context.addInitScript`, BEFORE the
 * page is created), it holds nothing until `holdStorageEvents`, and `holdStorageEvents` refuses a page that does not have it. The case
 * then asserts its premise (`markerEventCounts().held`): a hook that is not in force fails the case, it is never read as "held".
 */
interface StorageHold {
  held: boolean;
  received: number;
  events: Array<{ key: string | null; newValue: string | null }>;
}
export const storageHoldInit = (): void => {
  const w = window as unknown as { __storageHold?: StorageHold };
  if (w.__storageHold) return;
  const state: StorageHold = { held: false, received: 0, events: [] };
  w.__storageHold = state;
  window.addEventListener(
    "storage",
    (event) => {
      if (event.storageArea !== window.localStorage) return;
      if (event.key !== null && !event.key.startsWith("atlas-write-failing:"))
        return;
      state.received += 1;
      if (!state.held) return;
      state.events.push({ key: event.key, newValue: event.newValue });
      event.stopImmediatePropagation();
    },
    true,
  );
};
/** Installs `storageHoldInit` in every page the context creates from now on (call it BEFORE the page that must hold is created). */
export const installStorageHold = (context: BrowserContext) =>
  context.addInitScript(storageHoldInit);
/** From now on the page's marker `storage` events are kept back (the page must have been created after `installStorageHold`). */
export async function holdStorageEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __storageHold?: StorageHold })
      .__storageHold;
    if (!state)
      throw new Error(
        "holdStorageEvents: this page has no storage hold; call installStorageHold(context) before the page is created",
      );
    state.held = true;
  });
}
/** How many marker events the page has been sent since it began, and how many it is holding back now. */
export const markerEventCounts = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __storageHold?: StorageHold })
      .__storageHold;
    return { received: state?.received ?? 0, held: state?.events.length ?? 0 };
  });
/** Delivers what was held, in order, and stops holding. */
export const releaseStorageEvents = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __storageHold?: StorageHold })
      .__storageHold;
    if (!state) return;
    state.held = false;
    const pending = state.events.splice(0);
    for (const held of pending)
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: held.key,
          newValue: held.newValue,
          storageArea: window.localStorage,
          url: window.location.href,
        }),
      );
  });

export const arm = (
  page: Page,
  options: {
    id?: string;
    delete?: boolean;
    armed?: number;
    counter?: number;
    markers?: number;
  },
) =>
  page.evaluate((o) => {
    const fault = (window as unknown as { __fault: Fault }).__fault;
    fault.id = o.id ?? "";
    fault.delete = o.delete ?? false;
    fault.armed = o.armed ?? 0;
    fault.counter = o.counter ?? 0;
    fault.markers = o.markers ?? 0;
  }, options);
export const hits = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __fault: Fault }).__fault.hits);

/** Serves `GET /me` and `GET /sessions` (the profile read and the device mirror), as a healthy backend does; call it AFTER `stubNetwork`. */
export async function serveIdentityReads(
  context: BrowserContext,
): Promise<void> {
  const now = Date.now();
  await context.route("**/api/experimental/v1/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: ACCOUNT, username: "alice" }),
    }),
  );
  await context.route("**/api/experimental/v1/sessions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "s1",
            device_id: "dev-1",
            created_at: new Date(now - 60_000).toISOString(),
            expires_at: new Date(now + 86_400_000).toISOString(),
            authentication: "password",
            current: true,
          },
        ],
      }),
    }),
  );
}

/** A page with a running outbox over a database that has a valid cache; the network is stubbed and identity reads are served. */
export async function boot(context: BrowserContext) {
  const net = await stubNetwork(context);
  await serveIdentityReads(context);
  await seedSettled(context);
  const page = await bootSession(context);
  await untilTreeSettled(page, { connections: 0 });
  await startOutbox(page);
  await untilTreeSettled(page, { connections: 2 });
  await page.evaluate(
    (acct) =>
      window.__atlasData?.put(
        acct,
        "cache",
        ["r", "s", "t", "u"].map((id) => ({
          id,
          kind: "person",
          parent_id: null,
          label: id,
          value: null,
          version: 5,
          can_edit: true,
          archived: false,
          kind_date: null,
        })),
      ),
    ACCOUNT,
  );
  await install(page);
  return { net, page };
}
