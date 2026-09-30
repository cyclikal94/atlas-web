import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * B4. Runs the repository's real biome.json and lint/*.grit against known-bad and known-good snippets placed at the
 * paths the rules are scoped to. Each bad fixture must yield exactly the expected diagnostics (rule and line); each good
 * fixture must yield none. Only diagnostics from plugins are compared; the ordinary Biome rules are covered by `pnpm lint`.
 */
const root = resolve(__dirname, "../..");
const biome = join(root, "node_modules/.bin/biome");

interface Fixture {
  name: string;
  path: string;
  code: string;
  /** Expected [rule, line] pairs, each pair once. An empty list means the fixture must be clean. */
  expected: Array<[string, number]>;
}

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

const fixtures: Fixture[] = [
  {
    name: "R1: every raw network primitive is caught in feature code",
    path: "src/features/x/net.ts",
    code: lines(
      'export const a = () => fetch("/x");',
      'export const b = () => window.fetch("/x");',
      'export const c = () => globalThis.fetch("/x");',
      'export const d = () => self.fetch("/x");',
      "export const e = () => new XMLHttpRequest();",
      'export const f = () => new WebSocket("wss://x");',
      'export const g = () => new EventSource("/x");',
      'export const h = () => navigator.sendBeacon("/x", "y");',
    ),
    expected: [1, 2, 3, 4, 5, 6, 7, 8].map(
      (line) => ["R1", line] as [string, number],
    ),
  },
  {
    name: "R1: a bare imported fetch identifier is caught",
    path: "src/features/x/imported.ts",
    code: lines(
      'import { fetch } from "some-polyfill";',
      'export const a = () => fetch("/x");',
    ),
    expected: [
      ["R1", 1],
      ["R1", 2],
    ],
  },
  {
    name: "R1: the service worker is covered too",
    path: "src/sw.ts",
    code: lines(
      'self.addEventListener("fetch", () => {});',
      'export const a = () => fetch("/x");',
    ),
    expected: [["R1", 2]],
  },
  {
    name: "R1: the api-client folder may reach the network",
    path: "src/lib/api-client/wrapper.ts",
    code: lines(
      'export const a = () => fetch("/x");',
      "export const b = () => new XMLHttpRequest();",
    ),
    expected: [],
  },
  {
    name: "R1: similarly named things are not caught",
    path: "src/features/x/similar.ts",
    code: lines(
      "export const a = (q: { fetchQuery(): void; fetchStatus: string }) => [q.fetchQuery(), q.fetchStatus];",
      'export const b = "fetch is only text here";',
    ),
    expected: [],
  },
  {
    name: "R1: tests and scripts are outside src and are not linted by the plugin",
    path: "tests/net.test.ts",
    code: lines('export const a = () => fetch("/x");'),
    expected: [],
  },
  {
    name: "R2: navigator.locks.query() is caught, request() is not",
    path: "src/features/x/locks.ts",
    code: lines(
      "export const a = () => navigator.locks.query();",
      "export const b = (locks: LockManager) => locks.query();",
      'export const c = () => navigator.locks.request("n", () => {});',
    ),
    expected: [
      ["R2", 1],
      ["R2", 2],
    ],
  },
  {
    name: "R3: portals and portal-producing imports are caught outside the ui folder",
    path: "src/features/x/portal.tsx",
    code: lines(
      'import { createPortal } from "react-dom";',
      'import * as Dialog from "@radix-ui/react-dialog";',
      'import { Tooltip } from "@radix-ui/react-tooltip";',
      'import * as Popover from "@radix-ui/react-popover";',
      "export const a = () => createPortal(<div />, document.body);",
      'export const b = (d: typeof import("react-dom")) => d.createPortal(<div />, document.body);',
      'export function c() { document.body.append(document.createElement("div")); }',
      'export function d() { document.body.insertAdjacentHTML("beforeend", "x"); }',
      'export function e() { document.write("x"); }',
      "export const used = [Dialog, Tooltip, Popover];",
    ),
    expected: [
      ["R3", 1],
      ["R3", 2],
      ["R3", 3],
      ["R3", 4],
      ["R3", 5],
      ["R3", 6],
      ["R3", 7],
      ["R3", 8],
      ["R3", 9],
    ],
  },
  {
    name: "R3: the same code is allowed inside src/components/ui",
    path: "src/components/ui/portal-usage.tsx",
    code: lines(
      'import { createPortal } from "react-dom";',
      'import * as Dialog from "@radix-ui/react-dialog";',
      "export const a = () => [createPortal(<div />, document.body), Dialog];",
    ),
    expected: [],
  },
  {
    name: "R3: createRoot and harmless document.body use are not portals",
    path: "src/features/x/harmless.tsx",
    code: lines(
      'import { createRoot } from "react-dom/client";',
      'export const a = () => { document.body.dataset.x = "1"; return createRoot; };',
      'export const b = () => document.getElementById("x")?.append("y");',
    ),
    expected: [],
  },
  {
    name: "R4: importing the gate is caught outside its allowlist",
    path: "src/features/x/gate.ts",
    code: lines(
      'import { liftGate } from "../../protected-surface/gate";',
      'import { applyGate } from "../../protected-surface/gate.ts";',
      'export const a = () => import("../../protected-surface/gate");',
      "export const used = [liftGate, applyGate];",
    ),
    expected: [
      ["R4", 1],
      ["R4", 2],
      ["R4", 3],
    ],
  },
  ...[
    "src/session/uses-gate.ts",
    "src/fixture/uses-gate.ts",
    "src/protected-surface/uses-gate.ts",
  ].map(
    (path): Fixture => ({
      name: `R4: ${path} may import the gate`,
      path,
      code: lines(
        'import { liftGate } from "../protected-surface/gate";',
        "export const a = liftGate;",
      ),
      expected: [],
    }),
  ),
  {
    name: "R5: writing document.title is caught outside the title module",
    path: "src/features/x/title.ts",
    code: lines(
      'export const a = () => { document.title = "x"; };',
      'export const b = () => { window.document.title = "x"; };',
      'export const c = () => { globalThis.document.title = "x"; };',
      'export const d = () => { document.title += "x"; };',
      "export const e = () => document.title;",
    ),
    expected: [1, 2, 3, 4].map((line) => ["R5", line] as [string, number]),
  },
  {
    name: "R5: the title module may write it",
    path: "src/protected-surface/title.ts",
    code: lines('export const a = () => { document.title = "x"; };'),
    expected: [],
  },
  {
    name: "R6: aria-live and status, alert and log roles are caught outside the registry",
    path: "src/features/x/live.tsx",
    code: lines(
      'export const a = <div aria-live="polite">x</div>;',
      'export const b = <div role="status">x</div>;',
      'export const c = <span role="alert" />;',
      'export const d = <div role="log">x</div>;',
      'export const e = <p aria-live="assertive" className="x" />;',
      'export const f = <div role="dialog" aria-label="ok">x</div>;',
    ),
    expected: [1, 2, 3, 4, 5].map((line) => ["R6", line] as [string, number]),
  },
  ...["announcer", "sync-status", "neutral-gate"].map(
    (name): Fixture => ({
      name: `R6: ${name} may hold live regions`,
      path: `src/components/ui/${name}.tsx`,
      code: lines(
        'export const a = <div role="status" aria-live="polite">x</div>;',
        'export const b = <div role="alert" />;',
      ),
      expected: [],
    }),
  ),
  {
    name: "R6: another ui component may not",
    path: "src/components/ui/other.tsx",
    code: lines('export const a = <div role="status">x</div>;'),
    expected: [["R6", 1]],
  },
];

