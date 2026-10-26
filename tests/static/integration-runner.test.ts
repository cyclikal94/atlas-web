// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Launched,
  OWNER,
  playwrightLister,
  runIntegration,
} from "../../scripts/integration/schedule.mjs";
import {
  assignCases,
  DEFAULT_STACKS,
  DESIGNED_SKIPS,
  designedSkip,
  judgeStack,
  planStacks,
  reportCases,
  type Stack,
  stackArgs,
} from "../../scripts/integration/stacks.mjs";

/**
 * WEB-08c revision 14 (review 14: R17 `integration-stack-throttle-isolation`, R18 `integration-runner-failfast`): the integration
 * runner's stack assignment and schedule, through the runner's own modules. Adapted from the sibling WEB-14a working tree's tests
 * (revisions 15/16, commit dab446e: a reference input, not accepted or merged; its review labels R22/R23 are kept on the tests that
 * came from it) to this branch's stacks; the process-group ownership tests are this task's own (process-groups.mjs).
 *
 * WEB-14a's description, adapted:
 * (scripts/integration/stacks.mjs, schedule.mjs). Discovery is Playwright's real `--list` of tests/integration (no backend, no
 * browser); only the stack PROCESSES are doubles: `execute` writes the result file a stack's Playwright would write.
 *
 * Revision 16 (review R23a-c): the judge is also checked against a REAL result of the pinned reporter
 * (tests/static/fixtures/integration-report-base-chromium.json: the r15 author run's chromium base stack, sanitised), one field changed
 * at a time; and the schedule's evidence writes, result reads and ownership claim fail one phase at a time.
 */
const ROOT = resolve(__dirname, "../..");
const BROWSERS = ["chromium", "firefox", "webkit"];
const scratch = mkdtempSync(join(tmpdir(), "atlas-runner-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// One real listing per selection, shared by the tests (each is about a second).
const realList = playwrightLister({
  root: ROOT,
  browsers: BROWSERS,
  dir: join(scratch, "listings"),
  env: { ...process.env, ATLAS_INTEGRATION_URL: "" },
});
const memo = new Map<string, Promise<string>>();
const cachedList = (selection: string[], label: string) => {
  const key = JSON.stringify(selection);
  if (!memo.has(key)) memo.set(key, realList(selection, label));
  return memo.get(key) as Promise<string>;
};
const keysOf = async (selection: string[]) =>
  reportCases(JSON.parse(await cachedList(selection, "t"))).map((c) => c.key);
const inBrowser = (keys: string[], browser: string) =>
  keys.filter((k) => k.startsWith(`integration-${browser} › `));

const STACKS = planStacks({
  grep: "",
  passthrough: [],
  oidc: true,
  postgres: false,
}).stacks;
const planned = new Map<string, string[]>();
beforeAll(async () => {
  for (const stack of STACKS)
    planned.set(stack.name, await keysOf(stackArgs(stack)));
}, 120_000);

type Outcome =
  | "passed"
  | "failed"
  | "skipped"
  | "interrupted"
  | "retried"
  | "designed";
interface Spec {
  title: string;
  file: string;
  tests: unknown[];
}
interface Suite {
  title: string;
  file: string;
  specs: Spec[];
  suites: Suite[];
}
const DESIGNED_FILES = new Map(
  DESIGNED_SKIPS.filter((r) => r.description).map((r) => [
    r.file,
    r.description as string,
  ]),
);

/** A Playwright JSON report of exactly these cases (keys as stacks.mjs `reportCases` makes them). */
function report(
  keys: string[],
  {
    outcome = () => "passed",
    startTime = new Date().toISOString(),
    errors = [],
    mutate,
  }: {
    outcome?: (key: string, file: string) => Outcome;
    startTime?: string;
    errors?: unknown[];
    /** Changes the finished report (one field at a time): aggregate and terminal fields need not change together. */
    mutate?: (report: Record<string, unknown> & { suites: Suite[] }) => void;
  } = {},
): string {
  const totals = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
  const files = new Map<string, Suite>();
  for (const key of keys) {
    const [project, file, ...titles] = key.split(" › ") as [
      string,
      string,
      ...string[],
    ];
    let suite = files.get(file);
    if (!suite) {
      suite = {
        title: file,
        file: `../integration/${file}`,
        specs: [],
        suites: [],
      };
      files.set(file, suite);
    }
    for (const describe of titles.slice(0, -1)) {
      let child: Suite | undefined = suite.suites.find(
        (s) => s.title === describe,
      );
      if (!child) {
        child = { title: describe, file: suite.file, specs: [], suites: [] };
        suite.suites.push(child);
      }
      suite = child;
    }
    const how = outcome(key, file);
    const result = (status: string, retry = 0) => ({
      status,
      retry,
      annotations: [],
    });
    const test =
      how === "passed"
        ? {
            projectName: project,
            expectedStatus: "passed",
            status: "expected",
            annotations: [],
            results: [result("passed")],
          }
        : how === "failed"
          ? {
              projectName: project,
              expectedStatus: "passed",
              status: "unexpected",
              annotations: [],
              results: [result("failed")],
            }
          : how === "retried"
            ? {
                projectName: project,
                expectedStatus: "passed",
                status: "flaky",
                annotations: [],
                results: [result("failed"), result("passed", 1)],
              }
            : how === "interrupted"
              ? {
                  projectName: project,
                  expectedStatus: "passed",
                  status: "skipped",
                  annotations: [],
                  results: [result("interrupted")],
                }
              : {
                  projectName: project,
                  expectedStatus: "skipped",
                  status: "skipped",
                  annotations:
                    how === "designed"
                      ? [
                          {
                            type: "skip",
                            description: DESIGNED_FILES.get(file),
                          },
                        ]
                      : [],
                  results: [result("skipped")],
                };
    totals[test.status as keyof typeof totals] += 1;
    suite.specs.push({
      title: titles.at(-1) as string,
      file: `../integration/${file}`,
      tests: [test],
    });
  }
  const finished = {
    config: {},
    suites: [...files.values()],
    errors,
    stats: { startTime, duration: 1, ...totals },
  };
  mutate?.(finished);
  return JSON.stringify(finished);
}
/** The first test record of a report (its first file's first spec, depth-first). */
const firstTest = (r: { suites: Suite[] }) => {
  const walk = (suite: Suite): Record<string, unknown> | undefined =>
    (suite.specs[0]?.tests[0] as Record<string, unknown> | undefined) ??
    suite.suites.map(walk).find(Boolean);
  return walk(r.suites[0] as Suite) as Record<string, unknown> & {
    results: Array<Record<string, unknown>>;
  };
};
/** The double's normal answer: everything passes, the measurement specs are their designed skips. */
const normal = (_key: string, file: string): Outcome =>
  DESIGNED_FILES.has(file) && file.includes("profile") ? "designed" : "passed";

interface World {
  evidence: string;
  events: string[];
  launches: string[];
  logs: string[];
  status: number;
  schedule: () => {
    entries: Array<{
      state: string;
      stack: string;
      browser: string;
      reasons: string[];
      phase?: string;
    }>;
  };
  summary: () => Record<string, unknown> & {
    status: string;
    complete: boolean;
    accounted: boolean;
    evidence: { complete: boolean; errors: Array<{ file: string }> };
    entries: Entry[];
  };
}
interface Entry {
  state: string;
  stack: string;
  browser: string;
  reasons: string[];
  phase?: string;
  planned_cases: number;
  counts?: Record<string, number>;
}
/** Each entry's counts add up to its planned cases. */
const conserved = (entries: Entry[]) =>
  entries.every(
    (e) =>
      Object.values(e.counts ?? {}).reduce((n, k) => n + k, 0) ===
      e.planned_cases,
  );
let worlds = 0;
async function world({
  stacks = STACKS,
  manifest,
  partial = false,
  narrowed = false,
  env = {},
  list = cachedList,
  execute,
  cleanup = async () => ({ problems: [] as string[] }),
  interrupted = () => null as string | null,
  write,
  before,
  readReport,
  exists,
  claim,
  evidence: given,
}: {
  stacks?: Stack[];
  manifest?: Stack[];
  partial?: boolean;
  narrowed?: boolean;
  env?: Record<string, string>;
  list?: (selection: string[], label: string) => Promise<string>;
  execute?: (
    stack: Stack,
    browser: string,
    file: string,
    keys: string[],
  ) => Promise<Launched>;
  cleanup?: () => Promise<{ problems: string[] }>;
  interrupted?: () => string | null;
  write?: (file: string, text: string) => void;
  before?: (evidence: string) => void;
  readReport?: (file: string) => string | null;
  exists?: (path: string) => boolean;
  claim?: (file: string, text: string) => void;
  evidence?: string;
} = {}): Promise<World> {
  worlds += 1;
  const evidence = given ?? join(scratch, `world-${worlds}`);
  before?.(evidence);
  const events: string[] = [];
  const launches: string[] = [];
  const logs: string[] = [];
  const realWrite = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  let running = 0;
  const status = await runIntegration({
    options: {
      browsers: BROWSERS,
      stacks,
      manifest,
      partial,
      narrowed,
      evidence,
      env,
      postgres: false,
      layer: "test",
    },
    deps: {
      list: async (selection, label) => {
        events.push(`list ${label}`);
        return list(selection, label);
      },
      execute: async (stack, browser) => {
        running += 1;
        expect(running).toBe(1); // one stack at a time
        launches.push(`${browser}/${stack.name}`);
        events.push(`launch ${browser}/${stack.name}`);
        const file = join(evidence, `results-${browser}${stack.suffix}.json`);
        const keys = inBrowser(planned.get(stack.name) ?? [], browser);
        try {
          if (execute) return await execute(stack, browser, file, keys);
          writeFileSync(file, report(keys, { outcome: normal }));
          return { exitCode: 0 };
        } finally {
          running -= 1;
        }
      },
      cleanup: async () => {
        events.push("cleanup");
        return cleanup();
      },
      readReport: (file) => {
        events.push("read");
        if (readReport) return readReport(file);
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      },
      exists: exists ?? existsSync,
      claim:
        claim ??
        ((file, text) => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text, { flag: "wx" });
        }),
      write: (file, text) => {
        events.push(`write ${file.slice(evidence.length + 1)}`);
        (write ?? realWrite)(file, text);
      },
      now: () => Date.now(),
      log: (line) => {
        logs.push(line);
      },
      interrupted,
      backend: () => ({ tag: "double" }),
    },
  });
  const read = (name: string) =>
    JSON.parse(readFileSync(join(evidence, name), "utf8"));
  return {
    evidence,
    events,
    launches,
    logs,
    status,
    schedule: () => read("schedule.json"),
    summary: () => read("summary.json"),
  };
}
const ORDER = BROWSERS.flatMap((b) => STACKS.map((s) => `${b}/${s.name}`));
/** The processes' events in order: launch, clean-up, result read (evidence writes and listings left out). */
const runsOf = (events: string[]) =>
  events.filter(
    (e) => e.startsWith("launch ") || e === "cleanup" || e === "read",
  );
