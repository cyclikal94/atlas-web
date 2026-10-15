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
  playwrightLister,
  runIntegration,
} from "../../scripts/integration/schedule.mjs";
import {
  assignCases,
  DEFAULT_STACKS,
  DESIGNED_SKIPS,
  designedSkip,
  planStacks,
  reportCases,
  type Stack,
  stackArgs,
} from "../../scripts/integration/stacks.mjs";

/**
 * WEB-14a revision 15 (review R22, R23): the integration runner's stack assignment and schedule, through the runner's own modules
 * (scripts/integration/stacks.mjs, schedule.mjs). Discovery is Playwright's real `--list` of tests/integration (no backend, no
 * browser); only the stack PROCESSES are doubles: `execute` writes the result file a stack's Playwright would write.
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
  }: {
    outcome?: (key: string, file: string) => Outcome;
    startTime?: string;
    errors?: unknown[];
  } = {},
): string {
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
    suite.specs.push({
      title: titles.at(-1) as string,
      file: `../integration/${file}`,
      tests: [test],
    });
  }
  return JSON.stringify({
    config: {},
    suites: [...files.values()],
    errors,
    stats: { startTime, expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
  });
}
/** The double's normal answer: everything passes, the measurement specs are their designed skips. */
const normal = (_key: string, file: string): Outcome =>
  DESIGNED_FILES.has(file) && file.includes("profile") ? "designed" : "passed";

interface World {
  evidence: string;
  events: string[];
  launches: string[];
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
    entries: Array<{
      state: string;
      stack: string;
      browser: string;
      reasons: string[];
      phase?: string;
    }>;
  };
}
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
} = {}): Promise<World> {
  worlds += 1;
  const evidence = join(scratch, `world-${worlds}`);
  before?.(evidence);
  const events: string[] = [];
  const launches: string[] = [];
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
      app: "",
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
      readReport: (file) =>
        existsSync(file) ? readFileSync(file, "utf8") : null,
      exists: existsSync,
      write:
        write ??
        ((file, text) => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, text);
        }),
      now: () => Date.now(),
      log: () => undefined,
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
    status,
    schedule: () => read("schedule.json"),
    summary: () => read("summary.json"),
  };
}
const ORDER = BROWSERS.flatMap((b) => STACKS.map((s) => `${b}/${s.name}`));

describe("R22: every discovered integration case is in exactly one stack (Playwright's own listing)", () => {
  test("the default stacks and the separate I-U2 obligation cover the whole listing once, in every engine", async () => {
    const whole = await keysOf([]);
    const pwa = await keysOf(["tests/integration/integration.pwa.spec.ts"]);
    const stacks = STACKS.map((s) => ({
      name: s.name,
      keys: planned.get(s.name) ?? [],
    }));
    expect(
      assignCases({
        all: whole,
        stacks,
        separate: [{ name: "pwa", keys: pwa }],
        browsers: BROWSERS,
      }),
    ).toEqual({ ok: true, problems: [] });
    for (const browser of BROWSERS) {
      expect(
        Object.fromEntries(
          stacks.map((s) => [s.name, inBrowser(s.keys, browser).length]),
        ),
      ).toEqual({
        base: 25,
        pages: 13,
        "password-path": 8,
        i14e: 4,
        i14d: 2,
        data: 37,
        traces: 16,
        registration: 20,
        oidc: 10,
        "oidc-off": 1,
        settings: 10,
        sharing: 7,
        snapshot: 6,
      });
      expect(inBrowser(whole, browser)).toHaveLength(160);
      expect(inBrowser(pwa, browser)).toHaveLength(1);
    }
    // Sharing and snapshot are named by their own stacks only.
    for (const s of stacks)
      expect(
        s.keys.some((k) => /integration\.(sharing|snapshot)\.spec/.test(k)),
      ).toBe(s.name === "sharing" || s.name === "snapshot");
  }, 120_000);

  test("compared with the schedule Review ran, only sharing, snapshot, pages and password-path cases move: from base to their own fresh stacks", async () => {
    // The revision-14 stacks, verbatim (scripts/integration/run.mjs at 6ad80ae).
    const OLD: Array<[string, string[]]> = [
      [
        "base",
        [
          "--grep-invert",
          "I-14e|I-14d \\(revision 11\\)|I-(P|O|C|S|W|U)[0-9]|I-2[0-9]|I-30",
        ],
      ],
      ["i14e", ["--grep", "I-14e"]],
      ["i14d", ["--grep", "I-14d \\(revision 11\\)"]],
      ["data", ["tests/integration/integration.data.spec.ts"]],
      ["traces", ["--grep", "I-20|I-22|I-23"]],
      ["registration", ["--grep", "I-24|I-25|I-26"]],
      ["oidc", ["--grep", "I-21|I-27|I-28a"]],
      ["oidc-off", ["--grep", "I-28b"]],
      ["settings", ["--grep", "I-29|I-30"]],
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
    // Per engine: sharing 7, snapshot 6 (R22) and pages 13, password-path 8 (revision 15's measured throttle split).
    expect(moved).toEqual({
      sharing: 21,
      snapshot: 18,
      pages: 39,
      "password-path": 24,
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
              tests: [{ projectName: "integration-firefox", results: [] }],
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
    const runs = w.events.filter((e) => !e.startsWith("list"));
    expect(runs).toEqual(ORDER.flatMap((o) => [`launch ${o}`, "cleanup"]));
    const summary = w.summary();
    expect(summary.status).toBe("passed");
    expect(summary.complete).toBe(true);
    const engines = summary.engines as Record<string, Record<string, unknown>>;
    for (const browser of BROWSERS)
      expect(engines[browser]).toMatchObject({
        complete: true,
        planned_cases: 159,
        passed: 153,
        designed_skips: 6,
        failed: 0,
        not_run: 0,
      });
    expect(summary.separate_obligations).toEqual([
      expect.objectContaining({
        name: "pwa",
        state: "not run by this command",
      }),
    ]);
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
      expect(w.events.filter((e) => !e.startsWith("list")).at(-1)).toBe(
        "cleanup",
      );
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
      expect(w.events.at(-1)).toBe("cleanup");
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
    const w = await world({
      interrupted: () => received,
      list: async (selection, label) => {
        received = "SIGTERM";
        return cachedList(selection, label);
      },
    });
    expect(w.status).toBe(143);
    expect(w.launches).toEqual([]);
    expect(new Set(w.summary().entries.map((e) => e.state))).toEqual(
      new Set(["not_run"]),
    );
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
  const context = { env: {}, oidc: false, app: "" };
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
    "-traces",
    "-registration",
    "-oidc",
    "-oidc-off",
    "-settings",
    "-sharing",
    "-snapshot",
  ]);
  expect(DEFAULT_STACKS.filter((s) => s.oidc).map((s) => s.name)).toEqual([
    "oidc",
  ]);
  expect(
    DEFAULT_STACKS.filter((s) => s.deliberateThrottle).map((s) => s.name),
  ).toEqual(["settings"]);
});
