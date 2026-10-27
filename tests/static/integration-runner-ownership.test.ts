// @vitest-environment node
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ownedGroups } from "../../scripts/integration/process-groups.mjs";
import {
  consumesSourceBudget,
  DEFAULT_STACKS,
  judgeStack,
  PLAYWRIGHT_POLICY,
  passthroughProblems,
  planStacks,
  SOURCE_BUDGET,
  SOURCE_BUDGET_CONSUMERS,
  throttleRecord,
} from "../../scripts/integration/stacks.mjs";
import { paceSignIn, stackFile } from "../integration/stack-state";

/**
 * WEB-08c revision 14 (review 14): this task's own controls for the integration runner, beside the adapted schedule tests
 * (integration-runner.test.ts).
 *
 * R18 `integration-runner-failfast`: review 14 stopped the runner after its failures and found Playwright and its worker still
 * running: the Playwright child was never registered for clean-up, and nothing addressed its descendants. These tests use REAL
 * processes (small Node programmes in a scratch directory): a leader with a grandchild that ignores SIGTERM, a leader that exits
 * before its tree, a leader that reports on SIGINT, and an unowned sentinel that must survive everything.
 *
 * R17 `integration-stack-throttle-isolation`: the source-budget consumers are the pinned backend's own (`source_attempt` callers at
 * v0.29.0-rc.1), counted whatever their status.
 */
const ROOT = resolve(__dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "atlas-ownership-test-"));
const unowned: ChildProcess[] = [];
afterAll(() => {
  for (const child of unowned)
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      // gone
    }
  rmSync(scratch, { recursive: true, force: true });
});