/** After the last launch: it was cleaned up, and nothing launched after it. */
const endsCleanly = (events: string[]) => {
  const runs = runsOf(events);
  const last = runs.map((e) => e.startsWith("launch ")).lastIndexOf(true);
  return runs.slice(last + 1).includes("cleanup");
};

describe("R22: every discovered integration case is in exactly one stack (Playwright's own listing)", () => {
  test("the default stacks cover the whole listing once, in every engine (no separate obligation on this branch)", async () => {
    const whole = await keysOf([]);
    const stacks = STACKS.map((s) => ({
      name: s.name,
      keys: planned.get(s.name) ?? [],
    }));
    expect(
      assignCases({
        all: whole,
        stacks,
        separate: [],
        browsers: BROWSERS,
      }),
    ).toEqual({ ok: true, problems: [] });
    for (const browser of BROWSERS) {
      expect(
        Object.fromEntries(
          stacks.map((s) => [s.name, inBrowser(s.keys, browser).length]),
        ),
      ).toEqual({
        base: 28,
        pages: 18,
        "password-path": 8,
        i14e: 4,
        i14d: 4,
        data: 32,
        calendar: 13,
        traces: 16,
        registration: 20,
        oidc: 10,
        "oidc-off": 1,
        settings: 10,
        lifecycle: 17,
        "lifecycle-restart": 16,
        sharing: 7,
        snapshot: 6,
        tasks: 22,
        labels: 15,
      });
      expect(inBrowser(whole, browser)).toHaveLength(247);
    }
    // Sharing and snapshot are named by their own stacks only.
    for (const s of stacks)
      expect(
        s.keys.some((k) => /integration\.(sharing|snapshot)\.spec/.test(k)),
      ).toBe(s.name === "sharing" || s.name === "snapshot");
  }, 120_000);

  test("compared with the schedule review 14 ran, sharing, snapshot, pages, password-path and adopted task cases have their own fresh stacks", async () => {
    // The stacks of candidate b003cff (review 14), verbatim (scripts/integration/run.mjs STACKS).
    const OLD: Array<[string, string[]]> = [
      [
        "base",
        [
          "--grep-invert",
          "I-14e|I-14d \\(revision 11\\)|I-(P|O|C|S|W|L)[0-9]|I-CAL|I-2[0-9]|I-30",
        ],
      ],
      ["i14e", ["--grep", "I-14e"]],
      ["i14d", ["--grep", "I-14d \\(revision 11\\)"]],
      ["data", ["tests/integration/integration.data.spec.ts"]],
      ["calendar", ["tests/integration/integration.calendars.spec.ts"]],
      ["traces", ["--grep", "I-20|I-22|I-23"]],
      ["registration", ["--grep", "I-24|I-25|I-26"]],
      ["oidc", ["--grep", "I-21|I-27|I-28a"]],
      ["oidc-off", ["--grep", "I-28b"]],
      ["settings", ["--grep", "I-29|I-30"]],
      ["lifecycle", ["tests/integration/integration.lifecycle.spec.ts"]],
      [
        "lifecycle-restart",
        ["tests/integration/integration.lifecycle-restart.spec.ts"],
      ],
    ];
    const before = new Map<string, string>();
    for (const [name, args] of OLD)
      for (const key of await keysOf(args)) {
        expect(before.has(key)).toBe(false);
        before.set(key, name);
      }
    const after = new Map<string, string>();
    for (const [name, keys] of planned)
      for (const key of keys) {
        expect(after.get(key)).toBeUndefined(); // one stack each
        after.set(key, name);
      }
    const moved: Record<string, number> = {};
    for (const [key, name] of after) {
      const was = before.get(key);
      if (was === name) continue;
      expect(was).toBe("base");
      moved[name] = (moved[name] ?? 0) + 1;
    }
    // Per engine: sharing 7, snapshot 6 (R17), pages 18 (13, and revision 34's five I-13 premise controls) and password-path 8 (the
    // measured base overrun).
    expect(moved).toEqual({
      sharing: 21,
      snapshot: 18,
      pages: 54,
      "password-path": 24,
      tasks: 66,
      labels: 45,
    });
    expect([...before.keys()].every((k) => after.has(k))).toBe(true);
  }, 120_000);

  test("an unknown spec file, an unmatched case or a case in two stacks stops the run before any stack starts", async () => {
    const unknown = await world({
      list: async (selection, label) => {
        const text = await cachedList(selection, label);
        if (selection.length > 0) return text;
        const whole = JSON.parse(text);
        whole.suites.push({
          title: "integration.new.spec.ts",
          file: "../integration/integration.new.spec.ts",
          specs: [
            {
              title: "a case nobody assigned",
              file: "../integration/integration.new.spec.ts",
              // As Playwright's --list writes a test: no result.
              tests: [
                {
                  projectName: "integration-firefox",
                  status: "skipped",
                  expectedStatus: "passed",
                  annotations: [],
                  results: [],
                },
              ],
            },
          ],
          suites: [],
        });
        return JSON.stringify(whole);
      },
    });
    const twice = await world({
      stacks: [
        ...STACKS,
        {
          ...STACKS.find((s) => s.name === "sharing"),
          name: "sharing-again",
          suffix: "-x",
        } as Stack,
      ],
    });
    const narrow = STACKS.map((s) =>
      s.name === "snapshot" ? { ...s, grep: "I-N1" } : s,
    );
    const unmatched = await world({ stacks: narrow });
    // Revision 16: a listing that is not the reporter's shape is not an inventory (nothing is guessed from it).
    const malformed = await world({
      list: async (selection, label) => {
        const text = await cachedList(selection, label);
        if (selection.length > 0) return text;
        const whole = JSON.parse(text);
        whole.suites[0].specs = { not: "a list" };
        return JSON.stringify(whole);
      },
    });
    expect(malformed.status).toBe(1);
    expect(malformed.launches).toEqual([]);
    expect(malformed.summary()).toMatchObject({
      status: "failed",
      not_started: expect.stringMatching(
        /^discovery failed: the listing is malformed: suites\[0\]\.specs is not a list/,
      ),
    });
    for (const [w, problem] of [
      [unknown, "in no stack: integration-firefox › integration.new.spec.ts"],
      [twice, "in more than one stack (sharing, sharing-again)"],
      [
        unmatched,
        "in no stack: integration-chromium › integration.snapshot.spec.ts",
      ],
    ] as const) {
      expect(w.status).toBe(1);
      expect(w.launches).toEqual([]);
      const discovery = JSON.parse(
        readFileSync(join(w.evidence, "discovery/discovery.json"), "utf8"),
      );
      expect(discovery.assignment.ok).toBe(false);
      expect(
        discovery.assignment.problems.some((p: string) => p.includes(problem)),
      ).toBe(true);
      expect(new Set(w.summary().entries.map((e) => e.state))).toEqual(
        new Set(["not_run"]),
      );
      expect(w.summary().status).toBe("failed");
    }
  }, 120_000);
});

