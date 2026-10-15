// WEB-14a revision 15 (review R22, R23): one integration invocation, from the case inventory to the exit status.
//
//   1. refuse to start if any evidence path of this invocation already exists (no result is overwritten or mistaken for this run's);
//   2. list every stack's cases with Playwright itself (no backend is started) and, for the default suite, check that each discovered
//      case belongs to exactly one stack or a separate obligation (stacks.mjs `assignCases`);
//   3. run the stacks one at a time: prepare and run, clean up, judge the stack's own result file, and only then decide whether the
//      next stack or browser may start. The first stack that is not a complete pass stops the schedule; everything after it is
//      recorded `not_run`, never passed;
//   4. write the schedule after every stack and the summary at the end; exit non-zero unless every planned stack passed.
//
// The processes come from `deps` (scripts/integration/run.mjs gives the real ones; tests/static/integration-runner.test.ts doubles).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignCases,
  judgeStack,
  reportCases,
  SEPARATE,
  stackArgs,
  throttleRecord,
} from "./stacks.mjs";

const keysOf = (text) => reportCases(JSON.parse(text)).map((c) => c.key);
const inBrowser = (keys, browser) =>
  keys.filter((key) => key.startsWith(`integration-${browser} › `));
const counted = (keys) => {
  const map = new Map();
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};

/** The evidence paths one invocation writes. Each must not exist before it starts. */
export function evidencePaths(evidence, browsers, stacks) {
  return [
    join(evidence, "schedule.json"),
    join(evidence, "summary.json"),
    join(evidence, "discovery"),
    ...browsers.flatMap((browser) =>
      stacks.map((stack) =>
        join(evidence, `results-${browser}${stack.suffix}.json`),
      ),
    ),
  ];
}

/**
 * Playwright's own listing of a selection, for every browser of the invocation at once: no backend, no browser is started. Each
 * listing's JSON (and the evidence allocation the config makes even for `--list`) is kept under `dir`.
 */
export function playwrightLister({ root, browsers, dir, env }) {
  let listed = 0;
  return async (selection, label) => {
    mkdirSync(dir, { recursive: true });
    listed += 1;
    const out = join(dir, `${String(listed).padStart(2, "0")}-${label}.json`);
    const ran = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--list",
        "--reporter=json",
        ...browsers.map((b) => `--project=integration-${b}`),
        ...selection,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
          // Firefox and WebKit projects exist only with ATLAS_E2E_BROWSERS=all.
          ATLAS_E2E_BROWSERS: "all",
          ATLAS_EVIDENCE_DIR: join(dir, "browser-evidence"),
          PLAYWRIGHT_JSON_OUTPUT_NAME: out,
        },
      },
    );
    if (ran.status !== 0 || !existsSync(out))
      throw new Error(
        `playwright --list ${selection.join(" ")} exited ${ran.status}: ${`${ran.stdout}${ran.stderr}`.slice(-600)}`,
      );
    return readFileSync(out, "utf8");
  };
}

const exitFor = (signal) => (signal === "SIGINT" ? 130 : 143);

