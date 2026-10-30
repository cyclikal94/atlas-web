// WEB-09c (R23-PAIR): the development-pair TAP, a loopback pass-through between the delaying proxy and the backend
// (browser → preview → delaying proxy → TAP → backend). It records what the SERVER answered, before anything downstream alters it:
//
//   - every request: its sequence number, the interval label in force, method, path, status and loopback timings;
//   - every `GET …/sync`: the exact upstream body bytes, their SHA-256 and length, the request's cursor / limit / max_changes, the first
//     batch's revision and segment, the change count, has_more and next_cursor; the body is written to `bodiesDir` AFTER it has been
//     delivered, so the write is never inside the browser's receive path.
//
// It changes nothing unless a test arms a ONE-SHOT, LABELLED fault (`POST /fault`). A fault applies to the next 200 `/sync` answer whose
// first batch is a segment at or after `afterIndex`; it is recorded on that exchange (`delivered`, with its own hash, beside the unaltered
// upstream body) and counted (`GET /faults`: fired, at which sequence number). Kinds:
//   tamper_next_cursor       the last character of next_cursor changed (the server's answer to the tampered token is then real)
//   substitute_next_cursor   next_cursor replaced by `value` (another device's or account's real continuation)
//   segment_index_delta      batches[0].segment.index += delta (a gap or a reorder)
//   revision_delta           batches[0].revision += delta
//   replay_previous          the previously DELIVERED segmented body answered instead (a repeated piece at the current cursor)
//   answer_410               a 410 resync_required error answered in place of the real piece (client-only: NOT server expiry/pruning)
//   drop_connection          the connection is destroyed instead of answering: the SERVER has answered (and written its per-device
//                            delivered-ID ledger), the client receives nothing (the delaying proxy answers it 502)
// Every injected answer is client-side evidence only; the record says so. Request bodies, headers and cookies are forwarded untouched.
//
// Bounded: the in-memory log keeps at most `maxRecords` records (the oldest are dropped and counted); bodies live on disk only.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const FAULT_KINDS = [
  "tamper_next_cursor",
  "substitute_next_cursor",
  "segment_index_delta",
  "revision_delta",
  "replay_previous",
  "answer_410",
  "drop_connection",
];
/** The Atlas error body of an injected 410 (the shape the backend answers: code, message, details). */
export const INJECTED_410 = {
  code: "resync_required",
  message: "TAP-INJECTED resync_required",
  details: [],
};

/**
 * One character changed, so the token keeps its exact shape but cannot authenticate: the last character moves on by one IN ITS OWN
 * alphabet (a hexadecimal MAC stays hexadecimal), so the server reaches its MAC check rather than a shape refusal.
 */
export function tamper(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0)
    throw new Error("no cursor to tamper with");
  const last = cursor.at(-1);
  const hex = "0123456789abcdef";
  const other =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alphabet = hex.includes(last) ? hex : other;
  const at = alphabet.indexOf(last);
  const next = at < 0 ? "A" : alphabet[(at + 1) % alphabet.length];
  return cursor.slice(0, -1) + next;
}

/** The description of a `/sync` answer, from its exact bytes (null fields when the body is not a sync page). */
export function describeSync(bytes) {
  try {
    const page = JSON.parse(bytes.toString("utf8"));
    const first = Array.isArray(page.batches) ? page.batches[0] : undefined;
    return {
      phase: page.phase ?? null,
      batches: Array.isArray(page.batches) ? page.batches.length : null,
      changes: Array.isArray(page.batches)
        ? page.batches.reduce(
            (n, b) => n + (Array.isArray(b.changes) ? b.changes.length : 0),
            0,
          )
        : null,
      revision: first?.revision ?? null,
      last_revision:
        Array.isArray(page.batches) && page.batches.length > 0
          ? (page.batches.at(-1).revision ?? null)
          : null,
      segment: first?.segment ?? null,
      has_more: page.has_more ?? null,
      next_cursor: page.next_cursor ?? null,
      code: page.code ?? null,
    };
  } catch {
    return {
      phase: null,
      batches: null,
      changes: null,
      revision: null,
      last_revision: null,
      segment: null,
      has_more: null,
      next_cursor: null,
      code: null,
    };
  }
}

