#!/usr/bin/env node
// C3 / C4. Checks a REAL Atlas backend reached through the public origin (a reverse proxy or the Vite preview proxy) and,
// when --direct is given, compares every proxied answer with the same request sent straight to the backend. Layer C evidence
// only when the origin is the reference proxy (nginx) and the backend is a released artefact; the report says which was used.
//
// It follows the released contract (the version in contract-pin.json): POST /browser-sessions returns a one-time grant and sets no cookie;
// POST /browser-sessions/activate is the only response that sets the session cookie and returns the CSRF token.
//
//   node scripts/smoke-backend.mjs --origin http://127.0.0.1:8090 --direct http://127.0.0.1:3100 \
//        --user alice --password-env ATLAS_SMOKE_PASSWORD --label "reference proxy + container image" --out .agtx/evidence/WEB-07/C3
//
// The password is read from an environment variable and is never printed or written.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const origin = option("origin");
const direct = option("direct");
const user = option("user", "alice");
const password = process.env[option("password-env", "ATLAS_SMOKE_PASSWORD")];
const label = option("label", "unlabelled");
// nginx answers a missing /assets file with 404. The Vite preview server falls back to the shell for it, so this is asserted only
// when the origin is a real static-file server configuration (the reference proxy), never for a preview server.
const strictAssets = args.includes("--strict-assets");
const outDir = option("out", ".agtx/evidence/WEB-07/C3");
if (!origin || !password) {
  console.error(
    "usage: smoke-backend.mjs --origin <public origin> [--direct <backend url>] [--user alice] [--password-env VAR] [--label text] [--out dir]",
  );
  process.exit(2);
}

const failures = [];
const passes = [];
const check = (name, condition, detail = "") => {
  (condition ? passes : failures).push(
    condition ? name : `${name}${detail ? ` (${detail})` : ""}`,
  );
  return condition;
};

/** Sends a request. `base` is the origin (proxied) or the direct backend; the Origin header is always the public origin. */
async function send(base, method, path, { headers = {}, body, cookie } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    setCookie: response.headers.getSetCookie(),
    text,
    json,
  };
}

const VOLATILE =
  /^(date|server|connection|keep-alive|transfer-encoding|x-request-id|content-length|vary)$/i;
const shape = (response) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  headerNames: [...response.headers.keys()]
    .filter((name) => !VOLATILE.test(name))
    .sort(),
  setCookieCount: response.setCookie.length,
});
/** Replaces values that differ between two runs of the same request (ids, tokens, times) so bodies can be compared. */
const normalise = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null)
      .replace(/[0-9a-f]{64}/g, "<hex64>")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<uuid>",
      )
      .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "<time>"),
  );
const cookieShape = (setCookie) => {
  const [pair, ...attributes] = setCookie.split(/;\s*/);
  const [name] = pair.split("=");
  return {
    name,
    attributes: attributes
      .map((a) =>
        a.replace(/=.*/, (m) => (/^(path|samesite|domain)/i.test(a) ? m : "")),
      )
      .sort(),
  };
};

const report = {
  label,
  origin,
  direct: direct ?? null,
  at: new Date().toISOString(),
  checks: {},
  notes: [],
};
const publicOrigin = new URL(origin).origin;

async function pair(name, method, path, options = {}) {
  const proxied = await send(origin, method, path, options);
  const record = {
    proxied: {
      ...shape(proxied),
      body: proxied.json ? normalise(proxied.json) : proxied.text.slice(0, 120),
    },
  };
  if (direct) {
    const straight = await send(direct, method, path, options);
    record.direct = {
      ...shape(straight),
      body: straight.json
        ? normalise(straight.json)
        : straight.text.slice(0, 120),
    };
    check(
      `${name}: status equals the direct answer`,
      proxied.status === straight.status,
      `${proxied.status} vs ${straight.status}`,
    );
    check(
      `${name}: body equals the direct answer`,
      JSON.stringify(record.proxied.body) ===
        JSON.stringify(record.direct.body),
    );
    const extra = record.proxied.headerNames.filter(
      (h) => !record.direct.headerNames.includes(h),
    );
    const missing = record.direct.headerNames.filter(
      (h) => !record.proxied.headerNames.includes(h),
    );
    check(
      `${name}: the proxy adds and removes no response header`,
      extra.length === 0 && missing.length === 0,
      `added ${extra}, removed ${missing}`,
    );
  }
  report.checks[name] = record;
  return proxied;
}

