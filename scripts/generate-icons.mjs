#!/usr/bin/env node
// WEB-14a. Renders the installable app's PNG icons from public/favicon.svg (the accepted mark: an indigo rounded square) with Playwright's
// Chromium, into public/icons/. Run by hand when the mark changes; the PNGs are committed, and tests/static/pwa-manifest.test.ts checks
// their sizes against the manifest.
//
//   node scripts/generate-icons.mjs
//
// - icon-192.png, icon-512.png ("any"): the mark on a transparent background, as the SVG draws it.
// - icon-maskable-512.png ("maskable"): the mark inside the 80 % safe zone on the theme's background, so a platform's mask never cuts it.
// - apple-touch-icon.png (180): iOS draws no transparency, so the mark is on the theme's background, full bleed.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "public/favicon.svg"), "utf8");
const BACKGROUND = "#08090A";
const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });

const icons = [
  { file: "icon-192.png", size: 192, inset: 0, background: "transparent" },
  { file: "icon-512.png", size: 512, inset: 0, background: "transparent" },
  // The safe zone of a maskable icon is the centre circle of radius 40 % of the size: the mark's square fits in 80 %.
  {
    file: "icon-maskable-512.png",
    size: 512,
    inset: 0.1 * 512 + 0.1 * 0.8 * 512,
    background: BACKGROUND,
  },
  {
    file: "apple-touch-icon.png",
    size: 180,
    inset: 0.12 * 180,
    background: BACKGROUND,
  },
];

const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
    });
    const inner = icon.size - 2 * icon.inset;
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${icon.background}">` +
        `<div style="position:absolute;left:${icon.inset}px;top:${icon.inset}px;width:${inner}px;height:${inner}px">` +
        svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `) +
        "</div></body></html>",
    );
    await page.screenshot({
      path: join(out, icon.file),
      omitBackground: icon.background === "transparent",
      clip: { x: 0, y: 0, width: icon.size, height: icon.size },
    });
    await page.close();
    console.log(`public/icons/${icon.file} ${icon.size}x${icon.size}`);
  }
} finally {
  await browser.close();
}
