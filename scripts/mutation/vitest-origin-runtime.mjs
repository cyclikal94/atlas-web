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
//
// Revision 31 (review r30 R31/R33 incomplete_fix; design assessment 34d402c4 RC1/RC2, C1-C4, I2-I5):
//   - COLLECTION PATHS (RC1): Vitest's `failTask` expands a thrown array and then each AggregateError it meets (one level of each), and
//     only the children become errors. The wrapper that left a matcher carried the edge; its children did not. `collection` and
//     `snapshot` now take the receipt and edges of the root array and of each expanded aggregate (WeakMap lookups only, before the
//     framework serialises anything, without touching or traversing the objects) and every child's occurrence carries that `path`. An
//     edge on a framework-expanded container vetoes its children; nothing is written onto the shared children themselves.
//   - NO EXTRA REACTION (RC2): revision 30's second `then` on a native promise read its constructor and species (user code). It is
//     gone. The framework's own single `result.then(handler)` call stays the only subscription. When, BEFORE the framework reads
//     `result.then`, the result is proven an intrinsic promise whose whole species path is intrinsic (`intrinsic`: own and prototype
//     descriptors only, no user code), that one call also gets an explicit rejection handler that records the edge and rethrows: for an
//     intrinsic `then` the argument count is unobservable and a rethrowing handler settles the derived promise exactly as the implicit
//     thrower does, in the same job. Any other thenable keeps its one-argument call, and the worker is OPAQUE from then on: its handler
//     running proves nothing about what the thenable's `then` returned, and a thenable made in a hook, an earlier test or an earlier
//     attempt can hand anything to a later one, so every later occurrence of the worker is refused (fail closed). The same applies to
//     a `.resolves`/`.rejects` subject whose species path is not intrinsic (`consuming`).
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
const { getPrototypeOf, getOwnPropertyDescriptor, hasOwn, freeze } = Object;
// The intrinsics a promise's `then` uses, captured when the worker loads this module (before any test code runs).
const IntrinsicPromise = Promise;
const intrinsicProto = Promise.prototype;
const nativeThen = intrinsicProto.then;
const nativeCatch = intrinsicProto.catch;
const nativeFinally = intrinsicProto.finally;
const speciesGetter = getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
const iteratorKey = Symbol.iterator;

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

/** A data property that is exactly `value` (an own descriptor read: no getter runs). */
const dataIs = (object, key, value) => {
  const d = getOwnPropertyDescriptor(object, key);
  return d !== undefined && hasOwn(d, "value") && d.value === value;
};

/**
 * Revision 31 (RC2): whether the framework's `result.then(...)` call is, by the language's own steps, intrinsic code from end to end,
 * decided BEFORE the framework reads `result.then` and without running any user code (internal-slot checks and own descriptor reads of
 * a non-proxy object only). Then: `result` is a genuine non-proxy promise with no own `then` or `constructor` and the intrinsic
 * prototype, whose `then` and `constructor` are the intrinsic data properties, and `Promise[Symbol.species]` is the intrinsic getter.
 * So the framework's two reads of `result.then` read data, its call is the intrinsic `then`, whose SpeciesConstructor step reads the
 * prototype's data `constructor` and runs the intrinsic species getter, and its derived promise is a %Promise% made by the intrinsic
 * constructor (its `prototype` is non-writable). Nothing runs between this decision and that call except the framework's reads and
 * this adapter's argument evaluation. Anything else (a subclass, an own or inherited `constructor` getter, a replaced species, a proxy,
 * a foreign realm, a custom thenable) is not intrinsic.
 */
export function intrinsic(result) {
  try {
    if (!types.isPromise(result) || types.isProxy(result)) return false;
    if (hasOwn(result, "then") || hasOwn(result, "constructor")) return false;
    if (getPrototypeOf(result) !== intrinsicProto) return false;
    return intrinsicGlobals();
  } catch (error) {
    fail("intrinsic", error);
    return false;
  }
}
/** The shared half of `intrinsic`: %Promise.prototype%'s `then` and `constructor` and %Promise%'s species getter are the intrinsic ones. */
function intrinsicGlobals() {
  if (!dataIs(intrinsicProto, "then", nativeThen)) return false;
  if (!dataIs(intrinsicProto, "constructor", IntrinsicPromise)) return false;
  const species = getOwnPropertyDescriptor(IntrinsicPromise, Symbol.species);
  return (
    typeof speciesGetter === "function" &&
    species !== undefined &&
    species.get === speciesGetter
  );
}

