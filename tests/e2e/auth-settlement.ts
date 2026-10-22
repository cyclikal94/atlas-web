import { type BrowserContext, errors, type Page } from "@playwright/test";
import type { AuthStub, Delivery, DeliveryState, Hold } from "./auth-stub";

/**
 * WEB-14a revision 22 (review R28, design assessment C1-C4): WHEN an authentication journey in a real engine is over.
 *
 * The earlier production-auth helpers treated a returned click, a momentarily exposed shell or the last ARRIVED activation request as
 * completed work. A submitted sign-in is much longer than that: the form's handler hashes the challenge (`crypto.subtle.digest`),
 * waits for `atlas-auth`, allocates an epoch in IndexedDB, holds `atlas-attempt-<epoch>` for the whole attempt, exchanges, activates,
 * commits the settlement and only then exposes the protected tree, whose own readers (verification, profile, sessions, Settings) take
 * leases that can close OTHER pages' displays while they are unresolved (1e.interrupted). A page's form can unmount meanwhile.
 *
 * This is a TEST-SIDE OBSERVER over the unchanged production build: an init script, in every page of the context, records metadata only
 * (no record contents, credentials, grants, verifiers or bodies) about the platform work the session module does:
 *  - each native `submit` event, and whether its dispatch ADMITTED work (the handler started the challenge digest synchronously, as
 *    `SignInForm` -> `signIn` -> `attempts.begin` -> `ids.challenge` does; `JoinForm` -> `register` likewise);
 *  - challenge digests in flight;
 *  - Web Locks requests of the session's lock families (`atlas-auth`, `atlas-attempt-*`, `atlas-lease-*`, `atlas-issue-*`,
 *    `atlas-delete:*`, `atlas-op-*`): pending or held, by name;
 *  - `atlas-auth` IndexedDB transactions in flight, and whether a write request was made on each;
 *  - API `fetch`es in flight, by path.
 * Together with the stub's delivery ledger (`AuthStub.deliveries`) these give a FINITE completion boundary. Requests a test parks on
 * purpose (a `Hold` it has not released) are allowed only when named, with exactly the page work they explain.
 *
 * Revision 23 (review r22 R28, design assessment `d6673007` C2-C5, invariants 1-6): a fetch's promise settles with the HEADERS, so the
 * revision-22 observer lost the work between a delivered answer and the application's classification of it. The identity reader
 * (`handleIdentityAnswer`) surrenders its lease lock and sets an interim hold BEFORE it reads the body, and that hold deliberately leaves
 * an already displayed tree visible (D-21), so a pending `/browser-sessions/current` decode was invisible to every counter. Two further
 * kinds of witness close that gap:
 *  - the RESPONSE-BODY LIFECYCLE of every Response of the page (native, the reconstructed one `releaseResponse` hands on, and clones):
 *    each `arrayBuffer`/`blob`/`bytes`/`formData`/`json`/`text` read from its start to its settlement, each body-stream cancellation,
 *    and any other stream consumer (`getReader`, `pipeTo`, `pipeThrough`, `tee`), which no current reader uses and which is therefore
 *    reported as unsupported instead of silently passing. The body methods are installed as OUTERMOST accessors: a script that later
 *    assigns its own `Response.prototype.json` (a qualification gate, the reviewer's probes) is composed INSIDE the observed call, so a
 *    gate that holds a consumer after the native decode is still part of the observed read. No body content is copied or kept;
 *  - the DURABLE OBLIGATIONS of the `atlas-auth` record, read through the application's own connection (never opening, creating or
 *    upgrading a database) in a labelled read-only transaction that the counters and the S10 recorder leave out: an unretired request
 *    lease (any class but `exposure`) is unfinished work until its retirement or its observation is committed, whatever the page's locks,
 *    fetches and DOM show, and an attempt in the record is unfinished unless a named parked login request explains it. This is the
 *    bridge across the surrendered-lease gap, across a held consumer whose native decode has finished, and across the back-off between
 *    a failed retirement/recording and its retry. Fences, the settled session and pending deletions are terminal or waiting states: they
 *    are part of the compared picture, never "busy" by themselves.
 * IndexedDB transactions of the other databases (the account stores) are counted too. Every sample names its document, so a reload is a
 * change of picture, and every live page of the context must be in the inventory a caller gives (or be a blank page with no
 * application): an unknown page fails the boundary instead of being ignored. The boundary is still a finite, caller-defined one: it does
 * not claim the browser is idle or that no person or network event can follow.
 *
 * The init script can also DELAY a page's challenge digest or its session lock requests (`delayDigest`, `delayLocks`), or FAIL the
 * puts that would retire a request lease (`failLeaseRetirement`): the qualification schedules use them to open a gap deterministically.
 * They are never used by the ordinary cases.
 */

export interface DurableWork {
  /** Read through a connection the application opened in this document; `false` with `error` when it could not be read. */
  readable: boolean;
  error?: string;
  /** Unretired request leases, by class (`exposure` is counted apart: a finished exposure lease closes nothing). */
  leases: Record<string, number>;
  exposure: number;
  attempt: string | null;
  fences: string[];
  settledEpoch: number | null;
  latestEpoch: number | null;
  fenceSeq: number | null;
  pendingDeletions: number;
}

