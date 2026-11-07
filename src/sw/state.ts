import type { GenerationRecordView } from "./core";

/**
 * The service worker's own records (WEB-14a D-P3), kept in Cache Storage under `atlas-sw-state`, where every version of the worker can
 * read them (a worker's memory ends whenever the browser stops it). One entry per generation, written once at installation, and one entry
 * per window client (`/__atlas-sw/client/<id>`): a report replaces only its own client's entry, so two workers handling reports at once
 * never read, modify and write a shared record. A report is acknowledged only after its entry has been written (`recordReport`).
 * Nothing here is account data.
 */
export const STATE_CACHE = "atlas-sw-state";
const GENERATION = "/__atlas-sw/generation/";
const CLIENT = "/__atlas-sw/client/";

export interface GenerationRecord extends GenerationRecordView {
  /** When another generation became active instead (null while it is active or waiting). */
  retiredAt: number | null;
}
export interface ClientRecord {
  generations: string[];
  reportedAt: number;
}

/** The parts of `CacheStorage` and `Cache` used here (a test supplies a double). */
export interface CacheLike {
  put(request: string, response: Response): Promise<void>;
  match(request: string): Promise<Response | undefined>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

const pathOfKey = (url: string, origin: string): string =>
  url.startsWith(origin) ? url.slice(origin.length) : new URL(url).pathname;

export interface SwState {
  putGeneration(record: GenerationRecord): Promise<void>;
  generations(): Promise<GenerationRecord[]>;
  /** Marks every generation but `active` that is not yet retired as retired at `now`. */
  retireAllBut(active: string, now: number): Promise<void>;
  deleteGeneration(generation: string): Promise<void>;
  /** Writes the client's entry; resolves only once it is written. */
  recordReport(clientId: string, record: ClientRecord): Promise<void>;
  clients(): Promise<Map<string, ClientRecord>>;
  deleteClient(clientId: string): Promise<void>;
}

export function createSwState(caches: CachesLike, origin: string): SwState {
  const open = () => caches.open(STATE_CACHE);
  const url = (path: string) => `${origin}${path}`;
  const readAll = async <T>(prefix: string): Promise<Map<string, T>> => {
    const cache = await open();
    const found = new Map<string, T>();
    for (const request of await cache.keys()) {
      const path = pathOfKey(request.url, origin);
      if (!path.startsWith(prefix)) continue;
      const response = await cache.match(request.url);
      if (!response) continue;
      try {
        found.set(
          decodeURIComponent(path.slice(prefix.length)),
          (await response.json()) as T,
        );
      } catch {
        // A damaged entry is not a record: it is ignored (and its client counts as unacknowledged, which keeps everything).
      }
    }
    return found;
  };
  return {
    async putGeneration(record) {
      await (await open()).put(
        url(`${GENERATION}${encodeURIComponent(record.generation)}`),
        json(record),
      );
    },
    async generations() {
      return [...(await readAll<GenerationRecord>(GENERATION)).values()];
    },
    async retireAllBut(active, now) {
      for (const record of await this.generations())
        if (record.generation !== active && record.retiredAt === null)
          await this.putGeneration({ ...record, retiredAt: now });
    },
    async deleteGeneration(generation) {
      await (await open()).delete(
        url(`${GENERATION}${encodeURIComponent(generation)}`),
      );
    },
    async recordReport(clientId, record) {
      await (await open()).put(
        url(`${CLIENT}${encodeURIComponent(clientId)}`),
        json(record),
      );
    },
    clients: () => readAll<ClientRecord>(CLIENT),
    async deleteClient(clientId) {
      await (await open()).delete(
        url(`${CLIENT}${encodeURIComponent(clientId)}`),
      );
    },
  };
}
