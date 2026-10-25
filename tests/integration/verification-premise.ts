/**
 * WEB-08d revision 33 (review 34 R34-N1, family `i14d-post-navigation-lease-premise`): the premise of the two revision-11 I-14d
 * cases, judged from evidence instead of assumed.
 *
 * Those cases need a document that DISPLAYS the settled session and then makes its own optional verification (the resume check a
 * displaying page makes when the shared confirmation is older than the interval), whose answer the proxy holds. Revision 11 made that
 * document by navigating the signed-in page. A navigation abandons the old document's ordinary requests that are still outstanding
 * (the harness `/today` page's `/defaults/snapshot` and two `/daily` reads); their leases stay in the record, released to the next
 * document, and an exposure over an unresolved foreign lease closes (`CLOSED_UNRESOLVED`) and starts a verification of those leases
 * BEFORE display (src/session/kernel/expose.ts, the protection, not a defect). That verification is the one the proxy then held, the
 * test waited for a display that needed its answer, and its hook was never installed (review 34's Chromium trace).
 *
 * `judgeVerificationPremise` accepts the setup only with its evidence, collected while the answer is held:
 * - the seed (signed-in) and target documents are distinct boots, and the records come from the target document the setup booted;
 * - the record still settles the identity, and its shared confirmation is exactly the one the setup aged (no peer refreshed it);
 * - the target EXPOSED the identity (`act.begin`, then `act.end` of the same activity) and made exactly ONE verification of it,
 *   created after `act.begin` (display sets the view inside `act`, and the resume check starts synchronously from that, so creation
 *   may precede `act.end`), whose cover committed after `act.end` with an EMPTY captured set and which was then issued;
 * - that verification's lease is still in the record, as the target's, of the verification class (its answer is outstanding);
 * - every lease in the record belongs to the seed or the target;
 * - the identity reads: the target made one, the seed none, one reached the proxy and the proxy holds one.
 *
 * `judgeTypedCall` then judges the typed call the hook makes as that held answer is delivered: the hook ran once, after the
 * verification was issued and before the kernel handled its answer (the answer's detection hold `d:<lease>` is set after it). Each
 * attempt of the call names the kernel activity it created: the typed client's `send()` creates it synchronously inside the call, so
 * the page records `n` from the trace entry that call added. (The page's own reads can also create ordinary activities after
 * the hook: in Firefox on a pool host, in revision 33's second validation run, the target's `/defaults/snapshot` and both `/daily`
 * reads came 280 ms after it. They are not the call's.) Every attempt's activity was created after the hook; the first was made
 * before that hold ended and was never issued; without retry it is the only attempt and answered `not_sent`; with retry exactly one
 * attempt, the last, was issued, every earlier one answered `not_sent` and the last, once finished, returned; and the proxy's
 * `GET /sessions` arrivals equal the call's issued attempts (no other caller of that route runs on the page).
 *
 * Pure: it reads records the spec collects (the target page's kernel trace and durable record, the documents' own counts of identity
 * reads, the proxy's log and held counts). Unit-tested against valid and invalid records in verification-premise.test.ts and against
 * the real kernel's schedules (live seed, live seed with a held request, abandoned requests) in
 * tests/session/i14d-verification-premise.test.ts.
 */
import type { KernelEvent } from "./first-observer";

export type { KernelEvent };

export interface LeaseLike {
  account_id: string;
  epoch: number;
  boot_id: string;
  class: string;
}
export interface IdentityLike {
  account_id: string;
  epoch: number;
  session_id: string;
}