export interface PageWork {
  url: string;
  path: string;
  /** This document's identity: a reload or a navigation to a new document changes it. */
  doc: string;
  /** Every native submit, in order: `admitted` when its dispatch started session work. */
  submits: Array<{ t: number; admitted: boolean }>;
  digests: number;
  pending: string[];
  held: string[];
  /** `atlas-auth` IndexedDB transactions not yet complete or aborted. */
  authTx: number;
  /** Transactions of the other IndexedDB databases not yet complete or aborted, by database name. */
  otherTx: Record<string, number>;
  fetches: string[];
  /** Response bodies being read (`<method> <origin>`; the origin is the request path, `synthetic` or `clone of ...`). */
  bodies: string[];
  /** Body-stream cancellations not yet settled. */
  cancels: string[];
  /** Body reads that ended, by outcome: they change the picture, never the reasons. */
  bodyReads: {
    done: number;
    failed: number;
    cancelled: number;
    clones: number;
  };
  /** Response-body consumers the observer does not follow, and body methods another script displaced: each one fails the boundary. */
  unobserved: string[];
  /** The page's own reading of its DOM (as T15's original `tabState`). */
  dom:
    | "displaying"
    | "different_account"
    | "transition"
    | "signed_out"
    /** A neutral state that waits for the person or the network (1b, 3, the offline cards, ...): see `neutral`. */
    | "neutral"
    /** A same-origin document with no application (a test's instrument page: `settleAuth`'s `instruments`). */
    | "no_app"
    | "blank";
  neutral: string | null;
  /** Monotonic count of observed events: any change of work bumps it. */
  seq: number;
  /** `seq` again after the durable read: a sample is consistent only when no event happened while it was taken. */
  seqAfter: number;
  delayed: { digest: boolean; locks: boolean; retirement: boolean };
  /** The `atlas-auth` record's obligations (only when asked for: `lookAt` reads it once per look). */
  durable: DurableWork | null;
}

const BUSY_HELD = /^atlas-(auth$|attempt-|issue-|delete:|op-)/;
const LOGIN_PATHS = ["/browser-sessions", "/browser-registration"];

