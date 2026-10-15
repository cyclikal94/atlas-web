// WEB-13a: a loopback ICS feed for the linked-calendar integration specs (I-CAL). It is the "calendar provider" the released backend
// fetches from: the runner allows its exact origin (`ATLAS_OUTBOUND_ALLOW_ORIGINS`) because the backend denies private and loopback
// addresses and plain HTTP by default. Test infrastructure only: bound to 127.0.0.1, stopped with the stack, never part of `dist`.
//
// Feeds are paths (`/feeds/<name>.ics`). Each answers what the control API set for it (default: 404), and the feed counts every
// request it served and can HOLD requests (keep them open, unanswered) until released, so a spec can keep a backend fetch in flight
// (and so its refresh lease held) for as long as it needs, and then let it finish. The backend's own fetch time-out is 20 s.
//
// Control (same server, under /__feed/):
//   POST /__feed/set      { path, status?, body?, contentType? }   what `path` answers from now on
//   POST /__feed/hold     { path }                                   hold every later request to `path` until released
//   POST /__feed/release  { path }                                   answer every held request of `path` and stop holding
//   GET  /__feed/state                                               { counts: {path: n}, held: {path: n}, log: [{path, at, auth}] }
//   POST /__feed/reset                                               release everything, forget every setting and count
import { createServer } from "node:http";

export function createCalendarFeed({ port = 0 } = {}) {
  const feeds = new Map();
  const holds = new Map();
  const counts = new Map();
  const log = [];

  const answer = (res, path) => {
    const feed = feeds.get(path);
    if (!feed) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("no such feed");
    }
    res.writeHead(feed.status ?? 200, {
      "content-type": feed.contentType ?? "text/calendar; charset=utf-8",
    });
    res.end(feed.body ?? "");
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(
            chunks.length
              ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
              : {},
          );
        } catch {
          resolve({});
        }
      });
    });

  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/__feed/")) {
      (async () => {
        const action = url.pathname.slice("/__feed/".length);
        if (req.method === "GET" && action === "state")
          return json(res, 200, {
            counts: Object.fromEntries(counts),
            held: Object.fromEntries(
              [...holds].map(([path, hold]) => [path, hold.waiting.length]),
            ),
            log,
          });
        const body = req.method === "POST" ? await readBody(req) : {};
        if (action === "set") {
          feeds.set(body.path, {
            status: body.status,
            body: body.body,
            contentType: body.contentType,
          });
          return json(res, 200, { ok: true });
        }
        if (action === "hold") {
          if (!holds.has(body.path)) holds.set(body.path, { waiting: [] });
          return json(res, 200, { ok: true });
        }
        if (action === "release") {
          const hold = holds.get(body.path);
          holds.delete(body.path);
          for (const deliver of hold?.waiting ?? []) deliver();
          return json(res, 200, { released: hold?.waiting.length ?? 0 });
        }
        if (action === "reset") {
          for (const hold of holds.values())
            for (const deliver of hold.waiting) deliver();
          holds.clear();
          feeds.clear();
          counts.clear();
          log.length = 0;
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "unknown control endpoint" });
      })().catch((error) => json(res, 500, { error: String(error) }));
      return;
    }
    const path = url.pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    // Whether a token was presented, never the token itself.
    log.push({
      path,
      at: Date.now(),
      auth: req.headers.authorization ? "bearer" : "none",
    });
    const hold = holds.get(path);
    if (hold) {
      hold.waiting.push(() => answer(res, path));
      return;
    }
    answer(res, path);
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return { origin: `http://127.0.0.1:${server.address().port}` };
    },
    async stop() {
      for (const hold of holds.values())
        for (const deliver of hold.waiting) deliver();
      holds.clear();
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    },
  };
}

/** A minimal valid calendar with one event `days` from today (UTC), for a feed that refreshes successfully. */
export function sampleIcs({
  uid = "event-1",
  summary = "Event",
  days = 3,
} = {}) {
  const at = new Date(Date.now() + days * 86_400_000);
  const date = at.toISOString().slice(0, 10).replaceAll("-", "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//atlas-web//integration//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${date}T000000Z`,
    `DTSTART;VALUE=DATE:${date}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
