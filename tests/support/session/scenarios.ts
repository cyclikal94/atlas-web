import { type FakePage, Fixture } from "./harness";
import type { LogEntry } from "./world";

/** Shared scenario builders for the fake-world suites. */
export interface SignedIn {
  fixture: Fixture;
  page: FakePage;
  account: string;
  epoch: number;
  sessionId: string;
}

export async function newWorld(
  options: ConstructorParameters<typeof Fixture>[0] = {},
): Promise<Fixture> {
  const fixture = new Fixture(options);
  fixture.server.addAccount("kieran", "pw");
  fixture.server.addAccount("sam", "pw2");
  return fixture;
}

/** Boot a page, sign `username` in through the password path, and let it display. */
export async function signedInPage(
  fixture: Fixture,
  username = "kieran",
  password = "pw",
): Promise<SignedIn> {
  const page = fixture.addPage();
  await fixture.boot(page);
  const outcome = await fixture.signIn(page, username, password);
  if (outcome.kind !== "settled")
    throw new Error(`sign-in did not settle: ${JSON.stringify(outcome)}`);
  await fixture.settle();
  const identity = page.session.identity.get();
  if (!identity) throw new Error("no identity after sign-in");
  return {
    fixture,
    page,
    account: identity.account_id,
    epoch: identity.epoch,
    sessionId: identity.session_id,
  };
}

/** A further page of the same origin, booted; it exposes the settled account by itself. */
export async function openPage(fixture: Fixture): Promise<FakePage> {
  const page = fixture.addPage();
  await fixture.boot(page);
  return page;
}

export const logsOf = (fixture: Fixture, type: string): LogEntry[] =>
  fixture.world.logs.filter((entry) => entry.type === type);

/** A stamped ordinary GET through a page's API wrapper. */
export function ordinaryGet(
  page: FakePage,
  account: string,
  epoch: number,
  path = "/probe",
): Promise<Response> {
  const fetchFor = page.session.api.fetchFor("ordinary", account, epoch);
  return fetchFor(
    new Request(new URL(`/api/experimental/v1${path}`, "http://localhost")),
  );
}

export const stateOf = (fixture: Fixture) => fixture.store.records.auth_state;

import { createWebLocksPort } from "../../../src/session/adapters/web-locks";
import { sha256Base64url } from "./env";

/**
 * Hold a lock from a page that is not a session (for example a frozen tab inside its `atlas-auth` callback, which the
 * platform is not required to release). Returns the release.
 */
export async function holdLock(
  fixture: Fixture,
  holder: string,
  name: string,
): Promise<() => void> {
  fixture.world.registerPage(holder);
  const port = createWebLocksPort(fixture.locks.forPage(holder));
  const pending = port.acquire(name);
  await fixture.world.runUntilIdle();
  const handle = await pending;
  if (!handle) throw new Error(`could not hold ${name}`);
  return () => handle.release();
}

/** Write an attempt straight into the shared record (test set-up between runs, with the world idle). */
export function installAttempt(
  fixture: Fixture,
  attempt: {
    epoch: number;
    phase:
      | "exchanging"
      | "redirected"
      | "activating"
      | "indeterminate"
      | "verifying";
    verifier?: string;
    marker?: number | null;
    target?: string | null;
    cancel?: "not_activated" | "session_revoked" | "unknown" | null;
    /** Give the server a grant so that `activate/cancel` finds it. */
    serverGrant?: {
      account: string;
      state: "issued" | "redeemed" | "cancelled";
      session?: string | null;
    };
  },
): string {
  const verifier = attempt.verifier ?? "v".repeat(43);
  const state = fixture.store.records.auth_state;
  state.latest_epoch = Math.max(state.latest_epoch, attempt.epoch);
  state.attempt = {
    epoch: attempt.epoch,
    method: "password",
    phase: attempt.phase,
    previous_account_id: state.settled?.account_id ?? null,
    target_account_id: attempt.target ?? null,
    verifier,
    observations_deferred: attempt.marker ?? null,
    cancel_result:
      attempt.cancel ?? (attempt.phase === "verifying" ? "unknown" : null),
    started_at: "2026-09-30T12:00:00.000Z",
    expires_at: "2026-09-30T12:01:30.000Z",
  };
  if (attempt.marker != null)
    state.fence_seq = Math.max(state.fence_seq, attempt.marker);
  if (attempt.serverGrant) {
    fixture.server.grants.set(`grant-${attempt.epoch}`, {
      grant: `grant-${attempt.epoch}`,
      account: attempt.serverGrant.account,
      device: "dev",
      challenge: sha256Base64url(verifier),
      state: attempt.serverGrant.state,
      wrongVerifiers: 0,
      session: attempt.serverGrant.session ?? null,
    });
  }
  return verifier;
}

/** Hold the server's answers to matching requests (`Da` unbounded) until `release()`. */
export function holdAnswers(
  fixture: Fixture,
  match: (r: {
    method: string;
    path: string;
    ordinal: number;
    page: string;
  }) => boolean,
): { release: () => number; stop: () => void } {
  const stop = fixture.server.addRule({ match, delay: "unbounded" });
  return {
    release: () => fixture.world.release("Da"),
    stop,
  };
}

export const fencesOf = (fixture: Fixture, account: string) =>
  (fixture.store.records.auth_state.fences[account] ?? []).map(
    (fence) => fence.kind,
  );
export const leaseIds = (fixture: Fixture) =>
  Object.keys(fixture.store.records.auth_state.leases);

/** The attempt record, which a test has already established exists. */
export function attemptOf(fixture: Fixture) {
  const attempt = fixture.store.records.auth_state.attempt;
  if (!attempt) throw new Error("no attempt in the record");
  return attempt;
}
/** The fences of an account, which a test has already established exist. */
export function fenceList(fixture: Fixture, account: string) {
  return fixture.store.records.auth_state.fences[account] ?? [];
}
