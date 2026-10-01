import type { Fixture } from "./harness";
import type { LogEntry } from "./world";

/**
 * The property checkers (plan 13.1), evaluated on the logs AFTER every scenario, exactly as the matrix defines them
 * (section 3.6.3, the model check). They are independent of the kernel: they read only what the fake platform logged.
 */
const of = (logs: LogEntry[], type: string) =>
  logs.filter((entry) => entry.type === type);

interface Commit {
  seq: number;
  page: string;
  label: string;
  lease?: string;
  klass?: string;
}

function commits(logs: LogEntry[]): Commit[] {
  return of(logs, "store.commit")
    .filter((entry) => entry.wrote === true)
    .map((entry) => {
      const result = entry.result as
        | { kind?: string; lease?: string }
        | undefined;
      return {
        seq: entry.seq,
        page: entry.page as string,
        label: entry.label as string,
        lease: result?.kind === "COVERED" ? result.lease : undefined,
      };
    });
}

export interface PropertyOptions {
  /** Statuses that count as an invalidating detection for V1 and V2. */
  invalidating?: number[];
}

export function checkProperties(
  fixture: Fixture,
  options: PropertyOptions = {},
): string[] {
  const { logs } = fixture.world;
  const invalidating = options.invalidating ?? [401];
  const violations: string[] = [];
  if (fixture.world.livelocked)
    violations.push(
      `LIVELOCK: the world log exceeded ${fixture.world.maxLogs} entries`,
    );
  const all = commits(logs);
  const closingCommits = all.filter(
    (commit) =>
      commit.label.startsWith("closing:") &&
      // A retry marker is not a commit of the write.
      (
        logs.find((l) => l.seq === commit.seq)?.result as
          | { retry?: boolean }
          | undefined
      )?.retry !== true,
  );
  const leaseCommit = new Map<string, Commit>();
  for (const commit of all)
    if (commit.lease) leaseCommit.set(commit.lease, commit);

  const surrenders = of(logs, "trace.surrender").filter((entry) =>
    invalidating.includes(entry.status as number),
  );
  const issued = of(logs, "trace.request.issued");
  const attaches = of(logs, "surface.attach");
  const actBegin = of(logs, "trace.act.begin");
  const covered = of(logs, "trace.cover.committed");

  // n (per page) -> lease id of the attempt whose act this is
  const leaseOfActivity = (page: string, n: number): string | undefined =>
    covered.find((entry) => entry.page === page && entry.n === n)?.lease as
      | string
      | undefined;

  // P-I: every act follows the commit of ITS OWN cover (a completion is matched to the activity that asked).
  for (const begin of actBegin) {
    const lease = leaseOfActivity(begin.page as string, begin.n as number);
    const cover = lease ? leaseCommit.get(lease) : undefined;
    if (!cover || cover.seq > begin.seq)
      violations.push(
        `P-I: page ${begin.page} acted for attempt ${begin.n} without its own committed cover`,
      );
  }

  for (const attach of attaches) {
    // P-C: the protected tree is attached only inside `act`.
    if (attach.inAct !== true)
      violations.push(
        `P-C: attach outside act (seq ${attach.seq}, page ${attach.page})`,
      );
    // V1: no exposure act follows a detection by another page (same account and epoch).
    for (const s of surrenders) {
      if (
        s.page !== attach.page &&
        s.account === attach.account &&
        s.epoch === attach.epoch &&
        s.seq < attach.seq
      )
        violations.push(
          `V1: page ${attach.page} acted (seq ${attach.seq}) after page ${s.page} detected (seq ${s.seq})`,
        );
    }
    // V3 (and Theorem 3): no exposure act after a closing write committed between its cover and its act.
    const begin = actBegin
      .filter((entry) => entry.page === attach.page && entry.seq < attach.seq)
      .at(-1);
    const lease = begin
      ? leaseOfActivity(attach.page as string, begin.n as number)
      : undefined;
    const cover = lease ? leaseCommit.get(lease) : undefined;
    if (cover) {
      for (const w of closingCommits) {
        if (w.seq > cover.seq && w.seq < attach.seq)
          violations.push(
            `V3: page ${attach.page} acted (seq ${attach.seq}) after closing write ${w.label} committed (seq ${w.seq}) following its cover (seq ${cover.seq})`,
          );
      }
      // V4: no act by an attempt whose lock was already released.
      const name = `atlas-lease-${lease}`;
      const released = of(logs, "lock.release_called").find(
        (entry) => entry.page === attach.page && entry.name === name,
      );
      if (released && released.seq < attach.seq)
        violations.push(
          `V4: page ${attach.page} acted after releasing ${name}`,
        );
    }
  }

  for (const request of issued) {
    const klass = request.klass as string;
    const lease = request.lease as string;
    // P-B: every stamped fetch is preceded by its own lease's commit.
    const cover = leaseCommit.get(lease);
    if (!cover || cover.seq > request.seq)
      violations.push(
        `P-B: request ${lease} issued (seq ${request.seq}) without its own lease committed`,
      );
    if (klass !== "ordinary" && klass !== "recovery") continue;
    // V2: no ordinary fetch after any detection (another page's or the sender's own).
    for (const s of surrenders) {
      if (
        s.account === request.account &&
        s.epoch === request.epoch &&
        s.seq < request.seq
      )
        violations.push(
          `V2: ${klass} request ${lease} (page ${request.page}) issued (seq ${request.seq}) after detection by page ${s.page} (seq ${s.seq})`,
        );
    }
    // V5: no ordinary or recovery fetch after a closing write committed, for a request covered before the write.
    if (cover) {
      for (const w of closingCommits) {
        if (w.seq > cover.seq && w.seq < request.seq)
          violations.push(
            `V5: ${klass} request ${lease} (page ${request.page}) issued (seq ${request.seq}) after closing write ${w.label} (seq ${w.seq})`,
          );
      }
    }
  }

  // V6: an answer is released in the step that read the record. The record named the identity the request was stamped with,
  // and no transaction committed a write between that read and the release, so a transition is either before the read
  // (it was seen) or after the release (the answer had been handed back). A release that waits for the delivery of the
  // read's completion breaks this whenever another page commits in between.
  const checks = of(logs, "trace.response.check");
  for (const released of of(logs, "trace.response.released")) {
    const check = checks.find(
      (entry) => entry.page === released.page && entry.n === released.n,
    );
    if (!check) {
      violations.push(
        `V6: page ${released.page} released answer ${released.n} without a check of the record`,
      );
      continue;
    }
    const durable = check.durable as { account: string; epoch: number } | null;
    if (
      !durable ||
      durable.account !== released.account ||
      durable.epoch !== released.epoch
    )
      violations.push(
        `V6: page ${released.page} released answer ${released.n} for ${released.account}/${released.epoch} but the record it read named ${JSON.stringify(durable)}`,
      );
    for (const commit of all)
      if (commit.seq > check.seq && commit.seq < released.seq)
        violations.push(
          `V6: ${commit.label} committed (page ${commit.page}, seq ${commit.seq}) between page ${released.page}'s read of the record (seq ${check.seq}) and its release of answer ${released.n} (seq ${released.seq})`,
        );
  }

  // V7: what a PUBLIC call (the typed client, the Settings operations) hands the application is validated after the call's last
  // decode. Decoding a buffered body is asynchronous (a fetch task), so a check made before it, however carefully ordered, is
  // overtaken by a transition that completes while the decode runs. The release of a result therefore names the decode it
  // follows, and the read of the record that decided it was made after that decode finished. (V6 above states that the read
  // and the release are one step; V7 states what the release is OF.)
  const decodes = of(logs, "trace.response.decoded");
  for (const released of of(logs, "trace.response.released")) {
    if (released.to !== "result") continue;
    const decode = decodes.find(
      (entry) => entry.page === released.page && entry.d === released.decoded,
    );
    if (!decode) {
      violations.push(
        `V7: page ${released.page} released a result (answer ${released.n}) that names no finished decode`,
      );
      continue;
    }
    const check = checks.find(
      (entry) => entry.page === released.page && entry.n === released.n,
    );
    if (check && check.seq < decode.seq)
      violations.push(
        `V7: page ${released.page} read the record (seq ${check.seq}) for result ${released.n} BEFORE the decode it followed finished (seq ${decode.seq})`,
      );
  }

  // P-F: the record's invariants held after every commit.
  for (const violation of fixture.store.violations)
    violations.push(`P-F: ${violation}`);
  return violations;
}

