#!/usr/bin/env node
// WEB-14a revision 27 (review r26 R31, design assessment C1/C2): one Vitest run under an owned lifecycle, ending in a terminal
// evidence envelope that scripts/mutation/vitest-evidence.mjs reads. A consumer never admits a run from its JSON report alone.
//
//   node scripts/mutation/vitest-supervised.mjs <request.json>
//
// The request (schema atlas-vitest-request/1) names the config, the test files, the JSON report path, the envelope path, a nonce and
// a label. This process runs Vitest 5.0.1 programmatically with the JSON reporter plus a WITNESS reporter that counts, from Vitest's
// own entities, every module, nested suite and test error and the unhandled errors handed to onTestRunEnd. It then closes Vitest
// itself, counting every error Vitest logs (close() logs global-teardown and pool/project close failures and still resolves),
// unhandled errors recorded after the run and process-level error events, with a bound on shutdown. Only after all of that is the
// envelope written (atomically, then the process exits with the code it records). A crash, kill or exit before that point leaves NO
// envelope, which every consumer refuses.
//
// Revision 28 (review r27 R31, design assessment C1): every project's FIRST setup file is vitest-origin-setup.mjs, which records in
// the worker which framework class produced each assertion error, bound to this request's nonce (passed to the workers in the
// environment). The setup is prepended by a `configureVitest` hook, so the config's own setup files still run, in their order, after
// it. A project without it is an unsupported lifecycle (no admissible envelope).
//
// Revision 29 (review r28 R31 incomplete_fix, design assessment C3): the setup no longer brands a class; each project's workers also get
// `--import vitest-origin-register.mjs`, whose loading hook instruments the pinned framework modules so that each audited site marks
// the error it constructs (vitest-origin-sites.mjs). The setup proves in every worker that this happened. The envelope (schema 3)
// records the adapter digest of the exact table and files used; a project without the setup first or without the hook is unsupported.
// Each witnessed test records its id, to which an assertion's receipt must belong.
//
// Revision 30 (review r29 R31/R33, design assessment b8e8e25d C3/C4): workers also run with `--experimental-async-context-frame` (the
// runtime's asynchronous invocation context without promise hooks), and each witnessed module carries the runtime's per-file health
// attestation from its task meta (vitest-origin-setup.mjs); envelope schema 4.
//
// Mutation-runner time limit (7 November 2026, MUTATION-RUNNER-TIMEOUT-20261107): a request may name `testTimeoutMs`, which is given to
// Vitest as `testTimeout` (the per-test DEFAULT; a test's or suite's own explicit timeout still wins). Every project must resolve to
// exactly that limit (`origin.projects[].testTimeout`) or the lifecycle is unsupported, and each witnessed test records the limit it ran
// under (`timeout`). Without it, Vitest's own default applies. The envelope schema is unchanged: both records are additions.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { searchForWorkspaceRoot } from "vite";
import {
  adapterDigest,
  ENVELOPE_SCHEMA,
  ORIGIN_FILES,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  ORIGIN_SETUP,
  PINNED_VITEST,
  project,
  REQUEST_SCHEMA,
} from "./vitest-evidence.mjs";
import { ASYNC_CONTEXT_FLAG, HEALTH_META_KEY } from "./vitest-origin-sites.mjs";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (request.schema !== REQUEST_SCHEMA) {
  console.error(
    `vitest-supervised: unsupported request schema ${JSON.stringify(request.schema)}`,
  );
  process.exit(70);
}

if (typeof request.nonce !== "string" || request.nonce.length === 0) {
  console.error("vitest-supervised: the request has no nonce");
  process.exit(70);
}
if (
  request.testTimeoutMs !== undefined &&
  !(Number.isSafeInteger(request.testTimeoutMs) && request.testTimeoutMs > 0)
) {
  console.error(
    `vitest-supervised: the request's per-test time limit is not a positive whole number of milliseconds: ${JSON.stringify(request.testTimeoutMs)}`,
  );
  process.exit(70);
}
// Workers inherit this process's environment: the origin setup binds every record it writes to this request.
process.env[ORIGIN_NONCE_ENV] = request.nonce;
const REGISTER_URL = pathToFileURL(ORIGIN_FILES.register).href;
const { digest: adapter, files: adapterFiles } = adapterDigest();
const origin = {
  schema: ORIGIN_SCHEMA,
  adapter,
  files: adapterFiles,
  setupFile: ORIGIN_SETUP,
  register: REGISTER_URL,
  projects: [],
  installed: false,
};
const originPlugin = {
  name: "atlas-assertion-origin",
  // The setup lives beside this script, which may be outside the run's root (qualification fixtures): its directory is ADDED to the
  // files Vite may serve. Vite's own default (the workspace root) is kept when the config names none, and merged lists concatenate.
  config(config) {
    const allow = config.server?.fs?.allow ?? [
      searchForWorkspaceRoot(config.root ?? request.root ?? process.cwd()),
    ];
    return {
      server: { fs: { allow: [...allow, dirname(ORIGIN_SETUP)] } },
    };
  },
  configureVitest({ project }) {
    project.config.setupFiles = [
      ORIGIN_SETUP,
      ...project.config.setupFiles.filter((file) => file !== ORIGIN_SETUP),
    ];
    // Read by the pool when it first starts a worker of this project, so the hook is registered before Vitest is imported there.
    project.config.execArgv = [
      "--import",
      REGISTER_URL,
      ASYNC_CONTEXT_FLAG,
      ...(project.config.execArgv ?? []),
    ];
  },
};

