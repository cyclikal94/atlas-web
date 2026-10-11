// Part C (plan 14.2): a loopback HTTP proxy between the preview server and the backend, with a loopback CONTROL endpoint, that can
// hold, delay, drop after forwarding, rewrite to a status after forwarding, and swap responses. It logs every request and response
// with timing. It never modifies a request body and never strips or adds Set-Cookie, Origin or X-CSRF-Token: the only response
// it ever changes is one a rule asks it to (rewrite_status, rewrite_json, replace_response).
//
// Rules are matched by method, path (exact string or /regex/) and ORDINAL (the nth matching request since the rule was added,
// 1-based; absent = every match). Actions:
//   hold                 forward now, deliver the response only after POST /release/<id> (the backend has already committed)
//   hold_request         do NOT forward until POST /release/<id>
//   buffer_request       read the WHOLE request now, hold it, and forward it on POST /release/<id> EVEN IF THE CLIENT HAS GONE (it
//                        models a gateway or queue that has accepted a request and delivers it late). `hold_request` cannot: it keeps
//                        the request unread, so a client that times out and aborts takes the request with it. A reset or a stop
//                        DISCARDS buffered requests instead of forwarding them, so no late write lands in a later test.
//   delay                deliver the response after `ms`
//   drop_after_forward   forward, let the backend commit, then destroy the connection (the browser sees it close)
//   rewrite_status       forward, then answer with `status` and an empty JSON body and NONE of the backend's headers (a gateway's error carries no Set-Cookie)
//   replace_response     forward, then answer with `status` and the JSON body `json` (for example an Atlas-formatted error with its `code`) and none of the backend's headers
//   rewrite_json         forward, then set/delete fields of the JSON body: { set: {...}, delete: [...] }
//   swap                 with `with: <other rule id>`: hold both, then deliver each to the OTHER's client on release
import { createServer, request as httpRequest } from "node:http";

