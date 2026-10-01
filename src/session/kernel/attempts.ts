import type {
  AttemptHandle,
  AttemptOutcome,
  Attempts,
  BeginResult,
  ExchangeResult,
} from "../api";
import { LOCKS } from "../constants";
import {
  allocateEpoch,
  beginActivating,
  clearNonGating,
  failDefinitive,
  markIndeterminate,
  markRedirected,
  readAttempt,
  recordGrant,
  resolveAfterCancel,
  settle,
} from "../model/reducers/attempt";
import { deviceGetOrCreate } from "../model/reducers/misc";
import type {
  AccountId,
  AttemptMethod,
  AuthRecords,
  Epoch,
} from "../model/types";
import { isGating } from "../model/types";
import type { LockHandle } from "../ports/locks";
import type { RawAnswer } from "../ports/transport";
import { runClosingTransaction } from "./closing";
import { beginClosing, endClosing } from "./expose";
import { readIdentity } from "./identity";
import type { Kernel } from "./state";
import type { WipeService } from "./wipe";

/**
 * Self-establishing paths (matrix 3.4): password login, registration, OIDC sign-in and link, the incoming side of a
 * switch, and re-authentication. Initiation does NOT change what renders; only an attempt reaching a gating phase
 * does. A valid cookie with `settled == null` never signs anyone in: identity is established only by settlement.
 */

export type Classification =
  | { kind: "settle"; session: BrowserSessionBody }
  | { kind: "definitive"; error: NonNullable<RawAnswer["atlasError"]> }
  | { kind: "indeterminate" };

export interface BrowserSessionBody {
  account_id: AccountId;
  expires_at: string;
  csrf_token: string;
  session_id: string;
}

function parseSession(value: unknown): BrowserSessionBody | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.account_id !== "string" ||
    typeof body.expires_at !== "string" ||
    typeof body.csrf_token !== "string" ||
    typeof body.session_id !== "string"
  )
    return null;
  return {
    account_id: body.account_id,
    expires_at: body.expires_at,
    csrf_token: body.csrf_token,
    session_id: body.session_id,
  };
}

/**
 * Step 5 (matrix 3.4), one pure function. Definitive ONLY for a `2xx` valid `BrowserSession`, an Atlas-formatted `4xx`
 * or a `503 device_capacity`. Everything else is indeterminate: a proxy can answer `502` or `504` after the origin
 * committed the request and lost the reply, and HTTP gives a client no way to know.
 */
export function classifyActivation(answer: RawAnswer | null): Classification {
  if (answer === null) return { kind: "indeterminate" };
  if (answer.status >= 200 && answer.status < 300) {
    const session = parseSession(answer.json);
    return session ? { kind: "settle", session } : { kind: "indeterminate" };
  }
  const error = answer.atlasError;
  if (error === null) return { kind: "indeterminate" };
  if (answer.status >= 400 && answer.status < 500)
    return { kind: "definitive", error };
  if (answer.status === 503 && error.code === "device_capacity")
    return { kind: "definitive", error };
  return { kind: "indeterminate" };
}

const CANCEL_RESULTS = ["not_activated", "session_revoked", "unknown"] as const;

export class AttemptService implements Attempts {
  /** `atlas-attempt-<epoch>` locks this page holds: a liveness signal only. */
  private readonly owned = new Map<Epoch, LockHandle>();
  private resolving = false;
  private activation: AbortController | null = null;
  /**
   * Open from the moment an activation is committed to until its request is issued: the wait for `atlas-auth`, for other
   * pages' reservations and for the closing transaction. There is no request to abort yet, so hiding the page marks the
   * window instead, and the activation boundary consults it (matrix 3.4 step 3: a cookie-changing request must never be
   * issued by a page that is hidden or about to freeze).
   */
  private activationWindow: { hidden: boolean } | null = null;

  constructor(
    private readonly k: Kernel,
    private readonly wipe: WipeService,
  ) {}

