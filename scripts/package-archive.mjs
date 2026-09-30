#!/usr/bin/env node
// Builds the standalone release archive from an already-built dist/ (never rebuilds): atlas-web-<version>.tar.gz.
// It is deterministic: entries sorted, fixed mtime, root ownership, fixed modes, gzip level 9. Two runs over the same
// dist/ are byte-identical. It contains the static site, provenance, third-party notices, the licence and example
// server configuration. It contains no backend code and no fixture code.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const version = option(
  "version",
  JSON.parse(readFileSync("package.json", "utf8")).version,
);
const distribution = option("dist", "dist");
const outDir = option("out", "release");
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
const top = `atlas-web-${version}`;

const entries = new Map(); // archive path -> { data: Buffer } or { directory: true }
const addDirectory = (path) => entries.set(`${path}/`, { directory: true });
const addFile = (path, data) => entries.set(path, { data });

function walk(directory, prefix) {
  addDirectory(prefix);
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    const target = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) walk(full, target);
    else addFile(target, readFileSync(full));
  }
}

addDirectory(top);
walk(distribution, `${top}/site`);
addFile(
  `${top}/provenance.json`,
  readFileSync(join(distribution, "_web/provenance.json")),
);
addFile(
  `${top}/THIRD-PARTY-NOTICES.txt`,
  readFileSync(join(distribution, "_web/third-party-notices.txt")),
);
addFile(`${top}/LICENSE`, readFileSync("LICENSE"));
addDirectory(`${top}/examples`);
addFile(
  `${top}/examples/nginx-web.conf`,
  readFileSync("deploy/nginx/web.conf"),
);
addFile(
  `${top}/examples/nginx-security-headers.conf`,
  readFileSync("deploy/nginx/security-headers.conf"),
);
addFile(
  `${top}/examples/nginx-proxy.conf.template`,
  readFileSync("deploy/nginx/proxy.conf.template"),
);
addFile(
  `${top}/README.txt`,
  Buffer.from(
    [
      `Atlas Web ${version}`,
      "",
      "site/    the static client. Serve it from any static file server, over HTTPS, from the root of your public origin.",
      "         Unknown paths without a file extension must return site/index.html (deep links); missing /assets/* files must return 404.",
      "         Backend paths (/api, /health, /ready, /auth, /oidc) must be routed to the Atlas backend by your reverse proxy,",
      "         on the same origin. The client does not work from a different origin than the backend.",
      "examples/ a tested nginx configuration and the reference reverse-proxy template. See docs/hosting.md in the repository.",
      "provenance.json  the backend release and API contract this client was built against, and the tested pairings.",
      "",
    ].join("\n"),
  ),
);

// ustar writer.
const octal = (value, length) =>
  `${value.toString(8).padStart(length - 1, "0")}\0`;
function header(path, size, directory) {
  const block = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name) - cut - 1 > 100)
      throw new Error(`Path too long for ustar: ${path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  block.write(name, 0, "utf8");
  block.write(octal(directory ? 0o755 : 0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(epoch, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(directory ? "5" : "0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}
const chunks = [];
for (const path of [...entries.keys()].sort()) {
  const entry = entries.get(path);
  if (entry.directory) {
    chunks.push(header(path, 0, true));
  } else {
    chunks.push(header(path, entry.data.length, false), entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks), { level: 9 });

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${top}.tar.gz`);
writeFileSync(file, archive);
const digest = createHash("sha256").update(archive).digest("hex");
writeFileSync(
  join(outDir, `${top}.tar.gz.sha256`),
  `${digest}  ${top}.tar.gz\n`,
);
console.log(
  `${relative(process.cwd(), file).split(sep).join("/")}  ${archive.length} bytes  sha256 ${digest}`,
);
