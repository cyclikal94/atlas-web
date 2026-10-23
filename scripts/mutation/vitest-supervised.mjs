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
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  ENVELOPE_SCHEMA,
  PINNED_VITEST,
  project,
  REQUEST_SCHEMA,
} from "./vitest-evidence.mjs";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (request.schema !== REQUEST_SCHEMA) {
  console.error(
    `vitest-supervised: unsupported request schema ${JSON.stringify(request.schema)}`,
  );
  process.exit(70);
}

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
            module: id,
            moduleId: module.moduleId,
            ancestors: ancestorsOf(test),
            name: test.name,
            state: result.state,
            fails: test.options?.fails === true,
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
    {},
    {},
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
