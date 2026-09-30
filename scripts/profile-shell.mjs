#!/usr/bin/env node
// A2. Loads the fixture shell in Chromium with network and CPU throttling (fast 4G and slow 4G, 4x CPU) from a cold cache, three times
// each, and records LCP, CLS, first contentful paint, how long the fallback font could be visible (FOUT window) and bytes
// transferred. It MEASURES; it makes no correctness claim and has no pass criterion beyond "the numbers were recorded".
// The figures set the baseline WEB-09 profiling starts from. Run it against the throttling-free real server configuration
// (a container serving dist-fixture through deploy/nginx/web.conf), so compression and caching are the real ones:
//
//   node scripts/profile-shell.mjs --url http://127.0.0.1:PORT/today
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const url = args.includes("--url")
  ? args[args.indexOf("--url") + 1]
  : "http://127.0.0.1:4174/today?pending=2";
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
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const browser = await chromium.launch();
const results = [];
for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
  for (const [profileName, network] of Object.entries(PROFILES)) {
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
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
        ...metrics,
        fout: Math.max(0, metrics.fontsDone - metrics.fcp),
      });
      await context.close();
    }
    const row = {
      viewport: viewportName,
      network: profileName,
      cpuThrottle: 4,
      runs: RUNS,
      lcp_ms: Math.round(median(runs.map((r) => r.lcp))),
      fcp_ms: Math.round(median(runs.map((r) => r.fcp))),
      cls: Number(median(runs.map((r) => r.cls)).toFixed(4)),
      fout_window_ms: Math.round(median(runs.map((r) => r.fout))),
      transfer_kb: Math.round(median(runs.map((r) => r.transferBytes)) / 1024),
      requests: median(runs.map((r) => r.requests)),
      fonts_loaded: `${median(runs.map((r) => r.fontsLoaded))}/${median(runs.map((r) => r.fonts))}`,
      raw: runs,
    };
    results.push(row);
    console.log(
      `${viewportName.padEnd(8)} ${profileName.padEnd(8)} LCP ${row.lcp_ms} ms  FCP ${row.fcp_ms} ms  CLS ${row.cls}  FOUT ${row.fout_window_ms} ms  ${row.transfer_kb} KB in ${row.requests} requests  fonts ${row.fonts_loaded}`,
    );
  }
}
await browser.close();
mkdirSync(".agtx/evidence/WEB-07/A2", { recursive: true });
writeFileSync(
  ".agtx/evidence/WEB-07/A2/shell-profile.json",
  `${JSON.stringify({ url, note: "measurements only; cold cache; median of 3; Chromium", results }, null, 2)}\n`,
);