/**
 * Revision 31: every asynchronous invocation or promise subject found NOT intrinsic so far in this worker. Monotone: a non-intrinsic
 * thenable made in a hook, an earlier test or an earlier attempt can hand anything to a later one, so every later occurrence of the
 * worker is refused (fail closed; the population has none).
 */
const opaqueSeen = [];
const markOpaque = (id) => {
  try {
    opaqueSeen.push(id);
  } catch (error) {
    fail("opaque", error);
  }
};

/**
 * Revision 31: Vitest's `.resolves`/`.rejects` wrappers are about to consume `subject` with `Promise.resolve(subject).then(...).catch(...)`
 * (and `recordAsyncExpect`'s `finally`), returning the derived promise to the test. A custom (non-promise) thenable is assimilated by
 * intrinsic code there (its own `then`'s return value is ignored), but a genuine promise with a non-intrinsic species path, or replaced
 * global promise methods, could hand the test a laundering derived promise. Decided without running user code, immediately before
 * that `Promise.resolve`; a non-intrinsic path is opaque for the rest of the worker. Returns nothing (the framework's code is unchanged).
 */
export function consuming(subject) {
  try {
    const promise = types.isPromise(subject) && !types.isProxy(subject);
    const ok =
      (promise ? intrinsic(subject) : intrinsicGlobals()) &&
      dataIs(intrinsicProto, "catch", nativeCatch) &&
      dataIs(intrinsicProto, "finally", nativeFinally);
    if (!ok) {
      invocations += 1;
      markOpaque(invocations);
    }
  } catch (error) {
    fail("consuming", error);
  }
}

/** The invocation `async` armed for the framework's call being evaluated (`rejection` takes it: evaluated right after, no user code between). */
let armed = null;
/**
 * Vitest's asynchronous extended-matcher path: called while the framework evaluates the FIRST argument of its own one
 * `result.then(handler)` call (after it read `result.then`), inside the matcher's invocation. It returns that invocation for the handler
 * the framework is about to pass. `isIntrinsic` is `intrinsic(result)`, decided before the framework's reads. A non-intrinsic result
 * makes the worker OPAQUE from now on (`opaqueSeen`; its handler running would not prove what its `then` returned).
 */
export function async(_result, isIntrinsic) {
  let inv = null;
  armed = null;
  try {
    inv = frames.at(-1)?.inv ?? null;
    armed = freeze({ inv, intrinsic: isIntrinsic === true });
  } catch (error) {
    fail("async", error);
  }
  try {
    if (inv !== null) inv.async = isIntrinsic === true ? "intrinsic" : "opaque";
    if (isIntrinsic !== true) {
      if (inv === null) invocations += 1;
      markOpaque(inv?.id ?? invocations);
    }
  } catch (error) {
    fail("async", error);
  }
  return inv;
}

const NO_ARGUMENTS = freeze({
  [iteratorKey]: () => ({ next: () => ({ done: true, value: undefined }) }),
});
/**
 * The remaining arguments of the framework's `result.then(handler, ...)` call, spread from an iterable made of own data properties only
 * (no prototype method, so no user code runs): none for a non-intrinsic result (its `then` sees exactly the framework's one argument),
 * and for an intrinsic promise ONE rejection handler that records the edge and rethrows the same value. For the intrinsic `then` that is
 * the framework's own implicit pass-through, made explicit: the derived promise is rejected with the same value in the same job, the
 * result has the same one reaction, and nothing else is enqueued.
 */
export function rejection() {
  const at = armed;
  armed = null;
  try {
    if (at?.intrinsic !== true) return NO_ARGUMENTS;
    const owner = at.inv;
    const onRejected = (reason) => {
      edge(reason, owner, "async-rejection");
      throw reason;
    };
    let given = false;
    return {
      [iteratorKey]: () => ({
        next: () => {
          if (given) return { done: true, value: undefined };
          given = true;
          return { done: false, value: onRejected };
        },
      }),
    };
  } catch (error) {
    fail("rejection", error);
    return NO_ARGUMENTS;
  }
}

