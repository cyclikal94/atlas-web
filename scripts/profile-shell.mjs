#!/usr/bin/env node
// A2. Loads the fixture shell in Chromium with network and CPU throttling (fast 4G and slow 4G, 4x CPU) from a cold cache, three times
// each, and records LCP, CLS, first contentful paint, how long the fallback font could be visible (FOUT window) and bytes
// transferred. It MEASURES; it makes no correctness claim and has no pass criterion beyond "the numbers were recorded".
// The figures set the baseline WEB-09 profiling starts from. Run it against the throttling-free real server configuration
// (a container serving dist-fixture through deploy/nginx/web.conf), so compression and caching are the real ones:
//
//   node scripts/profile-shell.mjs --url http://127.0.0.1:PORT/today [--out <file>]
//
// `--out` names the results file (the sync-profiling programme's P-1S writes into its own evidence directory); without it the file is
// WEB-07's `.agtx/evidence/WEB-07/A2/shell-profile.json`, as before. `--build` names the build measured (dist or dist-fixture).
//
// Every cold run records its own collection window (`from`: before its browser context opens; `to`: after its figures are read), and
// the file carries the programme stage and invocation it ran under (ATLAS_PROFILE_STAGE, ATLAS_PROFILE_INVOCATION), so the programme
// judges every run's isolation over the load samples of its stage (WEB-09c review R1). Run standalone, the file has no stage and no
// load samples: its figures are a diagnostic and can never be judged isolated, wherever the file is later copied.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const url = args.includes("--url")
  ? args[args.indexOf("--url") + 1]
  : "http://127.0.0.1:4174/today?pending=2";
const outFile = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : ".agtx/evidence/WEB-07/A2/shell-profile.json";
const build = args.includes("--build")
  ? args[args.indexOf("--build") + 1]
  : null;
const RUNS = 3;
// Chrome DevTools / Lighthouse network presets.
const PROFILES = {
  "fast-4g": {
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
    latency: 40,
  },
  "slow-4g": {
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    latency: 150,
  },
};
const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};
const median = (values) =>
  values.length === 0
    ? Number.NaN
    : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const browser = await chromium.launch();
const results = [];
let failedRuns = 0;
for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
  for (const [profileName, network] of Object.entries(PROFILES)) {
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) {
      const from = new Date().toISOString();
      // A run that fails is recorded with its error and its window, and the measuring goes on: the evidence shows every cell and run.
      let context = null;
      try {
        context = await browser.newContext({ viewport });
        const page = await context.newPage();
        // What the server sent the scripts with: whether the transfer figures below are compressed ones.
        const scriptEncodings = {};
        page.on("response", (response) => {
          if (response.request().resourceType() !== "script") return;
          const encoding = response.headers()["content-encoding"] ?? "identity";
          scriptEncodings[encoding] = (scriptEncodings[encoding] ?? 0) + 1;
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          ...network,
        });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.addInitScript(() => {
          const m = { lcp: 0, cls: 0, fcp: 0, fontsStart: 0, fontsDone: 0 };
          window.__profile = m;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) m.lcp = e.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              if (!e.hadRecentInput) m.cls += e.value;
          }).observe({ type: "layout-shift", buffered: true });
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              if (e.name === "first-contentful-paint") m.fcp = e.startTime;
          }).observe({ type: "paint", buffered: true });
          document.fonts.addEventListener("loading", () => {
            if (!m.fontsStart) m.fontsStart = performance.now();
          });
          document.fonts.addEventListener("loadingdone", () => {
            m.fontsDone = performance.now();
          });
        });
        await page.goto(url, { waitUntil: "load", timeout: 120000 });
        await page.locator("h1").first().waitFor({ timeout: 120000 });
        await page.waitForTimeout(1500);
        const metrics = await page.evaluate(() => {
          const resources = performance.getEntriesByType("resource");
          const nav = performance.getEntriesByType("navigation")[0];
          return {
            ...window.__profile,
            transferBytes:
              resources.reduce((sum, r) => sum + r.transferSize, 0) +
              (nav?.transferSize ?? 0),
            requests: resources.length + 1,
            fonts: document.fonts.size,
            fontsLoaded: [...document.fonts].filter(
              (face) => face.status === "loaded",
            ).length,
          };
        });
        runs.push({
          run: run + 1,
          ...metrics,
          fout: Math.max(0, metrics.fontsDone - metrics.fcp),
          script_encodings: scriptEncodings,
          from,
          to: new Date().toISOString(),
        });
      } catch (error) {
        failedRuns += 1;
        runs.push({
          run: run + 1,
          error: String(error).slice(0, 300),
          from,
          to: new Date().toISOString(),
        });
      }
      await context?.close().catch(() => undefined);
    }
    const ok = runs.filter((r) => !r.error);
    const row = {
      viewport: viewportName,
      network: profileName,
      cpuThrottle: 4,
      runs: RUNS,
      // Medians of the runs that completed; a cell with a failed run is incomplete evidence (the programme's contract says so).
      runs_completed: ok.length,
      lcp_ms: Math.round(median(ok.map((r) => r.lcp))),
      fcp_ms: Math.round(median(ok.map((r) => r.fcp))),
      cls: Number(median(ok.map((r) => r.cls)).toFixed(4)),
      fout_window_ms: Math.round(median(ok.map((r) => r.fout))),
      transfer_kb: Math.round(median(ok.map((r) => r.transferBytes)) / 1024),
      requests: median(ok.map((r) => r.requests)),
      fonts_loaded: `${median(ok.map((r) => r.fontsLoaded))}/${median(ok.map((r) => r.fonts))}`,
      raw: runs,
    };
    results.push(row);
    console.log(
      `${viewportName.padEnd(8)} ${profileName.padEnd(8)} LCP ${row.lcp_ms} ms  FCP ${row.fcp_ms} ms  CLS ${row.cls}  FOUT ${row.fout_window_ms} ms  ${row.transfer_kb} KB in ${row.requests} requests  fonts ${row.fonts_loaded}`,
    );
  }
}
const browserVersion = browser.version();
await browser.close();
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      url,
      build,
      evidence: {
        stage: process.env.ATLAS_PROFILE_STAGE ?? null,
        invocation: process.env.ATLAS_PROFILE_INVOCATION ?? null,
      },
      note: "measurements only; cold cache; median of 3; Chromium; CDP network and CPU throttling (EMULATED, not a device); every run's window is from before its context opened to after its figures were read",
      browser: browserVersion,
      results,
    },
    null,
    2,
  )}\n`,
);
if (failedRuns > 0) {
  console.error(
    `${failedRuns} cold run(s) failed; each is recorded with its error`,
  );
  process.exit(1);
}
