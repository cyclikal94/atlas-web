import {
  createWriteFailureMarkers,
  directoryKey,
  MARKER_PREFIX,
  parseMarkerKey,
  recordStop,
  retireStops,
  type SlotLocks,
  type StopScope,
  type WriteFailureMarkers,
  witnessStops,
} from "../../data/engine/write-failure-marker";

/**
 * FIXTURE ONLY (R55 and R58, revision 34). The durable-failure lab: the PRODUCTION markers (`createWriteFailureMarkers`) and stop helpers
 * (`recordStop`, `witnessStops`, `retireStops`) over this page's REAL `localStorage` and REAL Web Locks, with the two things the specs
 * need to control and the production composition does not offer:
 *
 * - `holdDelivery`: the lock IS requested and granted by the browser, and its handle is kept from the markers until `deliver()`. That is
 *   the review's schedule for R58 (an actual acquired lock whose delivery is held), without a stand-in for the lock itself.
 * - `onlySlot`: the page asks for ONE named slot lock and no other, so that two pages that take and let go of it in turn hand the same
 *   directory over to each other, which is the review's native schedule for R55 (it never lets two pages own a slot at once: a lock
 *   that is held elsewhere is refused, as always).
 * - `noLocks`: a page that cannot take a slot at all.
 *
 * Nothing here changes what the markers do; the lab is only a way to compose them. A passing run is fixture evidence for THIS ENGINE ON
 * THIS MACHINE.
 */
export interface LabOptions {
  /** The page part of the failures' names (random by default). */
  id?: string;
  onlySlot?: number;
  holdDelivery?: boolean;
  noLocks?: boolean;
}

interface Lab {
  markers: WriteFailureMarkers;
  requested: number;
  acquired: number;
  waiting: Array<() => void>;
  memory: Set<string>;
  seen: Map<string, ReturnType<typeof witnessStops>>;
}

const labs = new Map<string, Lab>();
const need = (name: string): Lab => {
  const lab = labs.get(name);
  if (!lab) throw new Error(`no lab ${name}`);
  return lab;
};
const memoryKey = (scope: StopScope, operation: string): string =>
  `${scope.account}\u0000${scope.incarnationId}\u0000${operation}`;

function realLocks(lab: () => Lab, options: LabOptions): SlotLocks | undefined {
  if (options.noLocks === true) return undefined;
  return {
    tryAcquire(name) {
      if (
        options.onlySlot !== undefined &&
        name !== `atlas-write-slot:${options.onlySlot}`
      )
        return Promise.resolve(null);
      lab().requested += 1;
      return new Promise((resolve) => {
        navigator.locks
          .request(name, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(null);
              return undefined;
            }
            lab().acquired += 1;
            return new Promise<void>((done) => {
              const handle = { release: () => done() };
              if (options.holdDelivery === true)
                lab().waiting.push(() => resolve(handle));
              else resolve(handle);
            });
          })
          .catch(() => resolve(null));
      });
    },
  };
}

const lab = {
  create(name: string, options: LabOptions = {}): void {
    if (labs.has(name)) throw new Error(`lab ${name} exists`);
    // A lab that names its slot needs that slot free: the page's own markers took one of the 32 at load (a random one), and 1 time in 32
    // it is the one named. They are let go of; the page's own markers publish through the lab from here on.
    if (options.onlySlot !== undefined) window.__atlasData?.markers.release();
    const holder: { current?: Lab } = {};
    const locks = realLocks(() => holder.current as Lab, options);
    const markers = createWriteFailureMarkers(undefined, undefined, {
      ...(options.id === undefined ? {} : { id: () => options.id as string }),
      locks: locks ?? null,
      slotStart: () => options.onlySlot ?? Math.floor(Math.random() * 32),
    });
    holder.current = {
      markers,
      requested: 0,
      acquired: 0,
      waiting: [],
      memory: new Set(),
      seen: new Map(),
    };
    labs.set(name, holder.current);
  },
  destroy(name: string): void {
    const lab = labs.get(name);
    lab?.markers.release();
    for (const resolve of lab?.waiting.splice(0) ?? []) resolve();
    labs.delete(name);
  },
  /** The markers' own `set`: `alive` false is a callback that outlived its service. */
  set(name: string, scope: StopScope, operation: string, alive = true): string {
    return need(name).markers.set(scope, operation, () => alive).state;
  },
  /** The production `recordStop`, with the page's memory recorded in the lab. */
  recordStop(
    name: string,
    scope: StopScope,
    operation: string,
    alive = true,
  ): string {
    const l = need(name);
    return recordStop(l.markers, scope, operation, () => alive, {
      hold: () => {
        l.memory.add(memoryKey(scope, operation));
      },
    });
  },
  memoryHeld(name: string, scope: StopScope, operation: string): boolean {
    return need(name).memory.has(memoryKey(scope, operation));
  },
  /** The production `witnessStops` for one operation; answers the kind of marker it named. */
  witness(name: string, scope: StopScope, operation: string): string {
    const l = need(name);
    const witness = witnessStops(l.markers, l.markers.stops, scope, [
      operation,
    ]);
    l.seen.set(memoryKey(scope, operation), witness);
    return witness.stood.get(operation)?.marker.kind ?? "none";
  },
  /** The production `retireStops` over the witness taken by the last `witness` call for the operation. */
  retire(name: string, scope: StopScope, operation: string): string[] {
    const l = need(name);
    const witness = l.seen.get(memoryKey(scope, operation));
    if (!witness) throw new Error("no witness");
    return retireStops(l.markers, l.markers.stops, witness);
  },
  probe(name: string, scope: StopScope, operation: string): string {
    return need(name).markers.probe(scope, operation);
  },
  inspect(
    name: string,
    scope: StopScope,
  ): { operations: string[]; known: boolean } {
    return need(name).markers.inspect(scope);
  },
  prepare(name: string): Promise<boolean> {
    return need(name).markers.prepare();
  },
  release(name: string): void {
    need(name).markers.release();
  },
  /** Delivers the handles of the locks that were held back (the lock was granted earlier; this is when the markers learn of it). */
  deliver(name: string): number {
    const l = need(name);
    const waiting = l.waiting.splice(0);
    for (const resolve of waiting) resolve();
    return waiting.length;
  },
  counts(name: string): { requested: number; acquired: number; held: number } {
    const l = need(name);
    return {
      requested: l.requested,
      acquired: l.acquired,
      held: l.waiting.length,
    };
  },
  /** The raw keys of the scope's failures and directories, read without the markers (the oracle). */
  raw(scope: StopScope): { failures: string[]; directories: string[] } {
    const failures: string[] = [];
    const directories: string[] = [];
    for (let n = 0; n < localStorage.length; n += 1) {
      const key = localStorage.key(n);
      if (key === null) continue;
      const parsed = key.startsWith(MARKER_PREFIX) ? parseMarkerKey(key) : null;
      if (
        parsed !== null &&
        parsed.account === scope.account &&
        parsed.incarnationId === scope.incarnationId
      )
        failures.push(`${parsed.operation}#${parsed.instance}`);
    }
    for (let slot = 0; slot < 32; slot += 1) {
      const text = localStorage.getItem(directoryKey(scope, slot));
      if (text !== null) directories.push(`${slot}:${text}`);
    }
    return { failures: failures.sort(), directories };
  },
  clear(): void {
    localStorage.clear();
  },
};

export type DurableLab = typeof lab;
declare global {
  interface Window {
    __atlasDurableLab?: DurableLab;
  }
}
window.__atlasDurableLab = lab;