let phase = "run";
const processEvents = [];
process.on("uncaughtException", (error) =>
  processEvents.push({
    phase,
    type: "uncaughtException",
    error: project(error),
  }),
);
process.on("unhandledRejection", (reason) =>
  processEvents.push({
    phase,
    type: "unhandledRejection",
    error: project(reason),
  }),
);

const witness = {
  onTestRunEndCalls: 0,
  reason: null,
  modules: [],
  suites: [],
  tests: [],
  unhandledCount: 0,
  unhandled: [],
  failureCount: 0,
  failures: [],
};
const errorsOf = (list) => {
  const errors = Array.isArray(list) ? list : [];
  return { errorCount: errors.length, errors: errors.map(project) };
};
/** The runtime's per-file attestation as a plain copy, or null (never thrown: its absence is the reader's to judge). */
const healthOf = (module) => {
  try {
    const health = module.meta()?.[HEALTH_META_KEY];
    return health && typeof health === "object"
      ? JSON.parse(JSON.stringify(health))
      : null;
  } catch {
    return null;
  }
};
const ancestorsOf = (entity) => {
  const names = [];
  for (let at = entity.parent; at && at.type === "suite"; at = at.parent)
    names.unshift(at.name);
  return names;
};

const witnessReporter = {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    witness.onTestRunEndCalls += 1;
    try {
      witness.reason = reason ?? null;
      const unhandled = Array.isArray(unhandledErrors) ? unhandledErrors : [];
      witness.unhandledCount = unhandled.length;
      witness.unhandled = unhandled.map(project);
      for (const module of testModules) {
        const id = module.relativeModuleId ?? module.moduleId;
        witness.modules.push({
          id,
          state: module.state(),
          health: healthOf(module),
          ...errorsOf(module.errors()),
        });
        for (const suite of module.children.allSuites())
          witness.suites.push({
            module: id,
            fullName: suite.fullName,
            ...errorsOf(suite.errors()),
          });
        for (const test of module.children.allTests()) {
          const result = test.result();
          witness.tests.push({
            id: test.id,
            module: id,
            moduleId: module.moduleId,
            ancestors: ancestorsOf(test),
            name: test.name,
            state: result.state,
            fails: test.options?.fails === true,
            timeout: test.options?.timeout ?? null,
            ms: test.diagnostic()?.duration ?? null,
            ...errorsOf(result.errors),
          });
        }
      }
    } catch (error) {
      witness.failures.push(project(error));
      witness.failureCount = witness.failures.length;
    }
  },
};

