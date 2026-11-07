#!/usr/bin/env node
// CHECKS ONLY (WEB-14a). Builds the service-worker GENERATIONS the PWA browser checks move between, into the ignored dist-pwa/:
//
//   production-a  a byte copy of the real production build (dist/, which must be built first: `pnpm build`)
//   production-b  the production build again, with VITE_ATLAS_BUILD_LABEL=b (different hashed files, a different generation)
//   fixture-a/b/c the FIXTURE entry built with the worker (`vite build --mode pwa-fixture`), labels a, b and c
//
// The label is a harmless string the boot sequence writes to `data-atlas-build` (src/app/boot.tsx); the production build has none. Nothing
// in dist-pwa/ is ever packaged (check-no-fixture keeps checking dist/). Also writes dist-pwa/generations.json: per generation its entry
// script, files and the SHA-256 of every file, so a spec can tell which files belong to which generation.
//
//   node scripts/build-pwa-generations.mjs [--only fixture-a,fixture-b]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-pwa");
const at = process.argv.indexOf("--only");
const only = at >= 0 ? new Set(process.argv[at + 1].split(",")) : null;
const wanted = (name) => only === null || only.has(name);

const vite = (args, label) =>
  execFileSync(
    process.execPath,
    [join(root, "node_modules/vite/bin/vite.js"), "build", ...args],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, VITE_ATLAS_BUILD_LABEL: label },
    },
  );

mkdirSync(out, { recursive: true });
if (wanted("production-a")) {
  if (!existsSync(join(root, "dist/sw.js")))
    throw new Error("dist/ has no worker: run `pnpm build` first");
  rmSync(join(out, "production-a"), { recursive: true, force: true });
  cpSync(join(root, "dist"), join(out, "production-a"), { recursive: true });
}
if (wanted("production-b"))
  vite(["--outDir", "dist-pwa/production-b", "--emptyOutDir"], "b");
for (const label of ["a", "b", "c"])
  if (wanted(`fixture-${label}`))
    vite(
      [
        "--mode",
        "pwa-fixture",
        "--outDir",
        `dist-pwa/fixture-${label}`,
        "--emptyOutDir",
      ],
      label,
    );

const files = (dir) => {
  const found = [];
  (function walk(current) {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(`/${relative(dir, full).split("\\").join("/")}`);
    }
  })(dir);
  return found.sort();
};
const generations = {};
for (const name of readdirSync(out)) {
  const dir = join(out, name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "index.html")))
    continue;
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const entry =
    /<script type="module"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? null;
  const listed = files(dir);
  generations[name] = {
    entry,
    worker: existsSync(join(dir, "sw.js")),
    files: Object.fromEntries(
      listed.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(dir, file)))
          .digest("hex"),
      ]),
    ),
  };
}
writeFileSync(
  join(out, "generations.json"),
  `${JSON.stringify(generations, null, 2)}\n`,
);
for (const [name, value] of Object.entries(generations))
  console.log(
    `${name}: entry ${value.entry}, worker ${value.worker}, ${Object.keys(value.files).length} files`,
  );
