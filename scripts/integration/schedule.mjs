// WEB-08c revision 14 (review 14: R17, R18): one integration invocation, from the case inventory to the exit status. Adapted from
// the sibling WEB-14a working tree (revisions 15/16, commit dab446e: a reference input, not accepted or merged); see stacks.mjs.
//
//   1. refuse to start if any evidence path of this invocation already exists (no result is overwritten or mistaken for this run's),
//      then claim the evidence directory EXCLUSIVELY (`invocation.json`, created only if absent): of two invocations given the same
//      directory, exactly one proceeds and the other lists, writes and launches nothing;
//   2. list every stack's cases with Playwright itself (no backend is started) and, for the default suite, check that each discovered
//      case belongs to exactly one stack or a separate obligation (stacks.mjs `assignCases`);
//   3. run the stacks one at a time. A stack starts only once its own "running" record has been written and nothing has failed, been
//      interrupted or failed to be recorded before it; then it is prepared and run, cleaned up, its own result file is read and judged,
//      and only then may the next stack or browser start. The first stack that is not a complete pass stops the schedule; everything
//      after it is recorded `not_run` (counted `not_launched`), never passed;
//   4. write the schedule after every stack and the summary at the end; exit non-zero unless every planned stack passed AND every
//      evidence write succeeded.
//
// Evidence writes (WEB-14a revision 16, review R23b, kept): an evidence write that fails is latched for the whole invocation (it is listed in the summary, the
// summary can then never say passed or complete, and the exit is non-zero), and it stops the schedule BEFORE the next launch,
// including the failure of the very record that would admit that launch. A result file that cannot be read or judged, and any other
// error after a launch, makes that stack incomplete, marks the rest not run and still reaches the final schedule and summary.
// `summary.json` is the invocation's outcome; `schedule.json` is its progress record. If even the summary cannot be written, the
// terminal ledger goes to the log (stderr) and the exit is non-zero.
//
// The processes come from `deps` (scripts/integration/run.mjs gives the real ones; tests/static/integration-runner.test.ts doubles).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assignCases,
  emptyCounts,
  judgeStack,
  reportCases,
  reportShapeProblems,
  SEPARATE,
  stackArgs,
  throttleRecord,
} from "./stacks.mjs";

const keysOf = (text) => {
  const parsed = JSON.parse(text);
  const problems = reportShapeProblems(parsed);
  if (problems.length > 0)
    throw new Error(`the listing is malformed: ${problems.join("; ")}`);
  return reportCases(parsed).map((c) => c.key);
};
const inBrowser = (keys, browser) =>
  keys.filter((key) => key.startsWith(`integration-${browser} › `));
const counted = (keys) => {
  const map = new Map();
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};
const message = (error) =>
  String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, 300);

/** The file that makes an evidence directory one invocation's own (created exclusively; never removed or reused). */
export const OWNER = "invocation.json";

