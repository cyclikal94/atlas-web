// WEB-14a revision 30 (review r29 R31/R33, design assessment b8e8e25d C3/C4): the FIRST setup file of every project of a supervised
// Vitest run (vitest-supervised.mjs). Before any test it PROVES, in the worker realm that runs the tests, that the pinned framework
// modules were instrumented by the loading hook, that the worker runs with the asynchronous-context mode the runtime needs, that a
// genuine comparison, a wrapped execution error and an argument-validation error get the right construction receipts and that a genuine
// error thrown again out of ANOTHER matcher records that matcher's edge; it throws otherwise (a module error: never admitted). The
// runtime's per-file HEALTH attestation is written by the runner itself when it has finished the file (vitest-origin-runtime.mjs
// `attest`), so this file adds no hook to the suites under test.
//
// Revision 29 checked receipts on the error objects themselves; revision 30 keeps them in the runtime (the errors are untouched).
// Revision 31 (review r30 R33, design assessment 34d402c4 C4) also proves the intrinsic-promise decision on known cases.
import { chai, expect } from "vitest";
import {
  ASYNC_CONTEXT_FLAG,
  adapterDigest,
  MODULES,
  ORIGIN_NONCE_ENV,
  ORIGIN_SCHEMA,
  REGISTRY,
} from "./vitest-origin-sites.mjs";

const refuse = (why) => {
  throw new Error(`assertion-origin setup: ${why}`);
};
const nonce = process.env[ORIGIN_NONCE_ENV];
if (typeof nonce !== "string" || nonce.length === 0)
  refuse(`${ORIGIN_NONCE_ENV} is not set`);
const registry = globalThis[REGISTRY];
if (registry?.schema !== ORIGIN_SCHEMA)
  refuse("the instrumented runtime is not loaded in this worker");
if (registry.nonce !== nonce) refuse("the runtime belongs to another run");
if (registry.adapter !== adapterDigest().digest)
  refuse("the runtime's adapter is not this adapter");
if (registry.failures.length > 0)
  refuse(`the runtime failed: ${registry.failures.join("; ")}`);
if (!process.execArgv.includes(ASYNC_CONTEXT_FLAG))
  refuse(`the worker does not run with ${ASYNC_CONTEXT_FLAG}`);
if ((await registry.propagates()) !== true)
  refuse("the asynchronous context does not reach a promise reaction");
for (const m of MODULES) {
  const record = registry.modules.get(m.name);
  if (record?.sourceSha256 !== m.sha256)
    refuse(`${m.name} was not instrumented in this worker`);
}
// The modules the tests use are the instrumented ones (not a second, uninstrumented copy).
if (chai.AssertionError !== registry.modules.get("chai").AssertionError)
  refuse("vitest's chai is not the instrumented chai");
if (chai.Assertion !== registry.modules.get("chai").Assertion)
  refuse("vitest's chai Assertion is not the instrumented one");

const thrown = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return refuse("a probe did not throw");
};
const expectReceipt = (label, error, site, role) => {
  const r = registry.receiptOf(error);
  if (
    r?.schema !== ORIGIN_SCHEMA ||
    r.nonce !== nonce ||
    r.adapter !== registry.adapter ||
    r.site !== site ||
    r.role !== role
  )
    refuse(`${label} probe: ${JSON.stringify(r)}`);
  return r;
};
const genuine = thrown(() => expect(1).toBe(2));
const own = expectReceipt(
  "comparison",
  genuine,
  "chai.Assertion#assert",
  "comparison",
);
const edgesOf = (error) =>
  registry.edgesOf(error).map((e) => `${e.invocation}:${e.kind}`);
if (
  !own.framed ||
  JSON.stringify(edgesOf(genuine)) !==
    JSON.stringify([`${own.invocation}:sync`])
)
  refuse(`the comparison probe's edges: ${JSON.stringify(edgesOf(genuine))}`);
expectReceipt(
  "execution",
  thrown(() =>
    expect({}).toBeInstanceOf(
      // biome-ignore lint/complexity/noStaticOnlyClass: a valid constructor whose instanceof predicate throws (review r28)
      class {
        static [Symbol.hasInstance]() {
          throw new TypeError("probe");
        }
      },
    ),
  ),
  "chai.instanceOf.predicate-type-error",
  "execution",
);
expectReceipt(
  "precondition",
  thrown(() => expect({ x: 1 }).to.have.property(null)),
  "chai.property.name",
  "precondition",
);
// Review r29: the same genuine error thrown again from a getter another matcher reads is an edge of THAT matcher.
const borrowed = thrown(() =>
  expect({
    get x() {
      throw genuine;
    },
  }).toEqual({ x: 1 }),
);
const borrowedEdges = registry.edgesOf(borrowed);
if (
  borrowed !== genuine ||
  borrowedEdges.length !== 2 ||
  !borrowedEdges.some(
    (e) => e.invocation !== own.invocation && e.kind === "sync",
  )
)
  refuse(`the borrowed probe's edges: ${JSON.stringify(borrowedEdges)}`);
if (registry.receiptOf(new Error("probe")) !== null)
  refuse("an ordinary error carries a receipt");
// Revision 31 (RC2): the intrinsic-promise decision of this realm. A plain promise (and an async function's) is intrinsic; a subclass,
// an own `constructor`, a proxy and a custom thenable are not. Only own descriptors are read: the probe getter below must never run.
let probeGetterRan = false;
const ownConstructor = Promise.resolve();
Object.defineProperty(ownConstructor, "constructor", {
  get() {
    probeGetterRan = true;
    return Promise;
  },
});
const intrinsicCases = [
  ["plain", Promise.resolve(), true],
  ["async function", (async () => {})(), true],
  ["subclass", new (class extends Promise {})(() => {}), false],
  ["own constructor", ownConstructor, false],
  ["proxy", new Proxy(Promise.resolve(), {}), false],
  // biome-ignore lint/suspicious/noThenProperty: a custom thenable is this probe's subject
  ["thenable", { then() {} }, false],
];
for (const [label, value, expected] of intrinsicCases)
  if (registry.intrinsic(value) !== expected)
    refuse(`the intrinsic-promise probe (${label}) is not ${expected}`);
if (probeGetterRan)
  refuse("the intrinsic-promise decision ran a constructor getter");
if (registry.depth() !== 0)
  refuse("matcher frames are unbalanced after the probes");
if (registry.failures.length > 0)
  refuse(
    `the runtime failed during the probes: ${registry.failures.join("; ")}`,
  );
