import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ST-1 (WEB-09b, P-3 and P-13): production LEADS. The protected tree is unmounted under every fence, and recovery must run exactly
 * then, so the sync leader is composed at session level by the boot sequence; a composition that forgot it would ship a client whose
 * chip reads "Updates stopped" for ever and whose recovery never runs. Like the persistence hold's test, this checks the text of the
 * composition: removing the call, defaulting it off, or making the shim load the leader statically fails here.
 */
const read = (path: string): string => readFileSync(path, "utf8");
/** The code alone: comments removed (they name the rules they keep). */
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the production composition starts the sync leader", () => {
  it("boot announces the leader before the session starts and starts it after, unless asked not to (default on)", () => {
    const boot = read("src/app/boot.tsx");
    expect(boot).toMatch(/const leads = options\.dataLeader !== false;/);
    const announce = boot.indexOf("dataLeader.announce()");
    const start = boot.indexOf("await session.start(");
    const lead = boot.indexOf("dataLeader.start(session");
    expect(announce).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(announce);
    expect(lead).toBeGreaterThan(start);
  });

  it("main.tsx never turns it off; only the fixture session harness may, and only when the page does not ask for it", () => {
    expect(read("src/main.tsx")).not.toContain("dataLeader");
    expect(read("src/fixture/session-harness/main.tsx")).toMatch(
      /dataLeader: productionLeader/,
    );
  });

  it("the shim reaches the leader only through a dynamic import, so neither Dexie nor the engines enter the initial chunk", () => {
    const shim = read("src/data/leader/start.ts");
    expect(shim).toContain('import("../ui/browser-leader")');
    expect(shim).not.toMatch(/^import [^;]*from "\.\.\/ui\/browser-leader"/m);
    expect(read("src/app/data-leader.ts")).not.toMatch(
      /browser-leader|leader\/leader/,
    );
  });

  it("the leader's runtime is the browser composition's, so its commits take `session.persistence` (G5)", () => {
    const leader = read("src/data/ui/browser-leader.ts");
    expect(leader).toMatch(/createBrowserRuntime\(session\)/);
    expect(leader).toMatch(/host\.setRuntime\(/);
    expect(leader).not.toContain("unorderedPersistence");
    expect(read("src/data/ui/browser-env.ts")).toMatch(
      /persistence:\s*session\.persistence\b/,
    );
  });

  it("the provider uses the page's runtime whenever a leader was started, and never builds a second one over the same registry", () => {
    const react = read("src/data/ui/react.tsx");
    expect(react).toMatch(
      /if \(leaderStarted\(\) \|\| host\.runtime\.get\(\) !== null\)/,
    );
    expect(react).toContain("markers: host.markers");
  });

  it("the one leader lock is fixed and origin-wide, and the leader never queries locks", () => {
    expect(read("src/data/model/config.ts")).toContain(
      'syncLeaderLock: "atlas-sync-leader"',
    );
    for (const path of [
      "src/data/leader/election.ts",
      "src/data/leader/leader.ts",
      "src/data/ui/browser-leader.ts",
    ])
      expect(code(path), path).not.toMatch(/\.query\(|steal/);
  });
});
