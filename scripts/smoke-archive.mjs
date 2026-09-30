#!/usr/bin/env node
// B17. Builds the archive twice and byte-compares (determinism), extracts it, serves it with a plain static server
// (no backend), and checks: the shell, a deep link, provenance (schema and pin), notices, and no fixture code.
// Layer B for a local build; layer C evidence when run against the archive a release actually produced (`--archive`).
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const given = args.includes("--archive")
  ? args[args.indexOf("--archive") + 1]
  : undefined;
const scratch = mkdtempSync(join(tmpdir(), "atlas-web-archive-"));
const failures = [];
const check = (condition, message) => condition || failures.push(message);
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed:\n${result.stdout}${result.stderr}`,
    );
  return result.stdout;
};

let server;
try {
  let archive = given;
  if (!archive) {
    run("node", ["scripts/package-archive.mjs", "--out", join(scratch, "a")]);
    run("node", ["scripts/package-archive.mjs", "--out", join(scratch, "b")]);
    const a = readFileSync(join(scratch, "a/atlas-web-0.0.0.tar.gz"));
    const b = readFileSync(join(scratch, "b/atlas-web-0.0.0.tar.gz"));
    check(a.equals(b), "two builds of the archive are not byte-identical");
    archive = join(scratch, "a/atlas-web-0.0.0.tar.gz");
    const sha = readFileSync(
      join(scratch, "a/atlas-web-0.0.0.tar.gz.sha256"),
      "utf8",
    ).split(/\s+/)[0];
    check(
      run("shasum", ["-a", "256", archive]).startsWith(sha),
      "the published .sha256 does not match the archive",
    );
  }
  run("node", ["scripts/check-no-fixture.mjs", archive]);
  const extracted = join(scratch, "x");
  mkdirSync(extracted);
  run("tar", ["xzf", archive, "-C", extracted]);
  const top = join(
    extracted,
    run("tar", ["tzf", archive]).split("\n")[0].replace(/\/$/, ""),
  );
  for (const file of [
    "site/index.html",
    "site/theme-init.js",
    "site/favicon.svg",
    "provenance.json",
    "THIRD-PARTY-NOTICES.txt",
    "LICENSE",
    "README.txt",
    "examples/nginx-web.conf",
  ]) {
    check(existsSync(join(top, file)), `missing ${file}`);
  }
  run("node", [
    "scripts/validate-provenance.mjs",
    join(top, "provenance.json"),
  ]);
  check(
    readFileSync(join(top, "provenance.json"), "utf8") ===
      readFileSync(join(top, "site/_web/provenance.json"), "utf8"),
    "provenance differs between the archive root and site/_web",
  );
  check(
    /Geist/.test(readFileSync(join(top, "THIRD-PARTY-NOTICES.txt"), "utf8")),
    "notices do not mention Geist",
  );
  // Every package the build bundled, the Workbox code in sw.js included, has its notice in the archive.
  run("node", [
    "scripts/check-notices.mjs",
    join(top, "site"),
    "--notices",
    join(top, "THIRD-PARTY-NOTICES.txt"),
  ]);
  check(
    !existsSync(join(top, "site/fixture.html")),
    "fixture.html is in the archive",
  );

  server = spawn("node", ["scripts/serve-static.mjs", join(top, "site"), "0"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve) =>
    server.stdout.once("data", (data) =>
      resolve(Number(/listening (\d+)/.exec(String(data))[1])),
    ),
  );
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  const home = await get("/");
  const html = await home.text();
  check(
    home.status === 200 &&
      html.includes('id="protected-root"') &&
      html.includes("inert"),
    "the shell is not served at /",
  );
  check(
    (await (await get("/settings/appearance")).text()) === html,
    "a deep link does not fall back to the shell",
  );
  check(
    (await get("/assets/missing.js")).status === 404,
    "a missing asset is not a 404",
  );
  const provenance = await (await get("/_web/provenance.json")).json();
  check(
    provenance.atlas_backend_ref.tag === "v0.27.0-rc.1",
    "provenance is not served",
  );
  const asset = /assets\/index-[^"]+\.js/.exec(html)?.[0];
  check(
    asset && (await get(`/${asset}`)).status === 200,
    "the entry script is not served",
  );
} catch (error) {
  failures.push(error.message);
} finally {
  server?.kill();
  rmSync(scratch, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`Archive smoke FAILED:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(
  "Archive smoke ok: deterministic, complete, served by a plain static server, no fixture code.",
);
