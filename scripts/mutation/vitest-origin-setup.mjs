// WEB-14a revision 29 (review r28 R31 incomplete_fix, design assessment C2/C3): the FIRST setup file of every project of a supervised
// Vitest run (vitest-supervised.mjs). It no longer brands anything. It PROVES, in the worker realm that runs the tests, that the pinned
// framework modules were instrumented by the loading hook (vitest-origin-loader.mjs, from the worker's `--import`) and that their
// receipts reach the serialised error, and it throws otherwise: a module error, so the run is tainted and never admitted.
//
// Revision 28 put an accessor on chai's AssertionError class; the class is also constructed for argument validation and to wrap an
// execution error, so its membership proved nothing (review r28 R31). Receipts are now attached per occurrence at audited sites
// (vitest-origin-sites.mjs), and this file checks, before any test, one genuine comparison, one wrapped execution error and one
// argument-validation error against those sites.
import { chai, expect } from "vitest";
import {
  adapterDigest,
  MODULES,
  ORIGIN_KEY,
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

const receiptOf = (run) => {
  try {
    run();
  } catch (error) {
    return {
      own: Object.getOwnPropertyDescriptor(error, ORIGIN_KEY)?.value,
      json:
        typeof error?.toJSON === "function"
          ? error.toJSON()?.[ORIGIN_KEY]
          : undefined,
    };
  }
  return refuse("a probe did not throw");
};
const expectReceipt = (label, got, site, role) => {
  const r = got.own;
  if (
    r?.schema !== ORIGIN_SCHEMA ||
    r.nonce !== nonce ||
    r.adapter !== registry.adapter ||
    r.site !== site ||
    r.role !== role ||
    got.json !== r
  )
    refuse(
      `${label} probe: ${JSON.stringify(r)} (serialised ${JSON.stringify(got.json)})`,
    );
};
expectReceipt(
  "comparison",
  receiptOf(() => expect(1).toBe(2)),
  "chai.Assertion#assert",
  "comparison",
);
expectReceipt(
  "execution",
  receiptOf(() =>
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
  receiptOf(() => expect({ x: 1 }).to.have.property(null)),
  "chai.property.name",
  "precondition",
);
if (Object.hasOwn(new Error("probe"), ORIGIN_KEY))
  refuse("an ordinary error carries a receipt");
if (registry.depth() !== 0 || registry.outstanding() !== 0)
  refuse("matcher frames are unbalanced after the probes");
