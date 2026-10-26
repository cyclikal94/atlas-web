#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Applies a tweakcn (or any shadcn-format) theme export to the token files. Usage: node scripts/apply-theme.mjs <theme.css>
// The export's `:root` block becomes the light theme and its `.dark` block the dark theme, written into the four blocks of
// src/styles/tokens.css and mirrored into src/design/tokens.ts; `--radius` goes to src/styles/theme.css. Tokens the export does
// not name keep their current values. docs/design-tokens.md is regenerated. The contrast guard (`pnpm test tests/design`)
// then decides whether the theme can be read.
import { readFileSync, writeFileSync } from "node:fs";
import { tokenNames, tokens } from "../src/design/tokens.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-theme.mjs <theme.css>");
  process.exit(2);
}
const source = readFileSync(file, "utf8");

function declarations(selector) {
  const start = source.search(
    new RegExp(`(^|\\n)\\s*${selector.replace(/[.:]/g, "\\$&")}\\s*\\{`),
  );
  if (start < 0) return {};
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const out = {};
  for (const match of source
    .slice(open + 1, close)
    .matchAll(/--([a-z0-9-]+):\s*([^;]+);/g))
    out[match[1]] = match[2].trim();
  return out;
}
const light = declarations(":root");
const dark = declarations(".dark");
const next = {
  light: { ...tokens.light },
  dark: { ...tokens.dark },
};
let applied = 0;
for (const name of tokenNames) {
  if (light[name]) {
    next.light[name] = light[name];
    applied += 1;
  }
  if (dark[name]) {
    next.dark[name] = dark[name];
    applied += 1;
  }
}
if (applied === 0) {
  console.error(
    "No known tokens found in the export (expected `:root { --background: ... }` and `.dark { ... }`).",
  );
  process.exit(1);
}

const cssPath = "src/styles/tokens.css";
let css = readFileSync(cssPath, "utf8");
const rewrite = (selector, values, indent) => {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("}", start);
  const body = css.slice(start, end);
  const kept = body
    .split("\n")
    .filter((line) => /color-scheme:/.test(line) || /\{$/.test(line));
  const lines = [
    ...kept,
    ...tokenNames.map((name) => `${indent}--${name}: ${values[name]};`),
    indent.slice(2),
  ];
  css = `${css.slice(0, start)}${lines.join("\n")}${css.slice(end)}`;
};
rewrite(":root", next.dark, "  ");
rewrite(':root:not([data-theme="dark"])', next.light, "    ");
rewrite(':root[data-theme="light"]', next.light, "  ");
rewrite(':root[data-theme="dark"]', next.dark, "  ");
writeFileSync(cssPath, css);

const tsPath = "src/design/tokens.ts";
let ts = readFileSync(tsPath, "utf8");
const entries = (values) =>
  tokenNames
    .map(
      (name) =>
        `    "${name}": "${values[name].replace(/#[0-9a-f]{3,8}\b/gi, (h) => h.toUpperCase())}",`,
    )
    .join("\n");
ts = ts.replace(
  /dark: \{[\s\S]*?\n {2}\},\n {2}light: \{[\s\S]*?\n {2}\},/,
  `dark: {\n${entries(next.dark)}\n  },\n  light: {\n${entries(next.light)}\n  },`,
);
writeFileSync(tsPath, ts);

if (light.radius) {
  const themePath = "src/styles/theme.css";
  writeFileSync(
    themePath,
    readFileSync(themePath, "utf8").replace(
      /--radius: [^;]+;/,
      `--radius: ${light.radius};`,
    ),
  );
}
execFileSync(process.execPath, ["scripts/generate-token-docs.mjs"], {
  stdio: "inherit",
});
execFileSync("pnpm", ["exec", "biome", "check", "--write", cssPath, tsPath], {
  stdio: "inherit",
});
console.log(
  `Applied ${applied} token values from ${file}. Run \`pnpm test tests/design\` to check contrast.`,
);