// ---------------------------------------------------------------------------------------------------------------- C3
const health = await pair("GET /health", "GET", "/health");
check("/health is 200", health.status === 200);
// The pinned package records the contract's api_version. Recorded as observed, and asserted equal to the pin, so a mismatch is loud.
// This is an observation about the backend, not a client compatibility gate: gating on it is WEB-09 / WEB-14a's work (B2).
const pinnedApiVersion = JSON.parse(
  readFileSync("node_modules/@atlas/api-types/provenance.json", "utf8"),
).api_version;
report.notes.push(
  `/health body at this release: ${JSON.stringify(health.json ?? health.text)}`,
);
check(
  `/health reports api_version ${pinnedApiVersion}, the version of the pinned contract`,
  health.json?.api_version === pinnedApiVersion,
  `body ${JSON.stringify(health.json)}`,
);
const ready = await pair("GET /ready", "GET", "/ready");
check("/ready is 200", ready.status === 200);
check(
  "/health?probe=1 reaches the backend",
  (await pair("GET /health?probe=1", "GET", "/health?probe=1")).status === 200,
);

const unauth = await pair(
  "GET /browser-sessions/current (no cookie)",
  "GET",
  "/api/experimental/v1/browser-sessions/current",
  {
    headers: { "x-atlas-session": "1", origin: publicOrigin },
  },
);
check(
  "an unauthenticated API request is answered by the backend with its own 401",
  unauth.status === 401,
);
check(
  "...as JSON, not HTML",
  unauth.json !== undefined && !unauth.text.includes("<html"),
);
const missingApi = await pair(
  "GET /api/no/such/route",
  "GET",
  "/api/no/such/route",
);
check(
  "an unknown API path is the backend's 404, not the app shell",
  missingApi.status === 404 && !missingApi.text.includes("protected-root"),
);

const shell = await send(origin, "GET", "/");
check(
  "/ returns the app shell",
  shell.status === 200 && shell.text.includes('id="protected-root"'),
);
const deep = await send(origin, "GET", "/settings/appearance");
check("a deep link returns the same shell", deep.text === shell.text);
const missingAsset = await send(origin, "GET", "/assets/does-not-exist.js");
if (strictAssets) {
  check(
    "an asset that does not exist is a 404, not the shell",
    missingAsset.status === 404 &&
      !missingAsset.text.includes("protected-root"),
  );
} else {
  report.notes.push(
    "missing-asset 404 not asserted: this origin is a preview server, which serves the shell for unknown paths (nginx does not; see the image smoke test)",
  );
}

// ---------------------------------------------------------------------------------------------------------------- C4
/** Each session uses its own device, verifier and challenge: the backend refuses to reuse them. */
function newLogin() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    verifier,
    login: {
      username: user,
      password,
      device_id: `atlas-web-smoke-${randomBytes(4).toString("hex")}`,
      attempt_challenge: challenge,
    },
  };
}

async function session(base, name) {
  const { verifier, login } = newLogin();
  const grant = await send(
    base,
    "POST",
    "/api/experimental/v1/browser-sessions",
    { headers: { origin: publicOrigin }, body: login },
  );
  check(
    `${name}: login returns a grant`,
    grant.status === 200 && /^[0-9a-f]{64}$/.test(grant.json?.grant ?? ""),
    `status ${grant.status}`,
  );
  check(
    `${name}: login sets no cookie (activation is the only route that does)`,
    grant.setCookie.length === 0,
  );
  const activated = await send(
    base,
    "POST",
    "/api/experimental/v1/browser-sessions/activate",
    {
      headers: { origin: publicOrigin },
      body: { grant: grant.json?.grant, verifier },
    },
  );
  check(
    `${name}: activation returns a session with a CSRF token`,
    activated.status === 200 &&
      /^[0-9a-f]{64}$/.test(activated.json?.csrf_token ?? ""),
    `status ${activated.status}`,
  );
  check(
    `${name}: activation sets exactly one cookie`,
    activated.setCookie.length === 1,
    `${activated.setCookie.length}`,
  );
  const cookieHeader = activated.setCookie[0] ?? "";
  const cookie = cookieHeader.split(";")[0];
  return {
    grant,
    activated,
    cookie,
    cookieHeader,
    csrf: activated.json?.csrf_token,
    login,
  };
}

