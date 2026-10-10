# Hosting and routing

Atlas Web is a static client. It is developed, built, versioned and deployed **independently of the backend** (Q5), and the two
are served behind **one public origin** (Q6). This page states the routing rule, what the frontend container does, what the
reverse proxy or Ingress must do, and how each is tested. It replaces the discovery-era idea of an `atlas-server` static-fallback
route and of bundling the client into backend archives or images. Both are out of scope.

## The one rule

One public origin, for example `https://atlas.example.org`, is fronted by a reverse proxy or a Kubernetes Ingress:

| Path (case-sensitive, prefix match on a path element) | Goes to |
| --- | --- |
| `/api`, `/health`, `/ready`, `/auth`, `/oidc` (and anything beneath them) | the **backend** |
| everything else | the **frontend** (`atlas-web`) |

The list of backend prefixes lives **once**, in `src/lib/backend-routes.ts`. The development and preview proxy, the service
worker's navigation denylist, the frontend container's nginx config, the reference proxy's nginx config and the Helm Ingress are all
checked against it by `scripts/check-route-parity.mjs` (`pnpm check:route-parity`), which fails the build if any of them drifts.

Two facts about the list:

- At the pinned backend release (`v0.27.0-rc.1`) the backend registers `/health`, `/ready` and everything under
  `/api/experimental/v1/`. It has **no** top-level `/auth` or `/oidc` route; the OIDC callback is
  `/api/experimental/v1/oidc/callback`. `/auth` and `/oidc` are defensive reservations, kept because Q10 names authentication
  callback paths and the offline shell must never answer them.
- `/_web/*` is reserved for the frontend (its own health probe and its provenance), so the backend's `/health` is never shadowed.
- Two **frontend** routes matter to the sign-in journeys (WEB-08b), and both are plain client routes that every arrangement serves the shell for:
  `/join` (an invitation link is `https://<origin>/join#t=<64 hex>`: the token is in the fragment, which no proxy or server ever sees) and the
  **origin root** `/`, where the backend's OIDC callback redirects with `#atlas_grant=…&atlas_attempt=…&atlas_account=…`. Do not rewrite, strip or
  cache either response, and do not log full URLs of the browser: the fragment never reaches a server, but a browser extension, a screenshot or a
  history entry can see it, which is why the client strips it before it does anything else.

Client routes must not contain a dot: any other path with a file extension is treated as a file request (404 when absent, never
the shell). Prefix matching is by path element, so `/apiary` is a client route and `/api/x` is a backend path. Matching is
case-sensitive everywhere, so `/API/x` is a client route. nginx merges repeated slashes before matching, so `//api/x` reaches the
backend when proxied and is a 404 when it reaches the frontend container directly.

## What the proxy or Ingress must do

The session cookie is `__Host-atlas_session` (over HTTPS): host-only, `Path=/`, no `Domain`. CSRF uses the `X-CSRF-Token` header and
an `Origin` check. So the proxy or Ingress **must**:

- forward `Host` (and `X-Forwarded-*`) to both upstreams;
- terminate TLS so that both services see the same public origin;
- **not** add, rewrite or strip `Set-Cookie`, `Path`, `Domain`, `X-CSRF-Token`, `Origin` or `Host`. Adding a `Domain` attribute
  makes the browser discard the `__Host-` cookie.

The backend's `ATLAS_PUBLIC_ORIGIN` must equal the public origin exactly (scheme, host and port). Over plain loopback HTTP the cookie is
`atlas_session` (no `__Host-` prefix), which is how the local checks in this repository run.

## The frontend container

`deploy/nginx/web.conf` (with `deploy/nginx/security-headers.conf`) is the whole server configuration. It has no variables, so
the image runs unprivileged, as UID 101, on port 8080, with a **read-only root filesystem** and a writable `/tmp` only.

- Files are served from `/srv/atlas-web`, which holds exactly the built `dist/`.
- Backend paths return an explicit **404** with a plain-text explanation, so a mis-routed API call fails visibly instead of receiving HTML.
- Paths beneath `/assets/` and any path with a file extension return **404 when absent** (never the shell).
- Every other path falls back to `index.html`, so deep links and reloads work.
- `index.html`, `sw.js`, `theme-init.js`, `noscript.css`, `favicon.svg` and `/_web/*` are `Cache-Control: no-cache`; hashed `/assets/*` are
  `public, max-age=31536000, immutable`; dotfiles are denied; only `GET` and `HEAD` are allowed.
- `GET /_web/health` returns `200 ok`; `GET /_web/provenance.json` returns the release provenance.
- Every response carries the security headers below.

### Security headers and the content security policy

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self';
  manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
Cross-Origin-Opener-Policy: same-origin
```

The policy is strict on purpose. There is no `unsafe-inline` and no external source. If a component breaks it, fix the component.
This is not hypothetical: Radix's modal dialog locks scrolling by injecting a `<style>` element, which `style-src 'self'` refuses. The shared
`Dialog` therefore uses Radix in non-modal mode and supplies modality itself (`src/components/ui/modal-background.ts`): the page behind
becomes `inert` and `aria-hidden`, and scrolling stops through a CSSOM write, which the policy allows. Fonts are self-hosted and the
pre-paint theme script is an external file, for the same reason.

Tests: the browser suite runs every fixture page, dialog and tooltip under this exact policy read from
`deploy/nginx/security-headers.conf` (`tests/e2e/fixture.csp.spec.ts`, `production.csp.spec.ts`) and any violation fails the run; the
image smoke test (`scripts/smoke-image.sh`) then repeats the production suite against the real container.

## A reverse proxy example

`deploy/nginx/proxy.conf.template` is the reference proxy, used by `deploy/compose.yaml`. It routes by the same list, passes the request path
through unchanged (`proxy_pass` with no URI part), turns redirect rewriting off, forwards `Host`, and contains no `proxy_cookie_*`
directive. `client_max_body_size` comes from `ATLAS_PROXY_MAX_BODY` (default `8m`; WEB-13 confirms the figure for 1 MiB calendar imports).
It listens on plain HTTP and is for loopback use. Terminate TLS in front of it for anything reachable from a network.

Any reverse proxy works if it follows the rule above. Traefik, Caddy and cloud load balancers all support path-prefix routing
and host forwarding; only the nginx and Kubernetes forms are tested here.

## Kubernetes

`charts/atlas-web` (follow-up decision 2: the chart lives in this repository) deploys the frontend only: a Deployment (non-root, read-only
root filesystem, all capabilities dropped, probes on `/_web/health`), a Service and an optional Ingress that implements the rule above against a backend Service
you name:

```sh
helm upgrade --install atlas-web charts/atlas-web \
  --set image.repository=YOUR_REGISTRY/atlas-web --set image.tag=YOUR_TAG \
  --set ingress.enabled=true --set ingress.host=atlas.example.org \
  --set ingress.backend.serviceName=atlas --set ingress.backend.servicePort=3000
```

There is no default image repository. The chart never guesses one. The Ingress controller must forward `Host` and must not add, rewrite or strip
`Set-Cookie`, `X-CSRF-Token` or `Origin`. Set the backend's `ATLAS_PUBLIC_ORIGIN` to the Ingress origin.

## Running the two side by side without a proxy

Not supported. The browser must see one origin, because the cookie is host-only and the CSRF check compares `Origin`. For local
development `pnpm dev` proxies the backend paths to `ATLAS_BACKEND_URL` (default `http://127.0.0.1:3000`, the backend's documented bind).
