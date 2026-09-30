import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { contrastRatio } from "../../src/design/contrast";
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

/** Extracts the declarations of one rule. `selector` is matched literally, at the start of a line. */
function block(selector: string, source = css): Record<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  const end = source.indexOf("}", start);
  const body = source.slice(start + selector.length + 2, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*--([a-z0-9-]+):\s*(.+?);\s*$/gm)) {
    // The formatter lowercases hex colours; the mirror and the docs use upper case.
    if (match[1] && match[2])
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

  test("theme-color values equal the canvas tokens", () => {
    expect(THEME_COLOR.dark).toBe(tokens.dark.canvas);
    expect(THEME_COLOR.light).toBe(tokens.light.canvas);
  });

  test("Auto light applies only while no explicit dark choice exists", () => {
    expect(css).toContain(':root:not([data-theme="dark"])');
    expect(css).toMatch(/@media \(prefers-color-scheme: light\)/);
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toContain("light-dark(");
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
        contrastRatio(tokens[theme]["field-edge"], tokens[theme][surface]),
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("findings recorded in docs/design-tokens.md", () => {
  const ratio = (
    theme: "dark" | "light",
    a: keyof typeof tokens.dark,
    b: keyof typeof tokens.dark,
  ) => contrastRatio(tokens[theme][a], tokens[theme][b]);

  test("F1: light field-edge is below 3:1 on raised and chrome, which is why inputs fill from canvas or panel only", () => {
    expect(ratio("light", "field-edge", "raised")).toBeLessThan(3);
    expect(ratio("light", "field-edge", "chrome")).toBeLessThan(3);
    expect(inputFillSurfaces).toEqual(["canvas", "panel"]);
  });

  test("F3: ink-3 is not permitted on the tinted or inset surfaces", () => {
    expect(ratio("dark", "ink-3", "chrome-inset")).toBeLessThan(4.5);
    expect(ratio("dark", "ink-3", "nav-active")).toBeLessThan(4.5);
    expect(ratio("dark", "ink-3", "rail-hover")).toBeLessThan(4.5);
  });

  test("F5: the design's unselected radio ring (placeholder) fails 3:1, so field-edge replaces it", () => {
    expect(ratio("dark", "placeholder", "panel")).toBeLessThan(3);
    expect(ratio("dark", "field-edge", "panel")).toBeGreaterThanOrEqual(3);
  });

  test("F6: nav-active on chrome is not a perceivable cue on its own", () => {
    expect(ratio("dark", "nav-active", "chrome")).toBeLessThan(3);
    expect(ratio("light", "nav-active", "chrome")).toBeLessThan(3);
  });

  test("the quoted 3.02:1 for light field-edge on white is really 3.22:1", () => {
    expect(ratio("light", "field-edge", "panel")).toBeCloseTo(3.22, 1);
  });
});

describe("mutation check", () => {
  test("a deliberately broken token value is caught by the guard", () => {
    const broken = { ...tokens.dark, "field-edge": tokens.dark.hairline };
    const failing = declaredPairs.filter(
      (pair) =>
        contrastRatio(broken[pair.fg], broken[pair.bg]) < minimumFor(pair.kind),
    );
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((pair) => pair.fg === "field-edge")).toBe(true);
  });
});

describe("input component", () => {
  test("never uses a hairline token for its edge", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/ui/input.tsx"),
      "utf8",
    );
    expect(source).toContain("border-field-edge");
    expect(source).not.toMatch(/border-hairline/);
  });
});