  // ---- step 1: initiate --------------------------------------------------------------------------------------------
  async begin(method: AttemptMethod): Promise<BeginResult> {
    const { k } = this;
    const verifier = k.ports.ids.verifier();
    const challenge = await k.ports.ids.challenge(verifier);
    const auth = await k.ports.locks.acquire(LOCKS.auth, {
      signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
    });
    if (auth === null) return { kind: "lock_timeout" };
    try {
      const now = k.ports.clock.iso();
      const expires = new Date(
        k.ports.clock.now() +
          (method === "oidc" || method === "oidc_link"
            ? k.config.redirectedExpiryMs
            : k.config.exchangingExpiryMs),
      ).toISOString();
      const allocated = await k.transact(
        (records) =>
          allocateEpoch(records, { method, verifier, now, expiresAt: expires }),
        "allocate",
      );
      if (allocated.kind === "RESOLVE_FIRST") {
        void this.resolve();
        return { kind: "resolving" };
      }
      // D-16: taken INSIDE the critical section, so "free" always means "owner gone".
      const owner = await k.ports.locks.acquire(LOCKS.attempt(allocated.epoch));
      if (owner) this.owned.set(allocated.epoch, owner);
      k.ports.hints.post({ type: "auth_state_changed" });
      return {
        kind: "started",
        handle: { epoch: allocated.epoch, method, challenge },
      };
    } catch {
      return { kind: "storage_unavailable" };
    } finally {
      auth.release();
    }
  }

  // ---- step 2: exchange ----------------------------------------------------------------------------------------------
  async signInWithPassword(
    handle: AttemptHandle,
    credentials: { username: string; password: string },
  ): Promise<AttemptOutcome> {
    const { k } = this;
    let result: ExchangeResult;
    try {
      const device = await k.transact(
        (records) =>
          deviceGetOrCreate(records, {
            device_id: k.ports.ids.uuid(),
            now: k.ports.clock.iso(),
          }),
        "device",
      );
      const answer = await k.ports.unstamped.exchange(
        "/browser-sessions",
        {
          username: credentials.username,
          password: credentials.password,
          device_id: device.device_id,
          attempt_challenge: handle.challenge,
        },
        k.ports.clock.abortAfter(k.config.stampedRequestTimeoutMs),
      );
      result = toExchangeResult(answer);
    } catch {
      result = { kind: "network_failure" };
    }
    return this.completeExchange(handle, result);
  }

  async completeExchange(
    handle: AttemptHandle,
    result: ExchangeResult,
  ): Promise<AttemptOutcome> {
    const { k } = this;
    if (result.kind !== "grant") {
      // An error or network failure clears the attempt (under the lock, re-checking the epoch).
      await this.clearOwn(handle.epoch);
      if (result.kind === "error" && result.error)
        return { kind: "refused", error: result.error, definitive: true };
      return {
        kind: "exchange_failed",
        status: result.kind === "error" ? result.status : null,
      };
    }
    let recorded: "OK" | "SUPERSEDED";
    try {
      recorded = await k.transact(
        (records) =>
          recordGrant(records, {
            epoch: handle.epoch,
            account_id: result.account_id,
          }),
        "grant",
      );
    } catch {
      this.releaseOwner(handle.epoch);
      return { kind: "not_started", reason: "attempt_gone" };
    }
    // A stale result is discarded silently: no state changes, no broadcast (O6, O7).
    if (recorded === "SUPERSEDED") {
      this.releaseOwner(handle.epoch);
      return { kind: "superseded" };
    }
    return this.activate(handle.epoch, result.grant, result.account_id);
  }

  async markRedirected(handle: AttemptHandle): Promise<void> {
    const { k } = this;
    try {
      await k.transact(
        (records) =>
          markRedirected(records, {
            epoch: handle.epoch,
            expiresAt: new Date(
              k.ports.clock.now() + k.config.redirectedExpiryMs,
            ).toISOString(),
          }),
        "redirected",
      );
    } finally {
      this.releaseOwner(handle.epoch);
    }
    k.ports.hints.post({ type: "auth_state_changed" });
  }