const handlerContexts = [];
/** The framework's handler of `inv`'s asynchronous result starts: it runs in that invocation. */
export function handling(inv) {
  try {
    handlerContexts.push(als.getStore());
    handlers.push(inv);
    if (inv !== null) als.enterWith(inv);
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
        opaque: [...opaqueSeen],
      });
    const at = freeze({
      test: state.id,
      phase: name ?? state.phase,
      attempt: state.attempt,
      concurrent: runningTests.size > 1,
      // Every opaque asynchronous invocation or promise subject of this worker so far (revision 31: never resolved by a later handler).
      opaque: [...opaqueSeen],
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
 * Revision 31 (RC1, C1): the receipt and edges `value` carries NOW, as a frozen snapshot. WeakMap lookups only: nothing of `value` is
 * read, traversed or written (a proxy's traps do not run). A primitive has neither. `null` only if the lookup itself failed.
 */
export function snapshot(value) {
  try {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return freeze({ object: false, receipt: null, edges: freeze([]) });
    return freeze({
      object: true,
      receipt: receipts.get(value) ?? null,
      edges: freeze([...(edges.get(value) ?? [])]),
    });
  } catch (error) {
    fail("snapshot", error);
    return null;
  }
}

/**
 * Revision 31 (RC1, C1/C2): `failTask` starts collecting `root` in `at` (`undefined`: an uninstrumented call, nothing is recorded).
 * `expanded` is the framework's own decision (`errors === err`: it iterated `root` as an array); the array's snapshot is taken here,
 * before any child is serialised, and becomes the first element of every child occurrence's path.
 */
export function collection(at, root, expanded) {
  if (at === undefined) return undefined;
  try {
    return freeze({
      at,
      array: expanded === true ? snapshot(root) : undefined,
      leaf: undefined,
    });
  } catch (error) {
    fail("collection", error);
    return freeze({ at: null, array: null, leaf: undefined });
  }
}

/**
 * `expect.soft`'s collection: the current phase, which continues. Inside a soft matcher's frame the error leaves that invocation by
 * being collected (a `soft` edge of it); collected after an asynchronous soft assertion settled, it already left its invocation. Called
 * before the framework serialises the error; the error's snapshot (taken after its soft edge) is the occurrence's leaf.
 */
export function soft(test, error) {
  try {
    const top = frames.at(-1);
    if (top?.inv) edge(error, top.inv, "soft");
  } catch (failure) {
    fail("soft", failure);
  }
  try {
    return freeze({
      at: context(test, null, false),
      array: undefined,
      leaf: snapshot(error),
    });
  } catch (failure) {
    fail("soft", failure);
    return freeze({ at: null, array: null, leaf: null });
  }
}

/** A path element: one container the framework expanded (`null` element: its snapshot failed). */
const element = (kind, s) =>
  s === null || s === undefined
    ? null
    : freeze({ kind, object: s.object, receipt: s.receipt, edges: s.edges });

/**
 * `failTask`/`handleTestError` serialised one collected value as `copy`: this occurrence's record goes on the copy. `leaf` is the
 * value's snapshot taken before serialisation (`undefined`: the collection's own `leaf`), `from` the collection (`collection`/`soft`),
 * `wrapper` the snapshot of the AggregateError the framework expanded to reach it (or null). The record's `path` lists, outermost first,
 * the containers the framework expanded on the way: their edges veto the child (vitest-evidence.mjs). Each call is its own occurrence.
 */
export function occurrence(leaf0, copy, from, wrapper) {
  try {
    if (from === undefined) return copy;
    const at = from?.at ?? null;
    const leaf = leaf0 === undefined ? from?.leaf : leaf0;
    const path = [];
    if (from?.array !== undefined) path.push(element("array", from?.array));
    if (wrapper !== null && wrapper !== undefined)
      path.push(element("aggregate", wrapper));
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
      opaque: at?.opaque ?? [],
      // false when any snapshot (leaf or path) or the collection context could not be taken: never admitted
      complete:
        at !== null &&
        leaf !== null &&
        leaf !== undefined &&
        path.every((p) => p !== null),
      path: path.filter((p) => p !== null),
      receipt: leaf?.receipt ?? null,
      edges: [...(leaf?.edges ?? [])],
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
    occurrence(
      snapshot(null),
      copy,
      freeze({ at, array: undefined, leaf: undefined }),
      null,
    );
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
    /** Revision 31: the intrinsic-promise decision (the setup proves it on known intrinsic and non-intrinsic promises). */
    intrinsic,
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