describe("R23: the next stack or browser starts only after the previous one passed completely and was cleaned up", () => {
  test("all-pass control: every stack once, in order, one at a time, each cleaned up before the next", async () => {
    const w = await world();
    expect(w.status).toBe(0);
    expect(w.launches).toEqual(ORDER);
    expect(runsOf(w.events)).toEqual(
      ORDER.flatMap((o) => [`launch ${o}`, "cleanup", "read"]),
    );
    // Every launch is admitted by its own "running" record, written immediately before it.
    for (const [i, e] of w.events.entries())
      if (e.startsWith("launch "))
        expect(w.events[i - 1]).toBe("write schedule.json");
    expect(w.events.at(-1)).toBe("write summary.json");
    const summary = w.summary();
    expect(summary.status).toBe("passed");
    expect(summary.complete).toBe(true);
    const engines = summary.engines as Record<string, Record<string, unknown>>;
    for (const browser of BROWSERS)
      expect(engines[browser]).toMatchObject({
        complete: true,
        planned_cases: 247,
        passed: 241,
        designed_skips: 6,
        failed: 0,
        interrupted: 0,
        not_run: 0,
        unproven: 0,
        not_launched: 0,
        accounted: true,
      });
    expect(summary).toMatchObject({
      accounted: true,
      evidence: { complete: true, errors: [] },
    });
    expect(existsSync(join(w.evidence, OWNER))).toBe(true);
    expect(summary.separate_obligations).toEqual([]);
  }, 120_000);

  const failAt =
    (at: string, how: (file: string, keys: string[]) => Launched) =>
    async (stack: Stack, browser: string, file: string, keys: string[]) => {
      if (`${browser}/${stack.name}` === at) return how(file, keys);
      writeFileSync(file, report(keys, { outcome: normal }));
      return { exitCode: 0 };
    };
  const thrown = (phase: string) => () => {
    throw Object.assign(new Error(`${phase} failed (double)`), { phase });
  };
  const cases: Array<
    [string, string, (file: string, keys: string[]) => Launched, string, string]
  > = [
    [
      "a failed test (exit 1)",
      "chromium/base",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            outcome: (k, f) => (k.includes("I-08") ? "failed" : normal(k, f)),
          }),
        );
        return { exitCode: 1 };
      },
      "failed",
      "result",
    ],
    [
      "a preparation exception",
      "chromium/base",
      thrown("prepare"),
      "failed",
      "prepare",
    ],
    ["a spawn exception", "chromium/base", thrown("spawn"), "failed", "spawn"],
    [
      "exit 0 with no result file",
      "chromium/sharing",
      () => ({ exitCode: 0 }),
      "incomplete",
      "result",
    ],
    [
      "exit 0 with a malformed result",
      "chromium/sharing",
      (file) => {
        writeFileSync(file, '{"suites": [');
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with a stale result",
      "chromium/sharing",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, { startTime: "2026-10-15T12:30:00.000Z" }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with a truncated result (a case missing)",
      "firefox/snapshot",
      (file, keys) => {
        writeFileSync(file, report(keys.slice(1)));
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with an unplanned case",
      "firefox/snapshot",
      (file, keys) => {
        writeFileSync(file, report([...keys, keys[0] as string]));
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with the wrong project",
      "firefox/data",
      (file, keys) => {
        writeFileSync(
          file,
          report(
            keys.map((k) =>
              k.replace("integration-firefox", "integration-webkit"),
            ),
          ),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with an undesigned skip",
      "webkit/traces",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            outcome: (k, f) => (k === keys[2] ? "skipped" : normal(k, f)),
          }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with an interrupted case",
      "webkit/traces",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            outcome: (k, f) => (k === keys[2] ? "interrupted" : normal(k, f)),
          }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with a failed case",
      "webkit/oidc",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            outcome: (k, f) => (k === keys[0] ? "failed" : normal(k, f)),
          }),
        );
        return { exitCode: 0 };
      },
      "failed",
      "result",
    ],
    [
      "exit 0 with a case that passed only on retry",
      "webkit/oidc",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            outcome: (k, f) => (k === keys[0] ? "retried" : normal(k, f)),
          }),
        );
        return { exitCode: 0 };
      },
      "failed",
      "result",
    ],
    [
      "exit 0 with a Playwright error outside any test",
      "chromium/i14e",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, { errors: [{ message: "global setup failed" }] }),
        );
        return { exitCode: 0 };
      },
      "failed",
      "result",
    ],
    [
      "a non-zero exit with a green result",
      "chromium/i14e",
      (file, keys) => {
        writeFileSync(file, report(keys));
        return { exitCode: 1 };
      },
      "failed",
      "result",
    ],
    // Revision 16 (R23a): one field of an otherwise passing report, through the real scheduler.
    [
      "exit 0 with a case that has no execution result under a passing aggregate",
      "chromium/sharing",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            mutate: (r) => {
              firstTest(r).results = [];
            },
          }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with an interrupted execution under a passing aggregate",
      "chromium/sharing",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, {
            mutate: (r) => {
              (firstTest(r).results[0] as Record<string, unknown>).status =
                "interrupted";
            },
          }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "exit 0 with an invalid report start time",
      "firefox/base",
      (file, keys) => {
        writeFileSync(
          file,
          report(keys, { outcome: normal, startTime: "not-a-time" }),
        );
        return { exitCode: 0 };
      },
      "incomplete",
      "result",
    ],
    [
      "a backend 429 outside the deliberate settings case, with a green result",
      "chromium/sharing",
      (file, keys) => {
        writeFileSync(file, report(keys));
        return {
          exitCode: 0,
          exchanges: [
            {
              method: "POST",
              path: "/api/experimental/v1/browser-sessions",
              status: 429,
              at: 1,
            },
          ],
        };
      },
      "failed",
      "result",
    ],
  ];
  test.each(cases)(
    "%s stops the schedule (%s)",
    async (_label, at, how, state, phase) => {
      const w = await world({ execute: failAt(at, how) });
      expect(w.status).toBe(1);
      const index = ORDER.indexOf(at);
      expect(w.launches).toEqual(ORDER.slice(0, index + 1));
      // The failed stack was cleaned up too, and nothing launched after it.
      expect(endsCleanly(w.events)).toBe(true);
      const entries = w.summary().entries;
      expect(entries[index]).toMatchObject({ state, phase });
      expect(entries[index]?.reasons.length).toBeGreaterThan(0);
      expect(entries.slice(0, index).every((e) => e.state === "passed")).toBe(
        true,
      );
      expect(entries.slice(index + 1).every((e) => e.state === "not_run")).toBe(
        true,
      );
      expect(entries.slice(index + 1)[0]?.reasons[0]).toMatch(
        /^not started: integration-/,
      );
      expect(w.summary().status).toBe(
        state === "failed" ? "failed" : "incomplete",
      );
      expect(w.schedule().entries.map((e) => e.state)).toEqual(
        entries.map((e) => e.state),
      );
      // Revision 16 (I6): every planned case is accounted for once, the stopped ones as not launched.
      expect(w.summary().accounted).toBe(true);
      expect(conserved(entries)).toBe(true);
      for (const e of entries.slice(index + 1))
        expect(e.counts?.not_launched).toBe(e.planned_cases);
    },
    120_000,
  );

  test("the deliberate I-30b 429 of the settings stack is not a failure; the same 429 in the stack before it is", async () => {
    const throttled =
      (name: string) =>
      async (stack: Stack, browser: string, file: string, keys: string[]) => {
        writeFileSync(file, report(keys, { outcome: normal }));
        return {
          exitCode: 0,
          exchanges:
            stack.name === name && browser === "chromium"
              ? [
                  {
                    method: "POST",
                    path: "/api/experimental/v1/browser-sessions",
                    status: 429,
                    at: 1,
                  },
                ]
              : [],
        };
      };
    const settings = await world({ execute: throttled("settings") });
    expect(settings.status).toBe(0);
    expect(
      settings.summary().entries[ORDER.indexOf("chromium/settings")],
    ).toMatchObject({
      stack: "settings",
      state: "passed",
    });
    const oidcOff = await world({ execute: throttled("oidc-off") });
    expect(oidcOff.status).toBe(1);
    expect(
      oidcOff.summary().entries[ORDER.indexOf("chromium/oidc-off")],
    ).toMatchObject({
      stack: "oidc-off",
      state: "failed",
    });
  }, 120_000);

  test("a measurement skip is designed only while ATLAS_PROFILE is unset", async () => {
    const w = await world({ env: { ATLAS_PROFILE: "1" } });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(["chromium/base"]);
    expect(w.summary().entries[0]).toMatchObject({ state: "incomplete" });
  }, 120_000);

  test("a clean-up problem or a failed clean-up fails the stack and stops the schedule", async () => {
    let n = 0;
    const leaky = await world({
      cleanup: async () => {
        n += 1;
        return {
          problems: n === 2 ? ["a listener remains on port(s) 4999"] : [],
        };
      },
    });
    expect(leaky.status).toBe(1);
    expect(leaky.launches).toEqual(ORDER.slice(0, 2));
    expect(leaky.summary().entries[1]).toMatchObject({
      state: "failed",
      phase: "cleanup",
    });
    const broken = await world({
      cleanup: async () => {
        throw new Error("rm failed");
      },
    });
    expect(broken.status).toBe(1);
    expect(broken.launches).toEqual(ORDER.slice(0, 1));
    expect(broken.summary().entries[0]?.reasons.join(" ")).toMatch(
      /clean-up failed: rm failed/,
    );
  }, 120_000);

  test.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])(
    "%s during a stack: that stack is recorded interrupted after its clean-up, nothing else starts (exit %i)",
    async (signal, code) => {
      let received: string | null = null;
      const w = await world({
        interrupted: () => received,
        execute: async (stack, browser, file, keys) => {
          if (`${browser}/${stack.name}` === "firefox/registration") {
            received = signal;
            writeFileSync(
              file,
              report(keys, {
                outcome: (k, f) =>
                  k === keys.at(-1) ? "interrupted" : normal(k, f),
              }),
            );
            return { exitCode: 130 };
          }
          writeFileSync(file, report(keys, { outcome: normal }));
          return { exitCode: 0 };
        },
      });
      expect(w.status).toBe(code);
      const index = ORDER.indexOf("firefox/registration");
      expect(w.launches).toEqual(ORDER.slice(0, index + 1));
      expect(endsCleanly(w.events)).toBe(true);
      const entries = w.summary().entries;
      expect(entries[index]).toMatchObject({ state: "interrupted" });
      expect(entries[index]?.reasons[0]).toBe(`interrupted by ${signal}`);
      expect(entries.slice(index + 1).every((e) => e.state === "not_run")).toBe(
        true,
      );
      expect(w.summary().status).toBe("interrupted");
    },
    120_000,
  );

  test("a signal during discovery starts no stack", async () => {
    let received: string | null = null;
    // Revision 16 (I3): after a known cancellation no stack is even admitted (recorded running), not merely not launched.
    const recorded: string[] = [];
    const w = await world({
      interrupted: () => received,
      list: async (selection, label) => {
        received = "SIGTERM";
        return cachedList(selection, label);
      },
      write: (file, text) => {
        if (file.endsWith("schedule.json"))
          for (const e of JSON.parse(text).entries) recorded.push(e.state);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      },
    });
    expect(w.status).toBe(143);
    expect(w.launches).toEqual([]);
    expect(new Set(w.summary().entries.map((e) => e.state))).toEqual(
      new Set(["not_run"]),
    );
    expect(recorded).not.toContain("running");
    expect(w.summary().entries[0]?.reasons).toEqual([
      "not started: interrupted by SIGTERM",
    ]);
  }, 120_000);

  test("a schedule that cannot be written stops before the next stack; the exit is non-zero", async () => {
    let writes = 0;
    const w = await world({
      write: (file, text) => {
        writes += 1;
        // discovery, the initial schedule and the first "running" record are written; the first stack's result record is not.
        if (writes === 4) throw new Error("disk full (double)");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      },
    });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(ORDER.slice(0, 1));
  }, 120_000);

  test("evidence that already exists is refused before anything is listed, run or written", async () => {
    const w = await world({
      before: (evidence) => {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "results-webkit-snapshot.json"), "{}");
      },
    });
    expect(w.status).toBe(1);
    expect(w.events).toEqual([]);
    expect(existsSync(join(w.evidence, "schedule.json"))).toBe(false);
    expect(
      readFileSync(join(w.evidence, "results-webkit-snapshot.json"), "utf8"),
    ).toBe("{}");
  }, 120_000);

  test("a narrowed run is one stack per engine, judged against its own listing; no closure check or separate obligation", async () => {
    const one = planStacks({
      grep: "I-14e",
      passthrough: [],
      oidc: true,
      postgres: false,
    });
    expect(one.narrowed).toBe(true);
    planned.set("narrowed", await keysOf(stackArgs(one.stacks[0] as Stack)));
    const w = await world({ stacks: one.stacks, narrowed: true });
    expect(w.status).toBe(0);
    expect(w.launches).toEqual(BROWSERS.map((b) => `${b}/narrowed`));
    expect(w.events.filter((e) => e.startsWith("list"))).toEqual([
      "list stack-narrowed",
    ]);
    expect(w.summary().separate_obligations).toEqual([]);
    expect(
      (w.summary().engines as Record<string, { planned_cases: number }>).webkit
        ?.planned_cases,
    ).toBe(4);
  }, 120_000);
});