/** The evidence paths one invocation writes. Each must not exist before it starts. */
export function evidencePaths(evidence, browsers, stacks) {
  return [
    join(evidence, OWNER),
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
  const { browsers, stacks, narrowed, evidence, env, postgres, layer } =
    options;
  // The default suite's whole manifest (closure check) and whether this run is only a named subset of it (`--stacks`).
  const manifest = options.manifest ?? stacks;
  const partial = Boolean(options.partial);
  const log = deps.log;
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

  // 1. No collision with earlier evidence, before anything is written; then this invocation's exclusive claim on the directory, and
  //    the same check again under that claim (a writer that does not claim cannot slip in between).
  const collisions = () =>
    evidencePaths(evidence, browsers, stacks).filter((p) => deps.exists(p));
  let taken = collisions();
  if (taken.length > 0) {
    log(
      `REFUSED: this invocation's evidence already exists (give a fresh --evidence directory):\n  ${taken.join("\n  ")}`,
    );
    return 1;
  }
  try {
    deps.claim(
      join(evidence, OWNER),
      json({
        layer,
        claimed_at: new Date(deps.now()).toISOString(),
        pid: process.pid,
        browsers,
        stacks: stacks.map((s) => s.name),
        narrowed,
        partial,
      }),
    );
  } catch (error) {
    log(
      `REFUSED: could not claim ${join(evidence, OWNER)} for this invocation (another invocation owns this directory, or an earlier one left it): ${message(error)}`,
    );
    return 1;
  }
  taken = collisions().filter((p) => p !== join(evidence, OWNER));
  if (taken.length > 0) {
    log(
      `REFUSED: evidence appeared in the claimed directory:\n  ${taken.join("\n  ")}`,
    );
    return 1;
  }

  // Every evidence write's outcome. A failure is latched: nothing is admitted after it, and the invocation cannot pass or be complete.
  const evidenceErrors = [];
  const persist = (name, value) => {
    try {
      deps.write(join(evidence, name), json(value));
      return true;
    } catch (error) {
      evidenceErrors.push({
        file: name,
        at: new Date(deps.now()).toISOString(),
        error: message(error),
      });
      log(`could not write ${name}: ${message(error)}`);
      return false;
    }
  };

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
    failure = `discovery failed: ${message(error)}`;
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
  persist("discovery/discovery.json", discovery);
  const schedule = () => ({
    layer,
    generated_at: new Date(deps.now()).toISOString(),
    note: "progress record; the invocation's outcome is summary.json",
    entries: entries.map(view),
  });
  const notRun = (entry, why) => {
    entry.state = "not_run";
    entry.reasons = [`not started: ${why.split("\n")[0]}`];
    entry.counts = { ...emptyCounts(), not_launched: entry.planned_cases };
  };
  const unprovenAll = (entry) => ({
    ...emptyCounts(),
    unproven: entry.planned_cases,
  });

  // 3. The stacks, one at a time; the first that is not a complete pass stops the rest.
  let stopped = failure;
  let internal = null;
  if (failure) log(`NOT STARTED: ${failure}`);
  persist("schedule.json", schedule());
  try {
    for (const entry of entries) {
      const signal = deps.interrupted();
      if (!stopped && signal) stopped = `interrupted by ${signal}`;
      if (!stopped && evidenceErrors.length > 0)
        stopped = `the evidence could not be written (${evidenceErrors[0].file})`;
      if (stopped) {
        notRun(entry, stopped);
        continue;
      }
      log(
        `\n=== integration-${entry.browser}${entry._stack.suffix ? ` (${entry._stack.name})` : ""} ===`,
      );
      const startedAt = deps.now();
      entry.state = "running";
      entry.started_at = new Date(startedAt).toISOString();
      // Admission: this stack's own "running" record must be written, and nothing may have failed to be recorded or been
      // interrupted since. No await separates this decision from the launch.
      const admitted = persist("schedule.json", schedule());
      const signalAtAdmission = deps.interrupted();
      if (!admitted || evidenceErrors.length > 0 || signalAtAdmission) {
        stopped = signalAtAdmission
          ? `interrupted by ${signalAtAdmission}`
          : !admitted
            ? "its admission record (schedule.json) could not be written"
            : `the evidence could not be written (${evidenceErrors[0].file})`;
        delete entry.started_at;
        notRun(entry, stopped);
        continue;
      }
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
          problems: [`clean-up failed: ${message(error)}`],
        };
      }
      try {
        const finishedAt = deps.now();
        entry.finished_at = new Date(finishedAt).toISOString();
        entry.exit_code = launched?.exitCode ?? null;
        entry.throttle = throttleRecord(launched?.exchanges ?? []);
        if (launched.error) {
          entry.state = "failed";
          entry.phase = launched.phase;
          entry.reasons = [`${launched.phase}: ${message(launched.error)}`];
          // `prepare` and `spawn` end before Playwright starts (run.mjs `main`): those cases were not launched. Anything else is unproven.
          entry.counts =
            launched.phase === "prepare" || launched.phase === "spawn"
              ? { ...emptyCounts(), not_launched: entry.planned_cases }
              : unprovenAll(entry);
        } else {
          let report;
          let readError = null;
          try {
            report = deps.readReport(entry.result_file);
          } catch (error) {
            readError = error;
          }
          if (readError) {
            entry.state = "incomplete";
            entry.phase = "result";
            entry.reasons = [
              `the result file could not be read: ${message(readError)}`,
            ];
            entry.counts = unprovenAll(entry);
          } else {
            const judged = judgeStack({
              planned: entry._planned,
              report,
              exitCode: launched.exitCode,
              startedAt,
              finishedAt,
              project: `integration-${entry.browser}`,
              context: { env, oidc: entry._stack.oidc, postgres },
              refusals: entry.throttle.refusals_429,
              deliberateThrottle: entry._deliberate,
            });
            entry.state = judged.verdict;
            entry.phase = judged.verdict === "passed" ? undefined : "result";
            entry.reasons = judged.reasons;
            entry.counts = judged.counts;
            entry.designed_skips = judged.designed_skips;
          }
        }
      } catch (error) {
        entry.state = "incomplete";
        entry.phase = "result";
        entry.reasons = [`the result could not be judged: ${message(error)}`];
        entry.counts = unprovenAll(entry);
      }
      const problems = cleaned?.problems ?? [];
      if ((cleaned?.notes ?? []).length > 0)
        entry.cleanup_notes = cleaned.notes;
      if (problems.length > 0) {
        entry.cleanup_problems = problems;
        if (entry.state === "passed") {
          entry.state = "failed";
          entry.phase = "cleanup";
        }
        entry.reasons = [...entry.reasons, ...problems];
      }
      const signalNow = deps.interrupted();
      if (signalNow) {
        entry.state = "interrupted";
        entry.reasons = [`interrupted by ${signalNow}`, ...entry.reasons];
      }
      if (entry.state !== "passed")
        stopped = `integration-${entry.browser} ${entry.stack} ${entry.state}`;
      persist("schedule.json", schedule());
    }
  } catch (error) {
    // Nothing above should throw; if something does, it ends the schedule here and is reported, never passed.
    internal = `the schedule stopped on an error: ${message(error)}`;
    log(internal);
  }
  for (const entry of entries)
    if (entry.state === "planned") notRun(entry, internal ?? "not reached");
    else if (entry.state === "running") {
      entry.state = "incomplete";
      entry.reasons = [internal ?? "the schedule ended while it ran"];
      entry.counts = unprovenAll(entry);
    }
  // The entries the schedule did not start are recorded as such in the schedule too.
  persist("schedule.json", schedule());

  // 4. The summary: per engine, what each stack did. Every planned case is counted once; not_launched, unproven and designed skips are
  //    never counted as passed. The invocation passes only if every stack passed and every evidence write succeeded.
  const signal = deps.interrupted();
  const engines = {};
  let accounted = true;
  for (const browser of browsers) {
    const mine = entries.filter((e) => e.browser === browser);
    const sum = emptyCounts();
    for (const e of mine)
      for (const key of Object.keys(sum)) sum[key] += e.counts?.[key] ?? 0;
    const planned = mine.reduce((n, e) => n + e.planned_cases, 0);
    const counts = Object.values(sum).reduce((n, k) => n + k, 0);
    if (counts !== planned) accounted = false;
    engines[browser] = {
      complete: mine.every((e) => e.state === "passed"),
      planned_cases: planned,
      ...sum,
      accounted: counts === planned,
      stacks: Object.fromEntries(mine.map((e) => [e.stack, e.state])),
    };
  }
  const allPassed =
    !failure && !internal && entries.every((e) => e.state === "passed");
  const outcome = () => {
    const healthy = evidenceErrors.length === 0 && accounted;
    return {
      status: signal
        ? "interrupted"
        : allPassed && healthy
          ? "passed"
          : entries.some((e) => e.state === "failed") || failure || internal
            ? "failed"
            : "incomplete",
      complete: allPassed && healthy && !partial,
    };
  };
  const summary = () => ({
    layer,
    generated_at: new Date(deps.now()).toISOString(),
    ...outcome(),
    partial: partial ? stacks.map((s) => s.name) : undefined,
    not_started: failure ?? undefined,
    schedule_error: internal ?? undefined,
    evidence: {
      complete: evidenceErrors.length === 0,
      errors: [...evidenceErrors],
    },
    accounted,
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
  if (!persist("summary.json", summary()))
    log(
      `the summary could not be written; this invocation's terminal ledger:\n${json(summary())}`,
    );
  if (signal) return exitFor(signal);
  if (!allPassed || evidenceErrors.length > 0 || !accounted) return 1;
  return 0;
}
