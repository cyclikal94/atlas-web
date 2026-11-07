import { test as guarded } from "./auth-helpers";

export { expect } from "./auth-helpers";

/**
 * The test topology of every spec whose authentication is the INTERCEPTED double `AuthStub` (tests/e2e/auth-stub.ts), which answers
 * `/api/experimental/v1/**` with a `BrowserContext.route` and nothing else: there is no server behind it (the preview's stub backend
 * answers only health/ready and 404s the rest).
 *
 * HARNESS ADAPTATION, labelled (WEB-14a revision 19, Kieran, 15 October 2026; extended to every AuthStub suite in revision 34 for R37):
 * the production build registers the app's service worker, and once a document is controlled Playwright WebKit does not apply
 * `context.route` to the requests the worker passes on. The first page is never controlled, but a peer page, a navigation or a reload can
 * be, and its `/me`, `/sessions` or `activate/cancel` then reached the preview's 404 instead of the stub (R37: E-L2's peer switch and the
 * ACTIVATING reload in WebKit). Those specs test the authentication and lifecycle surfaces, not the worker, so they run with service
 * worker registration BLOCKED for the whole context, before the first navigation: blocking prevents control, where a later `unregister()`
 * would not. Playwright 1.63 applies the same option to a context a test creates with `browser.newContext()` unless that call overrides
 * it. The worker itself stays covered with registration allowed: production.pwa.spec.ts, production.offline.spec.ts (which imports
 * auth-helpers' worker-neutral `test` directly), the PWA fixtures and the released-backend I-U2.
 */
export const INTERCEPTED_AUTH_SERVICE_WORKERS = "block";

/** Refuses any other worker setting for a spec on this fixture, before its scenario runs, instead of a misleading UI timeout later. */
export function requireInterceptedAuthTopology(serviceWorkers: string): void {
  if (serviceWorkers !== INTERCEPTED_AUTH_SERVICE_WORKERS)
    throw new Error(
      `this spec answers its API with the intercepted AuthStub (context.route), so service workers must be "${INTERCEPTED_AUTH_SERVICE_WORKERS}"; got "${serviceWorkers}". A worker-controlled page's API requests bypass the route. Test the worker itself with auth-helpers' test and a real server.`,
    );
}

export const test = guarded.extend<{ interceptedAuth: undefined }>({
  serviceWorkers: INTERCEPTED_AUTH_SERVICE_WORKERS,
  interceptedAuth: [
    async ({ serviceWorkers }, use) => {
      requireInterceptedAuthTopology(serviceWorkers);
      await use(undefined);
    },
    { auto: true },
  ],
});