// A leader that starts a grandchild (optionally deaf to SIGTERM) and records both pids only once the grandchild has installed its
// handler (so "deaf" is a fact before any signal is sent), then waits or exits at once.
const TREE = join(scratch, "tree.mjs");
writeFileSync(
  TREE,
  `import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
const [file, deaf, leaderExits] = process.argv.slice(2);
const ready = file + ".ready";
const code = (deaf === "deaf" ? "process.on('SIGTERM', () => {});" : "") + "require('fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);";
const grandchild = spawn(process.execPath, ["-e", code, ready], { stdio: "ignore" });
const proceed = () => {
  if (!existsSync(ready)) return setTimeout(proceed, 10);
  // Written beside the file, then renamed: a reader never sees it half-written.
  writeFileSync(file + ".partial", JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }));
  renameSync(file + ".partial", file);
  if (leaderExits === "exits") process.exit(0);
};
proceed();
setInterval(() => {}, 1000);
`,
);
// A leader that reports a SIGINT (as Playwright writes its partial result) and then exits.
const REPORTER = join(scratch, "reporter.mjs");
writeFileSync(
  REPORTER,
  `import { writeFileSync } from "node:fs";
const [file] = process.argv.slice(2);
writeFileSync(file, "started");
process.on("SIGINT", () => { writeFileSync(file, "SIGINT"); process.exit(130); });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const groupPresent = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const pids = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as {
    leader: number;
    grandchild: number;
  };
let n = 0;
const fresh = (name: string) => {
  n += 1;
  return join(scratch, `${name}-${n}`);
};
/** A process this test owns OUTSIDE the runner's groups (its own group): nothing the runner does may reach it. */
function sentinel(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  unowned.push(child);
  return child;
}

describe("R18: the runner owns each spawned process's whole tree (real processes)", () => {
  test("a leader that exits before its tree: stopAll finds the surviving member, ends it (SIGKILL for one deaf to SIGTERM) and reports it; an unowned sentinel survives", async () => {
    const other = sentinel();
    const groups = ownedGroups({ graceMs: 400, killWaitMs: 2_000 });
    const file = fresh("tree");
    const child = groups.spawn(
      "playwright",
      process.execPath,
      [TREE, file, "deaf", "exits"],
      { stdio: "ignore" },
    );
    await until(() => existsSync(file));
    const { grandchild } = pids(file);
    if (child.exitCode === null && child.signalCode === null)
      await new Promise<void>((r) => child.once("exit", () => r()));
    // The defect review 14 saw: the leader is gone, its descendant is not.
    expect(alive(grandchild)).toBe(true);
    const stopped = await groups.stopAll();
    expect(stopped.problems).toEqual([]);
    expect(stopped.notes).toEqual([
      `process group ${child.pid} (playwright) still had members after its leader exited; terminated`,
    ]);
    expect(alive(grandchild)).toBe(false);
    expect(groupPresent(child.pid as number)).toBe(false);
    expect(alive(other.pid as number)).toBe(true);
    expect(groups.owned()).toEqual([]);
  }, 20_000);

  test("the ordinary clean-up of a live tree ends leader and descendants and reports nothing", async () => {
    const groups = ownedGroups({ graceMs: 2_000 });
    const file = fresh("tree");
    const child = groups.spawn(
      "backend",
      process.execPath,
      [TREE, file, "plain", "waits"],
      { stdio: "ignore" },
    );
    await until(() => existsSync(file));
    const { leader, grandchild } = pids(file);
    expect(leader).toBe(child.pid);
    const stopped = await groups.stopAll();
    expect(stopped).toEqual({ problems: [], notes: [] });
    expect(alive(leader)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  test("interrupt: Playwright's leader is asked with SIGINT (it reports), every owned group is gone within two seconds even when deaf to SIGTERM, and nothing can start afterwards", async () => {
    const other = sentinel();
    const groups = ownedGroups();
    const report = fresh("report");
    const file = fresh("tree");
    const playwright = groups.spawn(
      "playwright",
      process.execPath,
      [REPORTER, report],
      { stdio: "ignore" },
      { interruptWith: "SIGINT" },
    );
    groups.spawn("preview", process.execPath, [TREE, file, "deaf", "waits"], {
      stdio: "ignore",
    });
    await until(() => existsSync(file) && existsSync(report));
    const { leader, grandchild } = pids(file);
    const started = Date.now();
    groups.interrupt("interrupted by SIGTERM");
    await until(
      () =>
        !groupPresent(playwright.pid as number) &&
        !alive(leader) &&
        !alive(grandchild),
      3_000,
    );
    // Inside the shared validation driver's two-second grace before it SIGKILLs the runner itself.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(report, "utf8")).toBe("SIGINT");
    expect(() =>
      groups.spawn("playwright", process.execPath, ["-e", ""], {}),
    ).toThrow(/not started: interrupted by SIGTERM/);
    expect(groups.closed).toBe("interrupted by SIGTERM");
    expect(alive(other.pid as number)).toBe(true);
    expect(await groups.stopAll()).toEqual({ problems: [], notes: [] });
  }, 20_000);

  test("a group that never empties is a problem (the stack fails), and it stays owned; only owned group ids are ever signalled", async () => {
    const signalled: Array<[number, string | number]> = [];
    const fake = {
      pid: 4_000_001,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    } as unknown as ChildProcess;
    const groups = ownedGroups({
      spawn: () => fake,
      kill: (pid, signal) => {
        signalled.push([pid, signal]);
      },
      graceMs: 50,
      killWaitMs: 50,
      pollMs: 10,
    });
    groups.spawn("playwright", "x", []);
    const stopped = await groups.stopAll();
    expect(stopped.problems).toEqual([
      "process group 4000001 (playwright) still has members after SIGKILL",
    ]);
    expect(new Set(signalled.map(([pid]) => pid))).toEqual(
      new Set([-4_000_001]),
    );
    expect(signalled.some(([, s]) => s === "SIGTERM")).toBe(true);
    expect(signalled.some(([, s]) => s === "SIGKILL")).toBe(true);
    expect(groups.owned()).toEqual([{ pgid: 4_000_001, label: "playwright" }]);
  });

  test("concurrent stops are one stop (the signal path and the schedule's clean-up join)", async () => {
    let probes = 0;
    const groups = ownedGroups({
      spawn: () =>
        ({
          pid: 4_000_002,
          exitCode: 0,
          signalCode: null,
          kill: () => true,
        }) as unknown as ChildProcess,
      kill: (_pid, signal) => {
        if (signal === 0) {
          probes += 1;
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
      },
    });
    groups.spawn("preview", "x", []);
    const [a, b] = [groups.stopAll(), groups.stopAll()];
    expect(a).toBe(b);
    await a;
    expect(probes).toBeGreaterThan(0);
  });

  test("the runner spawns every long-lived process through its owned groups, Playwright last-argued with the policy", () => {
    const source = readFileSync(
      join(ROOT, "scripts/integration/run.mjs"),
      "utf8",
    );
    // No bare spawn: the review-14 defect was a Playwright `spawn(...)` that clean-up did not know. WEB-08d revision 30: ONE named
    // exception, the reaper (scripts/integration/reaper.mjs), which must outlive the owned groups to clean them up after a SIGKILL
    // of the runner: it is started first, in a group of its own, and told every owned group as it is spawned.
    const reaperSpawn =
      /const reaper = spawn\(\s*process\.execPath,\s*\[\s*join\(root, "scripts\/integration\/reaper\.mjs"\),[\s\S]*?\{ detached: true, stdio: \["pipe", "inherit", "inherit"\] \},\s*\);/;
    expect(source).toMatch(reaperSpawn);
    expect(source.replace(reaperSpawn, "")).not.toMatch(/(^|[^.\w])spawn\(/m);
    expect(source).toMatch(
      /onSpawn: \(\{ pgid, label \}\) => \{\s*tellReaper\(\{ type: "group", pgid \}\);/,
    );
    expect(source.indexOf("const reaper = spawn(")).toBeLessThan(
      source.indexOf("const groups = ownedGroups("),
    );
    expect(source.match(/groups\.spawn\(/g)).toHaveLength(3);
    expect(source).toMatch(
      /groups\.spawn\(\s*"playwright",[\s\S]*?\.\.\.stack\.passthrough,\s*\.\.\.PLAYWRIGHT_POLICY,\s*\]/,
    );
    expect(source).toMatch(/interruptWith: "SIGINT"/);
  });
});

describe("R18: one worker, no retry, --max-failures=1; arguments that would override the runner are refused", () => {
  test("the policy", () => {
    expect(PLAYWRIGHT_POLICY).toEqual([
      "--workers=1",
      "--retries=0",
      "--max-failures=1",
    ]);
  });

  test.each([
    ["--workers=2"],
    ["--workers", "2"],
    ["-j", "2"],
    ["--retries=1"],
    ["--max-failures=5"],
    ["-x"],
    ["--fully-parallel"],
    ["--reporter=line"],
    ["--project=integration-webkit"],
    ["--output=/tmp/x"],
    ["--list"],
    ["--pass-with-no-tests"],
    ["--last-failed"],
  ])("refused: %s", (...args) => {
    expect(passthroughProblems(args)).toHaveLength(1);
    expect(() =>
      planStacks({
        grep: "",
        passthrough: args,
        oidc: true,
        postgres: false,
      }),
    ).toThrow(/refused Playwright arguments/);
  });

  test("a narrowing selection, a repeat and a title filter are the caller's to choose", () => {
    expect(
      passthroughProblems([
        "tests/integration/integration.pages.spec.ts",
        "--repeat-each=3",
        "--grep",
        "I-14d",
        "--grep-invert=I-14e",
      ]),
    ).toEqual([]);
  });

  test("the real runner refuses before it lists, claims or starts anything (exit 2, no evidence directory)", () => {
    const evidence = fresh("refused-evidence");
    for (const extra of [["--workers=2"], ["-x"], ["--retries=1"]]) {
      const ran = spawnSync(
        process.execPath,
        [
          join(ROOT, "scripts/integration/run.mjs"),
          "--evidence",
          evidence,
          "--",
          ...extra,
        ],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env } },
      );
      expect(ran.status).toBe(2);
      expect(ran.stderr).toMatch(/^REFUSED: refused Playwright arguments/m);
      expect(existsSync(evidence)).toBe(false);
    }
  });
});

describe("R17: the source budget the pinned backend counts, and each stack's record of it", () => {
  test("exactly the pinned backend's `source_attempt` handlers count, whatever their status; nothing else does", () => {
    expect(SOURCE_BUDGET).toEqual({ limit: 120, windowMs: 60_000 });
    for (const [method, route] of SOURCE_BUDGET_CONSUMERS)
      expect(consumesSourceBudget(method, `/api/experimental/v1${route}`)).toBe(
        true,
      );
    for (const [method, path] of <Array<[string, string]>>[
      ["GET", "/api/experimental/v1/browser-sessions/current"],
      ["GET", "/api/experimental/v1/sessions"],
      ["DELETE", "/api/experimental/v1/sessions/current"],
      ["POST", "/api/experimental/v1/commands"],
      ["GET", "/api/experimental/v1/registration/preview"],
      ["POST", "/browser-sessions"],
      ["POST", "/api/experimental/v1/browser-sessions/activate/cancel/x"],
    ])
      expect(consumesSourceBudget(method, path)).toBe(false);
  });

  test("the record counts every consumer, a failed or refused one included, and its peak over any 60 s", () => {
    const at0 = 1_000_000;
    const ex = (
      method: string,
      route: string,
      status: number | null,
      at: number,
    ) => ({
      method,
      path: `/api/experimental/v1${route}`,
      status,
      at,
    });
    const exchanges = [
      ...Array.from({ length: 70 }, (_, i) =>
        ex("POST", "/browser-sessions", 200, at0 + i * 100),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        ex(
          "POST",
          "/browser-sessions/activate",
          i % 2 ? 400 : 200,
          at0 + 10_000 + i * 100,
        ),
      ),
      ex("POST", "/password", null, at0 + 20_000),
      ex("POST", "/browser-sessions/activate", 429, at0 + 30_000),
      ex("GET", "/browser-sessions/current", 200, at0 + 30_000),
      // A minute after the first: outside its window.
      ex("POST", "/browser-sessions", 200, at0 + 61_000),
    ];
    const record = throttleRecord(exchanges);
    expect(record.source_budget_requests).toBe(123);
    expect(record.source_budget_peak_60s).toBe(122);
    expect(record.source_budget_limit).toBe(120);
    expect(record.source_budget_by_route).toEqual({
      "POST /browser-sessions": 71,
      "POST /browser-sessions/activate": 51,
      "POST /password": 1,
    });
    expect(record.refusals_429).toEqual([
      {
        method: "POST",
        path: "/api/experimental/v1/browser-sessions/activate",
        at: at0 + 30_000,
      },
    ]);
  });

  test("every default stack names its files and what it changes in its own backend; sharing and snapshot have their own", () => {
    for (const stack of DEFAULT_STACKS) {
      expect(stack.files?.length).toBeGreaterThan(0);
      expect(stack.mutates).toMatch(/\S/);
    }
    const owners = (file: string) =>
      DEFAULT_STACKS.filter((s) => s.files?.some((f) => f.endsWith(file))).map(
        (s) => s.name,
      );
    expect(owners("integration.sharing.spec.ts")).toEqual(["sharing"]);
    expect(owners("integration.snapshot.spec.ts")).toEqual(["snapshot"]);
    expect(owners("integration.password-path.spec.ts")).toEqual([
      "password-path",
    ]);
  });
});

describe("R17: a stack's helper state is its own, and a malformed ledger is never taken as empty", () => {
  test("the state directory the runner gives each stack, else TMPDIR keyed by the preview's port", () => {
    expect(
      stackFile("atlas-signin-ledger.json", {
        ATLAS_INTEGRATION_STATE_DIR: "/state/of/stack",
        ATLAS_INTEGRATION_URL: "http://127.0.0.1:5555",
      }),
    ).toBe("/state/of/stack/atlas-signin-ledger.json");
    expect(
      stackFile("atlas-signin-ledger.json", {
        ATLAS_INTEGRATION_URL: "http://127.0.0.1:5555",
      }),
    ).toBe(join(tmpdir(), "atlas-signin-ledger-5555.json"));
  });

  const clock = (start: number) => {
    const slept: number[] = [];
    let t = start;
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
    };
  };

  test("an absent ledger is empty; the ninth attempt within a minute waits until the oldest is a minute old; accounts are separate", async () => {
    const ledger = fresh("ledger.json");
    const c = clock(1_000_000);
    for (let i = 0; i < 8; i += 1) await paceSignIn("alice", ledger, c);
    expect(c.slept).toEqual([]);
    await paceSignIn("bob", ledger, c);
    expect(c.slept).toEqual([]);
    await paceSignIn("alice", ledger, c);
    expect(c.slept).toEqual([60_250]);
    const written = JSON.parse(readFileSync(ledger, "utf8"));
    expect(written.alice).toHaveLength(1);
    expect(written.bob).toEqual([1_000_000]);
  });

  test.each([
    ["not JSON", "{"],
    ["a list", "[]"],
    ["null", "null"],
    ["times that are not numbers", JSON.stringify({ alice: ["x"] })],
    ["an account that is not a list", JSON.stringify({ alice: 3 })],
  ])(
    "a ledger that is %s stops the test and is left as it was",
    async (_what, text) => {
      const ledger = fresh("ledger.json");
      writeFileSync(ledger, text);
      await expect(paceSignIn("alice", ledger, clock(0))).rejects.toThrow(
        /is malformed/,
      );
      expect(readFileSync(ledger, "utf8")).toBe(text);
    },
  );
});

describe("R18: a failure the report shows is a failed stack; its fail-fast unrun cases are not run, never passed", () => {
  const key = (title: string) =>
    `integration-chromium › integration.x.spec.ts › group › ${title}`;
  const planned = new Map([key("a"), key("b"), key("c")].map((k) => [k, 1]));
  const report = (contradict = false) => {
    const t = (
      title: string,
      status: string,
      results: Array<{ status: string }>,
    ) => ({
      title,
      file: "integration.x.spec.ts",
      tests: [
        {
          projectName: "integration-chromium",
          status,
          expectedStatus: "passed",
          annotations: [],
          results: results.map((r) => ({ ...r, retry: 0, annotations: [] })),
        },
      ],
    });
    return JSON.stringify({
      config: {},
      errors: [
        { message: "Testing stopped early after 1 maximum allowed failures." },
      ],
      stats: {
        startTime: new Date(1_000_000).toISOString(),
        duration: 5,
        expected: 0,
        skipped: contradict ? 1 : 2,
        unexpected: 1,
        flaky: 0,
      },
      suites: [
        {
          title: "integration.x.spec.ts",
          file: "integration.x.spec.ts",
          specs: [],
          suites: [
            {
              title: "group",
              file: "integration.x.spec.ts",
              specs: [
                t("a", "unexpected", [{ status: "failed" }]),
                t("b", "skipped", []),
                t("c", "skipped", []),
              ],
              suites: [],
            },
          ],
        },
      ],
    });
  };
  const judge = (text: string) =>
    judgeStack({
      planned,
      report: text,
      exitCode: 1,
      startedAt: 999_000,
      finishedAt: 1_100_000,
      project: "integration-chromium",
      context: { env: {}, oidc: false, postgres: false },
    });

  test("the first case failed under --max-failures=1: failed, one failure and two not run", () => {
    const judged = judge(report());
    expect(judged.verdict).toBe("failed");
    expect(judged.counts).toMatchObject({ failed: 1, not_run: 2, passed: 0 });
  });

  test("the same report with totals that contradict its tests is not evidence: incomplete", () => {
    expect(judge(report(true)).verdict).toBe("incomplete");
  });
});