const unsupported = [];
const logged = [];
let ctx;
let startError = null;
let closeError = null;
let closeTimedOut = false;
let lateUnhandled = [];
try {
  const vitestNode = await import("vitest/node");
  ctx = await vitestNode.createVitest(
    "test",
    {
      root: request.root,
      config: request.config,
      run: true,
      watch: false,
      // `extraReporters` (module paths, default export a reporter class) exist for the qualification of this boundary: a reporter
      // that fails after the JSON report was produced must refuse the run.
      reporters: [
        "json",
        witnessReporter,
        ...(await Promise.all(
          (request.extraReporters ?? []).map(
            async (path) => new (await import(path)).default(),
          ),
        )),
      ],
      outputFile: { json: request.json },
      // The mutation runner's per-test limit, as Vitest's `testTimeout` (a CLI-level option: it overrides the config file and every
      // project's value, but not a test's or suite's own explicit timeout).
      ...(request.testTimeoutMs !== undefined
        ? { testTimeout: request.testTimeoutMs }
        : {}),
      // An optional test-name filter (a narrowed catalogue selection): `{ source, flags }` of a RegExp. Cases it excludes are reported
      // as skipped; the consumer checks the selected inventory exactly.
      ...(request.testNamePattern
        ? {
            testNamePattern: new RegExp(
              request.testNamePattern.source,
              request.testNamePattern.flags ?? "",
            ),
          }
        : {}),
    },
    { plugins: [originPlugin] },
    {},
  );
  origin.projects = (ctx.projects ?? []).map((p) => ({
    name: p.name ?? "",
    setupFiles: [...(p.config?.setupFiles ?? [])],
    execArgv: [...(p.config?.execArgv ?? [])],
    pool: p.config?.pool ?? null,
    testTimeout: p.config?.testTimeout ?? null,
  }));
  // Only a process pool runs the worker with these execArgv and this realm's loading hook (`threads`/`vm*` are not qualified).
  origin.installed =
    origin.projects.length > 0 &&
    origin.projects.every(
      (p) =>
        p.setupFiles[0] === ORIGIN_SETUP &&
        p.execArgv[0] === "--import" &&
        p.execArgv[1] === REGISTER_URL &&
        p.execArgv[2] === ASYNC_CONTEXT_FLAG &&
        p.pool === "forks",
    );
  if (!origin.installed)
    unsupported.push(
      "the assertion-origin setup and loading hook are not installed in every project (setup first, --import hook, async context, forks pool)",
    );
  if (
    request.testTimeoutMs !== undefined &&
    !origin.projects.every((p) => p.testTimeout === request.testTimeoutMs)
  )
    unsupported.push(
      `the per-test time limit ${request.testTimeoutMs} ms is not the limit of every project (${origin.projects.map((p) => JSON.stringify(p.testTimeout)).join(", ")})`,
    );
  if (ctx.version !== PINNED_VITEST)
    unsupported.push(`Vitest ${ctx.version}, qualified ${PINNED_VITEST}`);
  for (const method of ["error", "printError"]) {
    const original = ctx.logger?.[method];
    if (typeof original !== "function") {
      unsupported.push(`logger.${method} is not a function`);
      continue;
    }
    // Counted by the CALL, whatever its arguments; the original is called unchanged.
    ctx.logger[method] = function (...args) {
      logged.push({
        phase,
        method,
        first: project(args[0]),
        second: args.length > 1 ? project(args[1]) : null,
      });
      return original.apply(this, args);
    };
  }
  await ctx.start(request.files);
} catch (error) {
  startError = project(error);
}

phase = "close";
if (ctx) {
  const bound = request.closeTimeoutMs ?? 60_000;
  let timer;
  try {
    const outcome = await Promise.race([
      ctx.close().then(() => "closed"),
      new Promise((done) => {
        timer = setTimeout(() => done("timeout"), bound);
      }),
    ]);
    closeTimedOut = outcome === "timeout";
  } catch (error) {
    closeError = project(error);
  } finally {
    clearTimeout(timer);
  }
  try {
    const recorded = ctx.state.getUnhandledErrors();
    lateUnhandled = recorded.slice(witness.unhandledCount).map(project);
    if (recorded.length < witness.unhandledCount)
      unsupported.push("Vitest lost unhandled errors it had reported");
  } catch (error) {
    unsupported.push(
      `unhandled-error state unreadable: ${String(error?.message ?? error)}`,
    );
  }
} else unsupported.push("Vitest was not created");
phase = "envelope";

const clean =
  unsupported.length === 0 &&
  startError === null &&
  closeError === null &&
  !closeTimedOut &&
  logged.length === 0 &&
  processEvents.length === 0 &&
  lateUnhandled.length === 0 &&
  witness.onTestRunEndCalls === 1 &&
  witness.failureCount === 0 &&
  witness.unhandledCount === 0 &&
  witness.modules.every((m) => m.errorCount === 0) &&
  witness.suites.every((s) => s.errorCount === 0);
const allPassed =
  witness.reason === "passed" &&
  witness.tests.every((t) => t.state === "passed" || t.state === "skipped");
const exitCode = clean && allPassed && (process.exitCode ?? 0) === 0 ? 0 : 1;
const envelope = {
  schema: ENVELOPE_SCHEMA,
  nonce: request.nonce,
  label: request.label,
  vitest: ctx?.version ?? null,
  node: process.version,
  pid: process.pid,
  supported: unsupported.length === 0,
  unsupported,
  witness,
  lateUnhandledCount: lateUnhandled.length,
  lateUnhandled,
  logged: { count: logged.length, calls: logged },
  processEvents: { count: processEvents.length, events: processEvents },
  startError,
  closeError,
  closeTimedOut,
  origin,
  vitestExitCode: process.exitCode ?? 0,
  exitCode,
  complete:
    ctx !== undefined && witness.onTestRunEndCalls === 1 && !closeTimedOut,
  finishedAt: new Date().toISOString(),
};
try {
  const temporary = `${request.envelope}.partial`;
  writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`);
  renameSync(temporary, request.envelope);
} catch (error) {
  console.error(
    `vitest-supervised: the envelope could not be written: ${error?.message ?? error}`,
  );
  process.exit(70);
}
process.exit(exitCode);