let scratch = "";
let diagnostics: Array<{ path: string; rule: string; line: number }> = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "atlas-lint-"));
  cpSync(join(root, "biome.json"), join(scratch, "biome.json"));
  mkdirSync(join(scratch, "lint"));
  for (const file of readdirSync(join(root, "lint"))) {
    if (file.endsWith(".grit"))
      cpSync(join(root, "lint", file), join(scratch, "lint", file));
  }
  for (const fixture of fixtures) {
    const target = join(scratch, fixture.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, fixture.code);
  }
  const result = spawnSync(
    biome,
    ["lint", "--reporter=json", "--max-diagnostics=1000", "."],
    {
      cwd: scratch,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{
      category: string;
      message: string;
      location?: { path?: string; start?: { line: number } };
    }>;
  };
  diagnostics = report.diagnostics
    .filter((d) => d.category === "plugin")
    .map((d) => ({
      path: d.location?.path ?? "",
      rule: /^(R\d+)/.exec(d.message)?.[1] ?? d.message,
      line: d.location?.start?.line ?? 0,
    }));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("guardrail rules R1 to R6 (fixture suite)", () => {
  test.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const found = diagnostics.filter((d) => d.path === fixture.path);
      const pairs = [
        ...new Set(found.map((d) => `${d.rule}@${d.line}`)),
      ].sort();
      const expected = fixture.expected
        .map(([rule, line]) => `${rule}@${line}`)
        .sort();
      expect(pairs).toEqual(expected);
    },
  );

  test("the plugin engine reported no load errors", () => {
    expect(diagnostics.every((d) => /^R\d+$/.test(d.rule))).toBe(true);
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