describe("--stacks: a labelled partial run of named default stacks", () => {
  test("runs only the named stacks in their usual order, still checks the whole manifest, and is never complete", async () => {
    const plan = planStacks({
      grep: "",
      passthrough: [],
      oidc: true,
      postgres: false,
      only: ["snapshot", "base", "sharing"],
    });
    expect(plan.stacks.map((s) => s.name)).toEqual([
      "base",
      "sharing",
      "snapshot",
    ]);
    const w = await world({
      stacks: plan.stacks,
      manifest: plan.manifest,
      partial: true,
    });
    expect(w.status).toBe(0);
    expect(w.launches).toEqual(
      BROWSERS.flatMap((b) =>
        ["base", "sharing", "snapshot"].map((s) => `${b}/${s}`),
      ),
    );
    const discovery = JSON.parse(
      readFileSync(join(w.evidence, "discovery/discovery.json"), "utf8"),
    );
    expect(Object.keys(discovery.stacks)).toEqual(STACKS.map((s) => s.name));
    expect(discovery.assignment.ok).toBe(true);
    expect(w.summary()).toMatchObject({
      status: "passed",
      complete: false,
      partial: ["base", "sharing", "snapshot"],
    });
  }, 120_000);

  test("an unknown stack, or --stacks with a narrowed selection, is refused", () => {
    expect(() =>
      planStacks({
        grep: "",
        passthrough: [],
        oidc: true,
        postgres: false,
        only: ["nope"],
      }),
    ).toThrow("no such stack: nope");
    expect(() =>
      planStacks({
        grep: "I-08",
        passthrough: [],
        oidc: true,
        postgres: false,
        only: ["base"],
      }),
    ).toThrow("cannot be narrowed");
  });
});

