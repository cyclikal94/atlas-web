import type { Trace } from "../../session";
import type { SyncChannel } from "../engine/sync-channel";
import { DATA_CONFIG } from "../model/config";
import {
  EMPTY_DIGEST,
  NO_CONSENT_DIGEST,
  UNREADABLE_BASELINE,
  UNREADABLE_LIVE,
  UNREADABLE_SUMMARY,
} from "../model/local-work";
import type { AccountId } from "../model/types";
import {
  readBaseline,
  releaseFence,
  setClosing,
  setDraftFence,
  summariseWork,
} from "../plans/fence";
import type { AccountStore } from "../store/port";
import type { ConnectionRegistry } from "../store/registry";
import type { LocalWorkPort, WipeCoordinationPort } from "./types";

/**
 * `LocalWorkPort` and `WipeCoordinationPort` (plan 5.3.3), over the account's database. Loaded lazily: the small static shims
 * (`deletion-ports.ts`) import this module once, memoised.
 *
 * EVERY method whose caller does not catch a rejection is TOTAL: it never rejects, whatever fault is injected, because
 * `kernel/wipe.ts` does not catch them. Each failure becomes a conservative value that can only lead to a consent prompt, a
 * refused operation or a deletion that waits, never to a deletion: `setClosing` answers `unconfirmed` (R12) and the wipe does not go
 * on without the durable flag. Only `setDraftFence` rejects (`OperationService.initiate()` maps that to
 * `refused/storage_unavailable` and releases).
 *
 * A port opens the account's EXISTING database for the duration of one call, under its OWN registry, so the page's latch (a
 * wipe closes this page's service first) does not refuse it, and closes it straight after. It never creates a database.
 */
export interface PortsImplDeps {
  /** An EXISTING database, one short-lived connection, or null when there is none. The caller closes it. */
  openExisting(account: AccountId): Promise<AccountStore | null>;
  channel: SyncChannel;
  registry: Pick<ConnectionRegistry, "tabId">;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  ids: { uuid(): string };
  trace?: Trace;
  /** The grace in which a tab can answer the presence query. Defaults to `DATA_CONFIG.presenceGraceMs`; a test may use 0. */
  graceMs?: number;
}

interface Closure {
  operationId: string;
  nonce: string;
  queriedAt: number;
  present: Set<string>;
  acked: Set<string>;
  /** Called when a presence or an acknowledgement arrives. */
  wake: (() => void) | null;
}

