import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { contrastRatio, toHex } from "../../src/design/contrast";
import {
  declaredPairs,
  inputFillSurfaces,
  minimumFor,
} from "../../src/design/contrast-pairs";
import { THEME_COLOR } from "../../src/design/theme";
import { tokenNames, tokens } from "../../src/design/tokens";

const css = readFileSync(
  resolve(__dirname, "../../src/styles/tokens.css"),
  "utf8",
);

/**
 * Extracts the colour declarations of one rule. `selector` is matched literally, at the start of a line. A tweakcn export
 * also carries non-colour properties (`--radius`, fonts, shadows, tracking, spacing); those are not tokens and are ignored.
 */
const NON_COLOUR = /^(radius|font-|shadow|tracking|spacing|letter-spacing)/;
function block(selector: string, source = css): Record<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  const end = source.indexOf("}", start);
  const body = source.slice(start + selector.length + 2, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*--([a-z0-9-]+):\s*(.+?);\s*$/gm)) {
    if (!match[1] || !match[2] || NON_COLOUR.test(match[1])) continue;
    // The formatter lowercases hex colours; the mirror and the docs use upper case.
    out[match[1]] = match[2].replace(/#[0-9a-f]{3,8}\b/gi, (hex) =>
      hex.toUpperCase(),
    );
  }
  return out;
}

const darkDefault = block(":root");
const mediaSource = css.slice(
  css.indexOf("@media (prefers-color-scheme: light)"),
);
const lightAuto = block(':root:not([data-theme="dark"])', mediaSource);
const lightExplicit = block(':root[data-theme="light"]');
const darkExplicit = block(':root[data-theme="dark"]');

describe("tokens.css", () => {
  test("declares every token in every block", () => {
    for (const set of [darkDefault, lightAuto, lightExplicit, darkExplicit]) {
      expect(Object.keys(set).sort()).toEqual([...tokenNames].sort());
    }
  });

  test("the two light blocks (Auto and explicit) are identical, so they cannot drift", () => {
    expect(lightAuto).toEqual(lightExplicit);
  });

  test("the two dark blocks (default and explicit) are identical", () => {
    expect(darkExplicit).toEqual(darkDefault);
  });

  test("the typed mirror matches the CSS", () => {
    expect(darkDefault).toEqual(tokens.dark);
    expect(lightExplicit).toEqual(tokens.light);
  });

  test("every value is a colour the contrast maths can read", () => {
    for (const theme of ["dark", "light"] as const)
      for (const name of tokenNames)
        expect(toHex(tokens[theme][name])).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("theme-color values equal the background tokens", () => {
    expect(THEME_COLOR.dark).toBe(toHex(tokens.dark.background));
    expect(THEME_COLOR.light).toBe(toHex(tokens.light.background));
  });

  test("Auto light applies only while no explicit dark choice exists", () => {
    expect(css).toContain(':root:not([data-theme="dark"])');
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)/);
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toContain("light-dark(");
  });
});

describe("colour parsing (the formats a tweakcn export may use)", () => {
  test("hex, rgb, hsl and oklch all resolve to sRGB hex", () => {
    expect(toHex("#abc")).toBe("#AABBCC");
    expect(toHex("rgb(255, 0, 0)")).toBe("#FF0000");
    expect(toHex("hsl(120 100% 50%)")).toBe("#00FF00");
    expect(toHex("oklch(1 0 0)")).toBe("#FFFFFF");
    expect(toHex("oklch(0 0 0)")).toBe("#000000");
    // oklch(0.6231 0.188 259.81) is Tailwind's blue-500, #3B82F6.
    const blue = toHex("oklch(0.6231 0.188 259.81)");
    const channel = (at: number) => Number.parseInt(blue.slice(at, at + 2), 16);
    expect(Math.abs(channel(1) - 0x3b)).toBeLessThanOrEqual(2);
    expect(Math.abs(channel(3) - 0x82)).toBeLessThanOrEqual(2);
    expect(Math.abs(channel(5) - 0xf6)).toBeLessThanOrEqual(2);
  });

  test("anything else is refused", () => {
    expect(() => toHex("red")).toThrow();
    expect(() => toHex("var(--x)")).toThrow();
  });
});

describe.each(["dark", "light"] as const)("contrast guard (%s)", (theme) => {
  test.each(
    declaredPairs.map((pair) => [`${pair.fg} on ${pair.bg}`, pair] as const),
  )("%s meets its minimum", (_name, pair) => {
    const ratio = contrastRatio(tokens[theme][pair.fg], tokens[theme][pair.bg]);
    expect(ratio, pair.use).toBeGreaterThanOrEqual(minimumFor(pair.kind));
  });

  test("the input border is at least 3:1 on every permitted input fill", () => {
    for (const surface of inputFillSurfaces) {
      expect(
        contrastRatio(tokens[theme].input, tokens[theme][surface]),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("mutation check", () => {
  test("a deliberately broken token value is caught by the guard", () => {
    const broken = { ...tokens.dark, input: tokens.dark.border };
    const failing = declaredPairs.filter(
      (pair) =>
        contrastRatio(broken[pair.fg], broken[pair.bg]) < minimumFor(pair.kind),
    );
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((pair) => pair.fg === "input")).toBe(true);
  });
});

describe("input component", () => {
  test("takes the input edge, never a hairline, and fills only from background or card", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/ui/input.tsx"),
      "utf8",
    );
    expect(source).toContain("border-input");
    expect(source).not.toMatch(/border-border/);
    expect(inputFillSurfaces).toEqual(["background", "card"]);
  });
});