/** Properties that hold only at QUIESCENCE (nothing in flight, nothing held back). */
export function checkQuiescence(fixture: Fixture): string[] {
  const violations: string[] = [];
  const { logs } = fixture.world;
  const live = new Set(
    fixture.pages
      .filter((page) => !page.destroyed && !page.frozen)
      .map((page) => page.id),
  );
  // P-D, W1, W3: no lease lock and no issue lock is left held by a live page.
  for (const held of fixture.locks.allHeldNames()) {
    if (!live.has(held.page)) continue;
    if (held.name.startsWith("atlas-lease-"))
      violations.push(`P-D/W1: ${held.page} still holds ${held.name}`);
    if (held.name.startsWith("atlas-issue-"))
      violations.push(`P-D/W3: ${held.page} still holds ${held.name}`);
  }
  // W2 / P-E: a cancelled request leaves no lease of its own in the record.
  const cancelled = of(logs, "trace.activity.cancel").filter(
    (entry) => entry.kind === "request" && entry.lease,
  );
  const record = fixture.store.records.auth_state;
  for (const entry of cancelled) {
    if (!live.has(entry.page as string)) continue;
    if (record.leases[entry.lease as string] !== undefined)
      violations.push(
        `W2: cancelled request lease ${entry.lease} (page ${entry.page}) remains`,
      );
  }
  return violations;
}

