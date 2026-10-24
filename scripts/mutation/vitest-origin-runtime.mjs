// WEB-14a revision 30 (review r29 R31 incomplete_fix / R33 harness; design assessment b8e8e25d C1-C4, I2-I6): the instrumentation the
// loader inserts into the pinned framework modules calls this module, loaded natively once per Vitest worker. It records, without
// changing the framework's errors, results or control flow:
//
//   - INVOCATIONS: every outermost chai wrapper call (a matcher, property or chainable method) is one invocation, allocated when it is
//     CALLED (not when its receiver was made: one receiver used twice is two invocations). Same-root and root-less frames inside it are
//     its own delegation; a different root's frame inside it, or any invocation entered while the asynchronous context carries another
//     invocation, is `nested` in that one. The asynchronous context is an AsyncLocalStorage store entered at the outermost frame
//     (`enterWith`, no added stack frame) and carried by the promise reactions, timers and awaits the invocation creates; workers run with
//     `--experimental-async-context-frame` (no promise hooks: the suites' timing is not changed).
//   - CONSTRUCTION receipts (diagnostic origin): the site, role, invocation, root, test, attempt and phase of the ONE error an audited site
//     constructs, kept in a WeakMap (the error object is not touched; a lookup runs no user code, even for a proxy).
//   - PROPAGATION edges: each time an object leaves an invocation by a throw (its outermost frame), by its asynchronous result handler or
//     as the observed rejection of its asynchronous result, the edge names that invocation. An error that left any invocation other than
//     the one that constructed it was an execution failure of that invocation, whatever its receipt says (review r29: borrowed errors).
//   - OCCURRENCES: each error the runner collects for a test (body, hooks, cleanup, soft, inversion) gets a record on ITS serialised copy:
//     the phase and attempt it was collected in, a snapshot of the construction receipt and edges of the original object, and the
//     asynchronous matcher invocations of that attempt whose completion could not be observed. The same object collected twice is two
//     occurrences. vitest-evidence.mjs decides admission from that record alone.
//   - HEALTH: every instrumentation failure (it never replaces a framework value) is kept and attested per file (`attest`, called by the
//     runner after the file's afterAll hooks and cleanups, so a failing hook cannot skip it).
//
// R33: an asynchronous extended matcher's result is consumed ONCE, by the framework's own unchanged `result.then(handler)` call (the
// handler is the framework's, edited in place). Only a genuine native promise whose `then` is the intrinsic one (checked without running
// user code) also gets an inert reaction to observe a rejection, which no user code can see; any other thenable is left to the
// framework's call alone, and until its handler runs the invocation counts as unobserved (that attempt's occurrences are ambiguous).
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import {
  adapterDigest,
  HEALTH_META_KEY,
  OCCURRENCE_KEY,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  REGISTRY,
  ROOT_FLAG,
  SITES,
} from "./vitest-origin-sites.mjs";

const nonce = process.env[ORIGIN_NONCE_ENV] ?? null;
const { digest: adapter } = adapterDigest();
const als = new AsyncLocalStorage();
const nativeThen = Promise.prototype.then;
const { getPrototypeOf, getOwnPropertyDescriptor, hasOwn, freeze } = Object;

const frames = [];
const handlers = [];
const receipts = new WeakMap();
const edges = new WeakMap();
const states = new WeakMap();
const runningTests = new Set();
const modules = new Map();
const failures = [];
const issued = new Map();
let invocations = 0;
let roots = 0;
let occurrences = 0;
let currentTest = null;

/** A total description of any value (instrumentation failures are recorded through it, never by coercing the value itself). */
function describe(value) {
  try {
    if (value === null) return "null";
    const type = typeof value;
    if (type === "string") return value;
    if (type !== "object" && type !== "function")
      return `${type} ${String(value)}`;
    const message = getOwnPropertyDescriptor(value, "message")?.value;
    return typeof message === "string" ? message : `<${type}>`;
  } catch {
    return "<undescribable>";
  }
}
const fail = (what, error) => {
  try {
    failures.push(`${what}: ${describe(error)}`);
  } catch {
    // nothing more can be recorded; the attestation's count is still read from `failures`
  }
};

