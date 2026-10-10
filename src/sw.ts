/// <reference lib="webworker" />
import { NavigationRoute, Route, registerRoute } from "workbox-routing";
import { backendPaths } from "./lib/backend-routes";
import { parseToWorker } from "./lib/pwa/protocol";
import {
  decideFetch,
  generationOf,
  generationOfCache,
  pathOf,
  precacheCacheName,
  SHELL_PATH,
} from "./sw/core";
import {
  handleReport,
  type LifecycleDeps,
  onActivated,
  recordInstalled,
  retentionPass,
} from "./sw/lifecycle";
import { createSwState } from "./sw/state";

/**
 * The service worker (WEB-14a; WEB-03 3.7 and 3.7a, Q10, WEB-04 8). It serves the precached app shell and the generation's static files,
 * and nothing else: it holds no account data, makes no API request (it never calls `fetch`; lint rule R1), and never answers a backend
 * path, a non-GET or a cross-origin request, so the browser's own network path handles those. Its only requests are `Cache.addAll` of
 * its own static manifest at installation (and `Cache.add` of one of those files if its cache entry was lost).
 *
 * It never calls `skipWaiting()` on its own (only when the tab whose person accepted the update says so) and never `clients.claim()`
 * (WEB-07 F11 / WEB-08a F-12): a first installation controls pages from their next navigation, and a later one changes every controlled
 * page's controller through the activation algorithm, which is how the other tabs learn that the app was updated elsewhere.
 */
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const manifest = self.__WB_MANIFEST;
const generation = generationOf(manifest);
const cacheName = precacheCacheName(generation);
const ownPaths = new Set(manifest.map((entry) => pathOf(entry.url)));
const state = createSwState(self.caches, self.location.origin);
const deps: LifecycleDeps = {
  own: { generation, paths: [...ownPaths] },
  state,
  caches: {
    keys: () => self.caches.keys(),
    delete: (name) => self.caches.delete(name),
  },
  windows: () =>
    self.clients.matchAll({ type: "window", includeUncontrolled: true }),
  now: () => Date.now(),
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(cacheName);
      // `reload`: the files come from the server, never from the HTTP cache, so the generation is exactly what its manifest names.
      // One request per path: `addAll` rejects a list that names a file twice (the plugin lists the manifest's icons again).
      await cache.addAll(
        [...ownPaths].map((path) => new Request(path, { cache: "reload" })),
      );
      await recordInstalled(deps);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(onActivated(deps));
});

self.addEventListener("message", (event) => {
  const message = parseToWorker(event.data);
  if (!message) return;
  if (message.type === "atlas:skip-waiting") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  const port = event.ports[0];
  const source = event.source as Client | null;
  if (!port || !source) return;
  event.waitUntil(
    (async () => {
      // The record is written before the answer (`handleReport`), so an acknowledged page is a retained one.
      const ack = await handleReport(
        deps,
        source.id,
        message.entry,
        message.nonce,
      );
      port.postMessage(ack);
      await retentionPass(deps);
    })(),
  );
});

/** This generation's copy of `path`; if the entry was lost, it is fetched into the cache again (`Cache.add`), or the request fails. */
async function fromOwnCache(path: string): Promise<Response> {
  const cache = await self.caches.open(cacheName);
  const cached = await cache.match(path);
  if (cached) return cached;
  try {
    await cache.add(new Request(path, { cache: "reload" }));
  } catch {
    return Response.error();
  }
  return (await cache.match(path)) ?? Response.error();
}

/** A static file: this generation's copy first, then the newest other retained generation that has it (an older open page's file). */
async function asset(path: string): Promise<Response> {
  const own = await (await self.caches.open(cacheName)).match(path);
  if (own) return own;
  const records = await state.generations();
  const installed = (generationName: string) =>
    records.find((record) => record.generation === generationName)
      ?.installedAt ?? 0;
  const others = (await self.caches.keys())
    .map((name) => ({ name, generation: generationOfCache(name) }))
    .filter(
      (entry): entry is { name: string; generation: string } =>
        entry.generation !== null && entry.generation !== generation,
    )
    .sort((a, b) => installed(b.generation) - installed(a.generation));
  for (const other of others) {
    const found = await (await self.caches.open(other.name)).match(path);
    if (found) return found;
  }
  return fromOwnCache(path);
}

// Q10: Workbox's NavigationRoute over the precached shell, with every backend path (the OIDC callback included) denied.
registerRoute(
  new NavigationRoute(
    async ({ url }) => {
      const decision = decideFetch({
        method: "GET",
        mode: "navigate",
        url,
        origin: self.location.origin,
        ownPaths,
      });
      return decision.kind === "asset"
        ? fromOwnCache(decision.path)
        : fromOwnCache(SHELL_PATH);
    },
    {
      denylist: backendPaths,
    },
  ),
);

// Every other same-origin GET of a generation's static file.
registerRoute(
  new Route(
    ({ request, url }) =>
      request.mode !== "navigate" &&
      decideFetch({
        method: request.method,
        mode: request.mode,
        url,
        origin: self.location.origin,
        ownPaths,
      }).kind === "asset",
    async ({ url }) => asset(url.pathname),
  ),
);
