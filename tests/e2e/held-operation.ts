import type { Page } from "@playwright/test";
import type {
  DataHarness,
  HoldRelease,
  HoldToken,
} from "../../src/fixture/data-harness/main";
import { untilOutboxPlanCalled } from "./data-operation-barriers";
import {
  type CallRecord,
  type HeldOperationLedger,
  type HoldKind,
  type HoldRecord,
  heldOperationLedger,
  notAnAssertion,
  type RejectionRecord,
  type ScopeRecord,
} from "./held-operation-ledger";
import { expect } from "./helpers";

export { privateLedger } from "./held-operation-ledger";

/**
 * WEB-08d revision 21 (review r20 R20-N1, design assessment 4645b621): one owner for every operation a case starts under a held answer.
 *
 * A case arms the fixture's hold of a plan's answer (`holdOutboxPlan`, `holdEnginePlan`), starts an operation whose answer is then held,
 * makes its assertions, and releases the hold and awaits the operation at its success-path position. Before this, an assertion that failed
 * while the answer was held skipped the release and the await: the operation's `page.evaluate` stayed pending until Playwright ended the
 * case, and the report carried a second, unrelated error (`page.evaluate: Test ended`) beside the intended assertion (MU-990 in three
 * engines), which the all-error reader rightly refuses as a catch.
 *
 * `withHeldOperations` owns the holds and operations of its body:
 *  - H1: an operation is observed from the moment it starts (`launch`), so its rejection is never unhandled, and its real outcome is kept
 *    for the case (`settled()` gives its value or throws its error).
 *  - H2/H3: when the body ends, by success or failure, every hold it armed is released by its own token (a consumed hold delivers the real
 *    answer; an arm that was never reached is disarmed; another document's or a later arm's hold is never touched), and every operation is
 *    joined, within `settleMs`, before the body's failure is rethrown. Nothing here writes a marker, lifts a stop or repeats an operation.
 *  - H5: the body's own failure is rethrown unchanged. A failure of the cleanup itself (a release that fails, finds the hold's document gone
 *    or leaves it armed or held; an operation that rejects or does not settle) is recorded in the case's ledger and published by the
 *    `heldOperations` fixture (tests/e2e/helpers.ts) as a SEPARATE error of the case, never merged into the assertion's message. With no
 *    failure of the body, such a failure is the case's error.
 *  - H6: on the success path nothing extra runs between the body's last step and its end: the release and the await stay where the case
 *    put them, with their original values and timeouts.
 *  - H7 (revision 22, review r21 R21-N1): an operation's rejection that reaches a body which then fails is the case's runtime failure,
 *    never an assertion, whatever its text. `settled()` hands the body the rejection unchanged and the body's failure is rethrown
 *    unchanged (H5), so that failure can be the rejection itself, whose text the all-error reader may read as an assertion
 *    (`Error: expect(`). The cleanup therefore records a runtime-origin witness for each such call: one whose rejection `settled()`
 *    delivered to the body, or whose rejection IS the body's failure (or its `cause`). The witness names the call by its id and carries no
 *    text of the rejection; the `heldOperations` fixture publishes it as part of its separate error, so the case is an `error`, never a
 *    catch. Observing an outcome is not expecting it: a case that expects a rejection says so with `expectRejection()` and asserts it with
 *    a matcher (`await expect(call.expectRejection()).rejects.toThrow(...)`); such a rejection is witnessed only when it is itself the
 *    body's failure, so a later, different assertion of the body stays an assertion. A body that succeeds publishes no witness.
 *
 * A background continuation (the dispatcher or engine reading a held answer) has no handle here. On a failure path its hold is released or
 * disarmed and the hold's state is checked (neither armed nor held); the continuation itself is ended with the case's context and is not
 * claimed settled. On the success path the case's own assertions observe it, as before.
 */

/** The plans whose answers the fixture can hold, as the harness names them. */
export type OutboxHeldPlan = Parameters<DataHarness["holdOutboxPlan"]>[0];
export type EngineHeldPlan = Parameters<DataHarness["holdEnginePlan"]>[0];