/** The root record of an assertion (its chai flag), or null. Never throws (a proxy refusing a property is an absent root). */
function rootOf(receiver) {
  try {
    const flags = receiver?.__flags;
    return flags && hasOwn(flags, ROOT_FLAG) ? flags[ROOT_FLAG] : null;
  } catch {
    return null;
  }
}

function testOf(receiver) {
  try {
    const id = receiver?.__flags?.["vitest-test"]?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** The runner's current test (its task object), or null. */
function current() {
  try {
    const test = currentTest?.();
    return test && typeof test === "object" ? test : null;
  } catch {
    return null;
  }
}
const stateOf = (test) => (test ? (states.get(test) ?? null) : null);

function invocation(root, parent, testId) {
  invocations += 1;
  const test = current();
  const state = stateOf(test);
  return {
    id: invocations,
    root,
    testId,
    parent,
    nested: parent !== null,
    test: state,
    attempt: state?.attempt ?? null,
    async: null,
    settled: false,
  };
}

function edge(value, inv, kind) {
  try {
    if (
      inv === null ||
      (typeof value !== "object" && typeof value !== "function") ||
      value === null
    )
      return;
    const list = edges.get(value);
    const entry = freeze({ invocation: inv.id, kind });
    if (list === undefined) edges.set(value, [entry]);
    else if (!list.some((e) => e.invocation === inv.id && e.kind === kind))
      list.push(entry);
  } catch (error) {
    fail("edge", error);
  }
}

/** Vitest's `expect(value)`: the new assertion becomes a root, nested when made inside a matcher's (synchronous or asynchronous) execution. */
export function root(assertion) {
  try {
    const record = freeze({
      id: ++roots,
      nested: frames.length > 0 || als.getStore() !== undefined,
    });
    assertion.__flags[ROOT_FLAG] = record;
  } catch (error) {
    fail("root", error);
  }
  return assertion;
}

/** Entered before every chai assertion method, property and chainable behaviour body; `exit` after it. `threw` on its way out. */
export function enter(receiver) {
  let frame;
  try {
    const record = rootOf(receiver);
    const top = frames.at(-1);
    if (
      top !== undefined &&
      top.inv !== null &&
      (record === null || record === top.root)
    )
      frame = { root: top.root, inv: top.inv, changed: false, prev: undefined };
    else {
      const prev = als.getStore();
      const inv = invocation(
        record,
        top !== undefined ? top.inv : (prev ?? null),
        testOf(receiver),
      );
      als.enterWith(inv);
      frame = { root: record, inv, changed: true, prev };
    }
  } catch (error) {
    fail("enter", error);
    frame = { root: null, inv: null, changed: false, prev: undefined };
  }
  frames.push(frame);
}
export function exit() {
  const frame = frames.pop();
  try {
    if (frame?.changed) als.enterWith(frame.prev);
  } catch (error) {
    fail("exit", error);
  }
}
/** An object (anything) left the current frame by a throw: at an invocation's outermost frame, that is a propagation edge. */
export function threw(value) {
  try {
    const top = frames.at(-1);
    if (top === undefined || top.inv === null) return;
    const below = frames.at(-2);
    if (below !== undefined && below.inv === top.inv) return;
    edge(value, top.inv, "sync");
  } catch (error) {
    fail("threw", error);
  }
}

/** Whether `value` is a genuine native promise whose `then` is the intrinsic one, decided without running any user code. */
function nativePromise(value) {
  try {
    if (!types.isPromise(value) || types.isProxy(value)) return false;
    if (hasOwn(value, "then")) return false;
    const proto = getPrototypeOf(value);
    if (proto !== Promise.prototype) return false;
    const d = getOwnPropertyDescriptor(Promise.prototype, "then");
    return d !== undefined && hasOwn(d, "value") && d.value === nativeThen;
  } catch {
    return false;
  }
}

/**
 * Vitest's asynchronous extended-matcher path (R33): called while the framework evaluates the arguments of its own one
 * `result.then(handler)` call (after it read `result.then`), inside the matcher's invocation. It returns that invocation for the handler
 * the framework is about to pass. For a genuine native promise (decided without running user code) it also registers an inert reaction,
 * through the intrinsic `then` captured at load (no property of `result` is read), just before the framework's: it runs no user code,
 * its derived promise always fulfils, and every other job keeps its relative order. Any other thenable is left to the framework's
 * call alone, and the invocation is unobserved until its handler runs.
 */
export function async(result) {
  let inv = null;
  try {
    inv = frames.at(-1)?.inv ?? null;
    if (inv === null) return null;
    const owner = inv;
    if (nativePromise(result)) {
      owner.async = "observed";
      Reflect.apply(nativeThen, result, [
        undefined,
        (reason) => {
          owner.settled = true;
          edge(reason, owner, "async-rejection");
        },
      ]);
    } else {
      owner.async = "unobserved";
      owner.test?.unobserved.add(owner);
    }
  } catch (error) {
    fail("async", error);
  }
  return inv;
}
const handlerContexts = [];
/** The framework's handler of `inv`'s asynchronous result starts: it runs in that invocation. */
export function handling(inv) {
  try {
    handlerContexts.push(als.getStore());
    handlers.push(inv);
    if (inv !== null) {
      inv.settled = true;
      inv.test?.unobserved.delete(inv);
      als.enterWith(inv);
    }
  } catch (error) {
    fail("handling", error);
  }
}
/** The handler threw (its own failing result, or anything its message function or the result's getters threw). */
export function handlerThrew(inv, value) {
  edge(value, inv, "async-result");
}
export function handled(inv) {
  try {
    handlers.pop();
    const prev = handlerContexts.pop();
    if (inv !== null) als.enterWith(prev);
  } catch (error) {
    fail("handled", error);
  }
}

/**
 * A JestExtendError has set its fields (its constructor): it is one of the two audited sites. Inside a matcher frame it is that
 * invocation's synchronous failing result; with no frame but inside an asynchronous result handler, that handler's.
 */
export function extendError(error) {
  try {
    const top = frames.at(-1);
    if (top !== undefined)
      markAt(
        "vitest.extend.result",
        top.inv,
        top.inv?.root ?? null,
        top.inv?.testId ?? null,
        error,
      );
    else
      markAt(
        "vitest.extend.async-result",
        handlers.at(-1) ?? null,
        handlers.at(-1)?.root ?? null,
        handlers.at(-1)?.testId ?? null,
        error,
      );
  } catch (failure) {
    fail("extendError", failure);
  }
}

/** Record the receipt of `site` for `error` (the object that site just constructed) and return it unchanged. */
export function mark(site, receiver, error) {
  try {
    const spec = SITES[site];
    const top = frames.at(-1);
    let record = null;
    let owner = null;
    if (spec?.receiver === "assertion") {
      record = rootOf(receiver);
      owner = testOf(receiver);
    } else if (spec?.receiver === "task")
      owner = typeof receiver?.id === "string" ? receiver.id : null;
    markAt(site, top?.inv ?? null, record, owner, error, top !== undefined);
  } catch (failure) {
    fail(`mark ${site}`, failure);
  }
  return error;
}

function markAt(site, inv0, record, owner, error, framed0 = true) {
  try {
    const spec = SITES[site];
    const store = als.getStore();
    const test = current();
    const state = stateOf(test);
    let role = spec?.role ?? "unknown";
    let inv = inv0;
    let framed = framed0;
    if (spec?.handler === true) {
      // The extended matcher's asynchronous result handler: its invocation is the one whose handler is running.
      framed = true;
      if (inv === null || store !== inv) role = "unattributed";
    }
    if (role === "comparison") {
      if (record === null) role = "internal";
      else if (inv === null) {
        // A frameless comparison site (a promise wrong-settlement): its own synthetic invocation, unless it runs in another's context.
        if (store !== undefined) role = "nested";
        else inv = invocation(record, null, owner);
      } else if (inv.nested || inv.root !== record || record.nested)
        role = "nested";
    } else if (role === "explicit") {
      if (frames.length > 0 || store !== undefined) role = "nested";
      else inv = invocation(null, null, null);
    }
    receipts.set(
      error,
      freeze({
        schema: ORIGIN_SCHEMA,
        nonce,
        adapter,
        site,
        role,
        invocation: inv?.id ?? null,
        framed,
        root: record?.id ?? null,
        test: owner,
        current: typeof test?.id === "string" ? test.id : null,
        phase: state?.phase ?? null,
        attempt: state?.attempt ?? null,
        concurrent: runningTests.size > 1,
      }),
    );
  } catch (failure) {
    fail(`mark ${site}`, failure);
  }
}

// ---- the runner: tests, phases, attempts and collected occurrences ---------------------------------------------------------------

/** The runner registered `test` as running (`addRunningTest`); `ended` when it removes it. */
export function running(test) {
  try {
    states.set(test, {
      id: typeof test?.id === "string" ? test.id : null,
      phase: "prepare",
      attempt: 0,
      unobserved: new Set(),
    });
    runningTests.add(test);
  } catch (error) {
    fail("running", error);
  }
}
export function ended(test) {
  try {
    runningTests.delete(test);
  } catch (error) {
    fail("ended", error);
  }
}

/** The runner entered a phase of `test`'s current attempt ("before-try" starts a new attempt). */
export function phase(test, name) {
  try {
    const state = stateOf(test);
    if (state === null) throw new Error("phase of a test that is not running");
    if (name === "before-try") {
      state.attempt += 1;
      state.unobserved = new Set();
    }
    state.phase = name;
  } catch (error) {
    fail(`phase ${name}`, error);
  }
}

function context(test, name, advance) {
  try {
    const state = stateOf(test);
    if (state === null)
      return freeze({
        test: null,
        phase: name ?? "unknown",
        attempt: null,
        concurrent: runningTests.size > 1,
        unobserved: [],
      });
    const at = freeze({
      test: state.id,
      phase: name ?? state.phase,
      attempt: state.attempt,
      concurrent: runningTests.size > 1,
      unobserved: [...state.unobserved]
        .filter((inv) => !inv.settled)
        .map((inv) => inv.id),
    });
    if (advance) state.phase = "after-body";
    return at;
  } catch (error) {
    fail("failing", error);
    return null;
  }
}
/** The context in which the runner collects `test`'s error: a fixed phase, or (null) the phase the first try had reached. */
export const failing = (test, name) => context(test, name, name === null);
/**
 * `expect.soft`'s collection: the current phase, which continues. Inside a soft matcher's frame the error leaves that invocation by
 * being collected (a `soft` edge of it); collected after an asynchronous soft assertion settled, it already left its invocation.
 */
export function soft(test, error) {
  try {
    const top = frames.at(-1);
    if (top?.inv) edge(error, top.inv, "soft");
  } catch (failure) {
    fail("soft", failure);
  }
  return context(test, null, false);
}

/** `failTask`/`handleTestError` serialised `original` as `copy` in `at`: this occurrence's record goes on the copy. */
export function occurrence(original, copy, at, aggregate) {
  try {
    if (at === undefined) return copy;
    const object =
      (typeof original === "object" && original !== null) ||
      typeof original === "function";
    occurrences += 1;
    const id = occurrences;
    const record = {
      schema: ORIGIN_SCHEMA,
      nonce,
      adapter,
      id,
      test: at?.test ?? null,
      phase: at?.phase ?? "unknown",
      attempt: at?.attempt ?? null,
      concurrent: at?.concurrent ?? true,
      unobserved: at?.unobserved ?? [],
      aggregate: aggregate === true,
      receipt: object ? (receipts.get(original) ?? null) : null,
      edges: object ? [...(edges.get(original) ?? [])] : [],
    };
    if (record.test !== null)
      issued.set(record.test, [...(issued.get(record.test) ?? []), id]);
    if (copy !== null && typeof copy === "object")
      copy[OCCURRENCE_KEY] = record;
    else fail("occurrence", "the serialised error is not an object");
  } catch (error) {
    fail("occurrence", error);
  }
  return copy;
}

/**
 * The `test.fails` inversion: the runner's own error, constructed and serialised by that one statement (its site), collected in the
 * inversion phase. Its receipt is that site's, for this task; it was never thrown, so it has no edge.
 */
export function inversion(test, copy) {
  try {
    const state = stateOf(test);
    const at = context(test, "inversion", false);
    occurrence(null, copy, at, false);
    const record = copy?.[OCCURRENCE_KEY];
    if (record === undefined) throw new Error("the inversion was not recorded");
    record.receipt = freeze({
      schema: ORIGIN_SCHEMA,
      nonce,
      adapter,
      site: "vitest.runner.fails-inversion",
      role: SITES["vitest.runner.fails-inversion"]?.role ?? "unknown",
      invocation: null,
      framed: false,
      root: null,
      test: typeof test?.id === "string" ? test.id : null,
      current: typeof current()?.id === "string" ? current().id : null,
      phase: state?.phase ?? null,
      attempt: state?.attempt ?? null,
      concurrent: runningTests.size > 1,
    });
  } catch (error) {
    fail("inversion", error);
  }
}

function healthRecord() {
  return freeze({
    schema: ORIGIN_SCHEMA,
    nonce,
    adapter,
    failures: [...failures],
    depth: frames.length + handlers.length,
    invocations,
    occurrences,
    issued: Object.fromEntries(issued),
  });
}

/**
 * The runner finished a file suite (its afterAll hooks, cleanups and fixture cleanups have run or failed): write this worker's health
 * attestation into the file's task meta, and fail the file if the instrumentation failed or its frames are unbalanced.
 */
export function attest(suite, failTask, diffOptions) {
  let health = null;
  try {
    health = healthRecord();
    suite.meta[HEALTH_META_KEY] = health;
  } catch (error) {
    fail("attest", error);
  }
  try {
    if (health === null || health.failures.length > 0 || health.depth !== 0)
      failTask(
        suite.result,
        new Error(
          `assertion-origin runtime: ${failures.length} failure(s), depth ${frames.length + handlers.length}: ${failures.slice(0, 5).join("; ")}`,
        ),
        diffOptions,
      );
  } catch (error) {
    fail("attest failure", error);
  }
}

/** Each transformed module reports itself once it has evaluated, with the bindings the setup verifies. */
export function loaded(name, sourceSha256, bindings) {
  try {
    if (modules.has(name)) throw new Error(`${name} loaded twice`);
    modules.set(name, freeze({ sourceSha256, ...bindings }));
    if (name === "vitest-runner") currentTest = bindings.getCurrentTest;
  } catch (error) {
    fail(`loaded ${name}`, error);
  }
}

Object.defineProperty(globalThis, REGISTRY, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: freeze({
    schema: ORIGIN_SCHEMA,
    nonce,
    adapter,
    modules,
    failures,
    depth: () => frames.length + handlers.length,
    receiptOf: (error) => receipts.get(error) ?? null,
    edgesOf: (error) => [...(edges.get(error) ?? [])],
    /** Whether the asynchronous context reaches a promise reaction (the worker's async-context mode is checked by the setup). */
    propagates: () => {
      const probe = freeze({ probe: true });
      return als.run(probe, () =>
        Promise.resolve().then(() => als.getStore() === probe),
      );
    },
    /** The per-file attestation (`attest` puts it in the file's task meta when the runner has finished the file). */
    health: healthRecord,
  }),
});