  async landing(fragment: {
    grant: string;
    attempt: string;
    account: string;
  }): Promise<AttemptOutcome> {
    const { k } = this;
    const epoch = Number(fragment.attempt);
    let attempt: AuthRecords["auth_state"]["attempt"];
    try {
      attempt = await k.transact(
        (records) => readAttempt(records),
        "read",
        false,
      );
    } catch {
      return { kind: "not_started", reason: "attempt_gone" };
    }
    // The grant is useless without the verifier, which is not in the URL: a stale landing ends here.
    if (!attempt || attempt.epoch !== epoch || attempt.phase !== "redirected")
      return { kind: "superseded" };
    const owner = await k.ports.locks.acquire(LOCKS.attempt(epoch));
    if (owner) this.owned.set(epoch, owner);
    const recorded = await k.transact(
      (records) =>
        recordGrant(records, { epoch, account_id: fragment.account }),
      "grant",
    );
    if (recorded === "SUPERSEDED") {
      this.releaseOwner(epoch);
      return { kind: "superseded" };
    }
    return this.activate(epoch, fragment.grant, fragment.account);
  }

  async cancel(handle: AttemptHandle): Promise<void> {
    await this.clearOwn(handle.epoch);
  }

  // ---- step 3: activate --------------------------------------------------------------------------------------------
  /** The abort that the level-0 gate triggers in the same task (matrix 3.4 step 3). */
  abortActivation(): void {
    if (this.activationWindow) this.activationWindow.hidden = true;
    this.activation?.abort();
  }

  private async activate(
    epoch: Epoch,
    grant: string,
    account: AccountId,
  ): Promise<AttemptOutcome> {
    const { k } = this;
    // A fresh sign-in for an account whose deletion is outstanding runs the canonical procedure FIRST: a database
    // named in the ledger is never reused (EC-42).
    const pending = await this.wipe.outstanding(account);
    if (pending) {
      const done = await this.wipe.run(account, pending.operation_id, {
        create: "never",
      });
      if (
        done.kind !== "deleted" &&
        done.kind !== "absent" &&
        done.kind !== "superseded_incarnation"
      ) {
        await this.clearOwn(epoch);
        return { kind: "not_started", reason: "wipe_pending" };
      }
    }
    // The step begins only while the page is visible; a hidden page waits WITHOUT holding atlas-auth.
    if (!k.ports.page.isVisible()) {
      const visible = await this.waitVisible(epoch);
      if (!visible) {
        await this.clearOwn(epoch);
        return { kind: "not_started", reason: "hidden" };
      }
    }
    // From here until the request is issued, hiding the page is observable: it marks this window (there is no request to abort).
    const watch = { hidden: false };
    this.activationWindow = watch;
    const hiddenNow = () => watch.hidden || !k.ports.page.isVisible();
    let started: Awaited<ReturnType<AttemptService["activatingClosingWrite"]>>;
    try {
      started = await this.activatingClosingWrite(epoch, hiddenNow);
    } catch (error) {
      this.activationWindow = null;
      throw error;
    }
    if (started.kind !== "started") {
      this.activationWindow = null;
      // Hidden while it waited, before anything was committed: the attempt is cleared, exactly as when the wait was for visibility.
      if (started.kind === "abandoned") await this.clearOwn(epoch);
      else this.releaseOwner(epoch);
      return started.outcome;
    }
    const { verifier, auth } = started;
    // THE ACTIVATION BOUNDARY: the last check before the request, made in the same step that issues it. The page may have
    // hidden while the write waited for `atlas-auth` or its transaction completed; `activating` is already committed, so the
    // attempt is resolved by the terminal-cancellation protocol (below), never by discarding the verifier.
    const hidden = hiddenNow();
    this.activationWindow = null;
    // The lock is held until a definitive result, an abort or failure, or destruction.
    let answer: RawAnswer | null = null;
    if (!hidden) {
      const controller = new AbortController();
      this.activation = controller;
      const timer = k.ports.clock.setTimeout(
        () => controller.abort(),
        k.config.activationAbortMs,
      );
      try {
        answer = await k.ports.unstamped.activate(
          { grant, verifier },
          controller.signal,
        );
      } catch {
        answer = null;
      } finally {
        k.ports.clock.clearTimeout(timer);
        this.activation = null;
      }
    } else k.emit("activation.not_sent_hidden", { epoch });
    const verdict = classifyActivation(answer);
    try {
      if (verdict.kind === "settle")
        return await this.settleAttempt(epoch, verdict.session, auth);
      if (verdict.kind === "definitive")
        return await this.refuseAttempt(epoch, verdict.error);
      await this.markIndeterminate(epoch);
      return { kind: "gating" };
    } finally {
      auth.release();
      this.releaseOwner(epoch);
      if (verdict.kind !== "settle") void this.resolve();
    }
  }

