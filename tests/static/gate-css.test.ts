import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * WEB-11a revision 27 (review 28, R28.1): a STATIC guard of the gate's stylesheet. It is not the evidence that a closed gate is absent:
 * jsdom has no layout. The native evidence is S-GATE "R28.1" (tests/e2e/fixture.session-gate.spec.ts) and E-P50
 * (tests/e2e/fixture.people-restore.spec.ts), which read the engine's rendering and hit testing and then click.
 *
 * The resume gate keeps its closed `<dialog>` in the document. An author `display` on the gate element that does not require `[open]`
 * overrides the browser's hiding of a closed dialog, so the closed gate covers the page and takes every click. Every gate is a native
 * `<dialog>` that is open whenever it is shown, so the layout is scoped to `[open]`.
 */
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The innermost `selector { declarations }` blocks of a stylesheet (at-rule wrappers such as `@layer base { … }` are skipped). */
function rules(css: string): Array<{ selector: string; body: string }> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? "").trim(),
    body: match[2] ?? "",
  }));
}
/** Selectors that style the gate ELEMENT itself (`.neutral-gate`, possibly compound), not a descendant or a `__` part. */
const gateItself = (selector: string) =>
  /^(?:dialog)?\.neutral-gate(?![\w-])[^\s>+~]*$/.test(selector);

describe("the neutral gate's stylesheet (src/styles/base.css)", () => {
  const css = read("src/styles/base.css");
  const gateRules = rules(css).flatMap(({ selector, body }) =>
    selector
      .split(",")
      .map((part) => part.trim())
      .filter(gateItself)
      .map((part) => ({ selector: part, body })),
  );

  test("lays out an OPEN gate as the opaque full-viewport cover (positive control: the parser finds the rule)", () => {
    const open = gateRules.filter(({ selector }) =>
      selector.includes("[open]"),
    );
    expect(open.map(({ selector }) => selector)).toEqual([
      ".neutral-gate[open]",
    ]);
    const body = open[0]?.body ?? "";
    for (const declaration of [
      /position:\s*fixed/,
      /inset:\s*0/,
      /z-index:\s*100/,
      /display:\s*flex/,
      /background:\s*var\(--background\)/,
    ])
      expect(body).toMatch(declaration);
  });

  test("never gives the gate element a display (or any layout) that a CLOSED dialog would keep", () => {
    const unscoped = gateRules.filter(
      ({ selector, body }) =>
        !selector.includes("[open]") &&
        /(?:^|[;\s])(?:display|position|inset|z-index)\s*:/.test(body),
    );
    expect(unscoped).toEqual([]);
  });
});

describe("every element given the gate's root class is a native <dialog>", () => {
  // Scoping the layout to `[open]` styles only dialogs: a non-dialog consumer would lose the cover without failing anything else.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|html)$/.test(name)) files.push(relative(root, path));
    }
  };
  walk(join(root, "src"));
  files.push("index.html", "fixture.html");
  const consumers = files.filter((file) =>
    /["'\s]neutral-gate["'\s]/.test(read(file)),
  );

  test("the known consumers, and only those", () => {
    expect(consumers.sort()).toEqual([
      "fixture.html",
      "index.html",
      "src/components/ui/gate-dialog.ts",
      "src/components/ui/neutral-gate.tsx",
    ]);
  });

  test.each([
    ["index.html", /<dialog open class="neutral-gate"/],
    ["fixture.html", /<dialog open class="neutral-gate"/],
    [
      "src/components/ui/neutral-gate.tsx",
      /<dialog open className="neutral-gate"/,
    ],
  ])("%s renders it as an open <dialog>", (file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  test("the resume gate builds a <dialog> and shows it with showModal()", () => {
    const source = read("src/components/ui/gate-dialog.ts");
    expect(source).toMatch(/createElement\("dialog"\)/);
    expect(source).toMatch(/element\.className = "neutral-gate";/);
    expect(source).toMatch(/dialog\.showModal\(\)/);
  });
});