/** Applies one fault to a parsed page (a copy); returns the new page. `previous` is the previously delivered segmented body. */
export function applyFault(fault, page, previous) {
  const copy = structuredClone(page);
  switch (fault.kind) {
    case "tamper_next_cursor":
      copy.next_cursor = tamper(copy.next_cursor);
      return copy;
    case "substitute_next_cursor":
      if (typeof fault.value !== "string" || fault.value === "")
        throw new Error("substitute_next_cursor needs a value");
      copy.next_cursor = fault.value;
      return copy;
    case "segment_index_delta":
      copy.batches[0].segment.index += fault.delta ?? 1;
      return copy;
    case "revision_delta":
      copy.batches[0].revision += fault.delta ?? 1;
      return copy;
    case "replay_previous":
      if (!previous)
        throw new Error("replay_previous: no earlier segmented answer");
      return JSON.parse(previous.toString("utf8"));
    case "answer_410":
      return structuredClone(INJECTED_410);
    default:
      throw new Error(`unknown fault ${fault.kind}`);
  }
}

export function createTap({
  upstream,
  port = 0,
  controlPort = 0,
  bodiesDir,
  maxRecords = 4000,
  now = () => performance.now(),
}) {
  const target = new URL(upstream);
  if (target.hostname !== "127.0.0.1")
    throw new Error("the tap forwards to loopback only");
  mkdirSync(bodiesDir, { recursive: true });
  const records = [];
  let dropped = 0;
  let seq = 0;
  let label = null;
  const faults = [];
  const writes = new Set();
  const upstreams = new Set();
  let previousSegmented = null;
  let stopped = false;
  const keep = (record) => {
    records.push(record);
    while (records.length > maxRecords) {
      records.shift();
      dropped += 1;
    }
  };
  const persist = (file, bytes) => {
    const done = writeFile(join(bodiesDir, file), bytes).finally(() =>
      writes.delete(done),
    );
    writes.add(done);
  };

  const server = createServer((req, res) => {
    const id = ++seq;
    const url = new URL(req.url, "http://x");
    const isSync = req.method === "GET" && url.pathname.endsWith("/sync");
    const record = {
      seq: id,
      label,
      method: req.method,
      path: url.pathname,
      ...(isSync
        ? {
            query: {
              cursor: url.searchParams.get("cursor"),
              limit: url.searchParams.get("limit"),
              max_changes: url.searchParams.get("max_changes"),
            },
          }
        : {}),
      status: null,
      t_request: now(),
      t_upstream_end: null,
      t_delivered: null,
    };
    keep(record);
    if (stopped) {
      res.destroy();
      return;
    }
    const upstreamReq = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        if (!isSync) {
          record.status = upstreamRes.statusCode;
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
          upstreamRes.on("end", () => {
            record.t_upstream_end = now();
          });
          return;
        }
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          record.t_upstream_end = now();
          record.status = upstreamRes.statusCode;
          const body = Buffer.concat(chunks);
          const file = `${String(id).padStart(6, "0")}.upstream.json`;
          Object.assign(record, {
            bytes: body.length,
            sha256: sha256(body),
            body_file: file,
            ...describeSync(body),
          });
          let payload = body;
          let status = upstreamRes.statusCode;
          const headers = { ...upstreamRes.headers };
          if (upstreamRes.statusCode === 200 && record.segment) {
            const at = faults.findIndex(
              (f) =>
                f.fired === null &&
                (f.afterIndex === undefined ||
                  record.segment.index >= f.afterIndex),
            );
            if (at >= 0 && faults[at].kind === "drop_connection") {
              const fault = faults[at];
              fault.fired = id;
              record.dropped =
                "TAP-INJECTED drop_connection: the server answered; the connection was destroyed before any byte reached the client";
              persist(file, body);
              res.destroy();
              return;
            }
            if (at >= 0) {
              const fault = faults[at];
              try {
                const changed = Buffer.from(
                  JSON.stringify(
                    applyFault(
                      fault,
                      JSON.parse(body.toString("utf8")),
                      previousSegmented,
                    ),
                  ),
                );
                payload = changed;
                if (fault.kind === "answer_410") {
                  status = 410;
                  for (const name of Object.keys(headers))
                    if (name.toLowerCase() === "set-cookie")
                      delete headers[name];
                  headers["cache-control"] = "private, no-store";
                }
                const deliveredFile = `${String(id).padStart(6, "0")}.delivered.json`;
                record.delivered = {
                  injected: `TAP-INJECTED ${fault.kind}`,
                  status,
                  bytes: changed.length,
                  sha256: sha256(changed),
                  body_file: deliveredFile,
                  ...describeSync(changed),
                };
                fault.fired = id;
                persist(deliveredFile, changed);
              } catch (error) {
                fault.fired = id;
                fault.error = String(error?.message ?? error);
              }
            }
            if (status === 200) previousSegmented = payload;
          }
          if (res.destroyed || res.writableEnded) {
            record.client_gone = true;
          } else {
            // The body was buffered whole: it is sent with its exact length (never also chunked).
            for (const name of Object.keys(headers))
              if (name.toLowerCase() === "transfer-encoding")
                delete headers[name];
            headers["content-length"] = String(payload.length);
            res.writeHead(status, headers);
            res.end(payload);
            record.t_delivered = now();
          }
          persist(file, body);
        });
      },
    );
    upstreams.add(upstreamReq);
    upstreamReq.once("close", () => upstreams.delete(upstreamReq));
    upstreamReq.on("error", (error) => {
      record.upstream_error = String(error?.message ?? error);
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end("{}");
      }
    });
    req.pipe(upstreamReq);
  });

  const control = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const body = () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            resolve(
              chunks.length
                ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
                : {},
            );
          } catch (error) {
            reject(error);
          }
        });
      });
    (async () => {
      if (req.method === "GET" && url.pathname === "/log") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return json(200, {
          dropped,
          records: records.filter((r) => r.seq > since),
        });
      }
      if (req.method === "POST" && url.pathname === "/label") {
        label = (await body()).label ?? null;
        return json(200, { label, seq });
      }
      if (req.method === "POST" && url.pathname === "/fault") {
        const fault = await body();
        if (!FAULT_KINDS.includes(fault.kind))
          return json(400, { error: `unknown fault ${fault.kind}` });
        const armed = { id: `f${faults.length + 1}`, ...fault, fired: null };
        faults.push(armed);
        return json(200, armed);
      }
      if (req.method === "GET" && url.pathname === "/faults")
        return json(200, faults);
      if (req.method === "POST" && url.pathname === "/flush") {
        await Promise.allSettled([...writes]);
        return json(200, { flushed: true });
      }
      if (req.method === "POST" && url.pathname === "/reset") {
        // Every armed fault is discarded (and reported, so an unfired fault is never forgotten silently); the log restarts. Bodies stay.
        const unfired = faults.filter((f) => f.fired === null).map((f) => f.id);
        faults.length = 0;
        records.length = 0;
        label = null;
        previousSegmented = null;
        return json(200, { unfired, seq });
      }
      return json(404, { error: "unknown control endpoint" });
    })().catch((error) => json(500, { error: String(error) }));
  });

  const listen = (s, wanted) =>
    new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen(wanted, "127.0.0.1", () => {
        s.off("error", reject);
        resolve();
      });
    });
  const close = (s) =>
    new Promise((resolve) => {
      if (!s.listening) return resolve();
      s.closeAllConnections?.();
      s.close(() => resolve());
    });
  return {
    async start() {
      await listen(server, port);
      await listen(control, controlPort);
      return {
        tapUrl: `http://127.0.0.1:${server.address().port}`,
        controlUrl: `http://127.0.0.1:${control.address().port}`,
      };
    },
    async stop() {
      stopped = true;
      for (const u of upstreams) u.destroy();
      await Promise.all([server, control].map(close));
      await Promise.allSettled([...writes]);
      return { ok: !server.listening && !control.listening };
    },
    records,
    faults,
  };
}