export interface VerificationPremiseInput {
  identity: { account: string; epoch: number; session: string };
  seed: { boot: string };
  /** The target's boot, and a token the setup wrote into the target at boot, read back when judging (a later document has none). */
  target: {
    boot: string;
    token: { atBoot: string; atJudgement: string | null };
  };
  /** The target document's whole kernel trace. */
  trace: KernelEvent[];
  /** The durable record, read from the target while the answer is held. */
  record: {
    settled: IdentityLike | null;
    confirmation: (IdentityLike & { confirmed_at: string }) | null;
    leases: Record<string, LeaseLike>;
  };
  /** The `confirmed_at` the setup wrote when it aged the shared confirmation. */
  agedConfirmedAt: string;
  /** Identity reads (`GET /browser-sessions/current`): each document's own count, the proxy's arrivals and its held answers. */
  identityReads: { seed: number; target: number; wire: number; held: number };
}

export interface PremiseVerdict {
  problems: string[];
  exposure: { n: number; begin: number; end: number } | null;
  verification: {
    n: number;
    lease: string;
    created: number;
    committed: number;
    issued: number;
  } | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const same = (
  a: IdentityLike | null,
  b: VerificationPremiseInput["identity"],
) =>
  a !== null &&
  a.account_id === b.account &&
  a.epoch === b.epoch &&
  a.session_id === b.session;

const find = (
  trace: KernelEvent[],
  from: number,
  test: (entry: KernelEvent) => boolean,
): number => {
  for (let i = Math.max(0, from); i < trace.length; i += 1) {
    const entry = trace[i];
    if (entry && test(entry)) return i;
  }
  return -1;
};

export function judgeVerificationPremise(
  input: VerificationPremiseInput,
): PremiseVerdict {
  const problems: string[] = [];
  const { trace, identity } = input;
  if (input.target.token.atJudgement !== input.target.token.atBoot)
    problems.push(
      "the records were not collected from the target document the setup booted",
    );
  if (input.seed.boot === input.target.boot)
    problems.push(
      "the seed and the target are one boot (the setup needs a separate target document)",
    );
  if (!same(input.record.settled, identity))
    problems.push("the record no longer settles the identity");
  const confirmation = input.record.confirmation;
  if (!confirmation || !same(confirmation, identity))
    problems.push("the record has no shared confirmation of the identity");
  else if (confirmation.confirmed_at !== input.agedConfirmedAt)
    problems.push(
      "the shared confirmation is not the one the setup aged (it was refreshed or replaced)",
    );

  const ofIdentity = (data: Record<string, unknown> | undefined) =>
    data?.account === identity.account && data?.epoch === identity.epoch;
  const verifications: number[] = [];
  trace.forEach((entry, i) => {
    if (
      entry.event === "activity.create" &&
      entry.data?.kind === "request" &&
      entry.data?.klass === "verification" &&
      ofIdentity(entry.data)
    )
      verifications.push(i);
  });
  const captured = trace.filter(
    (entry) =>
      entry.event === "cover.committed" &&
      entry.data?.klass === "verification" &&
      Array.isArray(entry.data?.unresolved) &&
      (entry.data.unresolved as unknown[]).length > 0,
  );
  for (const entry of captured)
    problems.push(
      `a verification captured unresolved leases ${JSON.stringify(entry.data?.unresolved)}: it verifies abandoned requests, it is not the optional check`,
    );

  let exposure: PremiseVerdict["exposure"] = null;
  const begin = find(
    trace,
    0,
    (e) => e.event === "act.begin" && ofIdentity(e.data),
  );
  const actN = begin >= 0 ? num(trace[begin]?.data?.n) : null;
  const end =
    actN === null
      ? -1
      : find(
          trace,
          begin + 1,
          (e) => e.event === "act.end" && e.data?.n === actN,
        );
  if (begin < 0 || actN === null || end < 0)
    problems.push(
      "the target never exposed the identity (no act.begin/act.end)",
    );
  else exposure = { n: actN, begin, end };

  let verification: PremiseVerdict["verification"] = null;
  if (verifications.length === 0)
    problems.push("the target made no verification of the identity");
  else if (verifications.length > 1)
    problems.push(
      `the target made ${verifications.length} verifications of the identity (exactly one expected)`,
    );
  else {
    const created = verifications[0] as number;
    const n = num(trace[created]?.data?.n);
    const committed =
      n === null
        ? -1
        : find(
            trace,
            created + 1,
            (e) =>
              e.event === "cover.committed" &&
              e.data?.n === n &&
              e.data?.klass === "verification",
          );
    const committedEntry = committed >= 0 ? trace[committed] : undefined;
    const lease = str(committedEntry?.data?.lease);
    const issued =
      n === null
        ? -1
        : find(
            trace,
            committed + 1,
            (e) => e.event === "request.issued" && e.data?.n === n,
          );
    if (exposure && created < exposure.begin)
      problems.push(
        "the verification was created before the target's exposure began (it is the check that gates display)",
      );
    if (n === null || lease === null)
      problems.push("the verification's cover never committed");
    else {
      if (exposure && committed < exposure.end)
        problems.push(
          "the verification's cover committed before the target's exposure ended",
        );
      const unresolved = committedEntry?.data?.unresolved;
      if (!Array.isArray(unresolved) || unresolved.length > 0)
        problems.push(
          `the verification's captured set is ${JSON.stringify(unresolved)}, not empty`,
        );
      if (issued < 0) problems.push("the verification was never issued");
      const recorded = input.record.leases[lease];
      if (
        !recorded ||
        recorded.boot_id !== input.target.boot ||
        recorded.class !== "verification" ||
        recorded.account_id !== identity.account ||
        recorded.epoch !== identity.epoch
      )
        problems.push(
          "the verification's lease is not in the record as the target's outstanding verification",
        );
      verification = { n, lease, created, committed, issued };
    }
  }

  for (const [id, lease] of Object.entries(input.record.leases))
    if (
      lease.boot_id !== input.seed.boot &&
      lease.boot_id !== input.target.boot
    )
      problems.push(`lease ${id} belongs to neither the seed nor the target`);

  const reads = input.identityReads;
  if (reads.target !== 1)
    problems.push(`the target made ${reads.target} identity read(s), not 1`);
  if (reads.seed !== 0)
    problems.push(`the seed made ${reads.seed} identity read(s), not 0`);
  if (reads.wire !== 1)
    problems.push(`${reads.wire} identity read(s) reached the proxy, not 1`);
  if (reads.held !== 1)
    problems.push(`the proxy holds ${reads.held} identity answer(s), not 1`);
  return { problems, exposure, verification };
}

export interface TypedCallInput {
  identity: { account: string; epoch: number };
  /** The target document's whole kernel trace. */
  trace: KernelEvent[];
  /** The verification the premise established (its activity, lease and issue index). */
  verification: { n: number; lease: string; issued: number };
  /** How many times the hook ran, and the trace length when it first ran. */
  hook: { runs: number; at: number | null };
  /**
   * The call's attempts in order: the activity each created (null: the call added no `activity.create`), and its outcome once it
   * finished (the typed client's `returned`, `not_sent` or error kind; null while outstanding).
   */
  attempts: Array<{ n: number | null; outcome: string | null }>;
  /** Whether the call retries `not_sent` (`__retryTyped`). */
  retry: boolean;
  /** `GET /sessions` requests that reached the proxy during the test. */
  wireSessions: number;
}

export interface TypedCallVerdict {
  problems: string[];
  /** The call's attempts as the trace shows them. */
  activities: Array<{ n: number; created: number; issued: number | null }>;
  /** The trace indices of the verification answer's detection hold. */
  detection: { set: number; release: number | null } | null;
}

export function judgeTypedCall(input: TypedCallInput): TypedCallVerdict {
  const problems: string[] = [];
  const { trace, identity, hook } = input;
  if (hook.runs !== 1)
    problems.push(`the hook ran ${hook.runs} time(s), not once`);
  const at = hook.at ?? -1;
  if (hook.at === null) problems.push("the hook never ran");
  else if (hook.at <= input.verification.issued)
    problems.push(
      "the hook ran before the verification was issued (it must run as its answer is delivered)",
    );
  const holdId = `d:${input.verification.lease}`;
  const set =
    hook.at === null
      ? -1
      : find(
          trace,
          at,
          (e) =>
            e.event === "hold.set" &&
            e.data?.id === holdId &&
            e.data?.cause === "detection",
        );
  let detection: TypedCallVerdict["detection"] = null;
  if (set < 0)
    problems.push(
      "the verification's answer set no detection hold after the hook ran (the hook did not run before the kernel handled it)",
    );
  else {
    const release = find(
      trace,
      set + 1,
      (e) => e.event === "hold.release" && e.data?.id === holdId,
    );
    detection = { set, release: release < 0 ? null : release };
  }

  const activities: TypedCallVerdict["activities"] = [];
  input.attempts.forEach((attempt, index) => {
    const created =
      attempt.n === null
        ? -1
        : find(
            trace,
            0,
            (e) =>
              e.event === "activity.create" &&
              e.data?.n === attempt.n &&
              e.data?.kind === "request" &&
              e.data?.klass === "ordinary" &&
              e.data?.account === identity.account &&
              e.data?.epoch === identity.epoch,
          );
    if (attempt.n === null || created < 0) {
      problems.push(
        `attempt ${index + 1} of the call names no ordinary activity of the identity in the trace`,
      );
      return;
    }
    if (created < at)
      problems.push(
        `attempt ${index + 1} of the call was created before the hook ran`,
      );
    const issued = find(
      trace,
      created + 1,
      (e) => e.event === "request.issued" && e.data?.n === attempt.n,
    );
    activities.push({
      n: attempt.n,
      created,
      issued: issued < 0 ? null : issued,
    });
  });

  const first = activities[0];
  if (input.attempts.length === 0)
    problems.push("the call made no attempt after the hook ran");
  else if (first) {
    if (
      detection &&
      detection.release !== null &&
      first.created > detection.release
    )
      problems.push(
        "the call's first attempt was made after the verification's detection hold ended",
      );
    if (first.issued !== null)
      problems.push(
        "the call's first attempt was issued (it was not refused while the hold was in force)",
      );
  }
  // Every attempt but the last has finished; the last is outstanding only while it is the issued one.
  const outcomes = input.attempts.map((attempt) => attempt.outcome);
  if (outcomes.slice(0, -1).some((outcome) => outcome === null))
    problems.push("an attempt of the call before the last never finished");
  const issued = activities.filter((a) => a.issued !== null);
  const last = activities[activities.length - 1];
  const lastOutcome = outcomes[outcomes.length - 1] ?? null;
  if (!input.retry) {
    if (input.attempts.length > 1)
      problems.push(
        `without retry the call made ${input.attempts.length} attempts, not 1`,
      );
    if (issued.length > 0)
      problems.push("without retry an attempt of the call was issued");
    if (lastOutcome !== null && lastOutcome !== "not_sent")
      problems.push(
        `without retry the call answered ${lastOutcome}, not not_sent`,
      );
  } else {
    if (issued.length !== 1)
      problems.push(
        `with retry ${issued.length} attempt(s) of the call were issued, not 1`,
      );
    else if (issued[0] !== last)
      problems.push("with retry the issued attempt is not the call's last");
    // Only `not_sent` is retried: every attempt before the last answered it; the last, once finished, returned.
    const before = outcomes.slice(0, -1);
    if (before.some((outcome) => outcome !== null && outcome !== "not_sent"))
      problems.push(
        `with retry an attempt before the last answered ${JSON.stringify(before)} (only not_sent is retried)`,
      );
    if (lastOutcome !== null && lastOutcome !== "returned")
      problems.push(
        `with retry the call's last attempt answered ${lastOutcome}, not returned`,
      );
  }
  if (input.wireSessions !== issued.length)
    problems.push(
      `${input.wireSessions} GET /sessions request(s) reached the proxy, but the call issued ${issued.length}`,
    );
  return { problems, activities, detection };
}