export function createPortsImpl(deps: PortsImplDeps): {
  localWork: LocalWorkPort;
  coordination: WipeCoordinationPort;
} {
  const closures = new Map<AccountId, Closure>();
  const graceMs = deps.graceMs ?? DATA_CONFIG.presenceGraceMs;

  // The coordinator listens for the answers to its own presence query and for acknowledgements of its own broadcast.
  deps.channel.subscribe((message) => {
    if (message.type !== "presence" && message.type !== "closed_ack") return;
    const closure = closures.get(message.account);
    if (!closure) return;
    if (message.type === "presence") {
      if (message.nonce !== closure.nonce) return;
      closure.present.add(message.tab_id);
    } else {
      closure.acked.add(message.tab_id);
    }
    closure.wake?.();
  });

  async function withStore<T>(
    account: AccountId,
    run: (store: AccountStore) => Promise<T>,
    absent: T,
  ): Promise<T> {
    const store = await deps.openExisting(account);
    if (store === null) return absent;
    try {
      return await run(store);
    } finally {
      store.close();
    }
  }

  const localWork: LocalWorkPort = {
    async summarise(account) {
      try {
        return await withStore(
          account,
          (store) =>
            store.run(summariseWork, { incarnationId: store.incarnationId }),
          { count: 0, items: [], digest: EMPTY_DIGEST },
        );
      } catch {
        deps.trace?.emit("data.summarise_failed");
        // Not a throw: the kernel treats a throw as "the dialog shows nothing", which would hide real work. The digest cannot
        // equal any baseline, so a later recount that CAN read the work differs and the person is shown "Actually N changes".
        return { count: 0, items: [], digest: UNREADABLE_SUMMARY };
      }
    },
  };

  const coordination: WipeCoordinationPort = {
    async setDraftFence(account, operationId) {
      // May reject: `initiate()` maps it to `refused/storage_unavailable`.
      return await withStore(
        account,
        async (store) => {
          const result = await store.run(setDraftFence, {
            incarnationId: store.incarnationId,
            now: deps.clock.now(),
            token: deps.ids.uuid(),
            operationId,
          });
          if (result.kind !== "set")
            throw new Error("the account database has no singleton");
          return { consentDigest: result.consentDigest };
        },
        // No database: there is no local work to fence. (A database created in the instant before the envelope is written
        // is found by the wipe's own `exists`, and `baselineDigest` then answers a digest no live digest can equal.)
        { consentDigest: EMPTY_DIGEST },
      );
    },

    broadcastImminent(account, operationId) {
      // Intent only. `wipe_imminent` is posted by `setClosing` AFTER its transaction completes, so no tab can observe the
      // broadcast while `closing` is still false (RC trace 7 header; D:6997-7000 "in the same transaction that sends the
      // broadcast" cannot be literal, because a broadcast cannot be part of an IndexedDB transaction).
      try {
        const nonce = deps.ids.uuid();
        closures.set(account, {
          operationId,
          nonce,
          queriedAt: deps.clock.now(),
          present: new Set(),
          acked: new Set(),
          wake: null,
        });
        deps.channel.post({ type: "presence_query", account, nonce });
      } catch {
        deps.trace?.emit("data.broadcast_intent_failed");
      }
    },

    async setClosing(account) {
      let confirmed = false;
      try {
        const result = await withStore(
          account,
          (store) =>
            store.run(setClosing, {
              incarnationId: store.incarnationId,
              now: deps.clock.now(),
              token: deps.ids.uuid(),
            }),
          // No database: there is nothing to close.
          { kind: "closing" as const },
        );
        // A singleton that is missing cannot carry the flag: not known to be set.
        confirmed = result.kind === "closing";
      } catch {
        // The transaction failed (an abort, an error, the quota, a database that closed under it).
      }
      if (!confirmed) {
        // Total, and HONEST (R12): the failure is answered, never swallowed, and nothing is announced. `wipe_imminent` says "the flag
        // is set"; a tab that acts on it stops writing and closes, and no tab may observe it while `closing` is still false (RC trace
        // 7). The wipe keeps its entry, its fence and the work, and asks again; a recovery writer that has not heard is excluded only
        // by the flag, and an announcement cannot stand in for it.
        deps.trace?.emit("data.set_closing_failed");
        return "unconfirmed";
      }
      try {
        deps.channel.post({
          type: "wipe_imminent",
          account,
          operation_id: closures.get(account)?.operationId ?? "unknown",
        });
      } catch {
        // The flag is durable, so a hint that was not delivered excludes nothing that the flag does not.
        deps.trace?.emit("data.broadcast_failed");
      }
      return "closing";
    },

    async waitForClosure(account, boundedMs) {
      try {
        const closure = closures.get(account);
        if (!closure) return;
        const settled = (): boolean => {
          if (deps.clock.now() - closure.queriedAt < graceMs) return false;
          for (const tab of closure.present)
            if (!closure.acked.has(tab)) return false;
          return true;
        };
        // Nothing to wait for: no grace and nobody present (or everyone present has already acknowledged).
        if (settled()) return;
        const bound = deps.clock.sleep(boundedMs);
        const grace = deps.clock.sleep(graceMs);
        const done = new Promise<void>((resolve) => {
          const check = (): void => {
            if (settled()) resolve();
          };
          closure.wake = check;
          void grace.then(check);
        });
        await Promise.race([done, bound]);
        closure.wake = null;
      } catch {
        deps.trace?.emit("data.wait_for_closure_failed");
      } finally {
        closures.delete(account);
      }
    },

    async liveDigest(account) {
      try {
        return await withStore(
          account,
          async (store) =>
            (
              await store.run(readBaseline, {
                incarnationId: store.incarnationId,
              })
            ).liveDigest,
          EMPTY_DIGEST,
        );
      } catch {
        return UNREADABLE_LIVE;
      }
    },

    async liveCount(account) {
      try {
        return await withStore(
          account,
          async (store) =>
            (
              await store.run(readBaseline, {
                incarnationId: store.incarnationId,
              })
            ).liveCount,
          0,
        );
      } catch {
        return 0;
      }
    },

    async baselineDigest(account) {
      try {
        return await withStore(
          account,
          async (store) => {
            const read = await store.run(readBaseline, {
              incarnationId: store.incarnationId,
            });
            if (read.fenceDigest !== null) return read.fenceDigest;
            // No fence. `null` ("nothing to consent to") would make the kernel skip the comparison, so work that appears
            // before the closing write would be deleted unasked. An empty database answers the empty digest instead (a live
            // digest that is still empty equals it), and a database with work answers a digest nothing can equal.
            return read.liveCount === 0 ? EMPTY_DIGEST : NO_CONSENT_DIGEST;
          },
          EMPTY_DIGEST,
        );
      } catch {
        return UNREADABLE_BASELINE;
      }
    },

    async releaseFence(account, operationId) {
      try {
        await withStore(
          account,
          (store) =>
            store.run(releaseFence, {
              incarnationId: store.incarnationId,
              operationId,
            }),
          { kind: "noop" as const },
        );
      } catch {
        // Idempotent and ownership-scanning; a failure leaves the fence, which the stale-fence rule clears when it is safe.
        deps.trace?.emit("data.release_fence_failed");
      }
    },
  };

  return { localWork, coordination };
}
