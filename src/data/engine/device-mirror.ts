import type { Identity, Store } from "../../session";
import type { AccountId, Epoch } from "../model/types";
import { recordDeviceVerification } from "../plans/profile";
import type { AccountService } from "./account-service";
import {
  followIdentity,
  type IdentityTaskDeps,
  type ReadResult,
  type TaskOutcome,
  unreadOutcome,
} from "./identity-task";

/**
 * The device mirror (plan 5.8, W13). Once per `(account, epoch)` while online, the current-device row of the sessions list yields
 * `device_id`; `recordDeviceVerification` writes `device_id`, `device_verified: true` and `device_verified_for` in one guarded
 * transaction. A failed or stale attempt leaves the stored fields exactly as they were. The reminder-timer re-derivation half of
 * D's reconcile is WEB-14b's.
 *
 * With no database open there is nothing to mirror into, so nothing is asked of the server: the mirror waits for the database (or
 * `online`, or a new epoch). A failed read is retried inside the data layer's per-caller budget (`followIdentity`), never by the
 * session's identity notifications.
 */
export interface DeviceMirrorDeps
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
  /** `session.operations.listSessions()` classified: the `device_id` of the row with `current: true` (see `ReadResult`). */
  currentDeviceId(): Promise<ReadResult<string>>;
  /** The OPEN service of an account (never opens or creates one). */
  service(account: AccountId): AccountService | null;
  clock: { now(): number; random?(): number };
}

export function startDeviceMirror(deps: DeviceMirrorDeps): () => void {
  const mirror = async (identity: Identity): Promise<TaskOutcome> => {
    const service = deps.service(identity.account_id);
    // No database yet: there is nothing to mirror into, and this never creates one. Tried again when it exists.
    if (!service?.live) return "wait";
    const result = await deps.currentDeviceId();
    if (result.kind !== "ok") return unreadOutcome(result);
    const epoch: Epoch = identity.epoch;
    const out = await service.commit(recordDeviceVerification, {
      captured: service.capture(epoch),
      deviceId: result.value,
    });
    if (out.kind === "applied") return "done";
    // A drop or a failure writes nothing and the fields stay as they were. Neither is an answer of the server, so neither is counted
    // as a failed read. A failed write, and an identity that could not be verified in time (nothing was decided), are asked again a
    // few times; any other drop means the identity or the database moved on, and a new identity or a database that opens asks afresh.
    return out.kind === "failed" || out.reason === "unverified"
      ? "quiet"
      : "wait";
  };
  return followIdentity({
    caller: "device",
    identity: deps.identity,
    online: deps.online,
    onOnline: deps.onOnline,
    service: deps.service,
    clock: deps.clock,
    ...(deps.onService ? { onService: deps.onService } : {}),
    ...(deps.databasePending ? { databasePending: deps.databasePending } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.config ? { config: deps.config } : {}),
    run: mirror,
  }).stop;
}