export async function observeAuthWork(context: BrowserContext) {
  await context.addInitScript(() => {
    // The application runs only in a secure context; an `about:blank` page (a fresh `context.newPage()`) has neither API.
    if (
      typeof SubtleCrypto === "undefined" ||
      typeof LockManager === "undefined"
    )
      return;
    const SESSION_LOCK = /^atlas-(auth$|attempt-|lease-|issue-|delete:|op-)/;
    // The neutral states that are work in progress (matrix 3.7); every other one waits for the person or the network.
    const IN_PROGRESS = new Set([
      "1a.checking",
      "1c.finishing",
      "1c.resolving",
      "1e.checking",
      "1e.interrupted_online",
      "1e.waiting",
      "2",
    ]);
    const API = "/api/experimental/v1";
    const w = window as unknown as Record<string, unknown>;
    const state = {
      doc: Math.random().toString(36).slice(2, 10),
      submits: [] as Array<{ t: number; admitted: boolean }>,
      digests: 0,
      locks: new Map<number, { name: string; held: boolean }>(),
      authTx: 0,
      otherTx: new Map<string, number>(),
      fetches: new Map<number, string>(),
      bodies: new Map<number, string>(),
      cancels: new Map<number, string>(),
      bodyReads: { done: 0, failed: 0, cancelled: 0, clones: 0 },
      unobserved: [] as string[],
      connections: new Set<IDBDatabase>(),
      seq: 0,
      dispatching: null as { admitted: boolean } | null,
      digestGate: null as Promise<void> | null,
      lockGate: null as Promise<void> | null,
      failRetirement: false,
      releaseDigest: (): void => undefined,
      releaseLocks: (): void => undefined,
    };
    let ids = 0;
    const bump = () => {
      state.seq += 1;
    };
    const realTransaction = IDBDatabase.prototype.transaction;
    const bodyMethods: Array<{ name: string; get: () => unknown }> = [];

    /** One read-only look at `auth_state` through the application's own connection, as metadata. */
    const readDurable = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const fail = (error: string) => resolve({ readable: false, error });
        const connections = [...state.connections];
        const db = connections[connections.length - 1];
        if (!db) {
          fail("no atlas-auth connection observed in this document");
          return;
        }
        let tx: IDBTransaction;
        // The S10 recorder (`recordAuthTransactions`) leaves out a transaction created while this flag is set.
        w.__atlasObserverTx = true;
        try {
          tx = realTransaction.call(db, "records", "readonly");
        } catch (error) {
          state.connections.delete(db);
          fail(`unreadable: ${(error as Error).name}`);
          return;
        } finally {
          w.__atlasObserverTx = false;
        }
        const store = tx.objectStore("records");
        const value = store.get("auth_state");
        const keys = store.getAllKeys();
        tx.onabort = () => fail(`aborted: ${tx.error?.name ?? "unknown"}`);
        tx.oncomplete = () => {
          const auth = value.result as
            | {
                attempt: { phase: string } | null;
                settled: { epoch: number } | null;
                fences: Record<string, Array<{ kind: string }>>;
                leases: Record<string, { class: string }>;
                latest_epoch: number;
                fence_seq: number;
              }
            | undefined;
          const leases: Record<string, number> = {};
          let exposure = 0;
          for (const lease of Object.values(auth?.leases ?? {})) {
            if (lease.class === "exposure") exposure += 1;
            else leases[lease.class] = (leases[lease.class] ?? 0) + 1;
          }
          resolve({
            readable: true,
            leases,
            exposure,
            attempt: auth?.attempt?.phase ?? null,
            fences: Object.values(auth?.fences ?? {})
              .flat()
              .map((fence) => fence.kind)
              .sort(),
            settledEpoch: auth?.settled?.epoch ?? null,
            latestEpoch: auth?.latest_epoch ?? null,
            fenceSeq: auth?.fence_seq ?? null,
            pendingDeletions: (keys.result as IDBValidKey[]).filter((key) =>
              String(key).startsWith("pending_deletions:"),
            ).length,
          });
        };
      });

    const snapshot = () => {
      const neutral =
        document
          .querySelector("[data-neutral-state]")
          ?.getAttribute("data-neutral-state") ?? null;
      const root = document.getElementById("protected-root");
      const signedOut = document.querySelector(
        'input[autocomplete="username"]',
      );
      const app =
        document.getElementById("neutral-root") !== null || root !== null;
      const dom = !app
        ? "no_app"
        : !neutral && root && !root.hasAttribute("inert")
          ? "displaying"
          : neutral === "1d"
            ? "different_account"
            : !neutral && signedOut
              ? "signed_out"
              : neutral && !IN_PROGRESS.has(neutral)
                ? "neutral"
                : "transition";
      const locks = [...state.locks.values()];
      const unobserved = state.unobserved.slice();
      // A body method that another script REPLACED (instead of assigning through the accessor) is no longer observed.
      for (const method of bodyMethods)
        if (
          Object.getOwnPropertyDescriptor(Response.prototype, method.name)
            ?.get !== method.get
        )
          unobserved.push(`Response.prototype.${method.name} displaced`);
      return {
        url: location.href,
        path: location.pathname,
        doc: state.doc,
        submits: state.submits.slice(),
        digests: state.digests,
        pending: locks
          .filter((l) => !l.held)
          .map((l) => l.name)
          .sort(),
        held: locks
          .filter((l) => l.held)
          .map((l) => l.name)
          .sort(),
        authTx: state.authTx,
        otherTx: Object.fromEntries(
          [...state.otherTx].filter(([, n]) => n > 0).sort(),
        ),
        fetches: [...state.fetches.values()].sort(),
        bodies: [...state.bodies.values()].sort(),
        cancels: [...state.cancels.values()].sort(),
        bodyReads: { ...state.bodyReads },
        unobserved,
        dom,
        neutral,
        seq: state.seq,
        seqAfter: state.seq,
        delayed: {
          digest: state.digestGate !== null,
          locks: state.lockGate !== null,
          retirement: state.failRetirement,
        },
        durable: null as Record<string, unknown> | null,
      };
    };

    w.__atlasAuthWork = {
      snapshot,
      async look(withDurable: boolean) {
        const work = snapshot();
        if (!withDurable) return work;
        work.durable = await readDurable();
        work.seqAfter = state.seq;
        return work;
      },
      delayDigest() {
        state.digestGate = new Promise<void>((resolve) => {
          state.releaseDigest = () => {
            state.digestGate = null;
            resolve();
          };
        });
      },
      releaseDigest() {
        state.releaseDigest();
      },
      delayLocks() {
        state.lockGate = new Promise<void>((resolve) => {
          state.releaseLocks = () => {
            state.lockGate = null;
            resolve();
          };
        });
      },
      releaseLocks() {
        state.releaseLocks();
      },
      failLeaseRetirement(on: boolean) {
        state.failRetirement = on;
        bump();
      },
    };

    // Submissions: capture on the way down, judge on the way back up (React's handler runs on its root, between the two).
    window.addEventListener(
      "submit",
      () => {
        state.dispatching = { admitted: false };
      },
      true,
    );
    window.addEventListener("submit", () => {
      const admitted = state.dispatching?.admitted ?? false;
      state.dispatching = null;
      state.submits.push({ t: performance.now(), admitted });
      bump();
    });

    const subtle = SubtleCrypto.prototype;
    const realDigest = subtle.digest;
    subtle.digest = function (
      this: SubtleCrypto,
      ...args: Parameters<SubtleCrypto["digest"]>
    ) {
      if (state.dispatching) state.dispatching.admitted = true;
      state.digests += 1;
      bump();
      const gate = state.digestGate;
      const run = gate
        ? gate.then(() => realDigest.apply(this, args))
        : realDigest.apply(this, args);
      const done = () => {
        state.digests -= 1;
        bump();
      };
      run.then(done, done);
      return run;
    } as SubtleCrypto["digest"];

    const manager = LockManager.prototype;
    const realRequest = manager.request as (
      ...args: unknown[]
    ) => Promise<unknown>;
    manager.request = function (this: LockManager, ...args: unknown[]) {
      const name = String(args[0]);
      if (!SESSION_LOCK.test(name)) return realRequest.apply(this, args);
      const id = ++ids;
      state.locks.set(id, { name, held: false });
      bump();
      const callback = args[args.length - 1] as (lock: Lock | null) => unknown;
      const wrapped = (lock: Lock | null) => {
        const entry = state.locks.get(id);
        if (entry && lock) entry.held = true;
        bump();
        return callback(lock);
      };
      const forward = () =>
        realRequest.apply(this, [...args.slice(0, -1), wrapped]);
      const gate = state.lockGate;
      const request = gate ? gate.then(forward) : forward();
      const done = () => {
        state.locks.delete(id);
        bump();
      };
      request.then(done, done);
      return request;
    } as LockManager["request"];

    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = realTransaction.apply(this, args);
      const auth = this.name === "atlas-auth";
      if (auth) state.connections.add(this);
      const name = this.name;
      const count = (delta: number) => {
        if (auth) state.authTx += delta;
        else state.otherTx.set(name, (state.otherTx.get(name) ?? 0) + delta);
        bump();
      };
      count(1);
      let open = true;
      const end = () => {
        if (!open) return;
        open = false;
        count(-1);
      };
      tx.addEventListener("complete", end);
      tx.addEventListener("abort", end);
      tx.addEventListener("error", () => bump());
      return tx;
    };

    // Qualification only (`failLeaseRetirement`): a put of `auth_state` that drops a request lease the record holds throws, so the
    // application's retirement aborts and retries on its back-off with the lease still in the record.
    const realPut = IDBObjectStore.prototype.put;
    const leasesOf = (value: unknown) =>
      Object.entries(
        ((value as { leases?: Record<string, { class: string }> } | null)
          ?.leases ?? {}) as Record<string, { class: string }>,
      )
        .filter(([, lease]) => lease.class !== "exposure")
        .map(([id]) => id);
    let lastLeases: string[] = [];
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (
        this.transaction.db.name === "atlas-auth" &&
        args[1] === "auth_state"
      ) {
        const next = leasesOf(args[0]);
        const dropped = lastLeases.some((id) => !next.includes(id));
        if (state.failRetirement && dropped) {
          bump();
          throw new DOMException(
            "qualification: lease retirement refused",
            "DataError",
          );
        }
        lastLeases = next;
      }
      return realPut.apply(this, args);
    };

    // ---- response bodies (revision 23) ----
    const origins = new WeakMap<object, string>();
    const streams = new WeakMap<object, string>();
    const originOf = (response: object) => {
      const known = origins.get(response);
      if (known) return known;
      const url = (response as Response).url;
      return url ? new URL(url).pathname.replace(API, "") : "synthetic";
    };
    const READS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"];
    for (const method of READS) {
      const native = (Response.prototype as unknown as Record<string, unknown>)[
        method
      ];
      if (typeof native !== "function") continue;
      const descriptor = Object.getOwnPropertyDescriptor(
        Response.prototype,
        method,
      );
      // `chain[0]` is the native method; a later assignment is pushed and runs INSIDE the observed call. A function that calls what it
      // read from the prototype (this accessor) reaches the next one down: each call on one Response moves one step towards native.
      const chain: Array<(...args: unknown[]) => unknown> = [
        native as (...args: unknown[]) => unknown,
      ];
      const depth = new WeakMap<object, number>();
      const outer = function (this: unknown, ...args: unknown[]) {
        const key = typeof this === "object" && this !== null ? this : null;
        const at = key ? depth.get(key) : undefined;
        if (key && at !== undefined) {
          const next = Math.max(0, at - 1);
          depth.set(key, next);
          return Reflect.apply(chain[next] as () => unknown, this, args);
        }
        const top = chain.length - 1;
        if (!key) return Reflect.apply(chain[top] as () => unknown, this, args);
        const id = ++ids;
        state.bodies.set(id, `${method} ${originOf(key)}`);
        depth.set(key, top);
        bump();
        const end = (outcome: "done" | "failed") => {
          if (!state.bodies.delete(id)) return;
          depth.delete(key);
          state.bodyReads[outcome] += 1;
          bump();
        };
        let result: unknown;
        try {
          result = Reflect.apply(chain[top] as () => unknown, this, args);
        } catch (error) {
          end("failed");
          throw error;
        }
        Promise.resolve(result).then(
          () => end("done"),
          () => end("failed"),
        );
        return result;
      };
      const get = () => outer;
      Object.defineProperty(Response.prototype, method, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get,
        set(value: (...args: unknown[]) => unknown) {
          chain.push(value);
          bump();
        },
      });
      bodyMethods.push({ name: method, get });
    }
    const realClone = Response.prototype.clone;
    Response.prototype.clone = function (this: Response) {
      const copy = realClone.call(this);
      origins.set(copy, `clone of ${originOf(this)}`);
      state.bodyReads.clones += 1;
      bump();
      return copy;
    };
    const bodyGetter = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "body",
    );
    if (bodyGetter?.get) {
      const realBody = bodyGetter.get;
      Object.defineProperty(Response.prototype, "body", {
        ...bodyGetter,
        get(this: Response) {
          const stream = realBody.call(this) as ReadableStream | null;
          if (stream) streams.set(stream, originOf(this));
          return stream;
        },
      });
    }
    const streamProto = ReadableStream.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const realCancel = streamProto.cancel as (...args: unknown[]) => unknown;
    streamProto.cancel = function (this: object, ...args: unknown[]) {
      const origin = streams.get(this);
      const result = Reflect.apply(realCancel, this, args);
      if (origin === undefined) return result;
      const id = ++ids;
      state.cancels.set(id, `cancel ${origin}`);
      bump();
      const end = () => {
        if (!state.cancels.delete(id)) return;
        state.bodyReads.cancelled += 1;
        bump();
      };
      Promise.resolve(result).then(end, end);
      return result;
    };
    for (const method of ["getReader", "pipeTo", "pipeThrough", "tee"]) {
      const real = streamProto[method];
      if (typeof real !== "function") continue;
      streamProto[method] = function (this: object, ...args: unknown[]) {
        const origin = streams.get(this);
        if (origin !== undefined) {
          state.unobserved.push(`${method} on the body of ${origin}`);
          bump();
        }
        return Reflect.apply(real, this, args);
      };
    }

    const realFetch = window.fetch;
    window.fetch = function (
      this: typeof window,
      ...args: Parameters<typeof fetch>
    ) {
      const input = args[0];
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href,
      );
      if (!url.pathname.startsWith(API) && url.pathname !== "/health")
        return realFetch.apply(this, args);
      const id = ++ids;
      const label = `${args[1]?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname.replace(API, "")}`;
      state.fetches.set(id, label);
      bump();
      const run = realFetch.apply(this, args);
      const done = () => {
        state.fetches.delete(id);
        bump();
      };
      run.then((response) => {
        origins.set(response, url.pathname.replace(API, ""));
        done();
      }, done);
      return run;
    } as typeof fetch;
  });
}

