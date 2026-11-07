/**
 * WEB-14a revision 46 (review r45 F-R45-I14D, family `i14d-post-navigation-lease-premise` (R34-N1); related family
 * `offline-reload-request-retirement-premise` (R41)): the premise of an INTENTIONAL ABANDONMENT, judged from evidence.
 *
 * A test that replaces a harness document states one of two premises, and they are contradictory, so neither may silently stand in
 * for the other:
 * - CLEAN REPLACEMENT (`freshHarnessDocument`, helpers.ts): the old document has finished its own requests. The durable record holds no
 *   request lease (any class but `exposure`) before the navigation, so the next document's only identity read is its own optional
 *   verification. Judged by `untilRequestsRetired` (unchanged here).
 * - INTENTIONAL ABANDONMENT (`abandonHarnessDocument`, helpers.ts): the old document made ONE named ordinary request, which was issued,
 *   whose answer the proxy holds and whose continuation the document never runs (`__freeze`), and the navigation destroys its owner
 *   before the owner can retire its lease. The next document must find that lease (lock-free) and verify it before it displays.
 *
 * Revision 37 strengthened the clean premise and the one abandonment control then inherited it: it proved one surviving ordinary lease,
 * then demanded zero (review r45's native WebKit failure, at the retirement bound, before navigation). These witnesses keep the two
 * premises apart.
 *
 * `judgeAbandonment` accepts the old document, sampled before the navigation, only when:
 * - the record still settles exactly the expected session, and the sample comes from the witnessed owner's boot and from the same
 *   document as the first sample (a marker the helper writes);
 * - the witnessed lease is in the record, of the `ordinary` class, the witnessed boot's, for the expected account and epoch;
 * - the old document's own kernel trace issued EXACTLY ONE request on that lease (`request.issued`, same class, account and epoch)
 *   and never retired it (`lease.retired`);
 * - the proxy holds a response for the witnessed rule (the answer was never delivered);
 * - no OTHER request lease is in the record. Others are reported apart (`waiting`): unrelated display reads still being retired by
 *   their live owner may finish within the helper's bound. Every other problem is final: the setup is invalid, not to be waited out.
 *
 * `judgeReplacement` then accepts the new document only when it has the fixture bridge, is a different document (marker) and boot from
 * the abandoned owner's, still settles exactly the expected session, and its record still holds the witnessed lease unchanged (the
 * owner did not handle the request first: a live owner that runs the request's continuation before it is destroyed retires the lease,
 * and that is the clean schedule, not an abandonment). The caller holds the next document's verification, so the new document cannot
 * have recovered the lease yet; a lease found missing is a failed premise, never a success.
 *
 * Pure: it reads records the spec collects. Metadata only (identifiers, classes, counts): never a credential, token or body.
 * Unit-tested against valid and invalid records in navigation-premise.test.ts and against the real kernel's schedules in
 * tests/session/i14d-verification-premise.test.ts.
 */
import type { KernelEvent } from "./first-observer";
import type { IdentityLike, LeaseLike } from "./verification-premise";

/** What the caller names as abandoned: the lease of its frozen request, its owner's boot, and the proxy rule holding its answer. */
export interface AbandonmentWitness {
  lease: string;
  boot: string;
  held: string;
}

/** One document's evidence, read by the helper from inside that document. */
export interface DocumentSample {
  /** The fixture bridge is present (a harness document, not the app route itself). */
  bridged: boolean;
  /** `window.__s.bootId` of the session this document booted. */
  boot: string | null;
  /** A marker the helper writes into the document on first read; a later document has a different one. */
  document: string;
  settled: IdentityLike | null;
  leases: Record<string, LeaseLike>;
  trace: KernelEvent[];
}

export interface AbandonmentInput {
  expected: IdentityLike;
  witness: AbandonmentWitness;
  /** The marker of the first sample of the old document (every later sample must come from the same document). */
  document: string;
  before: DocumentSample;
  /** The proxy's held count for `witness.held`. */
  held: number;
}

export interface AbandonmentVerdict {
  /** Final: the setup is invalid. */
  problems: string[];
  /** Other request leases still in the record (their live owner may retire them within the bound). */
  waiting: string[];
  /** The witnessed request's activity number, when correlated. */
  issued: number | null;
}