const viaProxy = await session(origin, "proxied");
const cookieAttrs = cookieShape(viaProxy.cookieHeader);
report.checks["proxied cookie"] = {
  name: cookieAttrs.name,
  attributes: cookieAttrs.attributes,
};
check("the cookie is HttpOnly", /;\s*HttpOnly/i.test(viaProxy.cookieHeader));
check("the cookie has Path=/", /;\s*Path=\//i.test(viaProxy.cookieHeader));
check(
  "the cookie has SameSite=Lax",
  /;\s*SameSite=Lax/i.test(viaProxy.cookieHeader),
);
check(
  "the cookie has no Domain attribute (host-only)",
  !/;\s*Domain=/i.test(viaProxy.cookieHeader),
);
const https = publicOrigin.startsWith("https:");
check(
  https
    ? "over HTTPS the cookie is __Host- prefixed and Secure"
    : "over loopback HTTP the cookie is atlas_session, not Secure",
  https
    ? cookieAttrs.name.startsWith("__Host-") &&
        /;\s*Secure/i.test(viaProxy.cookieHeader)
    : cookieAttrs.name === "atlas_session" &&
        !/;\s*Secure/i.test(viaProxy.cookieHeader),
);

if (direct) {
  const straight = await session(direct, "direct");
  const a = cookieShape(viaProxy.cookieHeader);
  const b = cookieShape(straight.cookieHeader);
  check(
    "the proxied Set-Cookie has the same name and attributes as the direct one",
    JSON.stringify(a) === JSON.stringify(b),
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );
  check(
    "the proxied activation body has the same shape as the direct one",
    JSON.stringify(Object.keys(viaProxy.activated.json ?? {}).sort()) ===
      JSON.stringify(Object.keys(straight.activated.json ?? {}).sort()),
  );
  await send(direct, "DELETE", "/api/experimental/v1/sessions/current", {
    cookie: straight.cookie,
    headers: { origin: publicOrigin, "x-csrf-token": straight.csrf ?? "" },
  });
}

const current = await send(
  origin,
  "GET",
  "/api/experimental/v1/browser-sessions/current",
  {
    cookie: viaProxy.cookie,
    headers: { "x-atlas-session": "1", origin: publicOrigin },
  },
);
check(
  "the reload bootstrap works through the proxy with the cookie",
  current.status === 200 &&
    current.json?.account_id === viaProxy.activated.json?.account_id,
  `status ${current.status}`,
);

const noCsrf = await send(
  origin,
  "DELETE",
  "/api/experimental/v1/sessions/current",
  { cookie: viaProxy.cookie, headers: { origin: publicOrigin } },
);
check(
  "a state-changing request without X-CSRF-Token is rejected by the backend",
  noCsrf.status === 403,
  `status ${noCsrf.status}`,
);
const wrongCsrf = await send(
  origin,
  "DELETE",
  "/api/experimental/v1/sessions/current",
  {
    cookie: viaProxy.cookie,
    headers: { origin: publicOrigin, "x-csrf-token": "0".repeat(64) },
  },
);
check(
  "a wrong X-CSRF-Token is rejected too",
  wrongCsrf.status === 403,
  `status ${wrongCsrf.status}`,
);
const badOrigin = await send(
  origin,
  "POST",
  "/api/experimental/v1/browser-sessions",
  { headers: { origin: "https://attacker.example" }, body: newLogin().login },
);
check(
  "a request whose Origin is not the public origin is refused",
  badOrigin.status >= 400 && badOrigin.status < 500,
  `status ${badOrigin.status}`,
);
if (direct) {
  const directNoCsrf = await send(
    direct,
    "DELETE",
    "/api/experimental/v1/sessions/current",
    { cookie: viaProxy.cookie, headers: { origin: publicOrigin } },
  );
  check(
    "the missing-token rejection is identical to the direct one",
    directNoCsrf.status === noCsrf.status &&
      JSON.stringify(normalise(directNoCsrf.json)) ===
        JSON.stringify(normalise(noCsrf.json)),
  );
}
const revoke = await send(
  origin,
  "DELETE",
  "/api/experimental/v1/sessions/current",
  {
    cookie: viaProxy.cookie,
    headers: { origin: publicOrigin, "x-csrf-token": viaProxy.csrf ?? "" },
  },
);
check(
  "revoking with the CSRF token succeeds (204) and sends no Set-Cookie",
  revoke.status === 204 && revoke.setCookie.length === 0,
  `status ${revoke.status}`,
);
const after = await send(
  origin,
  "GET",
  "/api/experimental/v1/browser-sessions/current",
  {
    cookie: viaProxy.cookie,
    headers: { "x-atlas-session": "1", origin: publicOrigin },
  },
);
check(
  "the revoked session is refused",
  after.status === 401,
  `status ${after.status}`,
);

// ----------------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
report.passes = passes;
report.failures = failures;
writeFileSync(
  `${outDir}/backend-${label.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
for (const name of passes) console.log(`ok:   ${name}`);
for (const name of failures) console.error(`FAIL: ${name}`);
if (failures.length > 0) process.exit(1);
console.log(`Backend smoke ok (${label}): ${passes.length} checks.`);
