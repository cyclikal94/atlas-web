// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkInitialChunk,
  initialScripts,
} from "../../scripts/lib/initial-chunk.mjs";

/**
 * S-2 (plan 8.8): the initial-chunk check can FAIL. A check that has never been seen to fail proves nothing, so this builds tiny
 * fake `dist` folders and shows each rule fires, and that a clean one passes. The real build is checked by `check:artefacts`.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function dist(files: Record<string, string>, html: string): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-initial-"));
  made.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), html);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
}
const HTML = `<html><head><script type="module" src="/assets/index.js"></script><link rel="modulepreload" href="/assets/shared.js"></head></html>`;

describe("the initial chunk check", () => {
  test("it reads the entry script and every modulepreload, and nothing lazy", () => {
    expect(
      initialScripts(
        `${HTML}<script type="module" src="/theme-init.js"></script><link rel="stylesheet" href="/assets/a.css">`,
      ),
    ).toEqual(["assets/index.js", "assets/shared.js", "theme-init.js"]);
  });

  test("a clean build passes", () => {
    const dir = dist(
      { "assets/index.js": "boot()", "assets/shared.js": "x" },
      HTML,
    );
    expect(checkInitialChunk(dir)).toEqual([]);
  });

  test.each([
    ["Dexie in the entry script", "assets/index.js", "class DexieError{}"],
    ["Dexie in a modulepreloaded script", "assets/shared.js", "// Dexie.js"],
    [
      "a Dexie error class in the entry script",
      "assets/index.js",
      "class PrematureCommitError{}",
    ],
    [
      "a transaction plan in the entry script",
      "assets/index.js",
      'name:"data.commitPage"',
    ],
    [
      "the outbox plan in a preloaded script",
      "assets/shared.js",
      'name:"data.enqueueDraft"',
    ],
  ])("%s fails", (_name, file, text) => {
    const files: Record<string, string> = {
      "assets/index.js": "ok",
      "assets/shared.js": "ok",
    };
    files[file] = text;
    const findings = checkInitialChunk(dist(files, HTML));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toContain(file);
  });

  test("the entry may NAME the lazy chunk it loads: only the library's own code is forbidden", () => {
    const dir = dist(
      {
        "assets/index.js": 'import("./dexie-adapter-abc.js")',
        "assets/shared.js": "ok",
      },
      HTML,
    );
    expect(checkInitialChunk(dir)).toEqual([]);
  });

  test("a lazy chunk may carry Dexie: only what index.html loads eagerly is checked", () => {
    const dir = dist(
      {
        "assets/index.js": "ok",
        "assets/shared.js": "ok",
        "assets/lazy.js": "class DexieError{}",
      },
      HTML,
    );
    expect(checkInitialChunk(dir)).toEqual([]);
  });

  test("an index.html that loads no script is a finding, not a pass", () => {
    expect(checkInitialChunk(dist({}, "<html></html>")).join()).toContain(
      "nothing was checked",
    );
  });
});
