import { recogniseAtlasError } from "../../lib/api-client/problem";
import { apiUrl } from "../../lib/api-client/wire";
import type {
  AccountSummary,
  DeviceRow,
  DevicesRead,
  OperationStart,
  Operations,
  Result,
  SessionSummary,
  Store,
} from "../api";
import { LOCKS } from "../constants";
import { raiseOperationFence } from "../model/reducers/operation";
import type {
  AccountId,
  AuthRecords,
  Envelope,
  Epoch,
  OperationId,
  SessionId,
} from "../model/types";
import type { LocalWorkSummary } from "../ports/deletion";
import { runClosingTransaction } from "./closing";
import { readRecords } from "./evaluate";
import { beginClosing, endClosing } from "./expose";
import { readIdentity } from "./identity";
import {
  classify403,
  cleanRelease,
  detectInvalidation,
  holdIdFor,
  type InFlight,
  recordAndHold,
  releaseHoldAndReevaluate,
  surrenderLock,
} from "./observation";
import {
  handleOrdinaryAnswer,
  type OrdinaryAnswer,
  releaseResponse,
  sealResult,
  send,
} from "./send";
import { type Kernel, MutableStore } from "./state";
import { StampedRequestError } from "./types";
import type { WipeService } from "./wipe";

/**
 * Self-revoking paths (matrix 3.5): explicit logout, self-retirement, password change and OIDC unlink. None of them
 * sets or clears the cookie (G1). Logout and retirement carry an operation ID as an `Idempotency-Key`, an immutable
 * envelope written in the SAME transaction as the fence, and are re-sent from the envelope ALONE.
 */
type OperationAnswer =
  | {
      kind: "outcome";
      outcome: "confirmed_applied" | "superseded" | "rejected_stale";
      inflight: InFlight;
    }
  | { kind: "auth_state" }
  | { kind: "unresolved"; status: number | null };

/** The request rebuilt from the envelope alone: the identical path, key and state token. Nothing is re-derived. */
export function requestFromEnvelope(envelope: Envelope): Request {
  if (envelope.op === "logout")
    return new Request(
      apiUrl(`/sessions/${encodeURIComponent(envelope.target.session_id)}`),
      {
        method: "DELETE",
        headers: { "Idempotency-Key": envelope.operation_id },
      },
    );
  return new Request(
    apiUrl(`/devices/${encodeURIComponent(envelope.target.device_id)}`),
    {
      method: "DELETE",
      headers: {
        "Idempotency-Key": envelope.operation_id,
        "Atlas-Device-State": envelope.state_token,
      },
    },
  );
}

/**
 * The handler for a logout or retirement call's answer. A response is applied ONLY if its `operation_id` and
 * `account_id` equal the envelope's. `401` is an observation (O9), never an outcome; `204`, `404`, `422`, other
 * `4xx`, `5xx` and network errors are not outcomes either: absence of the session, an expired session or a fresh
 * session is never confirmation (B7).
 */
