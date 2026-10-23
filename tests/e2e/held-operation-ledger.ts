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
/** An operation's rejection as it really was, for the attachment only: never part of an error's text (see `HeldOperationLedger.escaped`). */
export interface RejectionRecord {
  /** The error's `name` (`Error`, `TypeError`, ...), or `typeof` for a value that is not an Error. */
  type: string;
  message: string;
  stack?: string;
}
export interface CallRecord {
  /** Stable within the case: `s<scope>.c<call>`, in launch order. */
  id: string;
  name: string;
  state: "pending" | "fulfilled" | "rejected";
  /** The body or the cleanup awaited the outcome. Proves observation only: it says nothing about whether a rejection was expected. */
  joined: boolean;
  /** How many times `settled()` handed the body this call's rejection (revision 22, R21-N1). */
  rejectionsDelivered: number;
  /** `expectRejection()` handed the body the outcome: the case declared that this operation should reject. */
  rejectionExpected: boolean;
  /** The first line of the rejection's message (as before). */
  error?: string;
  rejection?: RejectionRecord;
  events: TraceEvent[];
}
export interface ScopeRecord {
  /** Stable within the case: `s<n>`, in the order the scopes began. */
  id: string;
  holds: HoldRecord[];
  calls: CallRecord[];
  finalised: boolean;
  /** The body failed: its failure was rethrown after the cleanup below. */
  bodyFailed?: boolean;
  /** What the cleanup found wrong, in order (also in the ledger's `errors` when the body failed). */
  problems: string[];
  /** The ids of the calls whose rejection reached the failed body (also in the ledger's `escaped`). */
  escaped?: string[];
}
/** The holds and operations of one case, and the failures it must report separately. */
export interface HeldOperationLedger {
  scopes: ScopeRecord[];
  /** Cleanup failures: a release, a join or an unjoined operation that failed. */
  errors: string[];
  /**
   * Revision 22 (review r21 R21-N1): runtime-origin witnesses. A failed body that `settled()` had handed an operation's rejection (or whose
   * failure IS an operation's rejection) is rethrown unchanged, so the case's first error is that rejection's own text, which the all-error
   * reader can read as an assertion (`Error: expect(`). Each witness is a neutral statement that the case's failure involves an operation's
   * runtime failure: it names the call by its id and never carries the rejection's message or stack, which stay in the attachment.
   */
  escaped: string[];
}

const ledgers = new WeakMap<TestInfo, HeldOperationLedger>();
/** The ledger of the running case (created on first use). */
export function heldOperationLedger(
  info: TestInfo = test.info(),
): HeldOperationLedger {
  let ledger = ledgers.get(info);
  if (ledger === undefined) {
    ledger = { scopes: [], errors: [], escaped: [] };
    ledgers.set(info, ledger);
  }
  return ledger;
}
/** A new, empty ledger that is NOT the case's: a qualification inspects what a scope recorded without it becoming the case's error. */
export const privateLedger = (): HeldOperationLedger => ({
  scopes: [],
  errors: [],
  escaped: [],
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
 * every cleanup failure, every scope that never finished (a case interrupted or timed out while it held an answer), every operation a
 * finished scope never joined (its cleanup must have awaited it: a later settlement is not ownership) and every runtime-origin witness
 * (an operation's rejection that reached the failed body). The text never carries a body failure's or a rejection's message, and it
 * passes through `notAnAssertion`, so the reader always sees this error as an `error`: a case with one is never an assertion-only case.
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
  const parts = [
    ...(errors.length > 0
      ? [`held-operation cleanup failed: ${errors.join(" | ")}`]
      : []),
    ...(ledger.escaped.length > 0
      ? [`held-operation runtime failure: ${ledger.escaped.join(" | ")}`]
      : []),
  ];
  if (parts.length > 0) throw new Error(notAnAssertion(parts.join(" || ")));
}
