/**
 * WEB-08d revision 32 (review 33 R33-N1, family `i04-first-stamped-request-premise`): which stamped request OBSERVED a credential
 * mismatch first, judged from evidence instead of assumed.
 *
 * I-05 swaps a settled page's HttpOnly cookie for another session's and then calls `listSessions()`. The original assertion assumed
 * that call is the first stamped request to meet the swapped cookie, so it must answer `auth_state` itself. The page's own readers
 * (`/defaults/snapshot`, `/daily`, the device mirror's `/sessions`) can be first: the released backend answers them 403
 * `credential_mismatch`, the kernel records the observation and closes admission, and the explicit call is then refused `closed`
 * WITHOUT being sent (review 33's WebKit trace). Both orders are correct product behaviour; neither string proves anything alone.
 *
 * `judgeFirstObserver` accepts an outcome only with its evidence:
 * - `auth_state`: the call's own final attempt was issued, its answer surrendered with 403, the kernel classified that answer as
 *   `credential_mismatch`, and the observation was durably recorded;
 * - `closed`: none of the call's attempts was issued, and a `credential_mismatch` observation from ANOTHER activity of this document
 *   had been durably recorded before the call's final attempt began.
 * In both, every stamped 403 the page received after the cut is the backend's `credential_mismatch` (an ordinary `forbidden` 403 is
 * not this observation), and there are at least as many of them, delivered by the proxy, as the kernel classified (a response the
 * proxy still holds was never observed). Only events after the cut count, only for the identity settled at the cut, and only in the
 * document the cut was taken in. When the test has established that no other caller of a path runs (`exclusive`), the proxy's
 * arrivals on that path must equal the issued attempts of the test's own calls: a call the kernel says was never issued cannot
 * appear on the wire.
 *
 * Pure: it reads records the spec collects (the harness page's kernel trace, the proxy's log, the page's own responses). Unit-tested
 * against valid and invalid records in first-observer.test.ts and against the real kernel's schedules in
 * tests/session/i05-first-observer.test.ts.
 */

/** One entry of the kernel's trace (`window.__atlasFixture.session.trace`, or the fake world's `trace.*` log entries). */
export interface KernelEvent {
  event: string;
  data?: Record<string, unknown>;
}

/** One attempt of a call made through the kernel: its activity number (null when no activity was created) and its result. */
export interface CallAttempt {
  n: number | null;
  result: { ok: boolean; error?: string };
}

/** An entry of the delaying proxy's log (scripts/integration/delaying-proxy.mjs); `id` is the arrival order. */
export interface WireEntry {
  id: number;
  method: string;
  path: string;
  status?: number;
  events: Array<{ event: string; status?: number }>;
}

/** A response the page received, with the Atlas error `code` of its body (null when it has none). */
export interface PageAnswer {
  method: string;
  path: string;
  status: number;
  code: string | null;
}

export interface FirstObserverInput {
  /** The settled identity at the cut: only observations stamped for it count. */
  identity: { account: string; epoch: number };
  /** A token the spec wrote into the document at the cut, and the one read back when judging: a different document has none. */
  document: { atCut: string; atJudgement: string | null };
  /** The document's whole kernel trace, and its length at the cut (the cookie swap began after it). */
  trace: KernelEvent[];
  cut: number;
  /** The call under test, made after the cut. */
  call: CallAttempt[];
  /** The proxy's log, and the highest entry id that had ARRIVED at the cut. */
  wire: WireEntry[];
  wireCut: number;
  /** The page's answers received after the cut. */
  answers: PageAnswer[];
  /**
   * Routes the test has established only its own calls use after the cut: for each, every call it made on that route (the
   * explicit call included when it is one of them).
   */
  exclusive?: Array<{ method: string; path: string; calls: CallAttempt[][] }>;
}

export interface Observation {
  n: number;
  lease: string;
  /** Trace indices: the surrender, the kernel's classification as credential_mismatch, its durable record (null: not recorded). */
  surrendered: number;
  classified: number;
  recorded: number | null;
}

export interface FirstObserverVerdict {
  problems: string[];
  /** `self`: the call observed the mismatch itself; `other`: another activity had, and the call was refused unsent. */
  observer: "self" | "other" | null;
  /** The observation the verdict rests on. */
  witness: Observation | null;
  /** Every post-cut credential_mismatch observation of the identity, in classification order. */
  observations: Observation[];
  /** The first of them (whose answer the kernel classified first). */
  first: Observation | null;
}

const API_PREFIX = "/api/experimental/v1";
/** Stamped paths: the API, less the unstamped session-establishment and identity routes and the health probe. */
export const isStampedPath = (path: string): boolean => {
  const pathname = path.split("?")[0] ?? "";
  if (!pathname.startsWith(`${API_PREFIX}/`)) return false;
  const route = pathname.slice(API_PREFIX.length);
  return !/^\/browser-sessions(\/|$)|^\/health$/.test(route);
};

const num = (value: unknown): number | null =>
  typeof value === "number" ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Every credential_mismatch observation of `identity` in `trace[cut..]`, linked surrender -> classification -> durable record. */