type WorkApi = {
  snapshot(): PageWork;
  look(withDurable: boolean): Promise<PageWork>;
  delayDigest(): void;
  releaseDigest(): void;
  delayLocks(): void;
  releaseLocks(): void;
  failLeaseRetirement(on: boolean): void;
};

/** An `about:blank` page (the fixture's unused `page`, a tab before its first navigation) runs no application and has no work. */
const BLANK: Omit<PageWork, "url"> = {
  path: "",
  doc: "blank",
  submits: [],
  digests: 0,
  pending: [],
  held: [],
  authTx: 0,
  otherTx: {},
  fetches: [],
  bodies: [],
  cancels: [],
  bodyReads: { done: 0, failed: 0, cancelled: 0, clones: 0 },
  unobserved: [],
  dom: "blank",
  neutral: null,
  seq: 0,
  seqAfter: 0,
  delayed: { digest: false, locks: false, retirement: false },
  durable: null,
};

/** The page's work; with `durable`, also the `atlas-auth` record's obligations, read through the page's own connection. */
export async function workOf(
  page: Page,
  options: { durable?: boolean } = {},
): Promise<PageWork> {
  const work = await page.evaluate(
    (withDurable) =>
      (
        window as unknown as { __atlasAuthWork?: WorkApi }
      ).__atlasAuthWork?.look(withDurable) ?? null,
    options.durable ?? false,
  );
  if (work) return work;
  const url = page.url();
  if (url === "about:blank") return { ...BLANK, url };
  throw new Error(`${url} has no authentication work observer`);
}

