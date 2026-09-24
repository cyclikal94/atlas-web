/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { backendPaths } from "./lib/backend-routes";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: backendPaths,
  }),
);
clientsClaim();
// WEB-14a owns activation/update UX and registration. No account data is cached here.
