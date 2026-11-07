import type {
  Attempts,
  NeutralActions,
  Operations,
  Recovery,
  Session,
  StampedApi,
  Store,
  Wipe,
} from "./api";
import { DEFAULT_CONFIG, type SessionConfig } from "./constants";
import { probeAdmission } from "./kernel/admission";
import { AttemptService } from "./kernel/attempts";
import { checkApiCompatibility } from "./kernel/compat";
import { evaluate } from "./kernel/evaluate";
import {
  applyLevel0Gate,
  closeDisplay,
  noteForeignLease,
} from "./kernel/expose";
import {
  convertOlderEpochLeases,
  ensureCsrf,
  readIdentity,
  startCredentialVerification,
  verifyUnresolved,
} from "./kernel/identity";
import { recordAndHold } from "./kernel/observation";
import { OperationService } from "./kernel/operations";
import { holdForPersistence } from "./kernel/persistence";
import { RecoveryService } from "./kernel/recovery";
import { createStampedFetch, sealResult } from "./kernel/send";
import { Kernel, MutableStore, type SessionPorts } from "./kernel/state";
import { StampedRequestError } from "./kernel/types";
import { WipeService } from "./kernel/wipe";
import { formatRange, type VersionRange } from "./model/api-version";
import type { AuthRecords } from "./model/types";
import type { ApiCompatibility } from "./model/view";
import type { Hint } from "./ports/hints";
import { createStampedClient } from "./stamped-client";

export interface CreateSessionOptions {
  config?: Partial<SessionConfig>;
  /** The API versions this client supports (decision D-08). */
  supportedRange: VersionRange;
  /** Where "Sign in" leads (WEB-08b supplies the surface). */
  onSignIn?: () => void;
  onReload?: () => void;
  onReviewDevice?: () => void;
}

/**
 * The composition root: it builds the kernel from ports, assigns the hooks that would otherwise make the kernel
 * modules import each other, and returns the public interface. `createSession` and `start()` are called OUTSIDE any
 * component effect (React StrictMode double-invokes effects; risk R-8).
 */
export function createSession(
  ports: SessionPorts,
  options: CreateSessionOptions,
): Session {
  return createSessionWithKernel(ports, options).session;
}

/**
 * The same, and also the kernel, for the fake-world suites and the fixture harness page. The kernel is NOT part of the
 * public interface: no other slice may reach it (a boundary test enforces this).
 */