  /**
   * A closing write (matrix 3.3.1, Ex2, Ex6): its FIRST statement is `beginClosing()` (lint rule R8). It commits
   * `phase = activating` only after every other page's reservation has been released to this page, and returns
   * with `atlas-auth` STILL HELD for the activation.
   */
  private async activatingClosingWrite(
    epoch: Epoch,
    hidden: () => boolean,
  ): Promise<
    | { kind: "started"; verifier: string; auth: LockHandle }
    | { kind: "failed"; outcome: AttemptOutcome }
    | { kind: "abandoned"; outcome: AttemptOutcome }
  > {
    beginClosing(this.k);
    try {
      const closing = await runClosingTransaction(this.k, {
        holdsAuth: false,
        keepAuth: true,
        label: "closing:activating",
        body: (records) => beginActivating(records, { epoch }),
        abandonIf: hidden,
      });
      if (closing.kind === "abandoned")
        return {
          kind: "abandoned",
          outcome: { kind: "not_started", reason: "hidden" },
        };
      if (closing.kind === "lock_timeout")
        return {
          kind: "failed",
          outcome: { kind: "not_started", reason: "lock_timeout" },
        };
      if (closing.kind === "gave_up")
        return {
          kind: "failed",
          outcome: { kind: "not_started", reason: "closing_write_gave_up" },
        };
      if (closing.kind === "failed")
        return {
          kind: "failed",
          outcome: { kind: "not_started", reason: "attempt_gone" },
        };
      if (closing.value.kind === "SUPERSEDED") {
        closing.auth?.release();
        return { kind: "failed", outcome: { kind: "superseded" } };
      }
      if (closing.auth === null)
        return {
          kind: "failed",
          outcome: { kind: "not_started", reason: "attempt_gone" },
        };
      this.k.ports.hints.post({ type: "auth_state_changed" });
      return {
        kind: "started",
        verifier: closing.value.verifier,
        auth: closing.auth,
      };
    } finally {
      endClosing(this.k);
    }
  }

  // ---- step 4: settle ----------------------------------------------------------------------------------------------
  private async settlementClosingWrite(
    epoch: Epoch,
    session: BrowserSessionBody,
    auth: LockHandle,
  ): Promise<"SETTLED" | "SUPERSEDED" | "failed" | "gave_up"> {
    beginClosing(this.k);
    try {
      const closing = await runClosingTransaction(this.k, {
        holdsAuth: true,
        label: "closing:settle",
        body: (records) =>
          settle(records, {
            epoch,
            account_id: session.account_id,
            session_id: session.session_id,
            now: this.k.ports.clock.iso(),
          }),
      });
      void auth;
      if (closing.kind === "done") return closing.value;
      return closing.kind === "gave_up" ? "gave_up" : "failed";
    } finally {
      endClosing(this.k);
    }
  }