export async function handleOperationAnswer(
  k: Kernel,
  inflight: InFlight,
  response: Response,
  envelope: Envelope,
): Promise<OperationAnswer> {
  const surrendered = surrenderLock(k, inflight, response.status);
  detectInvalidation(k, inflight, surrendered);
  const holdId = holdIdFor(inflight.lease);
  const unresolved = (): OperationAnswer => {
    cleanRelease(k, inflight);
    releaseHoldAndReevaluate(k, inflight.account, holdId);
    return { kind: "unresolved", status: response.status };
  };
  if (response.status === 401) {
    void recordAndHold(k, {
      obs_id: k.ports.ids.uuid(),
      lease_id: inflight.lease,
      account: inflight.account,
      epoch: inflight.epoch,
      kind: "unauthenticated",
      hold_id: holdId,
    });
    return { kind: "auth_state" };
  }
  if (response.status === 403) {
    if ((await classify403(response)) === "credential_mismatch") {
      void recordAndHold(k, {
        obs_id: k.ports.ids.uuid(),
        lease_id: inflight.lease,
        account: inflight.account,
        epoch: inflight.epoch,
        kind: "credential_mismatch",
        hold_id: holdId,
      });
      return { kind: "auth_state" };
    }
    return unresolved();
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    body =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  const matches =
    body !== null &&
    body.operation_id === envelope.operation_id &&
    body.account_id === envelope.account_id;
  if (response.status === 200 && matches) {
    if (body?.outcome === "confirmed_applied" || body?.outcome === "superseded")
      return { kind: "outcome", outcome: body.outcome, inflight };
  }
  if (
    response.status === 409 &&
    matches &&
    body?.outcome === "rejected_stale"
  ) {
    const atlas = recogniseAtlasError(
      response.headers.get("content-type"),
      body,
    );
    if (atlas !== null || body.code === "operation_conflict")
      return { kind: "outcome", outcome: "rejected_stale", inflight };
  }
  return unresolved();
}

/**
 * One stamped ordinary request, answered through the two validations a public call needs. A clean answer first passes
 * `releaseResponse`, the boundary every stamped request shares with the typed client: its body is read there (unless the
 * caller needs only the status) and the answer is handed on only if the durable record still names the identity the call was
 * made under (G4). The call's own decode (`read`) is asynchronous too, and it runs AFTER that, so the result is validated a
 * second time, at the record, after the last decode (`sealResult`): nothing that can be overtaken by another page's
 * transition remains between the verdict and the promise the application holds. `closed` means the identity moved on, at
 * either check: the answer belongs to an identity that is no longer settled, and nothing of it is returned. The surrender,
 * hold and lease retirement of the answer's first step (`handleOrdinaryAnswer`) run before, and unchanged, for a
 * self-revoking answer too. A call that needs only the status (`readBody: false`) decodes nothing, so the first check is
 * its last.
 */
export async function ordinaryCall<T>(
  k: Kernel,
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
    selfRevoking?: "password" | "unlink";
    /** False for a call that needs only the status: the body is discarded, not read. Default true. */
    readBody?: boolean;
  },
  read: (response: Response) => Result<T> | Promise<Result<T>>,
): Promise<Result<T>> {
  const identity = k.identity.get();
  if (!identity) return { ok: false, error: "not_sent" };
  const request = new Request(apiUrl(path), {
    method,
    headers: {
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const outcome = await send<OrdinaryAnswer>(k, {
    klass: "ordinary",
    account: identity.account_id,
    epoch: identity.epoch,
    request,
    selfRevoking: options.selfRevoking,
    onAnswer: handleOrdinaryAnswer,
  });
  switch (outcome.kind) {
    case "answered": {
      if (outcome.value.kind !== "response")
        return { ok: false, error: "auth_state" };
      try {
        const released = await releaseResponse(
          k,
          identity.account_id,
          identity.epoch,
          outcome.value.response,
          { readBody: options.readBody },
        );
        const result = read(released);
        return options.readBody === false
          ? await result
          : await sealResult(k, identity.account_id, identity.epoch, result);
      } catch (error) {
        // `stale`: the identity moved on, so the answer is not for this caller. Anything else is the body's read: the
        // connection dropped after the headers.
        return {
          ok: false,
          error: error instanceof StampedRequestError ? "closed" : "offline",
        };
      }
    }
    case "failed":
      return { ok: false, error: "offline" };
    case "closed":
    case "closed_unresolved":
    case "stale":
      return { ok: false, error: "closed" };
    default:
      return { ok: false, error: "not_sent" };
  }
}

export async function jsonResult<T>(
  response: Response,
  check: (value: unknown) => T | null,
): Promise<Result<T>> {
  if (!response.ok) {
    let atlas = null;
    try {
      atlas = recogniseAtlasError(
        response.headers.get("content-type"),
        await response.json(),
      );
    } catch {
      atlas = null;
    }
    return {
      ok: false,
      error: "http",
      status: response.status,
      atlasError: atlas ?? undefined,
    };
  }
  try {
    const parsed = check(await response.json());
    return parsed === null
      ? { ok: false, error: "http", status: response.status }
      : { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "http", status: response.status };
  }
}

export interface PendingOperation {
  account_id: AccountId;
  op: "logout" | "retire_device";
  operation_id: OperationId;
}

export class OperationService implements Operations {
  private readonly driving = new Set<OperationId>();
  /**
   * An operation that cannot proceed until something changes (a re-authentication for its account, connectivity, the
   * settled account) is not re-driven by the record's next read: it would loop. The signature says what it waited on.
   */
  private readonly blocked = new Map<OperationId, string>();
  private readonly pendingStore = new MutableStore<readonly PendingOperation[]>(
    [],
  );
  readonly pending: Store<readonly PendingOperation[]> = this.pendingStore;

  constructor(
    private readonly k: Kernel,
    private readonly wipe: WipeService,
  ) {}

  async summariseLocalWork(): Promise<LocalWorkSummary | null> {
    const identity = this.k.identity.get();
    if (!identity) return null;
    try {
      return await this.k.ports.deletion.localWork.summarise(
        identity.account_id,
      );
    } catch {
      return null;
    }
  }

  // ---- initiation ------------------------------------------------------------------------------------------------
  logout(confirmation: {
    unsynced: LocalWorkSummary;
  }): Promise<OperationStart> {
    return this.initiate({ op: "logout", unsynced: confirmation.unsynced });
  }

  retireThisDevice(confirmation: {
    read: DeviceRow;
    unsynced: LocalWorkSummary;
  }): Promise<OperationStart> {
    // SA-05: the device flagged `current: true` in the SAME read that supplied the token.
    if (!confirmation.read.current)
      return Promise.resolve({ kind: "refused", reason: "no_current_device" });
    // Retirement is online-only to initiate: it rests on a fresh read of the approved device state.
    if (!this.k.ports.page.isOnline())
      return Promise.resolve({ kind: "refused", reason: "offline" });
    return this.initiate({
      op: "retire_device",
      unsynced: confirmation.unsynced,
      device: confirmation.read,
    });
  }

  private async initiate(input: {
    op: "logout" | "retire_device";
    unsynced: LocalWorkSummary;
    device?: DeviceRow;
  }): Promise<OperationStart> {
    const { k } = this;
    const identity = k.identity.get();
    if (!identity) return { kind: "refused", reason: "not_settled" };
    const account = identity.account_id;
    const operationId = k.ports.ids.uuid();
    // D-18: the draft-write fence precedes the fence and the network call; a changed recount returns `reconfirm`.
    try {
      await k.ports.deletion.coordination.setDraftFence(account, operationId);
      const recount = await k.ports.deletion.localWork.summarise(account);
      if (recount.digest !== input.unsynced.digest) {
        await k.ports.deletion.coordination.releaseFence(account, operationId);
        return { kind: "reconfirm", unsynced: recount };
      }
    } catch {
      return { kind: "refused", reason: "storage_unavailable" };
    }
    const raised = await this.operationFenceClosingWrite(
      account,
      identity.epoch,
      operationId,
      input,
    );
    if (raised.kind !== "fenced") {
      await this.release(account, operationId);
      return raised.outcome;
    }
    k.ports.hints.post({ type: "auth_state_changed" });
    void k.hooks.evaluate("operation_fenced");
    void this.drive(account, raised.envelope);
    return { kind: "started", operation_id: operationId };
  }

  /** A closing write: its FIRST statement is `beginClosing()` (lint rule R8). */
  private async operationFenceClosingWrite(
    account: AccountId,
    epoch: Epoch,
    operationId: OperationId,
    input: { op: "logout" | "retire_device"; device?: DeviceRow },
  ): Promise<
    | { kind: "fenced"; envelope: Envelope }
    | { kind: "failed"; outcome: OperationStart }
  > {
    beginClosing(this.k);
    try {
      const base = {
        account_id: account,
        epoch,
        operation_id: operationId,
        obs_id: this.k.ports.ids.uuid(),
        now: this.k.ports.clock.iso(),
      };
      const closing = await runClosingTransaction(this.k, {
        holdsAuth: false,
        label: "closing:operation",
        body: (records) =>
          input.op === "logout" || !input.device
            ? raiseOperationFence(records, { ...base, op: "logout" })
            : raiseOperationFence(records, {
                ...base,
                op: "retire_device",
                device_id: input.device.id,
                state_token: input.device.state_token,
                summary: input.device.summary,
              }),
      });
      // `abandoned` needs `abandonIf`, which an operation never passes; it is handled as a give-up for completeness.
      if (
        closing.kind === "lock_timeout" ||
        closing.kind === "gave_up" ||
        closing.kind === "abandoned"
      )
        return {
          kind: "failed",
          outcome: { kind: "refused", reason: "closing_write_gave_up" },
        };
      if (closing.kind === "failed")
        return {
          kind: "failed",
          outcome: { kind: "refused", reason: "storage_unavailable" },
        };
      if (closing.value.kind === "REFUSED")
        return {
          kind: "failed",
          outcome: { kind: "refused", reason: closing.value.reason },
        };
      return { kind: "fenced", envelope: closing.value.envelope };
    } finally {
      endClosing(this.k);
    }
  }

  private async release(
    account: AccountId,
    operationId: OperationId,
  ): Promise<void> {
    try {
      await this.k.ports.deletion.coordination.releaseFence(
        account,
        operationId,
      );
    } catch {
      // The fence is released by its owner's next scan.
    }
  }

  // ---- the driver: send from the envelope ALONE --------------------------------------------------------------------
  /** Re-drives every operation fence: at boot, on `online`, on becoming visible, after a settlement. */
  resume(options: { force?: boolean } = {}): void {
    const { k } = this;
    const record = k.lastRecord;
    if (!record) return;
    if (options.force) this.blocked.clear();
    const signature = this.signature(record.settled);
    const found: PendingOperation[] = [];
    for (const [account, list] of Object.entries(record.fences)) {
      for (const fence of list) {
        if (fence.kind === "operation") {
          found.push({
            account_id: account,
            op: fence.envelope.op,
            operation_id: fence.envelope.operation_id,
          });
          if (this.blocked.get(fence.envelope.operation_id) !== signature)
            void this.drive(account, fence.envelope);
        }
      }
    }
    this.pendingStore.set(found);
  }

  private signature(
    settled: { account_id: AccountId; epoch: Epoch } | null,
  ): string {
    return `${this.k.ports.page.isOnline()}|${settled?.account_id ?? "-"}|${settled?.epoch ?? "-"}`;
  }

  async drive(account: AccountId, envelope: Envelope): Promise<void> {
    const { k } = this;
    if (this.driving.has(envelope.operation_id) || k.disposed) return;
    this.driving.add(envelope.operation_id);
    // D-17: at most one page at a time; correctness never depends on this lock (the ledger makes a duplicate harmless).
    const liveness = await k.ports.locks.tryAcquire(
      LOCKS.operation(envelope.operation_id),
    );
    if (liveness === null) {
      this.driving.delete(envelope.operation_id);
      return;
    }
    try {
      for (let attempt = 0; !k.disposed; attempt += 1) {
        if (!k.ports.page.isOnline()) {
          this.blocked.set(
            envelope.operation_id,
            this.signature(k.lastRecord?.settled ?? null),
          );
          return;
        }
        const records: AuthRecords | null = await readRecords(k);
        if (records === null) {
          await k.sleep(k.backoff(attempt));
          continue;
        }
        const stillFenced = (records.auth_state.fences[account] ?? []).some(
          (fence) =>
            fence.kind === "operation" &&
            fence.envelope.operation_id === envelope.operation_id,
        );
        if (!stillFenced) return;
        const settled = records.auth_state.settled;
        // (3) A different account (or none) is settled: send nothing under its credentials; X stays hidden and paused.
        if (!settled || settled.account_id !== account) {
          this.blocked.set(envelope.operation_id, this.signature(settled));
          return;
        }
        // (1) If a leased `current()` answers 200 for this account, send the identical call at once.
        const probe = await readIdentity(k, account, settled.epoch, {
          kind: "general",
          expectClear: false,
        });
        // (2) On 401 (an observation), state 1a waits for a re-authentication for that account; then it runs again.
        if (probe.kind === "observation" || probe.kind === "stale") {
          // State 1a waits for a re-authentication for that account; a new settlement changes the signature.
          this.blocked.set(envelope.operation_id, this.signature(settled));
          return;
        }
        if (probe.kind !== "ok") {
          const elapsed = await k.sleep(k.backoff(attempt));
          if (!elapsed) attempt = -1;
          continue;
        }
        k.neutral = { ...k.neutral, operationCallInFlight: true };
        void k.hooks.evaluate("operation_sending");
        const sent = await send<OperationAnswer>(k, {
          klass: "operation",
          account,
          epoch: settled.epoch,
          request: requestFromEnvelope(envelope),
          selfRevoking: envelope.op === "logout" ? "logout" : "retire",
          operationId: envelope.operation_id,
          onAnswer: (kernel, inflight, response) =>
            handleOperationAnswer(kernel, inflight, response, envelope),
        });
        k.neutral = { ...k.neutral, operationCallInFlight: false };
        if (sent.kind === "answered") {
          if (sent.value.kind === "outcome") {
            await this.apply(
              account,
              envelope,
              sent.value.outcome,
              sent.value.inflight,
            );
            return;
          }
          if (sent.value.kind === "auth_state") {
            this.blocked.set(envelope.operation_id, this.signature(settled));
            return;
          }
        }
        if (sent.kind === "closed" || sent.kind === "stale") {
          this.blocked.set(envelope.operation_id, this.signature(settled));
          return;
        }
        const elapsed = await k.sleep(k.backoff(attempt));
        if (!elapsed) attempt = -1;
      }
    } finally {
      liveness.release();
      this.driving.delete(envelope.operation_id);
      if (k.neutral.operationCallInFlight) {
        k.neutral = { ...k.neutral, operationCallInFlight: false };
        void k.hooks.evaluate("operation_driver_done");
      }
    }
  }

  private async apply(
    account: AccountId,
    envelope: Envelope,
    outcome: "confirmed_applied" | "superseded" | "rejected_stale",
    inflight: InFlight,
  ): Promise<void> {
    const { k } = this;
    const holdId = holdIdFor(inflight.lease);
    try {
      if (outcome === "confirmed_applied") {
        // Row 1/2: the canonical wipe runs to its own step 5, and THEN 3.5.4 is applied in the same procedure.
        await this.wipe.run(account, envelope.operation_id, {
          callLease: inflight.lease,
          create: "operation",
        });
        return;
      }
      await this.wipe.complete(
        account,
        envelope.operation_id,
        outcome,
        inflight.lease,
      );
      await this.release(account, envelope.operation_id);
      if (outcome === "rejected_stale")
        k.neutral = { ...k.neutral, notice: "1a.device_changed" };
    } finally {
      k.memory.releaseHold(account, holdId);
      k.ports.hints.post({ type: "auth_state_changed" });
      void k.hooks.evaluate("operation_applied");
    }
  }

  // ---- ordinary self-revoking and list calls ---------------------------------------------------------------------
  private ordinary<T>(
    method: string,
    path: string,
    options: Parameters<typeof ordinaryCall>[3],
    read: (response: Response) => Result<T> | Promise<Result<T>>,
  ): Promise<Result<T>> {
    return ordinaryCall(this.k, method, path, options, read);
  }

  private json<T>(
    response: Response,
    check: (value: unknown) => T | null,
  ): Promise<Result<T>> {
    return jsonResult(response, check);
  }

  readDevices(): Promise<Result<DevicesRead>> {
    return this.ordinary("GET", "/devices", {}, (response) =>
      this.json(response, (value) => {
        const devices = (value as { devices?: unknown } | null)?.devices;
        return Array.isArray(devices)
          ? { devices: devices as DeviceRow[] }
          : null;
      }),
    );
  }

  listSessions(): Promise<Result<{ sessions: readonly SessionSummary[] }>> {
    return this.ordinary("GET", "/sessions", {}, (response) =>
      this.json(response, (value) => {
        const sessions = (value as { sessions?: unknown } | null)?.sessions;
        return Array.isArray(sessions)
          ? { sessions: sessions as SessionSummary[] }
          : null;
      }),
    );
  }

  async revokeOtherSession(id: SessionId): Promise<Result<"revoked" | "gone">> {
    const identity = this.k.identity.get();
    // The current session ends only through `logout`, which raises a fence and an envelope first.
    if (identity && identity.session_id === id)
      return { ok: false, error: "closed" };
    return this.ordinary(
      "DELETE",
      `/sessions/${encodeURIComponent(id)}`,
      { readBody: false },
      (response): Result<"revoked" | "gone"> => {
        if (response.status === 204) return { ok: true, value: "revoked" };
        if (response.status === 404) return { ok: true, value: "gone" };
        return { ok: false, error: "http", status: response.status };
      },
    );
  }

  async retireOtherDevice(
    read: DeviceRow,
  ): Promise<Result<"confirmed_applied" | "superseded" | "rejected_stale">> {
    // SA-10: an ordinary request with a fresh key; no fence and no wipe (it cannot revoke this session).
    const operationId = this.k.ports.ids.uuid();
    return this.ordinary(
      "DELETE",
      `/devices/${encodeURIComponent(read.id)}`,
      {
        headers: {
          "Idempotency-Key": operationId,
          "Atlas-Device-State": read.state_token,
        },
      },
      async (
        response,
      ): Promise<
        Result<"confirmed_applied" | "superseded" | "rejected_stale">
      > => {
        let body: Record<string, unknown> | null = null;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          body = null;
        }
        const outcome = body?.outcome;
        if (
          (response.status === 200 &&
            (outcome === "confirmed_applied" || outcome === "superseded")) ||
          (response.status === 409 && outcome === "rejected_stale")
        )
          return { ok: true, value: outcome };
        return { ok: false, error: "http", status: response.status };
      },
    );
  }

  changePassword(input: {
    current: string;
    next: string;
  }): Promise<Result<"changed">> {
    return this.ordinary(
      "POST",
      "/password",
      {
        body: { current_password: input.current, new_password: input.next },
        selfRevoking: "password",
        readBody: false,
      },
      (response): Result<"changed"> =>
        response.status >= 200 && response.status < 300
          ? { ok: true, value: "changed" }
          : { ok: false, error: "http", status: response.status },
    );
  }

  /** `GET /me`: an ordinary stamped read that shares `listSessions`' decode path, so it is released and sealed the same way. */
  readAccount(): Promise<Result<AccountSummary>> {
    return this.ordinary("GET", "/me", {}, (response) =>
      this.json(response, (value) => {
        if (typeof value !== "object" || value === null) return null;
        const body = value as Record<string, unknown>;
        const issuers = body.oidc_issuers;
        if (
          typeof body.id !== "string" ||
          typeof body.username !== "string" ||
          typeof body.has_password !== "boolean" ||
          !Array.isArray(issuers) ||
          !issuers.every((issuer) => typeof issuer === "string")
        )
          return null;
        return {
          id: body.id,
          username: body.username,
          has_password: body.has_password,
          oidc_issuers: [...issuers] as string[],
        };
      }),
    );
  }

  unlinkOidc(issuer: string): Promise<Result<"unlinked">> {
    return this.ordinary(
      "DELETE",
      "/oidc/identities",
      { body: { issuer }, selfRevoking: "unlink", readBody: false },
      (response): Result<"unlinked"> =>
        response.status >= 200 && response.status < 300
          ? { ok: true, value: "unlinked" }
          : { ok: false, error: "http", status: response.status },
    );
  }
}
