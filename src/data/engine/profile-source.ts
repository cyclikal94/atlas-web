import type { Identity, Store, Trace } from "../../session";
import { parseAccountIdentity } from "../model/identity-bodies";
import type { AccountId, Epoch } from "../model/types";
import { readProfile, writeProfile } from "../plans/profile";
import type { AccountService } from "./account-service";
import {
  followIdentity,
  type IdentityTaskDeps,
  type ReadResult,
  type TaskOutcome,
  unreadOutcome,
} from "./identity-task";

/**
 * The verified profile read (plan 5.8, HO-9, decision D-15). `GET /me` through the stamped client, checked against the account,
 * keeping ONLY `username`. The label is VERIFIED FOR AN EPOCH and is shown only while `verified_epoch === identity.epoch`: a name
 * is never inferred from the opaque account id, and an older epoch's name is never shown for a newer one. It is held in memory and,
 * only when the account database already exists, written through `writeProfile` (which never creates it).
 *
 * A name persisted for the CURRENT epoch is shown without a request as soon as the account's database is open, whether the page is
 * online or not: the database opens a little after the page starts (the controller loads its runtime lazily), so the source reads
 * it when the service appears and not only when it starts. It never opens, and so never creates, a database. A name verified before
 * the database was open is written to it then, if it is the current epoch's and the database does not hold it.
 *
 * A device or session label (BE-Q25, WEB-08d) is a different concept and is not touched here.
 */
export interface VerifiedProfile {
  account: AccountId;
  epoch: Epoch;
  username: string;
}

export interface ProfileSource {
  readonly profile: Store<VerifiedProfile | null>;
  /** The label to show for this identity right now, or null. */
  labelFor(identity: Identity | null): string | null;
  /** Starts following the identity. Returns a function that stops it. */
  start(): () => void;
}

export interface ProfileSourceDeps
  extends Pick<
    IdentityTaskDeps,
    | "online"
    | "onOnline"
    | "onService"
    | "databasePending"
    | "timers"
    | "config"
  > {
  identity: Store<Identity | null>;
  /** `GET /me` through `session.api.client("ordinary", account, epoch)`, classified (see `ReadResult`). */
  readMe(account: AccountId, epoch: Epoch): Promise<ReadResult<unknown>>;
  /** The OPEN service of an account, or null: this source never opens (and so never creates) a database. */
  service(account: AccountId): AccountService | null;
  clock: { now(): number; random?(): number };
  trace?: Trace;
}

export { parseAccountIdentity };

class MutableStore<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createProfileSource(deps: ProfileSourceDeps): ProfileSource {
  const store = new MutableStore<VerifiedProfile | null>(null);

  const isCurrent = (identity: Identity): boolean => {
    const current = deps.identity.get();
    return (
      current?.account_id === identity.account_id &&
      current.epoch === identity.epoch
    );
  };
  const verifiedFor = (identity: Identity): VerifiedProfile | null => {
    const shown = store.get();
    return shown?.account === identity.account_id &&
      shown.epoch === identity.epoch
      ? shown
      : null;
  };

  /** Only if the database already exists; guarded like every response-derived write, and never fatal. */
  const persist = async (
    identity: Identity,
    username: string,
  ): Promise<void> => {
    const service = deps.service(identity.account_id);
    if (!service?.live) return;
    await service
      .commit(writeProfile, {
        captured: service.capture(identity.epoch),
        username,
        now: deps.clock.now(),
      })
      .catch(() => undefined);
  };

  /**
   * Shows the name persisted for THIS epoch (the same sign-in), and writes a name verified before the database was open. It reads
   * only through a service that is open now, and what it read is used only while the identity and that service still stand.
   */
  const hydrate = async (identity: Identity): Promise<void> => {
    const service = deps.service(identity.account_id);
    if (!service?.live) return;
    try {
      const persisted = await service.store.run(readProfile, {
        incarnationId: service.incarnationId,
      });
      if (
        !isCurrent(identity) ||
        !service.live ||
        deps.service(identity.account_id) !== service
      )
        return;
      const verified = verifiedFor(identity);
      if (verified === null) {
        if (persisted !== null && persisted.verified_epoch === identity.epoch)
          store.set({
            account: identity.account_id,
            epoch: persisted.verified_epoch,
            username: persisted.username,
          });
        return;
      }
      if (
        persisted === null ||
        persisted.verified_epoch !== identity.epoch ||
        persisted.username !== verified.username
      )
        await persist(identity, verified.username);
    } catch {
      // Nothing persisted that can be read: the verification is the source.
    }
  };

  const verify = async (identity: Identity): Promise<TaskOutcome> => {
    const result = await deps.readMe(identity.account_id, identity.epoch);
    // The identity may have moved while the request was in flight: an answer for another (account, epoch) is discarded.
    if (!isCurrent(identity)) return "wait";
    if (result.kind !== "ok") return unreadOutcome(result);
    const username = parseAccountIdentity(result.value, identity.account_id);
    if (username === null) {
      // A body that is not the contract's profile (no `username`, one of the wrong type, another account's `id`) is an UNRECOGNISED
      // answer: counted in this caller's budget (three in a row pause it), never a verification, and what the caller already counted
      // stays until a valid answer. The next valid answer verifies.
      deps.trace?.emit("data.profile_rejected");
      return "unrecognised";
    }
    store.set({
      account: identity.account_id,
      epoch: identity.epoch,
      username,
    });
    await persist(identity, username);
    return "done";
  };

  return {
    profile: store,
    labelFor(identity) {
      const verified = store.get();
      if (identity === null || verified === null) return null;
      return verified.account === identity.account_id &&
        verified.epoch === identity.epoch
        ? verified.username
        : null;
    },
    start() {
      const task = followIdentity({
        caller: "profile",
        identity: deps.identity,
        online: deps.online,
        onOnline: deps.onOnline,
        service: deps.service,
        clock: deps.clock,
        ...(deps.onService ? { onService: deps.onService } : {}),
        ...(deps.databasePending
          ? { databasePending: deps.databasePending }
          : {}),
        ...(deps.timers ? { timers: deps.timers } : {}),
        ...(deps.config ? { config: deps.config } : {}),
        run: verify,
      });
      // A name persisted for this epoch shows without a request, online or not: now if the database is open, and when it opens.
      let shownFor: string | null = null;
      const show = (): void => {
        const identity = deps.identity.get();
        if (identity === null) {
          shownFor = null;
          return;
        }
        void hydrate(identity);
      };
      const follow = (): void => {
        const identity = deps.identity.get();
        const key =
          identity === null ? null : `${identity.account_id}:${identity.epoch}`;
        if (key === shownFor) return;
        shownFor = key;
        show();
      };
      const offs = [
        deps.identity.subscribe(follow),
        deps.onService?.(show) ?? (() => undefined),
      ];
      follow();
      return () => {
        task.stop();
        for (const off of offs) off();
      };
    },
  };
}
