// WEB-14a revision 29 (review r28 R31 incomplete_fix, design assessment C2/C3): the instrumentation the loader inserts into the pinned
// framework modules calls this module, loaded natively once per Vitest worker. It attaches to the ONE error object an audited site
// constructs (vitest-origin-sites.mjs) a receipt naming that site, its role for this occurrence, the `expect()` root and test it
// belongs to and this run's nonce and adapter. Nothing else is changed: the framework's error, message, stack and control flow are
// the framework's own, and a failure here leaves the error unmarked (never admitted), it never replaces the framework's error.
//
// Occurrence roles for a `comparison` site (I2/I3/I5):
//   - the receiver has no root record: chai's internal precondition assertions (`new Assertion(obj, msg, ssfi, true)`), chai's
//     `assert` interface or anything else not made by Vitest's `expect()` → `internal`;
//   - the root was created while a matcher body was executing (an `expect()` inside a matcher, a callback, a message function, a
//     getter) or while an asynchronous extended matcher was outstanding → `nested`;
//   - the site runs inside a matcher body of ANOTHER root (the outermost executing matcher belongs to a different root) → `nested`.
// Matcher bodies are tracked synchronously by enter/exit around chai's chain wrappers (no AsyncLocalStorage: promise hooks would
// change the timing of the suites under test). Asynchronous extended matchers are counted while outstanding, failing closed.
import {
  adapterDigest,
  ORIGIN_KEY,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  REGISTRY,
  ROOT_FLAG,
  SITES,
} from "./vitest-origin-sites.mjs";

const nonce = process.env[ORIGIN_NONCE_ENV] ?? null;
const { digest: adapter } = adapterDigest();
const frames = [];
let asyncExtensions = 0;
let roots = 0;
const modules = new Map();
const failures = [];
let currentTest = null;

const fail = (what, error) => {
  failures.push(`${what}: ${String(error?.message ?? error)}`);
};

/** The root record of an assertion (its chai flag), or null. Never throws (a proxy refusing a property is an absent root). */
function rootOf(receiver) {
  try {
    const flags = receiver?.__flags;
    return flags && Object.hasOwn(flags, ROOT_FLAG) ? flags[ROOT_FLAG] : null;
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

function currentTestId() {
  try {
    const id = currentTest?.()?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Vitest's `expect(value)`: the new assertion becomes a root, nested when made inside a matcher body or an outstanding async matcher. */
export function root(assertion) {
  try {
    roots += 1;
    const record = Object.freeze({
      id: roots,
      nested: frames.length > 0 || asyncExtensions > 0,
    });
    assertion.__flags[ROOT_FLAG] = record;
  } catch (error) {
    fail("root", error);
  }
  return assertion;
}

/** Entered before, and exited after, the body of every chai assertion method, property and chainable behaviour. */
export function enter(receiver) {
  frames.push(rootOf(receiver));
}
export function exit() {
  frames.pop();
}

/** An extended matcher returned a thenable: until it has settled (and its result handler ran), every new root is nested. */
export function asyncExtension(result) {
  try {
    asyncExtensions += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // The framework's own handler was registered after this one; let it run first.
      Promise.resolve().then(() => {
        asyncExtensions -= 1;
      });
    };
    result.then(settle, settle);
  } catch (error) {
    fail("asyncExtension", error);
  }
  return undefined;
}

/** Attach the receipt of `site` to `error` (the object that site just constructed) and return it unchanged. */
export function mark(site, receiver, error) {
  try {
    const spec = SITES[site];
    let role = spec?.role ?? "unknown";
    let rootId = null;
    let test = null;
    if (spec?.receiver === "assertion") {
      const record = rootOf(receiver);
      rootId = record?.id ?? null;
      test = testOf(receiver);
      if (role === "comparison") {
        if (record === null) role = "internal";
        else if (record.nested || (frames.length > 0 && frames[0] !== record))
          role = "nested";
      }
    } else if (spec?.receiver === "task") {
      test = typeof receiver?.id === "string" ? receiver.id : null;
    }
    Object.defineProperty(error, ORIGIN_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        schema: ORIGIN_SCHEMA,
        nonce,
        adapter,
        site,
        role,
        root: rootId,
        test,
        current: currentTestId(),
      }),
    });
  } catch (failure) {
    fail(`mark ${site}`, failure);
  }
  return error;
}

/** Each transformed module reports itself once it has evaluated, with the bindings the setup verifies. */
export function loaded(name, sourceSha256, bindings) {
  try {
    if (modules.has(name)) throw new Error(`${name} loaded twice`);
    modules.set(name, Object.freeze({ sourceSha256, ...bindings }));
    if (name === "vitest-runner") currentTest = bindings.getCurrentTest;
    if (name === "chai") {
      // chai's error is serialised through its toJSON (own enumerable fields only): carry the receipt of this very object.
      const proto = bindings.AssertionError.prototype;
      const original = proto.toJSON;
      Object.defineProperty(proto, "toJSON", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function toJSON(...args) {
          const json = original.apply(this, args);
          if (
            json !== null &&
            typeof json === "object" &&
            Object.hasOwn(this, ORIGIN_KEY)
          )
            json[ORIGIN_KEY] = this[ORIGIN_KEY];
          return json;
        },
      });
    }
  } catch (error) {
    fail(`loaded ${name}`, error);
  }
}

Object.defineProperty(globalThis, REGISTRY, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    schema: ORIGIN_SCHEMA,
    nonce,
    adapter,
    modules,
    failures,
    depth: () => frames.length,
    outstanding: () => asyncExtensions,
  }),
});