test("a skip is designed only for its own file and under its own condition", () => {
  const skipped = (description: string) => ({
    status: "skipped",
    annotations: [{ type: "skip", description }],
    results: [{ status: "skipped" }],
  });
  const noOidc =
    "this stack did not configure the stub OpenID Connect provider";
  const context = { env: {}, oidc: false, postgres: false };
  expect(
    designedSkip("integration.web08b-oidc.spec.ts", skipped(noOidc), context),
  ).toBe(noOidc);
  expect(
    designedSkip("integration.web08b-oidc.spec.ts", skipped(noOidc), {
      ...context,
      oidc: true,
    }),
  ).toBeNull();
  expect(
    designedSkip("integration.sharing.spec.ts", skipped(noOidc), context),
  ).toBeNull();
  expect(
    designedSkip(
      "integration.web08b-oidc.spec.ts",
      skipped("something else"),
      context,
    ),
  ).toBeNull();
  expect(
    designedSkip(
      "integration.web08b-oidc.spec.ts",
      { status: "skipped", annotations: [], results: [] },
      context,
    ),
  ).toBeNull();
});

test("the manifest names each stack once, with the older result-file names unchanged", () => {
  expect(DEFAULT_STACKS.map((s) => s.suffix)).toEqual([
    "",
    "-pages",
    "-password-path",
    "-i14e",
    "-i14d",
    "-data",
    "-calendar",
    "-traces",
    "-registration",
    "-oidc",
    "-oidc-off",
    "-settings",
    "-lifecycle",
    "-lifecycle-restart",
    "-sharing",
    "-snapshot",
    "-tasks",
    "-labels",
  ]);
  expect(DEFAULT_STACKS.filter((s) => s.oidc).map((s) => s.name)).toEqual([
    "oidc",
  ]);
  expect(
    DEFAULT_STACKS.filter((s) => s.deliberateThrottle).map((s) => s.name),
  ).toEqual(["settings"]);
});