  private async settleAttempt(
    epoch: Epoch,
    session: BrowserSessionBody,
    auth: LockHandle,
  ): Promise<AttemptOutcome> {
    const { k } = this;
    const result = await this.settlementClosingWrite(epoch, session, auth);
    if (result === "SETTLED") {
      // The CSRF token goes to page memory tagged (account, epoch) and nowhere else.
      k.memory.csrf.set(
        k.memory.csrfKey(session.account_id, epoch),
        session.csrf_token,
      );
      k.memory.settled = {
        account: session.account_id,
        epoch,
        sessionId: session.session_id,
      };
      k.ports.hints.post({ type: "auth_state_changed" });
      void k.hooks.evaluate("settled");
      return { kind: "settled", account_id: session.account_id, epoch };
    }
    if (result === "SUPERSEDED") return { kind: "superseded" };
    // The client never adopts a session it could not record: it becomes indeterminate and the person signs in again.
    await this.markIndeterminate(epoch);
    return { kind: "gating" };
  }

  private async refuseAttempt(
    epoch: Epoch,
    error: NonNullable<RawAnswer["atlasError"]>,
  ): Promise<AttemptOutcome> {
    const { k } = this;
    try {
      await k.transact(
        (records) =>
          failDefinitive(records, {
            epoch,
            obsId: k.ports.ids.uuid(),
            now: k.ports.clock.iso(),
          }),
        "fail_definitive",
      );
    } catch {
      // The attempt stays activating; the next page treats it as indeterminate and resolves it.
      return { kind: "gating" };
    }
    k.ports.hints.post({ type: "auth_state_changed" });
    void k.hooks.evaluate("refused");
    return { kind: "refused", error, definitive: true };
  }

  private async markIndeterminate(epoch: Epoch): Promise<void> {
    const { k } = this;
    try {
      await k.transact(
        (records) => markIndeterminate(records, { epoch }),
        "indeterminate",
      );
    } catch {
      // The durable phase simply stays `activating`, which the next page treats as `indeterminate`.
    }
    k.ports.hints.post({ type: "auth_state_changed" });
    void k.hooks.evaluate("indeterminate");
  }

  // ---- 3.4.2: terminal resolution --------------------------------------------------------------------------------
  /**
   * `resolve()`: cancel, then observe. Single flight per page; runs under `atlas-auth`; every decision is taken from
   * `auth_state` re-read INSIDE the transaction that acts on it (rule 10). OBSERVE never waits for a lease lock while
   * holding `atlas-auth`: it probes each foreign lease, and on a `DEFER` leaves, waits outside and enters again.
   * There is no retry cap that clears the gate.
   */
  async resolve(): Promise<void> {
    const { k } = this;
    if (this.resolving) return;
    this.resolving = true;
    try {
      let attempt = 0;
      while (!k.disposed) {
        if (!k.ports.page.isOnline()) return; // stays gated (1c offline); resumes on `online`
        const auth = await k.ports.locks.acquire(LOCKS.auth, {
          signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
        });
        if (auth === null) {
          const elapsed = await k.sleep(k.backoff(attempt));
          attempt = elapsed ? attempt + 1 : 0;
          continue;
        }
        let step: Awaited<ReturnType<AttemptService["resolveUnderLock"]>>;
        try {
          step = await this.resolveUnderLock();
        } finally {
          auth.release();
        }
        if (step.kind === "done") return;
        if (step.kind === "again") continue;
        if (step.kind === "defer") {
          for (const id of step.ids) {
            const waited = await k.ports.locks.wait(LOCKS.lease(id));
            if (waited === "granted") k.memory.released.add(id);
          }
          continue;
        }
        const elapsed = await k.sleep(k.backoff(attempt));
        attempt = elapsed ? attempt + 1 : 0;
      }
    } finally {
      this.resolving = false;
      k.hooks.evaluate("resolved");
    }
  }