export interface ReplacementInput {
  expected: IdentityLike;
  witness: AbandonmentWitness;
  /** The old document's marker. */
  document: string;
  after: DocumentSample;
}

const sameSettlement = (
  settled: IdentityLike | null,
  expected: IdentityLike,
): boolean =>
  settled?.account_id === expected.account_id &&
  settled?.epoch === expected.epoch &&
  settled?.session_id === expected.session_id;

/** The lease is the witnessed request's: ordinary, the witnessed boot's, for the expected account and epoch. */
function leaseProblems(
  lease: LeaseLike | undefined,
  witness: AbandonmentWitness,
  expected: IdentityLike,
  where: string,
): string[] {
  if (lease === undefined)
    return [
      `${where}: the abandoned request's lease ${witness.lease} is not in the record (retired, or never written): this is not an abandonment`,
    ];
  const problems: string[] = [];
  if (lease.class !== "ordinary")
    problems.push(
      `${where}: the abandoned lease is of class ${lease.class}, not ordinary`,
    );
  if (lease.boot_id !== witness.boot)
    problems.push(
      `${where}: the abandoned lease belongs to boot ${lease.boot_id}, not the witnessed owner ${witness.boot}`,
    );
  if (
    lease.account_id !== expected.account_id ||
    lease.epoch !== expected.epoch
  )
    problems.push(
      `${where}: the abandoned lease is for ${lease.account_id}@${lease.epoch}, not the expected ${expected.account_id}@${expected.epoch}`,
    );
  return problems;
}

export function judgeAbandonment(input: AbandonmentInput): AbandonmentVerdict {
  const { expected, witness, before } = input;
  const problems: string[] = [];
  if (!before.bridged)
    problems.push("before: the document has no fixture session bridge");
  if (before.document !== input.document)
    problems.push("before: the document was replaced during the setup");
  if (before.boot !== witness.boot)
    problems.push(
      `before: the sampled document is boot ${before.boot}, not the witnessed owner ${witness.boot}`,
    );
  if (!sameSettlement(before.settled, expected))
    problems.push("before: the record no longer settles the expected session");
  problems.push(
    ...leaseProblems(before.leases[witness.lease], witness, expected, "before"),
  );
  const issued = before.trace.filter(
    (e) => e.event === "request.issued" && e.data?.lease === witness.lease,
  );
  if (issued.length !== 1)
    problems.push(
      `before: the owner's trace issued ${issued.length} request(s) on the abandoned lease, not exactly one (uncorrelated)`,
    );
  const [request] = issued;
  if (
    request !== undefined &&
    (request.data?.klass !== "ordinary" ||
      request.data?.account !== expected.account_id ||
      request.data?.epoch !== expected.epoch)
  )
    problems.push(
      "before: the issued request on the abandoned lease is not the expected ordinary request of the settled account and epoch",
    );
  if (
    before.trace.some(
      (e) => e.event === "lease.retired" && e.data?.lease === witness.lease,
    )
  )
    problems.push("before: the owner's trace retired the abandoned lease");
  if (input.held < 1)
    problems.push(
      `before: the proxy holds no response for rule ${witness.held} (the abandoned request's answer is not held)`,
    );
  const waiting = Object.entries(before.leases)
    .filter(([id, lease]) => id !== witness.lease && lease.class !== "exposure")
    .map(([id, lease]) => `${id} (${lease.class}, boot ${lease.boot_id})`);
  return {
    problems,
    waiting,
    issued:
      request !== undefined && typeof request.data?.n === "number"
        ? request.data.n
        : null,
  };
}

export function judgeReplacement(input: ReplacementInput): string[] {
  const { expected, witness, after } = input;
  const problems: string[] = [];
  if (!after.bridged)
    problems.push("after: the new document has no fixture session bridge");
  if (after.document === input.document)
    problems.push("after: the document was not replaced (same marker)");
  if (after.boot === null || after.boot === witness.boot)
    problems.push(
      `after: the new document did not boot a new session (boot ${after.boot})`,
    );
  if (!sameSettlement(after.settled, expected))
    problems.push(
      "after: the new document's record does not settle the expected session",
    );
  problems.push(
    ...leaseProblems(after.leases[witness.lease], witness, expected, "after"),
  );
  return problems;
}
