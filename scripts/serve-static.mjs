#!/usr/bin/env node
// A minimal static file server with history fallback, for archive smoke tests only. It stands in for "any static server":
// files are served as found, a path with no file extension falls back to index.html, and a missing file with an extension is a 404.
// It is NOT the reference server configuration (that is deploy/nginx/web.conf, tested in the image).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3] ?? 0);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(
    new URL(request.url ?? "/", "http://x").pathname,
  );
  let file = normalize(join(root, pathname));
  if (!file.startsWith(root)) return void response.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(pathname))
      return void response
        .writeHead(404, { "content-type": "text/plain" })
        .end("not found\n");
    file = join(root, "index.html");
  }
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`listening ${server.address().port}`),
);