  private async resolveUnderLock(): Promise<
    | { kind: "done" }
    | { kind: "again" }
    | { kind: "retry" }
    | { kind: "defer"; ids: readonly string[] }
  > {
    const { k } = this;
    let attempt = await k.transact(
      (records) => readAttempt(records),
      "read",
      false,
    );
    if (!attempt || !isGating(attempt)) return { kind: "done" };
    if (attempt.phase === "activating" && !this.owned.has(attempt.epoch)) {
      // An `activating` attempt whose owner lock is free is treated as `indeterminate` by whichever page finds it.
      const free = await k.ports.locks.probe(LOCKS.attempt(attempt.epoch));
      if (!free) return { kind: "retry" };
      await k.transact(
        (records) =>
          markIndeterminate(records, {
            epoch: (attempt as { epoch: Epoch }).epoch,
          }),
        "indeterminate",
      );
      attempt = await k.transact(
        (records) => readAttempt(records),
        "read",
        false,
      );
      if (!attempt || !isGating(attempt)) return { kind: "done" };
    }
    const epoch = attempt.epoch;
    if (attempt.phase !== "verifying") {
      let answer: RawAnswer | null = null;
      try {
        answer = await k.ports.unstamped.cancel(
          { verifier: attempt.verifier },
          k.ports.clock.abortAfter(k.config.cancelObserveTimeoutMs),
        );
      } catch {
        answer = null;
      }
      const result = cancelResult(answer);
      if (result === null) {
        // Did not complete (network error, timeout, non-Atlas response, 5xx): stay gated, retry later.
        await k.transact(
          (records) => markIndeterminate(records, { epoch }),
          "indeterminate",
        );
        return { kind: "retry" };
      }
      const resolved = await k.transact(
        (records) => resolveAfterCancel(records, { epoch, result }),
        "resolve_cancel",
      );
      k.ports.hints.post({ type: "auth_state_changed" });
      if (resolved === "CLEARED" || resolved === "SUPERSEDED")
        return { kind: "done" };
    }
    return this.observe(epoch);
  }

  /** OBSERVE: one leased `current()` for the settled account, decided by `observeAttempt`. */
  private async observe(
    epoch: Epoch,
  ): Promise<
    | { kind: "done" }
    | { kind: "again" }
    | { kind: "retry" }
    | { kind: "defer"; ids: readonly string[] }
  > {
    const { k } = this;
    const records = await k.transact(
      (current) => ({ write: null, result: structuredClone(current) }),
      "read",
      false,
    );
    const settled = records.auth_state.settled;
    if (settled === null) {
      // Nothing settled means nothing a stale cookie could affect: the attempt clears (decision D-20).
      await k.transact(
        (current) => clearGating(current, epoch),
        "resolve_unsettled",
      );
      return { kind: "done" };
    }
    // Probe every foreign lease of the settled account without blocking (a `null` proves nothing).
    for (const [id, lease] of Object.entries(records.auth_state.leases)) {
      if (lease.account_id !== settled.account_id || lease.boot_id === k.bootId)
        continue;
      if (await k.ports.locks.probe(LOCKS.lease(id))) k.memory.released.add(id);
    }
    const outcome = await readIdentity(k, settled.account_id, settled.epoch, {
      kind: "observe",
      attemptEpoch: epoch,
    });
    switch (outcome.kind) {
      case "observed":
        return outcome.result === "REOBSERVE"
          ? { kind: "again" }
          : { kind: "done" };
      case "defer":
        return { kind: "defer", ids: outcome.ids };
      default:
        return { kind: "retry" };
    }
  }