describe("R23a (revision 16): a stack passes only on terminal execution evidence (a REAL pinned-reporter result, one field changed at a time)", () => {
  type Obj = Record<string, unknown>;
  type Test = Obj & { results: Obj[]; annotations: Obj[] };
  type Report = Obj & { stats: Obj; suites: Obj[]; errors: unknown[] };
  // The r15 author run's chromium base stack (sanitised; provenance in the revision-16 execution report): 19 passes and the six
  // designed measurement skips, with the reporter's real annotations, serial skip shape and totals.
  const REAL = readFileSync(
    join(__dirname, "fixtures/integration-report-base-chromium.json"),
    "utf8",
  );
  const real = () => JSON.parse(REAL) as Report;
  const PLANNED = new Map<string, number>();
  for (const c of reportCases(real()))
    PLANNED.set(c.key, (PLANNED.get(c.key) ?? 0) + 1);
  const START = Date.parse(real().stats.startTime as string);
  const tests = (r: Report) => reportCases(r).map((c) => c.test as Test);
  const passing = (r: Report) =>
    tests(r).find((t) => t.status === "expected") as Test;
  const skipped = (r: Report) =>
    tests(r).find((t) => t.status === "skipped") as Test;
  const firstSpecs = (r: Report) => {
    const walk = (suite: Obj): Obj[] | undefined =>
      (suite.specs as Obj[]).length > 0
        ? (suite.specs as Obj[])
        : (suite.suites as Obj[]).map(walk).find(Boolean);
    return walk(r.suites[0] as Obj) as Obj[];
  };
  const judge = (
    r: unknown,
    over: Partial<Parameters<typeof judgeStack>[0]> = {},
  ) =>
    judgeStack({
      planned: PLANNED,
      report: typeof r === "string" ? r : JSON.stringify(r),
      exitCode: 0,
      startedAt: START - 1_000,
      finishedAt: START + 60_000,
      project: "integration-chromium",
      context: { env: {}, oidc: false, postgres: false },
      ...over,
    });
  const sum = (counts: object) =>
    Object.values(counts as Record<string, number>).reduce((n, k) => n + k, 0);

  test("positive control: the unchanged real report passes, 19 terminal passes and 6 designed skips, every case counted once", () => {
    expect(PLANNED.size).toBe(25);
    const judged = judge(real());
    expect(judged).toMatchObject({ verdict: "passed", reasons: [] });
    expect(judged.counts).toEqual({
      passed: 19,
      designed_skips: 6,
      failed: 0,
      interrupted: 0,
      not_run: 0,
      unproven: 0,
      not_launched: 0,
    });
  });

  const whole = { unproven: 25, passed: 0 };
  const cases: Array<
    [
      string,
      (r: Report) => void,
      "failed" | "incomplete",
      string,
      Record<string, number>,
    ]
  > = [
    // Terminal execution evidence of one passing case (its aggregate fields unchanged).
    [
      "no execution result under a passing aggregate (results: [])",
      (r) => {
        passing(r).results = [];
      },
      "incomplete",
      "no terminal passing execution",
      { passed: 18, unproven: 1 },
    ],
    [
      "an interrupted execution under a passing aggregate",
      (r) => {
        (passing(r).results[0] as Obj).status = "interrupted";
      },
      "incomplete",
      "interrupted: integration-chromium",
      { passed: 18, interrupted: 1 },
    ],
    [
      "a failed execution under a passing aggregate",
      (r) => {
        (passing(r).results[0] as Obj).status = "failed";
      },
      "failed",
      "a failed execution under status expected",
      { passed: 18, failed: 1 },
    ],
    [
      "a timed-out execution under a passing aggregate",
      (r) => {
        (passing(r).results[0] as Obj).status = "timedOut";
      },
      "failed",
      "a timedOut execution",
      { passed: 18, failed: 1 },
    ],
    [
      "a skipped execution under a passing aggregate",
      (r) => {
        (passing(r).results[0] as Obj).status = "skipped";
      },
      "incomplete",
      "no terminal passing execution",
      { passed: 18, unproven: 1 },
    ],
    [
      "a passing aggregate that expected a skip",
      (r) => {
        passing(r).expectedStatus = "skipped";
      },
      "incomplete",
      "no terminal passing execution",
      { passed: 18, unproven: 1 },
    ],
    [
      "a second execution (a retry) under a passing aggregate",
      (r) => {
        const t = passing(r);
        t.results.push({ ...(t.results[0] as Obj), retry: 1 });
      },
      "failed",
      "retried (no retry is approved)",
      { passed: 18, failed: 1 },
    ],
    [
      "one execution at retry 1",
      (r) => {
        (passing(r).results[0] as Obj).retry = 1;
      },
      "failed",
      "retried (no retry is approved)",
      { passed: 18, failed: 1 },
    ],
    [
      "an unexpected aggregate over a passing execution (totals unchanged)",
      (r) => {
        passing(r).status = "unexpected";
      },
      "incomplete",
      "the report's totals contradict its tests (expected 19 != 18, unexpected 0 != 1)",
      { passed: 18, failed: 1 },
    ],
    [
      "totals that contradict the tests",
      (r) => {
        r.stats.expected = 20;
      },
      "incomplete",
      "the report's totals contradict its tests",
      { passed: 19, designed_skips: 6 },
    ],
    // The report's shape: nothing is walked or guessed from a malformed report.
    [
      "an execution result without a retry count",
      (r) => {
        delete (passing(r).results[0] as Obj).retry;
      },
      "incomplete",
      "retry is not a count",
      whole,
    ],
    [
      "an unknown terminal status",
      (r) => {
        (passing(r).results[0] as Obj).status = "finished";
      },
      "incomplete",
      'has an unknown status "finished"',
      whole,
    ],
    [
      "an unknown aggregate status",
      (r) => {
        passing(r).status = "done";
      },
      "incomplete",
      'has an unknown status "done"',
      whole,
    ],
    [
      "execution results that are not a list",
      (r) => {
        (passing(r) as Obj).results = null;
      },
      "incomplete",
      "results is not a list",
      whole,
    ],
    [
      "an execution result that is not an object",
      (r) => {
        passing(r).results[0] = "passed" as unknown as Obj;
      },
      "incomplete",
      "results[0] is not an object",
      whole,
    ],
    [
      "a test that is not an object",
      (r) => {
        (firstSpecs(r)[0] as Obj).tests = [null];
      },
      "incomplete",
      "tests[0] is not an object",
      whole,
    ],
    [
      "specs that are not a list",
      (r) => {
        (r.suites[0] as Obj).specs = { title: "x" };
      },
      "incomplete",
      "suites[0].specs is not a list",
      whole,
    ],
    [
      "suites that are not a list",
      (r) => {
        (r as Obj).suites = {};
      },
      "incomplete",
      "suites is not a list",
      whole,
    ],
    [
      "annotations that are not a list",
      (r) => {
        passing(r).annotations = "evidence" as unknown as Obj[];
      },
      "incomplete",
      "annotations is not a list",
      whole,
    ],
    [
      "no stats",
      (r) => {
        delete (r as Obj).stats;
      },
      "incomplete",
      "the report has no stats",
      whole,
    ],
    [
      "an invalid start time",
      (r) => {
        r.stats.startTime = "not a valid timestamp";
      },
      "incomplete",
      'stats.startTime is not a time: "not a valid timestamp"',
      whole,
    ],
    [
      "no start time",
      (r) => {
        delete r.stats.startTime;
      },
      "incomplete",
      "stats.startTime is not a time",
      whole,
    ],
    [
      "a missing total",
      (r) => {
        delete r.stats.flaky;
      },
      "incomplete",
      "stats.flaky is not a count",
      whole,
    ],
    [
      "errors that are not a list",
      (r) => {
        (r as Obj).errors = null;
      },
      "incomplete",
      "errors is not a list",
      whole,
    ],
    // The invocation's own time and the report-level checks.
    [
      "a start time before this stack started (stale)",
      (r) => {
        r.stats.startTime = new Date(START - 2_000).toISOString();
      },
      "incomplete",
      "the result file is stale",
      whole,
    ],
    [
      "a start time after this stack finished",
      (r) => {
        r.stats.startTime = new Date(START + 120_000).toISOString();
      },
      "incomplete",
      "after this stack finished",
      whole,
    ],
    [
      "a Playwright error outside any test",
      (r) => {
        r.errors = [{ message: "global setup failed" }];
      },
      "failed",
      "error(s) outside a test",
      { passed: 19, designed_skips: 6 },
    ],
    // Identity: the planned multiset, exactly.
    [
      "a planned case without a result",
      (r) => {
        const specs = firstSpecs(r);
        const [gone] = specs.splice(0, 1) as Array<{ tests: Test[] }>;
        const status = (gone as { tests: Test[] }).tests[0]?.status;
        r.stats.expected =
          (r.stats.expected as number) - (status === "expected" ? 1 : 0);
      },
      "incomplete",
      "1 planned case(s) have no result",
      { unproven: 1 },
    ],
    [
      "an unplanned extra result",
      (r) => {
        const specs = firstSpecs(r);
        specs.push(structuredClone(specs[0] as Obj));
        r.stats.expected = (r.stats.expected as number) + 1;
      },
      "incomplete",
      "1 result(s) were not planned",
      { passed: 19, designed_skips: 6 },
    ],
    [
      "a result for another project",
      (r) => {
        passing(r).projectName = "integration-firefox";
      },
      "incomplete",
      "1 result(s) for another project (integration-firefox)",
      { passed: 18, unproven: 1 },
    ],
  ];
  test.each(cases)(
    "%s is not a pass, and every planned case is still counted once",
    (_label, change, verdict, reason, counts) => {
      const r = real();
      change(r);
      const judged = judge(r);
      expect(judged.verdict).toBe(verdict);
      expect(judged.reasons.join(" | ")).toContain(reason);
      expect(judged.counts).toMatchObject(counts);
      expect(sum(judged.counts)).toBe(25);
    },
  );

  test("a non-zero exit with the real green report fails; an absent, non-JSON or non-object result proves nothing about its 25 cases", () => {
    expect(judge(real(), { exitCode: 1 })).toMatchObject({
      verdict: "failed",
      reasons: ["Playwright exited 1"],
    });
    for (const [report, reason] of [
      [null, "no result file"],
      ['{"suites": [', "the result file is not JSON"],
      ["[]", "the report is not a JSON object"],
    ] as const) {
      const judged = judge(report === null ? null : report, {
        report: report,
      });
      expect(judged.verdict).toBe("incomplete");
      expect(judged.reasons.join(" ")).toContain(reason);
      expect(judged.counts).toMatchObject({ unproven: 25, passed: 0 });
    }
  });

  const skips: Array<
    [string, (r: Report) => void, string, Record<string, number>]
  > = [
    [
      "its execution record removed (results: [])",
      (r) => {
        skipped(r).results = [];
      },
      "not run, and not a designed skip",
      { designed_skips: 5, not_run: 1 },
    ],
    [
      "an interrupted execution",
      (r) => {
        (skipped(r).results[0] as Obj).status = "interrupted";
      },
      "interrupted",
      { designed_skips: 5, interrupted: 1 },
    ],
    [
      "a passing aggregate expectation (not the reporter's skip shape)",
      (r) => {
        skipped(r).expectedStatus = "passed";
      },
      "contradictory skip",
      { designed_skips: 5, unproven: 1 },
    ],
    [
      "another skip description",
      (r) => {
        const t = skipped(r);
        for (const a of [
          ...t.annotations,
          ...t.results.flatMap((x) => x.annotations as Obj[]),
        ])
          if (a.type === "skip") a.description = "skipped for another reason";
      },
      "not run, and not a designed skip",
      { designed_skips: 5, not_run: 1 },
    ],
  ];
  test.each(skips)(
    "a measurement skip with %s is not a designed skip",
    (_label, change, reason, counts) => {
      const r = real();
      change(r);
      const judged = judge(r);
      expect(judged.verdict).toBe("incomplete");
      expect(judged.reasons.join(" | ")).toContain(reason);
      expect(judged.counts).toMatchObject({ passed: 19, ...counts });
      expect(sum(judged.counts)).toBe(25);
    },
  );

  test("the real measurement skips are designed only while ATLAS_PROFILE is unset", () => {
    const judged = judge(real(), {
      context: { env: { ATLAS_PROFILE: "1" }, oidc: false, postgres: false },
    });
    expect(judged.verdict).toBe("incomplete");
    expect(judged.counts).toMatchObject({
      passed: 19,
      designed_skips: 0,
      not_run: 6,
    });
  });
});