type Gate = "delayDigest" | "releaseDigest" | "delayLocks" | "releaseLocks";
const gate = (page: Page, name: Gate) =>
  page.evaluate(
    (method) =>
      (window as unknown as { __atlasAuthWork: WorkApi }).__atlasAuthWork[
        method
      ](),
    name,
  );
export const delayDigest = (page: Page) => gate(page, "delayDigest");
export const releaseDigest = (page: Page) => gate(page, "releaseDigest");
export const delayLocks = (page: Page) => gate(page, "delayLocks");
export const releaseLocks = (page: Page) => gate(page, "releaseLocks");
/** Qualification only: refuse (`true`) or allow again (`false`) every put that would retire a request lease in this page. */
export const failLeaseRetirement = (page: Page, on: boolean) =>
  page.evaluate(
    (value) =>
      (
        window as unknown as { __atlasAuthWork: WorkApi }
      ).__atlasAuthWork.failLeaseRetirement(value),
    on,
  );

/** One page's unexplained work, given the answers parked on purpose (an empty list means the page is quiet). */
export function busyReasons(
  work: PageWork,
  parkedFromPage: readonly Delivery[],
): string[] {
  const reasons: string[] = [];
  if (work.digests > 0) reasons.push(`${work.digests} challenge digest(s)`);
  if (work.pending.length) reasons.push(`pending ${work.pending.join(", ")}`);
  const parkedPaths = parkedFromPage.map((d) => `${d.method} ${d.path}`);
  // Revision 23 (invariant 6): a hold explains exactly one request; two parked answers of one request on one page cannot be told apart
  // from the page's fetches, so the boundary refuses instead of guessing.
  const ambiguous = parkedPaths.filter(
    (path, i) => parkedPaths.indexOf(path) !== i,
  );
  if (ambiguous.length)
    reasons.push(
      `ambiguous parked answers: ${[...new Set(ambiguous)].join(", ")}`,
    );
  const fetches = [...(work.fetches ?? [])];
  for (const path of parkedPaths) {
    const at = fetches.indexOf(path);
    if (at >= 0) fetches.splice(at, 1);
  }
  if (fetches.length) reasons.push(`fetching ${fetches.join(", ")}`);
  // A parked exchange keeps its attempt's owner lock: one per parked login-family request of this page.
  let explainedAttempts = parkedFromPage.filter((d) =>
    LOGIN_PATHS.includes(d.path),
  ).length;
  const held = work.held.filter((name) => {
    if (!BUSY_HELD.test(name)) return false;
    if (name.startsWith("atlas-attempt-") && explainedAttempts > 0) {
      explainedAttempts -= 1;
      return false;
    }
    return true;
  });
  if (held.length) reasons.push(`holding ${held.join(", ")}`);
  if (work.authTx > 0) reasons.push(`${work.authTx} auth transaction(s)`);
  const other = Object.entries(work.otherTx ?? {});
  if (other.length)
    reasons.push(
      `transactions on ${other.map(([db, n]) => `${db} (${n})`).join(", ")}`,
    );
  // A parked answer has no body yet, so no body read is ever explained by a hold.
  if (work.bodies?.length)
    reasons.push(`reading response bodies: ${work.bodies.join(", ")}`);
  if (work.cancels?.length)
    reasons.push(`cancelling response bodies: ${work.cancels.join(", ")}`);
  if (work.unobserved?.length)
    reasons.push(`unobserved body consumers: ${work.unobserved.join(", ")}`);
  if (work.seqAfter !== undefined && work.seqAfter !== work.seq)
    reasons.push("work changed while the sample was taken");
  if (work.dom === "transition")
    reasons.push(`in transition (${work.neutral ?? "no neutral state"})`);
  // A refused retirement holds no work by itself (the record does: `durableReasons`), so it is not a reason here.
  if (work.delayed.digest || work.delayed.locks)
    reasons.push("a qualification delay is still in force");
  return reasons;
}