export function createProxy({ upstream, port = 0, controlPort = 0 }) {
  const target = new URL(upstream);
  const log = [];
  const rules = [];
  const held = new Map(); // rule id -> [{ deliver() }]
  let seq = 0;

  const match = (rule, req) => {
    if (rule.method && rule.method !== req.method) return false;
    const path = new URL(req.url, "http://x").pathname;
    if (typeof rule.path === "string") {
      if (
        rule.path.startsWith("/") &&
        rule.path.endsWith("/") &&
        rule.path.length > 2
      ) {
        if (!new RegExp(rule.path.slice(1, -1)).test(path)) return false;
      } else if (rule.path !== path) return false;
    }
    rule.seen = (rule.seen ?? 0) + 1;
    return rule.ordinal === undefined || rule.ordinal === rule.seen;
  };

  const proxy = createServer((req, res) => {
    const id = ++seq;
    const entry = {
      id,
      method: req.method,
      path: req.url,
      at: Date.now(),
      events: [],
    };
    log.push(entry);
    const rule = rules.find((r) => !r.spent && match(r, req));
    if (rule && rule.ordinal !== undefined) rule.spent = true;
    if (rule) entry.rule = rule.id;
    // `buffered`: the whole request body when it was read ahead of time (`buffer_request`); otherwise it is piped through.
    const forward = (buffered) => {
      const upstreamReq = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host },
        },
        (upstreamRes) => {
          const chunks = [];
          upstreamRes.on("data", (c) => chunks.push(c));
          upstreamRes.on("end", () => {
            entry.events.push({
              t: Date.now() - entry.at,
              event: "upstream_response",
              status: upstreamRes.statusCode,
            });
            entry.status = upstreamRes.statusCode;
            const body = Buffer.concat(chunks);
            const deliver = (override) => {
              // The client may have given up (its own time-out) long before a buffered request was released.
              if (res.destroyed || res.writableEnded) {
                entry.events.push({
                  t: Date.now() - entry.at,
                  event: "client_gone",
                });
                return;
              }
              const status = override?.status ?? upstreamRes.statusCode;
              const headers = override?.headers ?? { ...upstreamRes.headers };
              const payload = override?.body ?? body;
              if (override?.body !== undefined) {
                headers["content-length"] = String(payload.length);
                if (override.contentType)
                  headers["content-type"] = override.contentType;
              }
              res.writeHead(status, headers);
              res.end(payload);
              entry.events.push({
                t: Date.now() - entry.at,
                event: "delivered",
                status,
              });
            };
            if (!rule) return deliver();
            switch (rule.action) {
              case "delay":
                return void setTimeout(() => deliver(), rule.ms ?? 1000);
              case "hold": {
                const list = held.get(rule.id) ?? [];
                list.push({ deliver: () => deliver(), entry });
                held.set(rule.id, list);
                entry.events.push({ t: Date.now() - entry.at, event: "held" });
                return;
              }
              case "swap": {
                const list = held.get(rule.id) ?? [];
                list.push({
                  deliver,
                  entry,
                  body,
                  status: upstreamRes.statusCode,
                  headers: upstreamRes.headers,
                });
                held.set(rule.id, list);
                entry.events.push({
                  t: Date.now() - entry.at,
                  event: "held_for_swap",
                });
                return;
              }
              case "drop_after_forward":
                entry.events.push({
                  t: Date.now() - entry.at,
                  event: "dropped",
                });
                return void req.socket.destroy();
              case "rewrite_status":
                // NONE of the backend's headers, as documented above: a gateway's error carries no Set-Cookie. (WEB-08c HF-5: the
                // backend's headers used to be forwarded, so a rewritten `activate` still set the new session's cookie, unlike a gateway.)
                return deliver({
                  status: rule.status ?? 502,
                  headers: {},
                  body: Buffer.from("{}"),
                  contentType: "application/json",
                });
              case "replace_response":
                // None of the backend's headers, as documented above (WEB-08c HF-5, as for `rewrite_status`).
                return deliver({
                  status: rule.status ?? 502,
                  headers: {},
                  body: Buffer.from(JSON.stringify(rule.json ?? {})),
                  contentType: "application/json",
                });
              case "rewrite_json": {
                let json;
                try {
                  json = JSON.parse(body.toString("utf8"));
                } catch {
                  return deliver();
                }
                for (const [k, v] of Object.entries(rule.set ?? {}))
                  json[k] = v;
                for (const k of rule.delete ?? []) delete json[k];
                return deliver({
                  body: Buffer.from(JSON.stringify(json)),
                  contentType: "application/json",
                });
              }
              default:
                return deliver();
            }
          });
        },
      );
      upstreamReq.on("error", () => {
        entry.events.push({
          t: Date.now() - entry.at,
          event: "upstream_error",
        });
        if (res.destroyed || res.writableEnded) return;
        // An upstream error AFTER the answer began (a reset of a large response, a client that went away) must not throw: the
        // connection is simply ended. Before the answer began, it is a 502.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { "content-type": "application/json" });
        res.end("{}");
      });
      if (buffered) upstreamReq.end(buffered);
      else req.pipe(upstreamReq);
    };
    if (rule?.action === "buffer_request") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const list = held.get(rule.id) ?? [];
        list.push({
          deliver: () => forward(Buffer.concat(chunks)),
          discard: () => {},
          entry,
        });
        held.set(rule.id, list);
        entry.events.push({
          t: Date.now() - entry.at,
          event: "buffered_request",
        });
      });
      return;
    }
    if (rule?.action === "hold_request") {
      const list = held.get(rule.id) ?? [];
      list.push({ deliver: forward, entry });
      held.set(rule.id, list);
      entry.events.push({ t: 0, event: "held_request" });
      return;
    }
    forward();
  });

  const control = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () =>
          resolve(
            chunks.length
              ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
              : {},
          ),
        );
      });
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    (async () => {
      if (req.method === "POST" && url.pathname === "/rules") {
        const rule = await readBody();
        rule.id = rule.id ?? `r${rules.length + 1}`;
        rules.push(rule);
        return json(200, { id: rule.id });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/rules/")) {
        const id = url.pathname.slice("/rules/".length);
        const i = rules.findIndex((r) => r.id === id);
        if (i >= 0) rules.splice(i, 1);
        return json(200, { removed: i >= 0 });
      }
      if (req.method === "POST" && url.pathname.startsWith("/release/")) {
        const id = url.pathname.slice("/release/".length);
        const list = held.get(id) ?? [];
        held.delete(id);
        const rule = rules.find((r) => r.id === id);
        if (rule?.action === "swap" && list.length >= 2) {
          // Deliver each response to the OTHER request's client.
          const [a, b] = list;
          a.deliver({ status: b.status, body: b.body });
          b.deliver({ status: a.status, body: a.body });
        } else for (const item of list) item.deliver();
        return json(200, { released: list.length });
      }
      if (req.method === "GET" && url.pathname === "/held")
        return json(
          200,
          Object.fromEntries([...held].map(([k, v]) => [k, v.length])),
        );
      if (req.method === "GET" && url.pathname === "/log")
        return json(200, log);
      if (req.method === "POST" && url.pathname === "/reset") {
        rules.length = 0;
        log.length = 0;
        for (const list of held.values())
          for (const item of list) (item.discard ?? item.deliver)();
        held.clear();
        return json(200, {});
      }
      return json(404, { error: "unknown control endpoint" });
    })().catch((error) => json(500, { error: String(error) }));
  });

  return {
    async start() {
      await new Promise((resolve) => proxy.listen(port, "127.0.0.1", resolve));
      await new Promise((resolve) =>
        control.listen(controlPort, "127.0.0.1", resolve),
      );
      return {
        proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
        controlUrl: `http://127.0.0.1:${control.address().port}`,
      };
    },
    async stop() {
      for (const list of held.values())
        for (const item of list) (item.discard ?? item.deliver)();
      await Promise.all(
        [proxy, control].map(
          (s) =>
            new Promise((resolve) => {
              s.closeAllConnections?.();
              s.close(resolve);
            }),
        ),
      );
    },
    log,
  };
}
