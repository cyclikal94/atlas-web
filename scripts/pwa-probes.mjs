#!/usr/bin/env node
// QUALIFICATION PROBE Q-P0 (WEB-14a plan 8.1). Decides, per engine and per kind of browser context (ephemeral `newContext`, persistent
// `launchPersistentContext`), how the PWA browser checks can take the network away from a page controlled by the service worker:
//
//   cache      Cache Storage entries the worker wrote survive a navigation (an ephemeral WebKit context was found to drop them, WEB-09c r1)
//   offline    a worker-served navigation works under `context.setOffline(true)`
//   dark       a worker-served navigation works when the server destroys every connection (scripts/serve-generations.mjs dark mode)
//   passed     a request the worker does not answer (`/health`) still reaches the network (the server's log sees it)
//
// It registers the worker by hand (dist-pwa/fixture-a, no session): it probes the platform, not the app. Writes one JSON result.
//
//   node scripts/pwa-probes.mjs --out <file.json> [--browsers chromium,firefox,webkit]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit } from "@playwright/test";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const out = arg("--out", null);
if (!out) throw new Error("--out <file.json> is required");
const engines = { chromium, firefox, webkit };
const browsers = arg("--browsers", "chromium,firefox,webkit").split(",");

const server = spawn(
  process.execPath,
  ["scripts/serve-generations.mjs", "--generation", "fixture-a"],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const urls = await new Promise((resolve, reject) => {
  server.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
  server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
});
const control = async (path, init) =>
  (await fetch(`${urls.control}${path}`, { method: "POST", ...init })).json();

const attempt = async (fn, ms = 20_000) => {
  try {
    let timer;
    const value = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${ms} ms`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).split("\n")[0] };
  }
};

async function probe(engine, persistent) {
  const type = engines[engine];
  let dir = null;
  let browser = null;
  let context;
  if (persistent) {
    dir = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), `pwa-probe-${engine}-`),
    );
    context = await type.launchPersistentContext(dir, {});
  } else {
    browser = await type.launch();
    context = await browser.newContext();
  }
  const result = { engine, persistent };
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await control("/dark?on=0");
    await page.goto(`${urls.url}/__neutral`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    result.controlled = await page.evaluate(
      () => navigator.serviceWorker.controller !== null,
    );
    result.cache = await attempt(() =>
      page.evaluate(async () => {
        const keys = await caches.keys();
        let entries = 0;
        for (const key of keys)
          entries += (await (await caches.open(key)).keys()).length;
        return { keys: keys.length, entries };
      }),
    );
    // A same-document navigation away and back, then count again.
    await page.goto(`${urls.url}/__neutral?again=1`);
    result.cacheAfterNavigation = await attempt(() =>
      page.evaluate(async () => {
        let entries = 0;
        for (const key of await caches.keys())
          entries += (await (await caches.open(key)).keys()).length;
        return entries;
      }),
    );
    await control("/log/clear");
    result.passed = await attempt(async () => {
      const status = await page.evaluate(
        async () => (await fetch("/health")).status,
      );
      const log = await (await fetch(`${urls.control}/log`)).json();
      return {
        status,
        reachedServer: log.some((entry) => entry.path === "/health"),
      };
    });
    await context.setOffline(true);
    result.offline = await attempt(async () => {
      const response = await page.goto(`${urls.url}/tasks/never-visited`, {
        timeout: 10_000,
      });
      return { status: response?.status() ?? null, title: await page.title() };
    });
    await context.setOffline(false);
    await control("/dark?on=1");
    result.dark = await attempt(async () => {
      const response = await page.goto(`${urls.url}/tasks/also-never-visited`, {
        timeout: 10_000,
      });
      return { status: response?.status() ?? null, title: await page.title() };
    });
    await control("/dark?on=0");
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return result;
}

const results = [];
try {
  for (const engine of browsers)
    for (const persistent of [false, true]) {
      const result = await attempt(() => probe(engine, persistent), 120_000);
      results.push(
        result.ok ? result.value : { engine, persistent, error: result.error },
      );
      console.log(JSON.stringify(results.at(-1)));
    }
} finally {
  server.kill("SIGTERM");
}
writeFileSync(
  out,
  `${JSON.stringify({ probe: "Q-P0", at: new Date().toISOString(), results }, null, 2)}\n`,
);