  // ---- expiry, liveness ------------------------------------------------------------------------------------------
  /**
   * Phase-specific expiry (matrix 3.4.3). Only `exchanging` and `redirected` are cleared by time (or, for
   * `exchanging`, by a free owner lock); a gating attempt is NEVER cleared by time. Runs under `atlas-auth`.
   */
  async sweep(record: AuthRecords): Promise<void> {
    const { k } = this;
    const attempt = record.auth_state.attempt;
    if (!attempt || isGating(attempt)) return;
    if (this.owned.has(attempt.epoch)) return;
    const expired = Date.parse(attempt.expires_at) <= k.ports.clock.now();
    let orphaned = false;
    if (attempt.phase === "exchanging")
      orphaned = await k.ports.locks.probe(LOCKS.attempt(attempt.epoch));
    if (!expired && !orphaned) {
      const remaining = Date.parse(attempt.expires_at) - k.ports.clock.now();
      k.ports.clock.setTimeout(
        () => void k.hooks.evaluate("attempt_expiry"),
        Math.max(0, remaining) + 1,
      );
      return;
    }
    await this.clearUnderAuth(attempt.epoch);
  }

  private async clearOwn(epoch: Epoch): Promise<void> {
    try {
      await this.clearUnderAuth(epoch);
    } finally {
      this.releaseOwner(epoch);
    }
  }

  private async clearUnderAuth(epoch: Epoch): Promise<void> {
    const { k } = this;
    const auth = await k.ports.locks.acquire(LOCKS.auth, {
      signal: k.ports.clock.abortAfter(k.config.lockWaitMs),
    });
    if (auth === null) return;
    try {
      const cleared = await k.transact(
        (records) => clearNonGating(records, { epoch }),
        "clear_attempt",
      );
      if (cleared === "CLEARED") {
        k.ports.hints.post({ type: "auth_state_changed" });
        void k.hooks.evaluate("attempt_cleared");
      }
    } catch {
      // The attempt stays; expiry or a later page clears it.
    } finally {
      auth.release();
    }
  }

  private releaseOwner(epoch: Epoch): void {
    const handle = this.owned.get(epoch);
    this.owned.delete(epoch);
    handle?.release();
  }

  private waitVisible(epoch: Epoch): Promise<boolean> {
    const { k } = this;
    return new Promise((resolve) => {
      const stop = k.ports.page.on("visible", () => {
        stop();
        k.ports.clock.clearTimeout(timer);
        resolve(true);
      });
      // The grant lives 60 s and an attempt that has not reached `activating` is cleared at its expiry.
      const timer = k.ports.clock.setTimeout(() => {
        stop();
        resolve(false);
      }, k.config.exchangingExpiryMs);
      void epoch;
    });
  }

  ownsEpoch(epoch: Epoch): boolean {
    return this.owned.has(epoch);
  }
}

function toExchangeResult(answer: RawAnswer): ExchangeResult {
  if (answer.status >= 200 && answer.status < 300) {
    const body = answer.json as Record<string, unknown> | undefined;
    if (
      body &&
      typeof body.grant === "string" &&
      typeof body.grant_expires_at === "string" &&
      typeof body.account_id === "string"
    )
      return {
        kind: "grant",
        grant: body.grant,
        grant_expires_at: body.grant_expires_at,
        account_id: body.account_id,
      };
  }
  return { kind: "error", error: answer.atlasError, status: answer.status };
}

function cancelResult(
  answer: RawAnswer | null,
): (typeof CANCEL_RESULTS)[number] | null {
  if (answer?.status !== 200) return null;
  const body = answer.json as { result?: unknown } | undefined;
  const result = body?.result;
  return CANCEL_RESULTS.find((candidate) => candidate === result) ?? null;
}

/** Clear a gating attempt when nothing is settled (D-20). */
function clearGating(records: Readonly<AuthRecords>, epoch: Epoch) {
  const state = structuredClone(records.auth_state);
  if (state.attempt?.epoch !== epoch)
    return { write: null, result: "SUPERSEDED" as const };
  state.attempt = null;
  return { write: { auth_state: state }, result: "CLEARED" as const };
}
