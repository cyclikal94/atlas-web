// WEB-14a revision 28 (review r27 R31 incomplete_fix, design assessment C1/C2): the assertion-ORIGIN evidence of a supervised Vitest
// run. vitest-supervised.mjs makes this the FIRST setup file of every project; it runs in each worker before the test file.
//
// Why: an error that passed through an assertion wrapper (`__VITEST_EXTEND_ASSERTION__`, `resolves`, `rejects`) carries the wrapper's
// frame whether the matcher compared and failed or crashed first (a TypeError in the matcher, jest-dom refusing `null`, a throwing
// getter or message function), so frames, names and messages cannot tell an assertion from an execution error. The installed
// framework has exactly two classes that it constructs only as the RESULT of a failed comparison:
//
//   chai.AssertionError       chai's `Assertion#assert`, every built-in Vitest matcher's mismatch, `resolves`/`rejects` mismatches
//                             (`promise resolved … instead of rejecting`, `promise rejected … instead of resolving`), `assert.*`
//   JestExtendError           an `expect.extend` matcher (jest-dom's included) that returned a failing result: constructed only after
//                             the matcher returned and its message function succeeded (vitest 5.0.1 index.m3L2HgmY.js:2545-2577)
//
// Each gets a read-only accessor on its prototype answering, for an instance of that very class in this realm, which producer made it
// and the nonce of this run. Vitest serialises a failure in the worker by walking every own and inherited property name (so the
// accessor is read on the live error) or, for chai's error, through its `toJSON`, which is wrapped to carry the same record. Nothing
// else is changed: messages, stacks, diffs and assertion behaviour stay exactly as they were. Anything not constructed by these two
// classes (an ordinary Error or TypeError, jest-dom's HtmlElementTypeError, node:assert's AssertionError, a user class named
// AssertionError, a thrown string) has no origin and is never admitted as an assertion (vitest-evidence.mjs `classify`).
//
// Fail closed: if the classes cannot be found, or a branded probe does not read back, this setup throws, which is an error of the test
// module (a taint of the run), never a silently unbranded run.
import { chai, expect } from "vitest";
import {
  ORIGIN_KEY,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  PRODUCERS,
} from "./vitest-evidence.mjs";

const nonce = process.env[ORIGIN_NONCE_ENV];
if (typeof nonce !== "string" || nonce.length === 0)
  throw new Error(`assertion-origin setup: ${ORIGIN_NONCE_ENV} is not set`);
const INSTALLED = Symbol.for("atlas.assertion-origin.installed");

function brand(Class, producer) {
  const proto = Class.prototype;
  const installed = Object.getOwnPropertyDescriptor(proto, INSTALLED)?.value;
  if (installed !== undefined) {
    if (installed !== nonce)
      throw new Error(
        `assertion-origin setup: ${producer} is branded for another run`,
      );
    return;
  }
  Object.defineProperty(proto, ORIGIN_KEY, {
    configurable: false,
    enumerable: false,
    get() {
      return this instanceof Class
        ? { schema: ORIGIN_SCHEMA, producer, nonce }
        : undefined;
    },
  });
  Object.defineProperty(proto, INSTALLED, { value: nonce });
}

// chai.AssertionError: Vitest serialises it through its own toJSON (`{ ...this, name, message, ok, stack }`), which copies only own
// enumerable fields, so the record is added to that result.
const AssertionError = chai?.AssertionError;
if (
  typeof AssertionError !== "function" ||
  typeof AssertionError.prototype.toJSON !== "function"
)
  throw new Error(
    "assertion-origin setup: chai.AssertionError#toJSON is not available",
  );
if (!Object.hasOwn(AssertionError.prototype, INSTALLED)) {
  const toJSON = AssertionError.prototype.toJSON;
  Object.defineProperty(AssertionError.prototype, "toJSON", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function toJSONWithOrigin(...args) {
      const json = toJSON.apply(this, args);
      if (json !== null && typeof json === "object")
        json[ORIGIN_KEY] = this[ORIGIN_KEY];
      return json;
    },
  });
}
brand(AssertionError, PRODUCERS.chai);

// JestExtendError is not exported: one failing call of a probe matcher yields an instance, whose constructor is the class.
const PROBE = "__atlasAssertionOriginProbe";
expect.extend({
  [PROBE]: () => ({ pass: false, message: () => "assertion-origin probe" }),
});
let JestExtendError;
try {
  expect(0)[PROBE]();
} catch (error) {
  JestExtendError = error?.constructor;
}
if (
  typeof JestExtendError !== "function" ||
  JestExtendError.name !== "JestExtendError" ||
  !(JestExtendError.prototype instanceof Error)
)
  throw new Error(
    "assertion-origin setup: the extended-matcher failure class was not found",
  );
brand(JestExtendError, PRODUCERS.extend);

// Read back through the same paths Vitest uses before any test runs.
const chaiRecord = new AssertionError("probe").toJSON()?.[ORIGIN_KEY];
let extendRecord;
try {
  expect(0)[PROBE]();
} catch (error) {
  extendRecord = error?.[ORIGIN_KEY];
}
if (
  chaiRecord?.producer !== PRODUCERS.chai ||
  chaiRecord?.nonce !== nonce ||
  extendRecord?.producer !== PRODUCERS.extend ||
  extendRecord?.nonce !== nonce ||
  new Error("x")[ORIGIN_KEY] !== undefined
)
  throw new Error(
    "assertion-origin setup: the origin record does not read back",
  );