/** P-A: the number of `atlas-auth` requests a page made in a log window. */
export function authRequests(
  fixture: Fixture,
  page: string,
  from: number,
  to = Infinity,
): number {
  return fixture.world.logs.filter(
    (entry) =>
      entry.type === "lock.request" &&
      entry.page === page &&
      entry.name === "atlas-auth" &&
      entry.seq >= from &&
      entry.seq <= to,
  ).length;
}

/** The log sequence number of a page's first committed store transaction with this label after `from`. */
export function firstCommitSeq(
  fixture: Fixture,
  page: string,
  label: string,
  from = 0,
): number {
  const entry = fixture.world.logs.find(
    (log) =>
      log.type === "store.commit" &&
      log.page === page &&
      log.label === label &&
      log.wrote === true &&
      log.seq >= from,
  );
  if (!entry) throw new Error(`no committed ${label} transaction for ${page}`);
  return entry.seq;
}

/** Whether a page was granted a lock in a window of the log. */
export function grantedBetween(
  fixture: Fixture,
  page: string,
  name: string,
  from: number,
  to = Infinity,
): boolean {
  return fixture.world.logs.some(
    (log) =>
      log.type === "lock.grant" &&
      log.page === page &&
      log.name === name &&
      log.seq >= from &&
      log.seq <= to,
  );
}

/**
 * P-G (Ex1, invariant I3): no other page's lease is COMMITTED between an exposure lease's commit and the release of
 * its lock, for the same account. This is what makes "decision and act one step".
 */
export function checkExclusiveActivity(fixture: Fixture): string[] {
  const { logs } = fixture.world;
  const violations: string[] = [];
  const covers = logs.filter(
    (e) =>
      e.type === "store.commit" &&
      e.wrote === true &&
      String(e.label).startsWith("cover:") &&
      (e.result as { kind?: string } | undefined)?.kind === "COVERED",
  );
  const account = (lease: string) => {
    const created = logs.find(
      (e) => e.type === "trace.cover.committed" && e.lease === lease,
    );
    return created ? created.page : undefined;
  };
  void account;
  for (const exposure of covers.filter((e) => e.label === "cover:exposure")) {
    const lease = (exposure.result as { lease: string }).lease;
    const released = logs.find(
      (e) =>
        e.type === "lock.release_called" &&
        e.page === exposure.page &&
        e.name === `atlas-lease-${lease}`,
    );
    const destroyed = logs.find(
      (e) =>
        e.type === "page.destroyed" &&
        e.page === exposure.page &&
        e.seq > exposure.seq,
    );
    const end = Math.min(released?.seq ?? Infinity, destroyed?.seq ?? Infinity);
    for (const other of covers) {
      if (other.page === exposure.page) continue;
      if (other.seq > exposure.seq && other.seq < end)
        violations.push(
          `P-G: page ${other.page} committed ${other.label} (seq ${other.seq}) while page ${exposure.page} held exposure lease ${lease} (seq ${exposure.seq} to ${end})`,
        );
    }
  }
  return violations;
}

/**
 * P-H (Ex5, Lemma A): no act by an activity that had been cancelled, and every act is preceded by its own cover's
 * commit. A completion for a cancelled or superseded attempt never becomes a display.
 */
export function checkNoActByCancelled(fixture: Fixture): string[] {
  const { logs } = fixture.world;
  const violations: string[] = [];
  for (const act of logs.filter((e) => e.type === "trace.act.begin")) {
    const cancelled = logs.find(
      (e) =>
        e.type === "trace.activity.cancel" &&
        e.page === act.page &&
        e.n === act.n &&
        e.seq < act.seq &&
        e.kind === "exposure",
    );
    if (cancelled)
      violations.push(
        `P-H: page ${act.page} acted for attempt ${act.n} after cancelling it (${cancelled.reason}, seq ${cancelled.seq})`,
      );
  }
  return violations;
}