export async function runIntegration({ options, deps }) {
  const { browsers, stacks, narrowed, evidence, env, app, layer } = options;
  // The default suite's whole manifest (closure check) and whether this run is only a named subset of it (`--stacks`).
  const manifest = options.manifest ?? stacks;
  const partial = Boolean(options.partial);
  const log = deps.log;
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  // 1. No collision with earlier evidence, before anything is written.
  const taken = evidencePaths(evidence, browsers, stacks).filter((p) =>
    deps.exists(p),
  );
  if (taken.length > 0) {
    log(
      `REFUSED: this invocation's evidence already exists (give a fresh --evidence directory):\n  ${taken.join("\n  ")}`,
    );
    return 1;
  }

  // 2. The case inventory, from Playwright's own listing.
  const discovery = {
    narrowed,
    browsers,
    stacks: {},
    separate: {},
    whole: null,
    assignment: null,
  };
  const listed = {};
  let failure = null;
  try {
    for (const stack of narrowed ? stacks : manifest) {
      listed[stack.name] = keysOf(
        await deps.list(
          [...stackArgs(stack), ...(stack.passthrough ?? [])],
          `stack-${stack.name}`,
        ),
      );
      discovery.stacks[stack.name] = {
        args: [...stackArgs(stack), ...(stack.passthrough ?? [])],
        cases: listed[stack.name],
      };
    }
    if (!narrowed) {
      const whole = keysOf(await deps.list([], "whole"));
      const separate = [];
      for (const obligation of SEPARATE) {
        const keys = keysOf(
          await deps.list(obligation.files, `separate-${obligation.name}`),
        );
        separate.push({ name: obligation.name, keys });
        discovery.separate[obligation.name] = {
          obligation: obligation.obligation,
          cases: keys,
        };
      }
      discovery.whole = whole.length;
      discovery.assignment = assignCases({
        all: whole,
        stacks: manifest.map((s) => ({ name: s.name, keys: listed[s.name] })),
        separate,
        browsers,
      });
      if (!discovery.assignment.ok)
        failure = `the stacks do not cover the discovered cases exactly once:\n  ${discovery.assignment.problems.join("\n  ")}`;
    } else
      for (const browser of browsers)
        if (inBrowser(listed[stacks[0].name], browser).length === 0)
          failure = `the narrowed selection lists no case in ${browser}`;
  } catch (error) {
    failure = `discovery failed: ${String(error?.message ?? error)}`;
  }

  const entries = browsers.flatMap((browser) =>
    stacks.map((stack) => {
      const keys = inBrowser(listed[stack.name] ?? [], browser);
      return {
        browser,
        stack: stack.name,
        result_file: join(evidence, `results-${browser}${stack.suffix}.json`),
        planned_cases: keys.length,
        state: "planned",
        reasons: [],
        _stack: stack,
        _planned: counted(keys),
        _deliberate:
          stack.deliberateThrottle ??
          keys.some((k) =>
            k.includes(" › integration.web08b-settings.spec.ts › "),
          ),
      };
    }),
  );
  const view = (entry) =>
    Object.fromEntries(
      Object.entries(entry).filter(([key]) => !key.startsWith("_")),
    );
  let writeFailed = false;
  const persist = (name, value) => {
    try {
      deps.write(join(evidence, name), json(value));
    } catch (error) {
      writeFailed = true;
      log(`could not write ${name}: ${String(error?.message ?? error)}`);
    }
  };
  persist("discovery/discovery.json", discovery);
  const schedule = () => ({
    layer,
    generated_at: new Date(deps.now()).toISOString(),
    entries: entries.map(view),
  });

  // 3. The stacks, one at a time; the first that is not a complete pass stops the rest.
  let stopped = failure;
  if (failure) log(`NOT STARTED: ${failure}`);
  persist("schedule.json", schedule());
  for (const entry of entries) {
    const signal = deps.interrupted();
    if (!stopped && signal) stopped = `interrupted by ${signal}`;
    if (!stopped && writeFailed) stopped = "the schedule could not be written";
    if (stopped) {
      entry.state = "not_run";
      entry.reasons = [`not started: ${stopped.split("\n")[0]}`];
      continue;
    }
    log(
      `\n=== integration-${entry.browser}${entry._stack.suffix ? ` (${entry._stack.name})` : ""} ===`,
    );
    const startedAt = deps.now();
    entry.state = "running";
    entry.started_at = new Date(startedAt).toISOString();
    persist("schedule.json", schedule());
    let launched;
    try {
      launched = await deps.execute(entry._stack, entry.browser);
    } catch (error) {
      launched = {
        exitCode: null,
        phase: error?.phase ?? "prepare",
        error,
        exchanges: error?.exchanges ?? [],
      };
    }
    let cleaned;
    try {
      cleaned = await deps.cleanup();
    } catch (error) {
      cleaned = {
        problems: [`clean-up failed: ${String(error?.message ?? error)}`],
      };
    }
    entry.finished_at = new Date(deps.now()).toISOString();
    entry.exit_code = launched.exitCode ?? null;
    entry.throttle = throttleRecord(launched.exchanges ?? []);
    const signalNow = deps.interrupted();
    if (launched.error) {
      entry.state = "failed";
      entry.phase = launched.phase;
      entry.reasons = [
        `${launched.phase}: ${String(launched.error?.message ?? launched.error).split("\n")[0]}`,
      ];
    } else {
      const judged = judgeStack({
        planned: entry._planned,
        report: deps.readReport(entry.result_file),
        exitCode: launched.exitCode,
        startedAt,
        project: `integration-${entry.browser}`,
        context: { env, oidc: entry._stack.oidc, app },
        refusals: entry.throttle.refusals_429,
        deliberateThrottle: entry._deliberate,
      });
      entry.state = judged.verdict;
      entry.phase = judged.verdict === "passed" ? undefined : "result";
      entry.reasons = judged.reasons;
      entry.counts = judged.counts;
      entry.designed_skips = judged.designed_skips;
    }
    const problems = cleaned?.problems ?? [];
    if (problems.length > 0) {
      entry.cleanup_problems = problems;
      if (entry.state === "passed") {
        entry.state = "failed";
        entry.phase = "cleanup";
      }
      entry.reasons = [...entry.reasons, ...problems];
    }
    if (signalNow) {
      entry.state = "interrupted";
      entry.reasons = [`interrupted by ${signalNow}`, ...entry.reasons];
    }
    if (entry.state !== "passed")
      stopped = `integration-${entry.browser} ${entry.stack} ${entry.state}`;
    persist("schedule.json", schedule());
  }
  // The entries the schedule did not start are recorded as such in the schedule too.
  persist("schedule.json", schedule());

  // 4. The summary: per engine, what each stack did; not_run and designed skips are never counted as passed.
  const signal = deps.interrupted();
  const allPassed = !failure && entries.every((e) => e.state === "passed");
  const status = signal
    ? "interrupted"
    : allPassed
      ? "passed"
      : entries.some((e) => e.state === "failed") || failure
        ? "failed"
        : "incomplete";
  const engines = {};
  for (const browser of browsers) {
    const mine = entries.filter((e) => e.browser === browser);
    const sum = { passed: 0, designed_skips: 0, failed: 0, not_run: 0 };
    for (const e of mine)
      for (const key of Object.keys(sum)) sum[key] += e.counts?.[key] ?? 0;
    engines[browser] = {
      complete: mine.every((e) => e.state === "passed"),
      planned_cases: mine.reduce((n, e) => n + e.planned_cases, 0),
      ...sum,
      stacks: Object.fromEntries(mine.map((e) => [e.stack, e.state])),
    };
  }
  persist("summary.json", {
    layer,
    generated_at: new Date(deps.now()).toISOString(),
    status,
    complete: allPassed && !partial,
    partial: partial ? stacks.map((s) => s.name) : undefined,
    not_started: failure ?? undefined,
    engines,
    entries: entries.map(view),
    separate_obligations: narrowed
      ? []
      : SEPARATE.map((s) => ({
          name: s.name,
          obligation: s.obligation,
          state: "not run by this command",
        })),
    backend: deps.backend(),
  });
  if (signal) return exitFor(signal);
  if (!allPassed || writeFailed) return 1;
  return 0;
}