export function credentialMismatchObservations(
  trace: KernelEvent[],
  cut: number,
  identity: { account: string; epoch: number },
): Observation[] {
  const found: Observation[] = [];
  for (let i = cut; i < trace.length; i += 1) {
    const entry = trace[i];
    if (entry?.event !== "surrender") continue;
    const data = entry.data ?? {};
    const n = num(data.n);
    const lease = str(data.lease);
    if (
      n === null ||
      lease === null ||
      data.status !== 403 ||
      data.identityRead !== false ||
      data.account !== identity.account ||
      data.epoch !== identity.epoch
    )
      continue;
    const hold = `d:${lease}`;
    let classified = -1;
    for (let j = i + 1; j < trace.length; j += 1) {
      const e = trace[j];
      if (
        e?.event === "hold.set" &&
        e.data?.id === hold &&
        e.data?.account === identity.account &&
        e.data?.cause === "observation:credential_mismatch"
      ) {
        classified = j;
        break;
      }
    }
    if (classified < 0) continue;
    // The recording path emits `record.complete` and, in the same step, releases the observation's hold (`d:<lease>`).
    let recorded: number | null = null;
    for (let k = classified + 1; k + 1 < trace.length; k += 1) {
      const done = trace[k];
      const release = trace[k + 1];
      if (
        done?.event === "record.complete" &&
        done.data?.outcome === "DONE" &&
        release?.event === "hold.release" &&
        release.data?.id === hold
      ) {
        recorded = k;
        break;
      }
    }
    found.push({ n, lease, surrendered: i, classified, recorded });
  }
  return found.sort((a, b) => a.classified - b.classified);
}

const indexOf = (
  trace: KernelEvent[],
  cut: number,
  event: string,
  n: number,
): number => {
  for (let i = cut; i < trace.length; i += 1)
    if (trace[i]?.event === event && trace[i]?.data?.n === n) return i;
  return -1;
};

export function judgeFirstObserver(
  input: FirstObserverInput,
): FirstObserverVerdict {
  const problems: string[] = [];
  const { trace, cut, identity } = input;
  if (input.document.atJudgement !== input.document.atCut)
    problems.push(
      "the records were not collected from the document the cut was taken in",
    );
  const observations = credentialMismatchObservations(trace, cut, identity);
  const first = observations[0] ?? null;
  const issued = (attempt: CallAttempt) =>
    attempt.n !== null && indexOf(trace, cut, "request.issued", attempt.n) >= 0;
  const final = input.call[input.call.length - 1];
  let observer: FirstObserverVerdict["observer"] = null;
  let witness: Observation | null = null;
  if (!final || final.n === null)
    problems.push("the call made no attempt the kernel saw after the cut");
  else if (indexOf(trace, cut, "activity.create", final.n) < 0)
    problems.push(
      `the call's final attempt (activity ${final.n}) was not created after the cut`,
    );
  else if (!final.result.ok && final.result.error === "auth_state") {
    witness = observations.find((o) => o.n === final.n) ?? null;
    if (!issued(final))
      problems.push(
        "auth_state, but the call's final attempt was never issued",
      );
    else if (!witness)
      problems.push(
        "auth_state, but the kernel did not classify the call's own answer as credential_mismatch",
      );
    else if (witness.recorded === null)
      problems.push(
        "auth_state, but the call's credential_mismatch observation was never durably recorded",
      );
    else observer = "self";
  } else if (!final.result.ok && final.result.error === "closed") {
    const ns = new Set(input.call.map((attempt) => attempt.n));
    const began = indexOf(trace, cut, "activity.create", final.n);
    witness =
      observations.find(
        (o) => !ns.has(o.n) && o.recorded !== null && o.recorded < began,
      ) ?? null;
    if (input.call.some(issued))
      problems.push(
        "closed, but an attempt of the call was issued (its own answer, not an earlier observation, decided it)",
      );
    else if (!witness)
      problems.push(
        "closed, but no other activity's credential_mismatch observation was durably recorded before the call's final attempt",
      );
    else observer = "other";
  } else
    problems.push(
      `the call answered ${JSON.stringify(final.result)}: neither its own observation (auth_state) nor an earlier one (closed)`,
    );

  // The backend's own answers: every stamped 403 the page received is credential_mismatch, and none the kernel classified is missing.
  const stamped403 = input.answers.filter(
    (answer) => answer.status === 403 && isStampedPath(answer.path),
  );
  const others = stamped403.filter(
    (answer) => answer.code !== "credential_mismatch",
  );
  if (others.length > 0)
    problems.push(
      `the page received a stamped 403 that is not credential_mismatch: ${others
        .map((answer) => `${answer.method} ${answer.path} ${answer.code}`)
        .join(", ")}`,
    );
  if (stamped403.length < Math.max(1, observations.length))
    problems.push(
      `the kernel classified ${observations.length} credential_mismatch answer(s) but the page received ${stamped403.length} stamped 403(s)`,
    );
  const after = input.wire.filter((entry) => entry.id > input.wireCut);
  const delivered403 = after.filter(
    (entry) =>
      isStampedPath(entry.path) &&
      entry.events.some((e) => e.event === "delivered" && e.status === 403),
  );
  if (delivered403.length < Math.max(1, observations.length))
    problems.push(
      `the kernel classified ${observations.length} credential_mismatch answer(s) but the proxy delivered ${delivered403.length} stamped 403(s) after the cut`,
    );
  for (const { method, path, calls } of input.exclusive ?? []) {
    const arrivals = after.filter(
      (entry) =>
        entry.method === method && (entry.path.split("?")[0] ?? "") === path,
    ).length;
    const sent = calls.flat().filter(issued).length;
    if (arrivals !== sent)
      problems.push(
        `${arrivals} ${method} ${path} request(s) reached the proxy after the cut, but the test's own calls issued ${sent}`,
      );
  }
  return { problems, observer, witness, observations, first };
}