export function createSessionWithKernel(
  ports: SessionPorts,
  options: CreateSessionOptions,
): { session: Session; kernel: Kernel } {
  const config: SessionConfig = { ...DEFAULT_CONFIG, ...options.config };
  const k = new Kernel(ports, config);
  const wipe = new WipeService(k);
  const attempts = new AttemptService(k, wipe);
  const operations = new OperationService(k, wipe);
  const recovery = new RecoveryService(k);
  const compat = new MutableStore<ApiCompatibility>({ status: "unknown" });
  let lastVerifiedAt = Number.NEGATIVE_INFINITY;

  /**
   * HF1-SHARED-CONFIRMATION-20261013: the record's latest server confirmation of THIS session (its settlement, or any page's clean identity
   * read), less than the interval old, counts as this page's last verification. A timestamp in the future proves nothing. It only spares a
   * background check; it never permits display or sending.
   */
  const confirmedRecently = (identity: {
    account_id: string;
    epoch: number;
    session_id: string;
  }) => {
    const shared = k.lastRecord?.confirmation;
    if (
      !shared ||
      shared.account_id !== identity.account_id ||
      shared.epoch !== identity.epoch ||
      shared.session_id !== identity.session_id
    )
      return false;
    const age = ports.clock.now() - Date.parse(shared.confirmed_at);
    return age >= 0 && age < config.resumeVerificationMinIntervalMs;
  };

  const resumeVerification = () => {
    const identity = k.identity.get();
    if (
      !identity ||
      k.memory.display.kind !== "displaying" ||
      !ports.page.isOnline() ||
      ports.clock.now() - lastVerifiedAt <
        config.resumeVerificationMinIntervalMs ||
      confirmedRecently(identity)
    )
      return;
    lastVerifiedAt = ports.clock.now();
    // The resume verification never blocks display, so ordinary offline resume is unaffected (row 6).
    void readIdentity(k, identity.account_id, identity.epoch, {
      kind: "general",
      expectClear: false,
      knownSessionId: identity.session_id,
    });
  };

  const onRecord = (records: AuthRecords) => {
    const state = records.auth_state;
    const settled = state.settled;
    const online = ports.page.isOnline();
    if (settled && online) {
      const fences = state.fences[settled.account_id] ?? [];
      if (fences.some((fence) => fence.kind === "credential_unverified"))
        startCredentialVerification(k, settled.account_id, settled.epoch);
      if (k.neutral.unresolvedLeaseKnown)
        void k.hooks.verifyUnresolved(
          settled.account_id,
          settled.epoch,
          new Set(),
        );
    }
    if (state.attempt) {
      const gating =
        state.attempt.phase === "activating" ||
        state.attempt.phase === "indeterminate" ||
        state.attempt.phase === "verifying";
      if (gating && online) void attempts.resolve();
      else if (!gating) void attempts.sweep(records);
    }
    operations.resume();
  };

  k.hooks = {
    closeDisplay: (account, cause) => closeDisplay(k, account, cause),
    evaluate: (reason) => {
      void evaluate(k, reason);
    },
    startCredentialVerification: (account, epoch) =>
      startCredentialVerification(k, account, epoch),
    abortActivation: () => attempts.abortActivation(),
    onRecord,
    ensureCsrf: (account, epoch) => ensureCsrf(k, account, epoch),
    verifyUnresolved: async (account, epoch, unresolved) => {
      const outcome = await verifyUnresolved(k, account, epoch, unresolved);
      // Only a verification that actually ran to its end says the leases are resolved.
      if (outcome === "ran") {
        if (k.neutral.unresolvedLeaseKnown)
          k.neutral = { ...k.neutral, unresolvedLeaseKnown: false };
        void evaluate(k, "verified_unresolved");
      }
      return outcome;
    },
    closeFromCover: (account, outcome) => {
      if (outcome.record) k.lastRecord = outcome.record;
      // An operation cover without its fence, or a recovery cover that is ineligible, says nothing about display.
      if (
        outcome.kind === "CLOSED" &&
        (outcome.reason === "no_operation_fence" ||
          outcome.reason === "recovery_ineligible")
      )
        return;
      closeDisplay(k, account, "cover_closed");
      if (outcome.kind === "CLOSED_UNRESOLVED") {
        k.neutral = { ...k.neutral, unresolvedLeaseKnown: true };
        const settledNow = k.memory.settled;
        k.memory.unresolvedKnownFor = settledNow
          ? { account: settledNow.account, epoch: settledNow.epoch }
          : { account, epoch: 0 };
        // E5: unresolved leases of an OLDER epoch become fences (add-only, no lock, no network).
        void convertOlderEpochLeases(k, account, outcome.unresolved);
      }
      void evaluate(k, "cover_closed");
    },
  };

  const onHint = (hint: Hint) => {
    switch (hint.type) {
      case "auth_state_changed":
        void evaluate(k, "hint");
        return;
      case "lease":
        noteForeignLease(k, hint.lease_id, hint.account_id);
        return;
      case "observation": {
        const display = k.memory.display;
        // A tab holds only if it is CURRENTLY displaying that account under that epoch.
        if (
          display.kind === "displaying" &&
          display.account === hint.account_id &&
          display.epoch === hint.stamp_epoch
        ) {
          void recordAndHold(
            k,
            {
              obs_id: hint.obs_id,
              lease_id: hint.lease_id,
              account: hint.account_id,
              epoch: hint.stamp_epoch,
              kind: hint.kind,
              hold_id: `h:${hint.obs_id}`,
            },
            { announce: false },
          );
        } else void evaluate(k, "hint");
        return;
      }
    }
  };

  const api: StampedApi = {
    fetchFor: (klass, account, epoch) =>
      createStampedFetch(k, klass, account, epoch),
    client: (klass, account, epoch, send) =>
      createStampedClient(k, klass, account, epoch, send),
    seal: async (account, epoch, pending) => {
      const result = await sealResult(k, account, epoch, pending);
      // A disposed session hands nothing back (synchronous: nothing asynchronous follows the verdict).
      if (k.disposed) throw new StampedRequestError("stale");
      return result;
    },
    admission: (klass, account, epoch) =>
      probeAdmission(k, klass, account, epoch),
  };

  const actions: NeutralActions = {
    signIn: () => options.onSignIn?.(),
    retry: () => {
      k.nudge();
      void evaluate(k, "user_retry");
      void attempts.resolve();
      operations.resume({ force: true });
      // WEB-09b: state 3's "Try again" is the recovery job's own act as well (R2 of the review of 10 October 2026).
      recovery.retried();
    },
    reload: () => options.onReload?.(),
    reviewDevice: () => {
      k.neutral = { ...k.neutral, notice: null };
      void evaluate(k, "review_device");
      options.onReviewDevice?.();
    },
    consent: (choice, ticket) => {
      // Applied to the prompt the ticket names, never to "the first entry waiting" (two accounts can be waiting).
      void wipe.resolveConsent(ticket, choice).catch(() => {
        void evaluate(k, "consent_failed");
      });
    },
  };

  // The API-version check (D-08), asked at boot and again at every reconnect (WEB-14a, D-P9; WEB-03 3.9a), on a return to the page once
  // `compatRecheckMinIntervalMs` has passed, and on a paced timer while the answer is anything but `supported`. A page that KNOWS it is
  // offline does not send a request that is certain to fail: it reports `unreachable` (which offers nothing new and hides nothing) and
  // asks again when connectivity returns. One check is in flight; a trigger that arrives meanwhile asks for exactly one more after it,
  // so an answer asked for before a reconnect is always followed by one asked for after it, and answers land in the order asked.
  //
  // A RECONNECT CLOSES ADMISSION AT ONCE (WEB-14a revision 1, R1). The server may have been upgraded while this page could not reach it, so
  // a `supported` answer from before the reconnect says nothing about it: in the same synchronous step as the `online` event (before any
  // dispatcher can run) the fact becomes `unknown`, which holds queued writes quietly (`compat_unconfirmed`), and only an answer to a check
  // ASKED AFTER the latest reconnect is ever applied. An answer to a check asked before it (in flight when the page came back, or queued
  // behind one that was) is dropped: the check asked again after it is the one that decides.
  let checking = false;
  /** How many reconnects this page has seen: an answer is applied only by the check that was asked after the latest one. */
  let reconnects = 0;
  let again = false;
  let lastAnswerAt = Number.NEGATIVE_INFINITY;
  let retryTimer: number | null = null;
  let retryStep = 0;
  const cancelRetry = () => {
    if (retryTimer !== null) ports.clock.clearTimeout(retryTimer);
    retryTimer = null;
  };
  const answered = (result: ApiCompatibility) => {
    const before = compat.get().status;
    lastAnswerAt = ports.clock.now();
    compat.set(result);
    // The pace starts again whenever the answer changes; `supported` needs no timer (the events above still ask).
    if (result.status !== before) retryStep = 0;
    cancelRetry();
    if (k.disposed || result.status === "supported") return;
    const wait = Math.min(
      config.compatRetryMaxMs,
      config.compatRetryInitialMs * 2 ** retryStep,
    );
    retryStep += 1;
    retryTimer = ports.clock.setTimeout(() => {
      retryTimer = null;
      checkCompatibility();
    }, wait);
  };
  const checkCompatibility = () => {
    if (k.disposed) return;
    if (checking) {
      again = true;
      return;
    }
    if (!ports.page.isOnline()) {
      answered({ status: "unreachable" });
      return;
    }
    checking = true;
    const asked = reconnects;
    void checkApiCompatibility(k, options.supportedRange)
      .then((result) => {
        // Asked before the latest reconnect: it answers for a server this page may no longer be talking to (the rerun decides).
        if (!k.disposed && asked === reconnects) answered(result);
      })
      .finally(() => {
        checking = false;
        if (again) {
          again = false;
          checkCompatibility();
        }
      });
  };
  /**
   * A reconnect: the last `supported` answer no longer admits a write (the fact is `unknown` until a check asked from now on answers), and
   * that check is asked. A pause (`unsupported`, `missing`) or `unreachable` already admits nothing and stays as it is until the answer.
   */
  const revalidate = () => {
    if (k.disposed) return;
    reconnects += 1;
    if (compat.get().status === "supported") compat.set({ status: "unknown" });
    checkCompatibility();
  };
  /** A return to the page asks again only when the last answer is old enough (a focus is not a reason to ask on its own). */
  const recheckIfStale = () => {
    // An answer on its way is a fresh one: a return to the page during it asks for nothing more.
    if (checking) return;
    if (ports.clock.now() - lastAnswerAt >= config.compatRecheckMinIntervalMs)
      checkCompatibility();
  };

  let started = false;
  const session: Session = {
    bootId: k.bootId,
    notices: k.notices,
    dismissNotice(id) {
      k.notices.set(k.notices.get().filter((notice) => notice.id !== id));
    },
    async start(startOptions) {
      if (started) return;
      started = true;
      startOptions?.beforeStart?.();
      const { page } = ports;
      k.cleanups.push(
        page.on("hidden", () => {
          applyLevel0Gate(k);
          attempts.abortActivation();
        }),
        page.on("pagehide", () => {
          applyLevel0Gate(k);
          attempts.abortActivation();
        }),
        page.on("visible", () => {
          recheckIfStale();
          void evaluate(k, "visible");
        }),
        page.on("pageshow", () => {
          recheckIfStale();
          void evaluate(k, "pageshow");
        }),
        page.on("focus", () => {
          recheckIfStale();
          void evaluate(k, "focus");
        }),
        page.on("resume", () => {
          recheckIfStale();
          void evaluate(k, "resume");
        }),
        page.on("online", () => {
          k.nudge();
          // Every reconnect asks again (WEB-03 3.9a), and admits no queued write until it has its answer: the server may have been upgraded
          // while this page could not reach it. FIRST, before anything below can wake a sender.
          revalidate();
          void evaluate(k, "online");
          void attempts.resolve();
          operations.resume();
        }),
        page.on("offline", () => void evaluate(k, "offline")),
        ports.hints.subscribe(onHint),
        cancelRetry,
        k.view.subscribe(() => {
          if (k.view.get().kind === "displaying") resumeVerification();
        }),
      );
      // WEB-08c revision 4 (R9 of the review of 14 October 2026; design assessment P3, invariant 4): a visible page that shows recovery
      // state 2 or 3 is scanned too, so the recovery's completion (its fence cleared) is learned from the page's OWN record read within
      // one scan interval even when every hint is lost. A read only: display still needs the exposure protocol; a hidden page reads nothing.
      const scan = () => {
        if (k.disposed) return;
        const view = k.view.get();
        if (
          ports.page.isVisible() &&
          (k.memory.display.kind === "displaying" ||
            (view.kind === "neutral" && /^[23]$/.test(view.state)))
        )
          void evaluate(k, "scan");
        ports.clock.setTimeout(scan, config.scanIntervalMs);
      };
      ports.clock.setTimeout(scan, config.scanIntervalMs);
      await evaluate(k, "boot");
      checkCompatibility();
      await wipe.recoverPending();
    },
    dispose() {
      k.disposed = true;
      for (const cleanup of k.cleanups.splice(0)) cleanup();
      k.memory.exposure?.cancel("disposed");
      for (const set of [...k.memory.unsent.values()])
        for (const activity of [...set]) activity.cancel("disposed");
      k.nudge();
    },
    view: k.view as Store<ReturnType<typeof k.view.get>>,
    identity: k.identity,
    api,
    attempts: attempts as Attempts,
    operations: operations as Operations,
    recovery: recovery as Recovery,
    wipe: wipe as Wipe,
    compat,
    recheckCompatibility: () => checkCompatibility(),
    actions,
    persistence: {
      hold: (account, epoch) => holdForPersistence(k, account, epoch),
    },
  };
  void formatRange;
  return { session, kernel: k };
}
