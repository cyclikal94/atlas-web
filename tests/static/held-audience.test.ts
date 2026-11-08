// WEB-13b revision 36 (Review 43 F43-1; design assessment 4062d86c, I3 and Q7, fallback A′): the audience chooser drops its editing
// controls while it is blocked, so every use of it holds its height through `HeldAudience` (`HeldHeight` around the chooser). F42-4 fixed
// one caller and F43-1 was the sibling that had no reserve; this guard fails when a use of `AudienceChooser` is added anywhere in `src/`
// except inside `HeldAudience`, so the next caller cannot repeat it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SRC = join(ROOT, "src");
const OWNER = "src/features/sharing/AudienceChooser.tsx";
const CONTROLS = "src/features/tasks/detail/Controls.tsx";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every reference to the component itself (not its props type), outside comments and import declarations. */
function references(text: string): number[] {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/import\s*\{[\s\S]*?\}\s*from\s*"[^"]*";/g, (m) =>
      m.replace(/[^\n]/g, " "),
    );
  return [...code.matchAll(/\bAudienceChooser\b(?!Props)/g)].map(
    (m) => m.index ?? -1,
  );
}

/** The span of `function HeldAudience(…) { … }` in Controls.tsx. */
function heldAudience(text: string): {
  start: number;
  end: number;
  body: string;
} {
  const start = text.indexOf("function HeldAudience(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return { start, end, body: text.slice(start, end) };
}

describe("held audience guard (WEB-13b revision 36, F43-1)", () => {
  test("every use of AudienceChooser in src/ is the one inside HeldAudience, which holds the chooser itself while it is blocked", () => {
    const outside: string[] = [];
    let inside = 0;
    for (const path of sources(SRC)) {
      const file = relative(ROOT, path);
      if (file === OWNER) continue;
      const text = readFileSync(path, "utf8");
      const found = references(text);
      if (found.length === 0) continue;
      if (file !== CONTROLS) {
        outside.push(`${file}: ${found.length}`);
        continue;
      }
      const span = heldAudience(text);
      for (const at of found)
        if (at > span.start && at < span.end) inside += 1;
        else
          outside.push(
            `${file}:${text.slice(0, at).split("\n").length} (outside HeldAudience)`,
          );
    }
    expect(outside).toEqual([]);
    expect(inside).toBe(1);
  });

  test("HeldAudience wraps the chooser itself in HeldHeight, held exactly while the chooser is blocked", () => {
    const { body } = heldAudience(readFileSync(join(ROOT, CONTROLS), "utf8"));
    expect(body).toMatch(
      /<HeldHeight held=\{props\.blocked !== null\}>\s*<AudienceChooser \{\.\.\.props\} \/>\s*<\/HeldHeight>/,
    );
  });

  test("the three forms that show an audience use HeldAudience (Enrolled's editor, the kept draft, the join form)", () => {
    const text = readFileSync(join(ROOT, CONTROLS), "utf8");
    expect([...text.matchAll(/<HeldAudience\b/g)]).toHaveLength(3);
  });
});
