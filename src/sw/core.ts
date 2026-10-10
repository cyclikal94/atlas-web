import { backendPaths } from "../lib/backend-routes";

/**
 * The service worker's DECISIONS, as pure functions (WEB-14a D-P1 to D-P3), so they are unit-tested and unit-mutated (the worker bundle
 * cannot be mutated in a real engine by the native runner). `src/sw.ts` only wires them to the platform.
 *
 * A GENERATION is one build's precache: a deterministic hash of its manifest. Each generation has its own cache
 * (`atlas-precache-<generation>`); the worker never deletes a generation that an open page still runs (WEB-04 8: live-generation
 * retention, no fixed cap), and never answers a backend path, a non-GET request or a cross-origin request.
 */
export interface PrecacheEntry {
  url: string;
  revision: string | null;
}

/** A manifest URL as a same-origin path: `index.html` and `/index.html` are `/index.html`. Queries and fragments are not part of it. */
export function pathOf(url: string): string {
  const bare = url.split(/[?#]/)[0] ?? "";
  return bare.startsWith("/") ? bare : `/${bare}`;
}

/** FNV-1a, 64-bit, as 16 hexadecimal digits. Not a security hash: a stable name for a manifest. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The generation of a manifest: the same files at the same revisions, in any order, are the same generation. */
export function generationOf(manifest: readonly PrecacheEntry[]): string {
  const lines = manifest
    .map((entry) => `${pathOf(entry.url)}\n${entry.revision ?? ""}`)
    .sort();
  return fnv1a64(lines.join("\n\n"));
}

const PRECACHE_PREFIX = "atlas-precache-";
export const precacheCacheName = (generation: string): string =>
  `${PRECACHE_PREFIX}${generation}`;
/** The generation a cache name belongs to, or null for any other cache. */
export const generationOfCache = (name: string): string | null =>
  name.startsWith(PRECACHE_PREFIX) && name.length > PRECACHE_PREFIX.length
    ? name.slice(PRECACHE_PREFIX.length)
    : null;

/** The shell every navigation is answered with. */
export const SHELL_PATH = "/index.html";

/** `/api`, `/health`, `/ready`, `/auth`, `/oidc` (and below them), matched as Workbox's `NavigationRoute` matches its denylist. */
export const isBackendPath = (url: URL): boolean => {
  const target = url.pathname + url.search;
  return backendPaths.some((pattern) => pattern.test(target));
};

export type FetchDecision =
  /** Not answered by the worker: the browser's own network path handles it. */
  | { kind: "pass" }
  /** A navigation answered with the active generation's shell. */
  | { kind: "shell" }
  /** A same-origin static file answered from the precache. */
  | { kind: "asset"; path: string };

export interface FetchInput {
  method: string;
  mode: string;
  url: URL;
  /** The worker's own origin. */
  origin: string;
  /** The paths of the worker's own generation. */
  ownPaths: ReadonlySet<string>;
}

/**
 * What the worker does with a request. A backend path, a non-GET request and a cross-origin request are ALWAYS passed, online or offline,
 * navigation or not, so the worker never answers the API, `/health`, `/ready`, `/auth` or the OIDC callback with the shell and never sends
 * them itself (Q10; the lifecycle constraint: the worker sends no stamped authenticated request). A navigation is answered with the shell
 * (an unvisited deep link included), except a navigation to one of the generation's own files, which is that file. Any other same-origin
 * GET is answered from the precache when it is one of the generation's files or under `/assets/` (a hashed file of a generation an open
 * page still runs); everything else is passed.
 */
export function decideFetch(input: FetchInput): FetchDecision {
  const { url } = input;
  if (input.method !== "GET") return { kind: "pass" };
  if (url.origin !== input.origin) return { kind: "pass" };
  if (isBackendPath(url)) return { kind: "pass" };
  const path = url.pathname;
  if (input.mode === "navigate")
    return input.ownPaths.has(path) && path !== SHELL_PATH
      ? { kind: "asset", path }
      : { kind: "shell" };
  if (input.ownPaths.has(path) || path.startsWith("/assets/"))
    return { kind: "asset", path };
  return { kind: "pass" };
}

export interface GenerationRecordView {
  generation: string;
  paths: readonly string[];
  installedAt: number;
}

/**
 * The generations whose files include a page's entry script, newest first. Usually one (the entry is hashed); a build that changed only an
 * unhashed file shares its entry with the one before, and the page is then counted as running both.
 */
export function generationsOfEntry(
  entry: string,
  records: readonly GenerationRecordView[],
): string[] {
  const path = pathOf(entry);
  return records
    .filter((record) => record.paths.includes(path))
    .sort((a, b) => b.installedAt - a.installedAt)
    .map((record) => record.generation);
}

/** Whether the active generation was installed after every generation the page runs (so another tab applied a newer version). */
export function activeIsNewer(
  active: string,
  pageGenerations: readonly string[],
  records: readonly GenerationRecordView[],
): boolean {
  if (pageGenerations.length === 0 || pageGenerations.includes(active))
    return false;
  const at = (generation: string) =>
    records.find((record) => record.generation === generation)?.installedAt;
  const activeAt = at(active);
  if (activeAt === undefined) return false;
  return pageGenerations.every((generation) => {
    const pageAt = at(generation);
    return pageAt !== undefined && activeAt > pageAt;
  });
}

/**
 * How long a generation that has stopped being active is kept whatever the reports say: a navigation answered by the old worker in the
 * instant another tab's activation happens creates its page just after the clients were listed, and the page's files must still be there
 * when it asks for them. Not a cap: after it, retention is decided by the reports alone.
 */
export const PURGE_GRACE_MS = 10_000;

export interface RetainedGeneration {
  generation: string;
  /** When it stopped being active (null: it has not: it is active, or installed and waiting). */
  retiredAt: number | null;
}
export interface ClientView {
  id: string;
  /** The generations its acknowledged report named; null when it has no acknowledged report. */
  reported: readonly string[] | null;
}

/**
 * Which generations to keep (WEB-04 8, adopted as designed; no fixed cap). The active generation is always kept, and so is any generation
 * that has not been retired or was retired less than `graceMs` ago. If ANY open window has no acknowledged report, nothing else can be
 * known about what it runs, so EVERY generation is kept; otherwise the generations the open windows reported are kept. The rest are purged.
 */
export function planRetention(input: {
  active: string;
  retained: readonly RetainedGeneration[];
  clients: readonly ClientView[];
  now: number;
  graceMs?: number;
}): { keep: string[]; purge: string[] } {
  const grace = input.graceMs ?? PURGE_GRACE_MS;
  const unknown = input.clients.some((client) => client.reported === null);
  const reported = new Set(
    input.clients.flatMap((client) => client.reported ?? []),
  );
  const keep: string[] = [];
  const purge: string[] = [];
  for (const { generation, retiredAt } of input.retained) {
    const kept =
      generation === input.active ||
      unknown ||
      reported.has(generation) ||
      retiredAt === null ||
      input.now - retiredAt < grace;
    (kept ? keep : purge).push(generation);
  }
  return { keep, purge };
}
