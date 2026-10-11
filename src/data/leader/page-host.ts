import type { Store } from "../../session";
import type { DataRuntime } from "../engine/account-service";
import type { RecoveryJob } from "../engine/recovery-job";
import type { SyncChannel } from "../engine/sync-channel";
import type { SyncEngine } from "../engine/sync-engine";
import {
  createWriteFailureMarkers,
  type WriteFailureMarkers,
} from "../engine/write-failure-marker";
import type { Outbox } from "../outbox/outbox";
import {
  type CommandRegistry,
  type ConflictHandlerRegistry,
  createCommandRegistry,
  createConflictHandlerRegistry,
} from "../outbox/registries";

/**
 * What every writer and every screen of ONE PAGE shares (P-4). No Dexie and no engine here: the page's protected tree and its leader
 * (which lives at session level, outside the tree, P-3) both read it.
 *
 *  - `markers`: the page's ONE write-failure markers object (R46: a memory-only stop is one stop for every writer of the page). Its
 *    directory slot is LEASED: every controller that runs takes a lease (`prepare`) and gives it back (`release`), and the slot goes only
 *    when the last lease does, so a protected tree that unmounts under a fence does not take the leader's slot with it;
 *  - `commands`, `conflicts`: the registries feature slices register into ONCE, for both the leader's dispatcher and the screens;
 *  - `leader`: what this page's leadership is, for the status model (the provider attaches it);
 *  - `runtime`: the page's data runtime when a production leader composed one: the provider then uses it instead of building its own,
 *    so the tree's disposal never closes the leader's connections (one runtime per page, never disposed while the page lives).
 */
export type LeaderAttachment =
  | {
      role: "leader";
      engine: SyncEngine;
      outbox: Outbox | null;
      recovery: RecoveryJob;
    }
  | { role: "follower" }
  | { role: "none" };

export interface PageRuntime {
  readonly runtime: DataRuntime;
  readonly channel: SyncChannel;
}

export interface PageDataHost {
  readonly markers: WriteFailureMarkers;
  readonly commands: CommandRegistry;
  readonly conflicts: ConflictHandlerRegistry;
  readonly leader: Store<LeaderAttachment>;
  setLeader(next: LeaderAttachment): void;
  readonly runtime: Store<PageRuntime | null>;
  setRuntime(next: PageRuntime | null): void;
}

class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * The markers with a leased directory slot: `prepare` takes a lease (the first takes the slot), `release` gives one back (the last lets
 * the slot go). Everything else is the markers' own, and the page's memory of stops (`stops`) is the same object for every user.
 */
export function leasedMarkers(
  markers: WriteFailureMarkers,
): WriteFailureMarkers {
  let leases = 0;
  return {
    set: (scope, operation, live) => markers.set(scope, operation, live),
    clear: (scope, operation) => markers.clear(scope, operation),
    witness: (scope, operation) => markers.witness(scope, operation),
    retire: (scope, operation, seen, options) =>
      markers.retire(scope, operation, seen, options),
    has: (scope, operation) => markers.has(scope, operation),
    probe: (scope, operation) => markers.probe(scope, operation),
    operations: (scope) => markers.operations(scope),
    inspect: (scope) => markers.inspect(scope),
    clearAccount: (account) => markers.clearAccount(account),
    get stops() {
      return markers.stops;
    },
    prepare: () => {
      leases += 1;
      return markers.prepare();
    },
    release: () => {
      if (leases === 0) return;
      leases -= 1;
      if (leases === 0) markers.release();
    },
    subscribe: (listener) => markers.subscribe(listener),
  };
}

export function createPageDataHost(
  markers: WriteFailureMarkers = createWriteFailureMarkers(),
): PageDataHost {
  const leader = new Cell<LeaderAttachment>({ role: "none" });
  const runtime = new Cell<PageRuntime | null>(null);
  return {
    markers: leasedMarkers(markers),
    commands: createCommandRegistry(),
    conflicts: createConflictHandlerRegistry(),
    leader,
    setLeader: (next) => leader.set(next),
    runtime,
    setRuntime: (next) => runtime.set(next),
  };
}

let page: PageDataHost | null = null;
/** The page's host (memoised, built on first use). */
export function getPageDataHost(): PageDataHost {
  page ??= createPageDataHost();
  return page;
}
/** Tests only: a fresh host for the next scenario. */
export function resetPageDataHost(next: PageDataHost | null = null): void {
  page = next;
}