/**
 * Revision 23 (C3): the durable obligations of the shared `atlas-auth` record that are not finished. An unretired request lease is
 * never explained by a hold (no current case parks a leased request; one that did would need an exact attribution this record does not
 * give, so the boundary refuses instead). The attempt is explained only by a parked login-family request.
 */
export function durableReasons(
  durable: DurableWork | null,
  parked: readonly Delivery[],
): string[] {
  if (durable === null) return ["no page could report the auth record"];
  if (!durable.readable)
    return [`the auth record could not be read (${durable.error})`];
  const reasons: string[] = [];
  const leases = Object.entries(durable.leases);
  if (leases.length)
    reasons.push(
      `unretired request leases: ${leases.map(([klass, n]) => `${klass} (${n})`).join(", ")}`,
    );
  if (
    durable.attempt !== null &&
    !parked.some((d) => LOGIN_PATHS.includes(d.path))
  )
    reasons.push(`an attempt is unresolved (${durable.attempt})`);
  return reasons;
}

export interface Settled {
  /** Each page's picture at the boundary, in the order given. */
  pages: PageWork[];
  /** The stub's ledger length at the boundary: later arrivals are measured against it. */
  arrivals: number;
  /** Revision 23 (C4, invariant 4): the delivery states and the cookie revision at the boundary, frozen for the UI collection. */
  states: DeliveryState[];
  cookieRevision: number;
  /** The delivered, cookie-changing activations at the boundary: the expected identity is the last of these. */
  activations: Array<Delivery & { account: string }>;
  durable: DurableWork | null;
}

/**
 * Every live page of the context must be in the inventory, be a declared instrument page with no application, or be blank (revision 23,
 * invariant 5): a page the caller did not name could be doing exactly the work the boundary claims is over.
 */
async function checkInventory(
  pages: readonly Page[],
  instruments: readonly Page[],
) {
  const context = pages[0]?.context();
  if (!context) throw new Error("settleAuth needs at least one page");
  for (const page of context.pages()) {
    if (page.isClosed() || pages.includes(page)) continue;
    const work = await workOf(page);
    if (
      instruments.includes(page) ? work.dom !== "no_app" : work.dom !== "blank"
    )
      throw new Error(
        `A live page of the context is not in the completion boundary's inventory: ${work.url} (${work.dom})`,
      );
  }
}