/** A held answer: wait until the plan has run and its answer is held, and release it at the case's success-path position. */
export interface Hold {
  readonly token: HoldToken;
  untilHeld(): Promise<void>;
  /** Delivers the held answer; anything but `released` (never reached, gone, stale) is the case's error. */
  release(): Promise<void>;
}
/** An operation started under a hold: `settled()` gives its value, or throws the error it really had. */
export interface HeldCall<T> {
  settled(): Promise<T>;
  /** As `settled()`, for a case that expects this operation to reject and asserts that with a matcher (H7). */
  expectRejection(): Promise<T>;
}
export interface HeldOperations {
  holdOutbox(page: Page, plan: OutboxHeldPlan): Promise<Hold>;
  holdEngine(page: Page, plan: EngineHeldPlan): Promise<Hold>;
  launch<T>(name: string, operation: () => Promise<T>): HeldCall<T>;
}
export interface HeldOperationsOptions {
  /** Default: the running case's ledger, published by the `heldOperations` fixture. */
  ledger?: HeldOperationLedger;
  /** How long the cleanup of a failed body waits for its releases and operations together. */
  settleMs?: number;
}

const SETTLE_MS = 5_000;

const firstLine = (error: unknown): string =>
  String((error as { message?: unknown } | null)?.message ?? error ?? "").split(
    "\n",
  )[0] ?? "";

/** The rejection as it really was, kept for the attachment (never put into an error's text). */
const rejectionOf = (error: unknown): RejectionRecord =>
  error instanceof Error
    ? { type: error.name, message: String(error.message), stack: error.stack }
    : { type: typeof error, message: String(error) };
/** `failure` is `error`, or has it in its `cause` chain (a bounded walk: a cycle cannot hold the cleanup). */
const carries = (failure: unknown, error: unknown): boolean => {
  let current: unknown = failure;
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === error) return true;
    if (current === null || typeof current !== "object") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
/** Waits for `promise` until `deadline` (ms since the epoch); `undefined` when it did not settle in time. */
async function until<T>(
  promise: Promise<Outcome<T>>,
  deadline: number,
): Promise<Outcome<T> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => resolve(undefined),
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
const observe = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );

/**
 * The seam's answers are checked, not trusted: a page whose harness predates the tokens (a stale fixture build) answers `undefined`, and that
 * must be an error that says so, not a cleanup that cannot read its own release.
 */
const isToken = (value: unknown): value is HoldToken =>
  typeof (value as HoldToken | null)?.document === "string" &&
  Number.isInteger((value as HoldToken | null)?.generation);
const isRelease = (value: unknown): value is HoldRelease =>
  ["released", "disarmed", "stale", "idle"].includes(
    (value as HoldRelease | null)?.outcome as string,
  ) &&
  typeof (value as HoldRelease).armed === "boolean" &&
  typeof (value as HoldRelease).held === "boolean";
async function arm(
  page: Page,
  kind: HoldKind,
  plan: string,
): Promise<HoldToken> {
  const token: unknown = await page.evaluate(
    ({ kind: which, plan: name }) => {
      const harness = window.__atlasData;
      if (harness === undefined) throw new Error("no data harness");
      return which === "outbox"
        ? harness.holdOutboxPlan(name as OutboxHeldPlan)
        : harness.holdEnginePlan(name as EngineHeldPlan);
    },
    { kind, plan },
  );
  if (!isToken(token))
    throw new Error(
      `the harness armed the ${plan} hold without a token (${JSON.stringify(token)}): is the fixture build older than its hold seam?`,
    );
  return token;
}
async function releaseOf(
  page: Page,
  kind: HoldKind,
  token: HoldToken,
): Promise<HoldRelease> {
  const released: unknown = await page.evaluate(
    ({ kind: which, token: owned }) => {
      const harness = window.__atlasData;
      if (harness === undefined) throw new Error("no data harness");
      return which === "outbox"
        ? harness.releaseOutboxPlan(owned)
        : harness.releaseEnginePlan(owned);
    },
    { kind, token },
  );
  if (!isRelease(released))
    throw new Error(
      `the harness answered a release with ${JSON.stringify(released)}, not a hold release: is the fixture build older than its hold seam?`,
    );
  return released;
}

