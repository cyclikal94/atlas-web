// Part C (WEB-08b plan 9.3): a STUB OpenID Connect provider, so the browser OIDC round trip can run against the RELEASED backend.
// It is a test double, not a provider: it implements exactly what the released backend's `openidconnect` client validates and
// nothing else, listens on loopback only, generates an RSA key per run and keeps no state beyond the process.
//
//   issuer port     GET  /.well-known/openid-configuration   discovery
//                   GET  /jwks                               the public key
//                   GET  /authorize                          validates client_id, redirect_uri, S256 PKCE; redirects with a code
//                   POST /token                              checks the code, redirect_uri and PKCE verifier; returns a signed ID token
//   control port    POST /subject {sub}      the subject the next authorisations approve (until changed)
//                   POST /hold {on}          park /authorize responses until /release (the T2 ordering control)
//                   POST /release            release every parked /authorize response
//                   POST /deny {on}          answer /authorize with error=access_denied (consent refused)
//                   GET  /waiting            how many /authorize responses are parked
//                   GET  /log                every request the issuer port saw (method, path, query keys only)
//
// What passing against it does NOT prove: a real provider's claims, key rotation, consent screens, or how a real provider redirects
// on failure. The HTTP issuer is accepted by the released backend only because it is loopback (docs/authentication.md).
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { createServer } from "node:http";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest();

export function createOidcProvider({
  port = 0,
  controlPort = 0,
  clientId,
  callbackUrl,
}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = b64url(randomBytes(8));
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map(); // code -> { nonce, challenge, subject, redirectUri }
  const parked = [];
  const log = [];
  let issuer = "";
  let subject = "stub-subject-default";
  let hold = false;
  let deny = false;

  const json = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };

  const signIdToken = ({ sub, nonce, accessToken }) => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid };
    const payload = {
      iss: issuer,
      sub,
      aud: clientId,
      exp: now + 600,
      iat: now,
      nonce,
      // Left half of the SHA-256 of the access token, as the spec defines `at_hash` for RS256. The backend checks it when present.
      at_hash: b64url(sha256(accessToken).subarray(0, 16)),
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
    return `${input}.${b64url(signature)}`;
  };

  const redirect = (res, url) => {
    res.writeHead(302, { location: url, "cache-control": "no-store" });
    res.end();
  };

  const authorize = (query, res) => {
    const target = new URL(callbackUrl);
    const state = query.get("state") ?? "";
    // Only the registered redirect URI, an authorisation-code request and S256 PKCE are accepted.
    if (
      query.get("client_id") !== clientId ||
      query.get("redirect_uri") !== callbackUrl ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      !query.get("code_challenge") ||
      !query.get("nonce")
    ) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid_request");
      return;
    }
    const finish = () => {
      if (deny) {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("state", state);
        return redirect(res, target.href);
      }
      const code = b64url(randomBytes(24));
      codes.set(code, {
        nonce: query.get("nonce"),
        challenge: query.get("code_challenge"),
        subject,
        redirectUri: callbackUrl,
      });
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      return redirect(res, target.href);
    };
    if (hold) parked.push(finish);
    else finish();
  };

  const token = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const record = codes.get(form.get("code") ?? "");
    const basic = req.headers.authorization?.startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64")
          .toString("utf8")
          .split(":")[0]
      : undefined;
    const presented = form.get("client_id") ?? basic;
    const fail = (error) => json(res, 400, { error });
    if (form.get("grant_type") !== "authorization_code")
      return fail("unsupported_grant_type");
    if (presented !== clientId) return fail("invalid_client");
    if (!record) return fail("invalid_grant");
    codes.delete(form.get("code")); // single use
    if (form.get("redirect_uri") !== record.redirectUri)
      return fail("invalid_grant");
    if (b64url(sha256(form.get("code_verifier") ?? "")) !== record.challenge)
      return fail("invalid_grant");
    const accessToken = b64url(randomBytes(24));
    return json(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 600,
      id_token: signIdToken({
        sub: record.subject,
        nonce: record.nonce,
        accessToken,
      }),
    });
  };

  const issuerServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    log.push({
      at: Date.now(),
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams.keys()],
    });
    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    )
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
      });
    if (req.method === "GET" && url.pathname === "/jwks")
      return json(res, 200, { keys: [jwk] });
    if (req.method === "GET" && url.pathname === "/authorize")
      return authorize(url.searchParams, res);
    if (req.method === "POST" && url.pathname === "/token")
      return void token(req, res);
    json(res, 404, { error: "not_found" });
  });

  const controlServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
        : {};
    } catch {
      body = {};
    }
    if (req.method === "POST" && url.pathname === "/subject") {
      subject = String(body.sub ?? subject);
      return json(res, 200, { sub: subject });
    }
    if (req.method === "POST" && url.pathname === "/hold") {
      hold = body.on !== false;
      return json(res, 200, { hold });
    }
    if (req.method === "POST" && url.pathname === "/deny") {
      deny = body.on !== false;
      return json(res, 200, { deny });
    }
    if (req.method === "POST" && url.pathname === "/release") {
      const released = parked.splice(0);
      for (const finish of released) finish();
      return json(res, 200, { released: released.length });
    }
    if (req.method === "GET" && url.pathname === "/waiting")
      return json(res, 200, { waiting: parked.length });
    if (req.method === "GET" && url.pathname === "/log")
      return json(res, 200, log);
    json(res, 404, { error: "not_found" });
  });

  const listen = (server, wanted) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, "127.0.0.1", () => {
        server.off("error", reject);
        resolve(server.address().port);
      });
    });
  const close = (server) =>
    new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  // Review r6 (H4a): `stop()` joins a `start()` still under way, so neither listener can appear after it.
  let stopped = false;
  let starting = null;
  return {
    start() {
      starting ??= (async () => {
        const issuerPort = stopped ? null : await listen(issuerServer, port);
        const controlPortActual = stopped
          ? null
          : await listen(controlServer, controlPort);
        if (stopped) {
          await Promise.all([issuerServer, controlServer].map(close));
          throw new Error("the provider was stopped while it was starting");
        }
        issuer = `http://127.0.0.1:${issuerPort}`;
        return {
          issuer,
          issuerPort,
          controlPort: controlPortActual,
          controlUrl: `http://127.0.0.1:${controlPortActual}`,
          clientId,
        };
      })();
      return starting;
    },
    async stop() {
      stopped = true;
      await starting?.catch(() => undefined);
      for (const finish of parked.splice(0)) finish();
      await Promise.all([issuerServer, controlServer].map(close));
      return {
        ok: !issuerServer.listening && !controlServer.listening,
        listening: [issuerServer, controlServer].filter((s) => s.listening)
          .length,
      };
    },
  };
}