/** The current picture: per page work and reasons, the shared record's obligations, plus the stub's undelivered answers. */
export async function lookAt(
  stub: AuthStub,
  pages: readonly Page[],
  parked: readonly Hold[] = [],
) {
  // The record is shared by every document of the origin: it is read once, through the first application page (and, when that page
  // cannot read it, through the next one).
  const reader = pages.findIndex((page) => page.url() !== "about:blank");
  const works = await Promise.all(
    pages.map((page, index) => workOf(page, { durable: index === reader })),
  );
  let durable = works[reader]?.durable ?? null;
  for (const [index, page] of pages.entries()) {
    if (durable?.readable || index <= reader) continue;
    if (works[index]?.dom === "blank") continue;
    durable = (await workOf(page, { durable: true })).durable;
  }
  const parkedDeliveries = stub.deliveries.filter(
    (d) => d.state === "held" && d.hold !== null && parked.includes(d.hold),
  );
  const reasons = works.map((work, index) =>
    busyReasons(
      work,
      parkedDeliveries.filter((d) => d.page === pages[index]),
    ),
  );
  const shared = durableReasons(durable, parkedDeliveries);
  const undelivered = stub.undelivered(parked);
  return { works, reasons, shared, durable, undelivered };
}

/**
 * Waits for the finite completion boundary (invariants 1-3 of the design assessment): no page has unexplained work, the shared record
 * holds no unfinished obligation, every answer is terminal (or parked by a named hold), every live page is in the inventory, and two
 * consecutive looks see exactly the same picture (documents, record and work) with no new arrival between them. It never retries anything
 * and never accepts a timeout: past `timeout` it throws with the last picture.
 */
