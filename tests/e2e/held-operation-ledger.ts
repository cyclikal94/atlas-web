import { type TestInfo, test } from "@playwright/test";
import type { HoldToken } from "../../src/fixture/data-harness/main";

/**
 * The ledger of the held operations of one case (WEB-08d revision 21, R20-N1): what each `withHeldOperations` scope armed, launched and
 * cleaned up (tests/e2e/held-operation.ts), and the cleanup failures the case must report as errors of their own. It has no other import,
 * so the fixtures (tests/e2e/helpers.ts) can publish it without a cycle.
 */
export type HoldKind = "outbox" | "engine";

/** One event of a hold or an operation, for the case's evidence (ms since the scope began). */
export interface TraceEvent {
  at: number;
  event: string;
  detail?: unknown;
}
export interface HoldRecord {
  kind: HoldKind;
  plan: string;
  token: HoldToken;
  released: boolean;
  events: TraceEvent[];
}
export interface CallRecord {
  name: string;
  state: "pending" | "fulfilled" | "rejected";
  joined: boolean;
  error?: string;
  events: TraceEvent[];
}
export interface ScopeRecord {
  holds: HoldRecord[];
  calls: CallRecord[];
  finalised: boolean;
  /** The body failed: its failure was rethrown after the cleanup below. */
  bodyFailed?: boolean;
  /** What the cleanup found wrong, in order (also in the ledger's `errors` when the body failed). */
  problems: string[];
}
/** The holds and operations of one case, and the cleanup failures it must report separately. */
export interface HeldOperationLedger {
  scopes: ScopeRecord[];
  errors: string[];
}

const ledgers = new WeakMap<TestInfo, HeldOperationLedger>();
/** The ledger of the running case (created on first use). */
export function heldOperationLedger(
  info: TestInfo = test.info(),
): HeldOperationLedger {
  let ledger = ledgers.get(info);
  if (ledger === undefined) {
    ledger = { scopes: [], errors: [] };
    ledgers.set(info, ledger);
  }
  return ledger;
}
/** A new, empty ledger that is NOT the case's: a qualification inspects what a scope recorded without it becoming the case's error. */
export const privateLedger = (): HeldOperationLedger => ({
  scopes: [],
  errors: [],
});

/**
 * A cleanup or operation failure's text, made unreadable as an assertion: the all-error reader (scripts/validation/engine-results.mjs)
 * classifies an error whose text has `Error: expect(` as an assertion, and an operation's own error could carry that text. Such an error must
 * stay an `error`, never become a second "assertion" that lets a mixed result pass as a catch.
 */
export const notAnAssertion = (text: string): string =>
  text.replaceAll("expect(", "expect (");

/**
 * The `heldOperations` fixture's teardown (tests/e2e/helpers.ts): attaches what every scope of the case did and, as ONE error of its own,
 * every cleanup failure, every scope that never finished (a case interrupted or timed out while it held an answer) and every operation a
 * finished scope never joined (its cleanup must have awaited it: a later settlement is not ownership). The text never
 * carries a body failure's message, and it passes through `notAnAssertion`.
 */
export async function publishHeldOperations(info: TestInfo): Promise<void> {
  const ledger = ledgers.get(info);
  if (ledger === undefined || ledger.scopes.length === 0) return;
  await info.attach("held-operations", {
    body: JSON.stringify(ledger, null, 2),
    contentType: "application/json",
  });
  const errors = [
    ...ledger.errors,
    ...ledger.scopes
      .filter((scope) => !scope.finalised)
      .map(
        (scope) =>
          `a held-operation scope never finished (${scope.holds.length} hold(s), ${scope.calls.filter((c) => c.state === "pending").length} operation(s) still pending)`,
      ),
    ...ledger.scopes
      .filter((scope) => scope.finalised)
      .flatMap((scope) => scope.calls.filter((call) => !call.joined))
      .map(
        (call) =>
          `the operation ${call.name} was never joined by its scope (${call.state})`,
      ),
  ];
  if (errors.length > 0)
    throw new Error(
      notAnAssertion(`held-operation cleanup failed: ${errors.join(" | ")}`),
    );
}