describe("R23b (revision 16): an evidence, result or ownership failure launches nothing after it and still reaches a terminal ledger", () => {
  const LAST = ORDER.length - 1;
  /** A write double that fails (ENOSPC) when `fails` says so for this file's nth write. */
  const failingWrite = (
    fails: (name: string, text: string, n: number) => boolean,
  ) => {
    const seen = new Map<string, number>();
    return (file: string, text: string) => {
      const name = file.endsWith("discovery.json")
        ? "discovery/discovery.json"
        : (file.split("/").at(-1) as string);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (fails(name, text, n))
        throw Object.assign(
          new Error("ENOSPC: no space left on device (double)"),
          { code: "ENOSPC" },
        );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
  };
  /** The schedule write that admits entry `index`: that entry is the one recorded running. */
  const admits = (index: number) => (name: string, text: string) =>
    name === "schedule.json" &&
    JSON.parse(text).entries[index].state === "running";
  const checkLedger = (w: World, failedFile: string) => {
    const summary = w.summary();
    expect(summary.status).not.toBe("passed");
    expect(summary.complete).toBe(false);
    expect(summary.evidence.complete).toBe(false);
    expect(summary.evidence.errors.map((e) => e.file)).toContain(failedFile);
    expect(summary.entries.some((e) => e.state === "running")).toBe(false);
    expect(summary.accounted).toBe(true);
    expect(conserved(summary.entries)).toBe(true);
  };

  test.each([
    [
      "the discovery record",
      (name: string) => name.startsWith("discovery/"),
      0,
      "discovery/discovery.json",
    ],
    [
      "the initial schedule",
      (name: string, _t: string, n: number) =>
        name === "schedule.json" && n === 1,
      0,
      "schedule.json",
    ],
    ["the first stack's admission record", admits(0), 0, "schedule.json"],
    [
      "a middle stack's admission record (firefox/base)",
      admits(13),
      13,
      "schedule.json",
    ],
    ["the last stack's admission record", admits(LAST), LAST, "schedule.json"],
  ] as const)(
    "%s cannot be written: no stack launches from then on, and the exit is 1",
    async (_label, fails, launched, failedFile) => {
      const w = await world({ write: failingWrite(fails) });
      expect(w.status).toBe(1);
      expect(w.launches).toEqual(ORDER.slice(0, launched));
      if (launched > 0) expect(endsCleanly(w.events)).toBe(true);
      checkLedger(w, failedFile);
      const entries = w.summary().entries;
      expect(
        entries.slice(0, launched).every((e) => e.state === "passed"),
      ).toBe(true);
      expect(entries.slice(launched).every((e) => e.state === "not_run")).toBe(
        true,
      );
      if (failedFile === "schedule.json" && launched === LAST)
        expect(entries[LAST]?.reasons[0]).toBe(
          "not started: its admission record (schedule.json) could not be written",
        );
    },
    120_000,
  );

  test("the last stack's result record cannot be written: every stack ran and passed, but the invocation is incomplete and exits 1", async () => {
    const w = await world({
      write: failingWrite(
        (name, _t, n) => name === "schedule.json" && n === 2 * ORDER.length + 1,
      ),
    });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(ORDER);
    checkLedger(w, "schedule.json");
    expect(w.summary().status).toBe("incomplete");
    expect(w.summary().entries.every((e) => e.state === "passed")).toBe(true);
  }, 120_000);

  test("a one-shot failure of the final schedule write, the disk then writable again: the summary still says incomplete, exit 1", async () => {
    const w = await world({
      write: failingWrite(
        (name, _t, n) => name === "schedule.json" && n === 2 * ORDER.length + 2,
      ),
    });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(ORDER);
    checkLedger(w, "schedule.json");
    expect(w.summary().status).toBe("incomplete");
  }, 120_000);

  test("the summary cannot be written: no summary file, the terminal ledger goes to the log, exit 1", async () => {
    const w = await world({
      write: failingWrite((name) => name === "summary.json"),
    });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(ORDER);
    expect(existsSync(join(w.evidence, "summary.json"))).toBe(false);
    const ledger = w.logs.find((l) =>
      l.startsWith("the summary could not be written"),
    ) as string;
    const terminal = JSON.parse(ledger.slice(ledger.indexOf("\n") + 1));
    expect(terminal).toMatchObject({
      status: "incomplete",
      complete: false,
      evidence: { complete: false, errors: [{ file: "summary.json" }] },
    });
  }, 120_000);

  test("a disk that refuses every write after the claim: nothing launches, nothing hangs, the ledger is logged, exit 1", async () => {
    const w = await world({ write: failingWrite(() => true) });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual([]);
    expect(existsSync(join(w.evidence, OWNER))).toBe(true);
    expect(existsSync(join(w.evidence, "schedule.json"))).toBe(false);
    expect(
      w.logs.some((l) => l.startsWith("the summary could not be written")),
    ).toBe(true);
  }, 120_000);

  test("a signal that arrives as a stack is admitted: that stack does not launch (exit 143)", async () => {
    let received: string | null = null;
    const w = await world({
      interrupted: () => received,
      write: (file, text) => {
        if (file.endsWith("schedule.json") && admits(2)("schedule.json", text))
          received = "SIGTERM";
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      },
    });
    expect(w.status).toBe(143);
    expect(w.launches).toEqual(ORDER.slice(0, 2));
    expect(w.summary().entries[2]).toMatchObject({
      state: "not_run",
      reasons: ["not started: interrupted by SIGTERM"],
    });
    expect(w.summary().status).toBe("interrupted");
  }, 120_000);

  const unreadable = (code: string, at: string) => (file: string) => {
    if (
      file.endsWith(`results-${at.replace("/", "-").replace("-base", "")}.json`)
    )
      throw Object.assign(
        new Error(`${code}: reading the result file (double)`),
        {
          code,
        },
      );
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  test.each([
    ["EIO", "chromium/sharing"],
    [
      "ENOENT (removed between the existence check and the read)",
      "firefox/base",
    ],
  ])(
    "a result file that cannot be read (%s) makes that stack incomplete after its clean-up; the rest are not run and the ledger is complete",
    async (code, at) => {
      const w = await world({
        readReport: unreadable(code.split(" ")[0] as string, at),
      });
      const index = ORDER.indexOf(at);
      expect(w.status).toBe(1);
      expect(w.launches).toEqual(ORDER.slice(0, index + 1));
      expect(endsCleanly(w.events)).toBe(true);
      const summary = w.summary();
      expect(summary.entries[index]).toMatchObject({
        state: "incomplete",
        phase: "result",
        counts: { unproven: summary.entries[index]?.planned_cases },
      });
      expect(summary.entries[index]?.reasons[0]).toMatch(
        /^the result file could not be read: (EIO|ENOENT)/,
      );
      expect(
        summary.entries.slice(index + 1).every((e) => e.state === "not_run"),
      ).toBe(true);
      expect(summary).toMatchObject({
        status: "incomplete",
        complete: false,
        accounted: true,
      });
      expect(summary.evidence.complete).toBe(true);
      expect(w.schedule().entries.some((e) => e.state === "running")).toBe(
        false,
      );
    },
    120_000,
  );

  test("an unreadable result AND an unwritable summary: still exit 1, both in the logged terminal ledger", async () => {
    const w = await world({
      readReport: unreadable("EIO", "chromium/sharing"),
      write: failingWrite((name) => name === "summary.json"),
    });
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(
      ORDER.slice(0, ORDER.indexOf("chromium/sharing") + 1),
    );
    const ledger = w.logs.find((l) =>
      l.startsWith("the summary could not be written"),
    ) as string;
    const terminal = JSON.parse(ledger.slice(ledger.indexOf("\n") + 1));
    expect(terminal.status).toBe("incomplete");
    expect(terminal.evidence.errors).toEqual([
      expect.objectContaining({ file: "summary.json" }),
    ]);
    expect(
      terminal.entries[ORDER.indexOf("chromium/sharing")].reasons[0],
    ).toMatch(/^the result file could not be read: EIO/);
  }, 120_000);

  test("an error while judging a stack (a malformed process record) is contained: that stack is incomplete, nothing launches after it", async () => {
    const at = "chromium/pages";
    const w = await world({
      execute: async (stack, browser, file, keys) => {
        writeFileSync(file, report(keys, { outcome: normal }));
        return {
          exitCode: 0,
          exchanges:
            `${browser}/${stack.name}` === at
              ? ([null] as unknown as Launched["exchanges"])
              : [],
        };
      },
    });
    const index = ORDER.indexOf(at);
    expect(w.status).toBe(1);
    expect(w.launches).toEqual(ORDER.slice(0, index + 1));
    expect(w.summary().entries[index]).toMatchObject({
      state: "incomplete",
      phase: "result",
    });
    expect(w.summary().entries[index]?.reasons[0]).toMatch(
      /^the result could not be judged: /,
    );
    expect(w.summary().accounted).toBe(true);
  }, 120_000);
});

describe("C5 (revision 16): one invocation owns its evidence directory", () => {
  test("two invocations that both found the directory empty: exactly one claims it; the other lists, writes and launches nothing", async () => {
    const one = planStacks({
      grep: "I-14e",
      passthrough: [],
      oidc: true,
      postgres: false,
    });
    planned.set("narrowed", await keysOf(stackArgs(one.stacks[0] as Stack)));
    const evidence = join(scratch, "shared-evidence");
    const claims: string[] = [];
    const claim = (file: string, text: string) => {
      mkdirSync(dirname(file), { recursive: true });
      try {
        writeFileSync(file, text, { flag: "wx" });
        claims.push("won");
      } catch (error) {
        claims.push("lost");
        throw error;
      }
    };
    // Both observed every path absent before either claimed (the interleaving a plain existence check cannot exclude).
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        world({
          stacks: one.stacks,
          narrowed: true,
          evidence,
          exists: () => false,
          claim,
        }),
      ),
    );
    expect(claims.sort()).toEqual(["lost", "won"]);
    const [winner, loser] =
      (a as World).status === 0
        ? [a as World, b as World]
        : [b as World, a as World];
    expect(winner.status).toBe(0);
    expect(loser.status).toBe(1);
    expect(loser.events).toEqual([]);
    expect(loser.launches).toEqual([]);
    expect(loser.logs.join("\n")).toMatch(
      /REFUSED: could not claim .*invocation\.json/,
    );
    expect(winner.launches).toEqual(BROWSERS.map((b) => `${b}/narrowed`));
    expect(winner.summary()).toMatchObject({
      status: "passed",
      complete: true,
    });
  }, 120_000);

  test("a claim left by an earlier (crashed) invocation is refused, not taken over, and its bytes are kept; a fresh directory runs", async () => {
    const left = '{"pid": 1, "claimed_at": "2026-10-15T00:00:00.000Z"}\n';
    const refused = await world({
      before: (evidence) => {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, OWNER), left);
      },
    });
    expect(refused.status).toBe(1);
    expect(refused.events).toEqual([]);
    expect(readFileSync(join(refused.evidence, OWNER), "utf8")).toBe(left);
    // The same claim, met at the exclusive create rather than at the existence check.
    const raced = await world({
      exists: () => false,
      before: (evidence) => {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, OWNER), left);
      },
    });
    expect(raced.status).toBe(1);
    expect(raced.events).toEqual([]);
    expect(readFileSync(join(raced.evidence, OWNER), "utf8")).toBe(left);
    const fresh = await world();
    expect(fresh.status).toBe(0);
  }, 120_000);
});