export async function settleAuth(
  stub: AuthStub,
  pages: readonly Page[],
  options: {
    parked?: readonly Hold[];
    /** Same-origin pages with no application that the test uses as instruments: their own work must be finished too. */
    instruments?: readonly Page[];
    timeout?: number;
  } = {},
): Promise<Settled> {
  const parked = options.parked ?? [];
  const instruments = options.instruments ?? [];
  const deadline = Date.now() + (options.timeout ?? 30_000);
  let previous: string | null = null;
  let last = "";
  for (;;) {
    await checkInventory(pages, instruments);
    const arrivals = stub.deliveries.length;
    const look = await lookAt(stub, pages, parked);
    const tools = await Promise.all(
      instruments.map(async (page) => busyReasons(await workOf(page), [])),
    );
    const quiet =
      look.reasons.every((r) => r.length === 0) &&
      tools.every((r) => r.length === 0) &&
      look.shared.length === 0 &&
      look.undelivered.length === 0 &&
      stub.deliveries.length === arrivals;
    const picture = JSON.stringify({
      arrivals,
      works: look.works.map(
        ({ url, doc, held, dom, neutral, seq, submits, bodyReads }) => ({
          url,
          doc,
          held,
          dom,
          neutral,
          seq,
          submits: submits.length,
          bodyReads,
        }),
      ),
      durable: look.durable,
      states: stub.deliveries.map((d) => d.state),
      cookie: stub.cookieHistory.length,
    });
    last = JSON.stringify(
      {
        reasons: look.reasons,
        instruments: tools,
        shared: look.shared,
        undelivered: look.undelivered.map(({ n, method, path, state }) => ({
          n,
          method,
          path,
          state,
        })),
        works: look.works,
        durable: look.durable,
        ledger: stub.deliveries.map(
          ({ n, method, path, state, status }) =>
            `${n} ${method} ${path} ${state}${status === null ? "" : ` ${status}`}`,
        ),
      },
      null,
      1,
    );
    if (quiet && picture === previous)
      return {
        pages: look.works,
        arrivals,
        states: stub.deliveries.map((d) => d.state),
        cookieRevision: stub.cookieHistory.length,
        activations: stub.deliveredActivations(),
        durable: look.durable,
      };
    previous = quiet ? picture : null;
    if (Date.now() > deadline)
      throw new Error(
        `The authentication work never reached its completion boundary within ${options.timeout ?? 30_000} ms: ${last}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Fails, with the ledger, when the oracle moved after a boundary while the UI was being collected: a login-family request arrived, an
 * answer that had arrived by the boundary changed state (revision 23: a delivery, not only a new arrival, can move it), or the cookie
 * changed.
 */
export function expectNoArrivalsSince(
  stub: AuthStub,
  boundary: Settled,
  paths: readonly string[],
) {
  const later = stub.deliveries
    .slice(boundary.arrivals)
    .filter((d) => d.method === "POST" && paths.includes(d.path));
  const changed = stub.deliveries
    .slice(0, boundary.arrivals)
    .filter((d, index) => d.state !== boundary.states[index]);
  const cookieMoved = stub.cookieHistory.length !== boundary.cookieRevision;
  if (later.length || changed.length || cookieMoved)
    throw new Error(
      `${later.length ? "An authentication request arrived" : changed.length ? "An answer changed state" : "The cookie changed"} after the completion boundary, so the expected identity moved while the UI was collected: ${JSON.stringify(
        {
          boundary: {
            arrivals: boundary.arrivals,
            cookie: boundary.cookieRevision,
          },
          ledger: stub.deliveries.map(({ n, method, path, state, status }) => ({
            n,
            method,
            path,
            state,
            status,
          })),
        },
      )}`,
    );
}

export type Offered = "submitted" | "refused_in_form" | "replaced";

/**
 * Fills and submits the sign-in form, if the page still offers it. The other tab's sign-in may REPLACE this form (matrix 3.7), possibly
 * between a fill and a click: that outcome is accepted only when it is PROVED (a Playwright time-out, the form gone, and no submission
 * of this page admitted since the offer began). Any other error, including a closed page, an unrelated selector or a time-out while the
 * form is still there, is rethrown.
 */
export async function offerSignIn(
  page: Page,
  username: string,
  password: string,
): Promise<Offered> {
  const before = (await workOf(page)).submits.length;
  try {
    await page.getByLabel("Username").fill(username, { timeout: 4000 });
    await page.getByLabel("Password").fill(password, { timeout: 4000 });
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .click({ timeout: 4000 });
  } catch (error) {
    return classifyOfferError(page, error, before);
  }
  const submits = (await workOf(page)).submits.slice(before);
  // A click whose press and release straddle the replacement reaches no button and submits nothing: that is a replacement too, but
  // only with the form gone. A click that submitted nothing while the form is still there is unexplained.
  if (submits.length === 0 && (await page.getByLabel("Username").count()) === 0)
    return "replaced";
  if (submits.length !== 1)
    throw new Error(
      `A click on "Sign in" dispatched ${submits.length} submissions while the form was still offered`,
    );
  return submits[0]?.admitted ? "submitted" : "refused_in_form";
}

/** The proof `offerSignIn` requires before it calls an error "the form was replaced"; exported for its qualification. */
export async function classifyOfferError(
  page: Page,
  error: unknown,
  submitsBefore: number,
): Promise<Offered> {
  if (!(error instanceof errors.TimeoutError)) throw error;
  if (page.isClosed()) throw error;
  const work = await workOf(page);
  if (work.submits.length > submitsBefore)
    return work.submits.slice(submitsBefore).some((s) => s.admitted)
      ? "submitted"
      : "refused_in_form";
  if ((await page.getByLabel("Username").count()) !== 0) throw error;
  return "replaced";
}

/** Every page of the context, for helpers that must look at all of them. */
export const pagesOf = (page: Page) =>
  page
    .context()
    .pages()
    .filter((p) => !p.isClosed());

/** One `atlas-auth` IndexedDB transaction as a page reported it: metadata only (stores, mode, whether a write was asked, how it ended). */
export interface AuthTransaction {
  doc: string;
  url: string;
  id: number;
  stores: string[];
  mode: string;
  writes: number;
  end: "complete" | "abort" | null;
}

/**
 * Revision 22 (C4, schedule S10): every `atlas-auth` transaction of every document of the context, reported through a binding as it
 * happens, so a transaction cut off by the document's departure is still on record (begun, never completed). No record contents.
 * Revision 23: the work observer's own labelled read-only look at the record is not the application's and is left out.
 */
export async function recordAuthTransactions(context: BrowserContext) {
  const log: AuthTransaction[] = [];
  await context.exposeBinding(
    "__atlasAuthTx",
    (
      _source,
      event: {
        doc: string;
        url: string;
        id: number;
        kind: "begin" | "write" | "complete" | "abort";
        stores?: string[];
        mode?: string;
      },
    ) => {
      if (event.kind === "begin") {
        log.push({
          doc: event.doc,
          url: event.url,
          id: event.id,
          stores: event.stores ?? [],
          mode: event.mode ?? "readonly",
          writes: 0,
          end: null,
        });
        return;
      }
      const tx = log.find((t) => t.doc === event.doc && t.id === event.id);
      if (!tx) return;
      if (event.kind === "write") tx.writes += 1;
      else tx.end ??= event.kind;
    },
  );
  await context.addInitScript(() => {
    if (typeof IDBDatabase === "undefined") return;
    const send = (window as unknown as { __atlasAuthTx?: (e: unknown) => void })
      .__atlasAuthTx;
    if (!send) return;
    const doc = Math.random().toString(36).slice(2, 10);
    let seq = 0;
    const ids = new WeakMap<IDBTransaction, number>();
    const realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = realTransaction.apply(this, args);
      if (this.name !== "atlas-auth") return tx;
      if (
        (window as unknown as { __atlasObserverTx?: boolean }).__atlasObserverTx
      )
        return tx;
      const id = ++seq;
      ids.set(tx, id);
      send({
        doc,
        url: location.href,
        id,
        kind: "begin",
        stores: Array.from(
          typeof args[0] === "string"
            ? [args[0]]
            : (args[0] as Iterable<string>),
        ),
        mode: args[1] ?? "readonly",
      });
      tx.addEventListener("complete", () =>
        send({ doc, url: location.href, id, kind: "complete" }),
      );
      tx.addEventListener("abort", () =>
        send({ doc, url: location.href, id, kind: "abort" }),
      );
      return tx;
    };
    for (const op of ["put", "add", "delete", "clear"] as const) {
      const real = IDBObjectStore.prototype[op] as (
        ...a: unknown[]
      ) => IDBRequest;
      (IDBObjectStore.prototype as unknown as Record<string, unknown>)[op] =
        function (this: IDBObjectStore, ...a: unknown[]) {
          const id = ids.get(this.transaction);
          if (id !== undefined)
            send({ doc, url: location.href, id, kind: "write" });
          return real.apply(this, a);
        };
    }
  });
  return log;
}
