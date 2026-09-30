import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(__dirname, "../..", file), "utf8");
const documents = {
  "index.html": read("index.html"),
  "fixture.html": read("fixture.html"),
};

describe.each(Object.entries(documents))(
  "%s (the static shell)",
  (_name, html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");

    test("ships #protected-root inert and hidden from assistive technology, and empty", () => {
      const root = doc.getElementById("protected-root");
      expect(root).not.toBeNull();
      expect(root?.hasAttribute("inert")).toBe(true);
      expect(root?.getAttribute("aria-hidden")).toBe("true");
      expect(root?.childElementCount).toBe(0);
      expect(root?.textContent?.trim()).toBe("");
    });

    test("ships a visible neutral boot gate in the neutral root, before any script runs", () => {
      const gate = doc.querySelector("#neutral-root dialog.neutral-gate");
      expect(gate).not.toBeNull();
      expect(gate?.hasAttribute("open")).toBe(true);
      expect(gate?.getAttribute("aria-labelledby")).toBe("gate-heading");
      expect(doc.getElementById("gate-heading")?.textContent).toBe("Atlas");
      expect(gate?.textContent).toContain("Opening Atlas…");
    });

    test("the boot gate is outside the protected root", () => {
      expect(
        doc
          .getElementById("protected-root")
          ?.contains(doc.querySelector(".neutral-gate")),
      ).toBe(false);
    });

    test("has no inline script and no inline style, because the content security policy forbids both", () => {
      for (const script of Array.from(doc.querySelectorAll("script"))) {
        expect(script.hasAttribute("src"), script.outerHTML).toBe(true);
      }
      expect(doc.querySelectorAll("style")).toHaveLength(0);
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    test("loads the pre-paint theme script synchronously in the head, before the module bundle", () => {
      const head = doc.head.querySelector('script[src="/theme-init.js"]');
      expect(head).not.toBeNull();
      expect(head?.hasAttribute("defer")).toBe(false);
      expect(head?.hasAttribute("async")).toBe(false);
      expect(head?.hasAttribute("type")).toBe(false);
    });

    test("declares per-scheme theme-color values that are accepted canvas tokens", () => {
      const colours = Array.from(
        doc.querySelectorAll('meta[name="theme-color"]'),
      ).map((meta) => [
        meta.getAttribute("media"),
        meta.getAttribute("content"),
      ]);
      expect(colours).toEqual([
        ["(prefers-color-scheme: dark)", "#08090A"],
        ["(prefers-color-scheme: light)", "#F7F8F9"],
      ]);
      expect(html).not.toContain("#14141a");
    });

    test("has a language, a viewport and a favicon (so /favicon.ico is never requested)", () => {
      expect(doc.documentElement.lang).toBe("en-GB");
      expect(
        doc.querySelector('meta[name="viewport"]')?.getAttribute("content"),
      ).toContain("width=device-width");
      expect(doc.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
        "/favicon.svg",
      );
    });

    test("keeps the noscript message from contradicting the boot message", () => {
      expect(doc.querySelector("head noscript")?.innerHTML ?? html).toContain(
        "noscript.css",
      );
      expect(html).toContain("Atlas needs JavaScript to open.");
    });
  },
);

test("only the fixture page loads the fixture entry, and only the production page loads the production entry", () => {
  expect(documents["index.html"]).toContain('src="/src/main.tsx"');
  expect(documents["index.html"]).not.toContain("fixture");
  expect(documents["fixture.html"]).toContain('src="/src/fixture/main.tsx"');
});
