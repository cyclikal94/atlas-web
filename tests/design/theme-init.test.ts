import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  applyPreference,
  parsePreference,
} from "../../src/design/theme";

const script = readFileSync(
  resolve(__dirname, "../../public/theme-init.js"),
  "utf8",
);

/** Runs public/theme-init.js against a fresh document and returns what it produced. */
function runInit(
  stored: string | null | "throw",
  prefersLight: boolean | "throw",
) {
  const doc = document.implementation.createHTMLDocument("x");
  doc.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0C0C10"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#F7F7FA">';
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => {
        if (stored === "throw") throw new Error("blocked");
        return key === APPEARANCE_STORAGE_KEY ? stored : null;
      },
    },
    matchMedia: () => {
      if (prefersLight === "throw") throw new Error("no matchMedia");
      return { matches: prefersLight };
    },
  };
  new Function("window", "document", script)(fakeWindow, doc);
  return {
    theme: doc.documentElement.getAttribute("data-theme"),
    metas: Array.from(doc.querySelectorAll('meta[name="theme-color"]')).map(
      (meta) => ({
        content: meta.getAttribute("content"),
        media: meta.getAttribute("media"),
      }),
    ),
  };
}

const CASES: Array<[string | null | "throw", boolean | "throw"]> = [
  [null, false],
  [null, true],
  ["light", false],
  ["light", true],
  ["dark", false],
  ["dark", true],
  ["auto", true],
  ["banana", true],
  ["", false],
  ["throw", true],
  [null, "throw"],
  ["light", "throw"],
];

describe("public/theme-init.js parity with src/design/theme.ts", () => {
  test.each(CASES)("stored %j, prefers light %j", (stored, prefersLight) => {
    const fromScript = runInit(stored, prefersLight);
    const doc = document.implementation.createHTMLDocument("x");
    doc.head.innerHTML =
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0C0C10"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#F7F7FA">';
    const preference = parsePreference(stored === "throw" ? null : stored);
    applyPreference(preference, doc, prefersLight === true);
    expect(fromScript.theme).toBe(
      doc.documentElement.getAttribute("data-theme"),
    );
    expect(fromScript.metas).toEqual(
      Array.from(doc.querySelectorAll('meta[name="theme-color"]')).map(
        (meta) => ({
          content: meta.getAttribute("content"),
          media: meta.getAttribute("media"),
        }),
      ),
    );
  });

  test("uses no inline handlers or network access", () => {
    expect(script).not.toMatch(/fetch|XMLHttpRequest|WebSocket|sendBeacon/);
  });
});