/**
 * Runs `body` as the owner of the holds it arms and the operations it launches (see the module's comment). The body's failure is rethrown
 * unchanged after the cleanup; a failure of the cleanup is the case's separate error.
 */
export async function withHeldOperations<R>(
  body: (holds: HeldOperations) => Promise<R>,
  options: HeldOperationsOptions = {},
): Promise<R> {
  const ledger = options.ledger ?? heldOperationLedger();
  const settleMs = options.settleMs ?? SETTLE_MS;
  const began = Date.now();
  const at = () => Date.now() - began;
  const record: ScopeRecord = {
    id: `s${ledger.scopes.length + 1}`,
    holds: [],
    calls: [],
    finalised: false,
    problems: [],
  };
  ledger.scopes.push(record);
  const holds: { page: Page; record: HoldRecord }[] = [];
  const calls: { record: CallRecord; outcome: Promise<Outcome<unknown>> }[] =
    [];

  const holdOf = async (
    page: Page,
    kind: HoldKind,
    plan: string,
  ): Promise<Hold> => {
    const token = await arm(page, kind, plan);
    const held: HoldRecord = {
      kind,
      plan,
      token,
      released: false,
      events: [{ at: at(), event: "armed" }],
    };
    record.holds.push(held);
    holds.push({ page, record: held });
    return {
      token,
      async untilHeld() {
        if (kind === "outbox") await untilOutboxPlanCalled(page);
        else
          await expect
            .poll(
              () => page.evaluate(() => window.__atlasData?.enginePlanHeld()),
              { timeout: 20_000 },
            )
            .toBe(true);
        held.events.push({ at: at(), event: "held" });
      },
      async release() {
        const released = await releaseOf(page, kind, token);
        held.released = true;
        held.events.push({ at: at(), event: "release", detail: released });
        if (released.outcome !== "released")
          throw new Error(
            `the held ${plan} answer was not released (${released.outcome}): the hold was never reached, or belongs to another document or arm`,
          );
      },
    };
  };

  const api: HeldOperations = {
    holdOutbox: (page, plan) => holdOf(page, "outbox", plan),
    holdEngine: (page, plan) => holdOf(page, "engine", plan),
    launch<T>(name: string, operation: () => Promise<T>): HeldCall<T> {
      const call: CallRecord = {
        id: `${record.id}.c${record.calls.length + 1}`,
        name,
        state: "pending",
        joined: false,
        rejectionsDelivered: 0,
        rejectionExpected: false,
        events: [{ at: at(), event: "launched" }],
      };
      record.calls.push(call);
      // Started at once, as the case started it, and observed at once (H1).
      let started: Promise<T>;
      try {
        started = operation();
      } catch (error) {
        started = Promise.reject(error);
      }
      const outcome = observe(started).then((settled) => {
        call.state = settled.ok ? "fulfilled" : "rejected";
        if (!settled.ok) {
          call.error = firstLine(settled.error);
          call.rejection = rejectionOf(settled.error);
        }
        call.events.push({ at: at(), event: call.state });
        return settled;
      });
      calls.push({ record: call, outcome });
      return {
        async settled() {
          const settled = await outcome;
          call.joined = true;
          if (!settled.ok) {
            // Handed to the body: if the body then fails, this is a runtime failure of the case (H7).
            call.rejectionsDelivered += 1;
            call.events.push({ at: at(), event: "rejection-delivered" });
            throw settled.error;
          }
          return settled.value as T;
        },
        async expectRejection() {
          call.rejectionExpected = true;
          const settled = await outcome;
          call.joined = true;
          if (!settled.ok) {
            call.events.push({
              at: at(),
              event: "expected-rejection-delivered",
            });
            throw settled.error;
          }
          return settled.value as T;
        },
      };
    },
  };

  /**
   * Releases what is still owned and joins every operation; returns what went wrong and, for a failed body, the runtime-origin witnesses
   * (H7). It never throws: anything unexpected is one more problem, and the scope is always marked finished, so a body's failure is never
   * replaced by the cleanup's.
   */
  const finalise = async (
    failed: { failure: unknown } | null,
  ): Promise<{ problems: string[]; escaped: string[] }> => {
    const problems: string[] = [];
    const escaped: CallRecord[] = [];
    try {
      await cleanUp(failed, problems, escaped);
    } catch (error) {
      problems.push(`the cleanup itself failed: ${firstLine(error)}`);
    }
    record.finalised = true;
    record.bodyFailed = failed !== null;
    record.problems = problems;
    if (failed !== null) record.escaped = escaped.map((call) => call.id);
    return {
      problems,
      escaped: escaped.map(
        (call) =>
          `operation ${call.id} (${call.name}) rejected and its rejection reached the case's body, which then failed: a runtime failure of the operation, not an assertion (its error is in the held-operations attachment)`,
      ),
    };
  };
  const cleanUp = async (
    failed: { failure: unknown } | null,
    problems: string[],
    escaped: CallRecord[],
  ): Promise<void> => {
    const bodyFailed = failed !== null;
    const deadline = Date.now() + settleMs;
    for (const { page, record: held } of holds) {
      // On the success path a hold the body released is left alone: nothing runs after the case's own steps (H6).
      if (held.released && !bodyFailed) continue;
      const attempted = await until(
        observe(releaseOf(page, held.kind, held.token)),
        deadline,
      );
      held.events.push({
        at: at(),
        event: "cleanup-release",
        detail:
          attempted === undefined
            ? "timed out"
            : attempted.ok
              ? attempted.value
              : firstLine(attempted.error),
      });
      if (attempted === undefined)
        problems.push(
          `releasing the held ${held.plan} answer did not finish within ${settleMs} ms`,
        );
      else if (!attempted.ok)
        problems.push(
          `releasing the held ${held.plan} answer failed: ${firstLine(attempted.error)}`,
        );
      else {
        const { outcome, armed, held: stillHeld } = attempted.value;
        if (outcome === "stale")
          problems.push(
            `the held ${held.plan} answer could not be released: its document or arm is gone (stale token)`,
          );
        else if (armed || stillHeld)
          problems.push(
            `the ${held.plan} hold is still ${stillHeld ? "held" : "armed"} after its release`,
          );
        else if (!held.released && !bodyFailed)
          problems.push(
            `the body did not release the held ${held.plan} answer (${outcome} by the cleanup)`,
          );
      }
      held.released = true;
    }
    for (const { record: call, outcome } of calls) {
      if (call.joined && !bodyFailed) continue;
      const settled = await until(outcome, deadline);
      if (settled === undefined) {
        call.events.push({ at: at(), event: "did-not-settle" });
        problems.push(
          `the operation ${call.name} did not settle within ${settleMs} ms of its hold's release`,
        );
        continue;
      }
      // A rejection no one received is a cleanup failure (as before). One the failed body received through `settled()`, or that IS the
      // body's failure, is witnessed instead (H7): never both, so one failed operation is one entry.
      if (!settled.ok && !call.joined)
        problems.push(
          `the operation ${call.name} failed: ${firstLine(settled.error)}`,
        );
      else if (
        !settled.ok &&
        failed !== null &&
        (call.rejectionsDelivered > 0 || carries(failed.failure, settled.error))
      ) {
        call.events.push({ at: at(), event: "runtime-origin-witnessed" });
        escaped.push(call);
      }
      call.joined = true;
    }
  };

  let result: R;
  try {
    result = await body(api);
  } catch (failure) {
    const { problems, escaped } = await finalise({ failure });
    ledger.errors.push(...problems);
    ledger.escaped.push(...escaped);
    throw failure;
  }
  const { problems } = await finalise(null);
  if (problems.length > 0)
    throw new Error(notAnAssertion(`held operations: ${problems.join("; ")}`));
  return result;
}
