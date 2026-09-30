#!/usr/bin/env node
// B13. One list of backend path prefixes, identical everywhere: the development proxy, the service-worker denylist, the
// frontend container's nginx config, the reference proxy's nginx config, and the Helm Ingress. The list lives once in
// src/lib/backend-routes.ts; every other place is checked against it.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { backendPrefixes } from "./lib/backend-prefixes.mjs";

const expected = backendPrefixes();
const failures = [];
const evidence = { expected, checked: {} };
const same = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function record(name, found, note = "") {
  evidence.checked[name] = { found, note };
  if (!same(expected, found))
    failures.push(
      `${name}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)}`,
    );
}

function nginxPrefixes(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(
    /location\s+~\s+\^\/\(\?:([^)]+)\)\(\?:\/\|\$\)/g,
  )) {
    found.push(match[1].split("|"));
  }
  return found;
}

for (const file of [
  "deploy/nginx/web.conf",
  "deploy/nginx/proxy.conf.template",
]) {
  const lists = nginxPrefixes(file);
  if (lists.length !== 1)
    failures.push(
      `${file}: expected exactly one backend location, found ${lists.length}`,
    );
  else record(file, lists[0]);
}

// Structural checks: the dev proxy and the worker read the shared module, not a copy.
const vite = readFileSync("vite.config.ts", "utf8");
if (
  !/backendPaths\.map/.test(vite) ||
  !/from "\.\/src\/lib\/backend-routes\.ts"/.test(vite)
) {
  failures.push(
    "vite.config.ts must build the proxy from backendPaths in src/lib/backend-routes.ts",
  );
}
if (!/preview:\s*\{\s*proxy/.test(vite))
  failures.push("vite.config.ts must apply the same proxy to preview");
evidence.checked["vite.config.ts"] = {
  found: expected,
  note: "derived from backendPaths (dev and preview)",
};
const worker = readFileSync("src/sw.ts", "utf8");
if (
  !/denylist:\s*backendPaths/.test(worker) ||
  !/from "\.\/lib\/backend-routes"/.test(worker)
) {
  failures.push("src/sw.ts must use backendPaths as the navigation denylist");
}
evidence.checked["src/sw.ts"] = {
  found: expected,
  note: "denylist is backendPaths",
};

const compose = readFileSync("deploy/compose.yaml", "utf8");
if (!compose.includes("nginx/proxy.conf.template"))
  failures.push(
    "deploy/compose.yaml must mount deploy/nginx/proxy.conf.template",
  );

// Helm: values list, and the rendered Ingress when helm is available.
const values = readFileSync("charts/atlas-web/values.yaml", "utf8");
const block = /backendPaths:\s*\n((?:\s+-\s+\S+\n)+)/.exec(values);
record(
  "charts/atlas-web/values.yaml ingress.backendPaths",
  block ? [...block[1].matchAll(/-\s+\/(\S+)/g)].map((m) => m[1]) : [],
);
try {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "parity",
      "charts/atlas-web",
      "--set",
      "image.repository=registry.example/atlas-web",
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.host=atlas.example.test",
      "--set",
      "ingress.backend.serviceName=atlas-backend",
    ],
    { encoding: "utf8" },
  );
  const ingress =
    rendered.split(/^---$/m).find((doc) => /kind:\s*Ingress/.test(doc)) ?? "";
  const backendPaths = [];
  let frontendRoot = false;
  for (const rule of ingress.split(/\n\s+- path:/).slice(1)) {
    const path = /^\s*(\S+)/.exec(rule)?.[1];
    const service = /name:\s*(\S+)/.exec(rule)?.[1] ?? "";
    if (path === "/" && service.includes("atlas-web")) frontendRoot = true;
    else if (path && service === "atlas-backend")
      backendPaths.push(path.replace(/^\//, ""));
    if (path && path !== "/" && !/pathType:\s*Prefix/.test(rule))
      failures.push(`Ingress path ${path} must be pathType Prefix`);
  }
  record("helm template: rendered Ingress backend paths", backendPaths);
  if (!frontendRoot)
    failures.push(
      "helm template: the Ingress must route / to the atlas-web service",
    );
} catch (error) {
  failures.push(
    `helm template failed or helm is missing: ${error.message.split("\n")[0]}`,
  );
}

mkdirSync(".agtx/evidence/WEB-07/B13", { recursive: true });
writeFileSync(
  ".agtx/evidence/WEB-07/B13/route-parity.json",
  `${JSON.stringify({ ...evidence, failures }, null, 2)}\n`,
);
if (failures.length > 0) {
  console.error(`Route parity FAILED:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `Route parity ok: ${expected.join(", ")} identical in ${Object.keys(evidence.checked).length} places.`,
);
