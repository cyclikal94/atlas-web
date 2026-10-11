import hashes from "../../../scripts/lib/profile-workload-hashes.json";
import {
  allWorkloads,
  sha256Hex,
  WORKLOAD_VERSION,
} from "../../../scripts/lib/profile-workloads.mjs";
import { scanSyncPage } from "../../data/scan/scan";
import {
  createKeyDerivers,
  createValueValidators,
  decodeChange,
} from "../../data/scan/validate";
import type { DataHarness } from "./main";
import {
  CaptureKeepError,
  type CaptureSource,
  captureFrom,
  captureQuery,
  keepCapture,
  loadCapture,
  protocolPlan,
  sha256Bytes,
  W2,
} from "./profile-capture";
import {
  type Attempt,
  admission,
  type Collections,
  captureDecision,
  compareAndSet,
  complete,
  decide,
  type Envelope,
  exportDiagnostic,
  exportResults,
  KEY_OF,
  MANUAL_KEY,
  mayClear,
  newEnvelope,
  nextUnusedRun,
  type Permit,
  PROTOCOL_KEY,
  permitProblem,
  type Read,
  type Reservation,
  readEnvelope,
  recoverAbandoned,
  recoveryTarget,
  reserve,
  type Target,
  tabToken,
} from "./profile-protocol";

/**
 * FIXTURE ONLY (never packaged; `check-no-fixture`). The device profiling page, `/profile-harness` (plan 7.5). One COLD run of one
 * workload per page load: it regenerates the workload in the page, verifies its SHA-256 against the recorded hashes, runs the
 * production processing path on it, records what it saw, and appends the record to this origin's localStorage so a person with a
 * device can collect runs across loads and copy one results file.
 *
 *   /profile-harness                       a menu and the collected results (it never runs, recovers or changes anything)
 *   /profile-harness?w=W1&run=1            one cold run (W1, W3, W4, W6, W5-limit-N, W7-<name>) into this tab's manual collection
 *   /profile-harness?protocol=1            every workload, five cold runs each, one page load per run
 *   ...&w2sha256=<hex>                     W2 as well: the released backend's captured batch, picked once with the page's file
 *                                          input, read back and verified on each run (profile-capture.ts; without it the protocol
 *                                          has no W2 and its results are incomplete)
 *
 * What this page is NOT: the transport is an in-page function that hands the body to the engine, so the real stamped wrapper's extra
 * buffer copy is NOT present (the desktop runs with the real wrapper quantify it); the engine writes to this device's real
 * IndexedDB; memory figures are what the page itself can see (`performance.memory` exists in Chromium only) and the platform's own
 * tool (Android `dumpsys meminfo`, Xcode Instruments, `about:memory`, a task manager) is to be noted beside each run.
 *
 * The protocol's state (revision 2, design assessment DA-1; profile-protocol.ts): one envelope, owned by the tab that started it, changed
 * by one whole write per transition. An attempt is reserved before it runs and its result stored with the end of the reservation, so a
 * killed tab's attempt is recorded once, as `killed`, by the owner's next load, and nothing is skipped. Another tab only reads and says
 * why. The results file is the envelope's runs, all of one protocol.
 *
 * Revision 3 (review 3 R5): ONE collector per origin. A collecting page (the protocol or a manual run) takes the origin-wide collector
 * guard before it reads or creates either collection and keeps it until it is navigated away; restoring a capture, a take-over, clear
 * and delete run under it too. An active protocol refuses every manual run (a copied owner token included), a reserved manual attempt
 * refuses a protocol start, a duplicate of a collecting tab only reads, and a page without Web Locks collects nothing. A result is stored
 * only into the reservation its page made. After a lost tab, the new owner restores the collection's capture by picking the very file
 * whose SHA-256 the collection pins (any other file, or another tab, changes nothing); earlier attempts and the take-over stay recorded.
 *
 * Revision 4 (review 4 R5, design assessment B1-B6): BOTH collections recover. "Collection" chooses which stored collection an action is
 * for (by default the only one it can apply to); "Take over or recover" moves a gone tab's protocol OR manual collection to this tab and
 * records an attempt its page left reserved as one `killed` result, in one write, without running anything; a reloaded manual link never
 * runs an attempt its reservation already recorded; a picked capture is resolved against every collection that pins one; the results,
 * a manual collection's diagnostic export and a raw snapshot are copied for the chosen collection (and shown in a box when the clipboard
 * refuses); clear is scoped to the chosen collection; and a run's engine is stopped whatever its observation afterwards throws.
 */
const RUNS = 5;
const VALID_ENGINE_RUNS = ["W1", "W3", "W4", "W6"];
const PROFILE_ACCOUNT_PREFIX = "fffffff0-0000-4000-8000-";

export interface ProfileRun {
  /** The protocol (or manual collection) this attempt belongs to: one per results file. */
  protocol_id?: string;
  workload: string;
  run: number;
  cold: true;
  expected: "admitted" | "refused";
  outcome: "admitted" | "refused" | "error" | "timeout" | "killed";
  detail: string;
  sha256: string;
  sha256_verified: boolean;
  /** W2 only: the name of the capture file the bytes were read from. */
  source?: string;
  bytes: number;
  elapsed_ms: number;
  scan_ms: number | null;
  commit_ms: number | null;
  request_count: number;
  limit: number | null;
  changes_written: number | null;
  cursor_after: string | null;
  heap_baseline_bytes: number | null;
  heap_peak_bytes: number | null;
  heap_after_bytes: number | null;
  user_agent: string;
  at: string;
}

const recordedHash = new Map(
  (
    hashes as { workloads: Array<{ name: string; sha256: string }> }
  ).workloads.map((w) => [w.name, w.sha256]),
);
const heap = (): number | null => {
  const memory = (
    performance as unknown as { memory?: { usedJSHeapSize: number } }
  ).memory;
  return memory ? memory.usedJSHeapSize : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function machine(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { brands?: unknown; mobile?: boolean; platform?: string };
  };
  return {
    user_agent: nav.userAgent,
    device_memory_gib: nav.deviceMemory ?? null,
    hardware_concurrency: nav.hardwareConcurrency ?? null,
    platform: nav.userAgentData?.platform ?? nav.platform ?? null,
    mobile: nav.userAgentData?.mobile ?? null,
    standalone:
      (navigator as Navigator & { standalone?: boolean }).standalone ??
      window.matchMedia("(display-mode: standalone)").matches,
    secure_context: window.isSecureContext,
    cross_origin_isolated: window.crossOriginIsolated,
    performance_memory_available: heap() !== null,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
  };
}

/** Samples the page's own heap while `until` is pending (Chromium only: others return null). */
async function withHeapPeak<T>(
  until: () => Promise<T>,
): Promise<{ value: T; peak: number | null }> {
  let peak: number | null = heap();
  let running = true;
  const sampler = (async () => {
    while (running) {
      const now = heap();
      if (now !== null && (peak === null || now > peak)) peak = now;
      await sleep(15);
    }
  })();
  try {
    return { value: await until(), peak };
  } finally {
    running = false;
    await sampler;
  }
}

/** What a run knows before it starts. */
type RunBase = Omit<
  ProfileRun,
  | "outcome"
  | "detail"
  | "elapsed_ms"
  | "scan_ms"
  | "commit_ms"
  | "request_count"
  | "limit"
  | "changes_written"
  | "cursor_after"
  | "heap_after_bytes"
  | "heap_peak_bytes"
>;

async function runEngine(
  data: DataHarness,
  bytes: Uint8Array,
  expected: ProfileRun["expected"],
  base: RunBase,
): Promise<ProfileRun> {
  const account = `${PROFILE_ACCOUNT_PREFIX}${(Date.now() % 0xffffffffffff)
    .toString(16)
    .padStart(12, "0")}`;
  let requests = 0;
  let limit: number | null = null;
  const transport = (request: Request): Promise<Response> => {
    requests += 1;
    limit = Number(new URL(request.url).searchParams.get("limit"));
    // The page is served once; later requests (the live-edge poll) get an empty page so the engine can settle.
    if (requests > 1)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            phase: "delta",
            batches: [],
            next_cursor: "after",
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    return Promise.resolve(
      new Response(bytes.slice(), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const started = performance.now();
  const trace0 = data.engineTrace.length;
  let outcome: ProfileRun["outcome"] = "error";
  let detail = "";
  const measured = await withHeapPeak(async () => {
    try {
      await data.startSyncLocal(account, {
        transport,
        seedCursor: "cursor-0",
        deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number })
          .deviceMemory,
      });
      const deadline = performance.now() + 180_000;
      for (;;) {
        const state = data.engineState();
        if (state && state.kind !== "running" && requests >= 1) {
          detail = JSON.stringify(state);
          outcome =
            state.kind === "idle"
              ? "admitted"
              : // The page was not applied: refused outright (stopped, waiting for a valid cache) or counted as a failed read and backed off.
                state.kind === "stopped" ||
                  state.kind === "waiting" ||
                  state.kind === "backing_off" ||
                  state.kind === "paused"
                ? "refused"
                : "error";
          return;
        }
        if (performance.now() > deadline) {
          outcome = "timeout";
          return;
        }
        await sleep(25);
      }
    } catch (error) {
      detail = String(error).slice(0, 200);
      outcome = "error";
    }
  });
  const elapsed = performance.now() - started;
  // The engine is stopped before this attempt settles, whatever the observation below throws (revision 4, B6/N-1): a run that ends in an
  // error never leaves its engine running into a clean-up, a deletion or the next collection.
  try {
    return await observeRun(data, account, trace0, base, {
      expected,
      outcome,
      detail,
      elapsed,
      requests,
      limit,
      peak: measured.peak,
    });
  } finally {
    data.stopSync();
  }
}

/** What a finished run observed after its engine settled; the caller stops the engine whatever this throws. */
async function observeRun(
  data: DataHarness,
  account: string,
  trace0: number,
  base: RunBase,
  run: {
    expected: ProfileRun["expected"];
    outcome: ProfileRun["outcome"];
    detail: string;
    elapsed: number;
    requests: number;
    limit: number | null;
    peak: number | null;
  },
): Promise<ProfileRun> {
  const { expected, outcome, detail, elapsed, requests, limit } = run;
  const sync = (await data.syncState(account)) as {
    cursor?: string | null;
  } | null;
  let changes: number | null = null;
  try {
    changes = (await data.rows(account, "cache")).length;
  } catch {
    changes = null;
  }
  const commits = data.engineTrace
    .slice(trace0)
    .filter((line) => line.includes("data.sync_commit"))
    .map((line) => {
      const at = line.indexOf("{");
      try {
        return at < 0 ? {} : JSON.parse(line.slice(at));
      } catch {
        return {};
      }
    }) as Array<{ scan_ms?: number; commit_ms?: number }>;
  const first = commits[0];
  data.stopSync();
  const after = heap();
  return {
    ...base,
    expected,
    outcome,
    detail,
    elapsed_ms: Math.round(elapsed),
    scan_ms: first?.scan_ms ?? null,
    commit_ms: first?.commit_ms ?? null,
    request_count: requests,
    limit,
    changes_written: changes,
    cursor_after: sync?.cursor ?? null,
    heap_peak_bytes: run.peak,
    heap_after_bytes: after,
  };
}

/** W5: the processing path only (scan, then validate every change), because a snapshot page is not an ordinary page. */
function runProcessing(bytes: Uint8Array, base: RunBase): ProfileRun {
  const started = performance.now();
  const scanStarted = performance.now();
  const scan = scanSyncPage(bytes);
  const scanMs = performance.now() - scanStarted;
  let outcome: ProfileRun["outcome"] = "refused";
  let detail = "";
  let decoded = 0;
  let peak = heap();
  if (scan.ok) {
    const deps = {
      validators: createValueValidators(),
      derivers: createKeyDerivers(),
    };
    try {
      for (let i = 0; i < scan.totalChanges; i += 1) {
        decodeChange(
          bytes,
          scan.elements[i * 2] as number,
          scan.elements[i * 2 + 1] as number,
          scan.nodes[i] as number,
          deps,
        );
        decoded += 1;
        const now = heap();
        if (now !== null && (peak === null || now > peak)) peak = now;
      }
      outcome = "admitted";
      detail = `phase ${scan.phase}, ${scan.totalChanges} changes in ${scan.batches.length} batches`;
    } catch (error) {
      detail = String(error).slice(0, 120);
    }
  } else detail = `${scan.stage}:${scan.reason}`;
  return {
    ...base,
    expected: "admitted",
    outcome,
    detail,
    elapsed_ms: Math.round(performance.now() - started),
    scan_ms: Math.round(scanMs * 1000) / 1000,
    commit_ms: null,
    request_count: 0,
    limit: null,
    changes_written: decoded,
    cursor_after: null,
    heap_peak_bytes: peak,
    heap_after_bytes: heap(),
  };
}

/** W2: the kept capture, read afresh and hashed; a capture that cannot be read is an `error` run, and nothing else stands in. */
async function runCapture(
  data: DataHarness,
  run: number,
  capture: CaptureSource | null,
): Promise<ProfileRun> {
  const loaded = capture
    ? await loadCapture(capture)
    : {
        ok: false,
        bytes: new Uint8Array(),
        sha256: "",
        verified: false,
        name: "",
        detail: "no capture named (w2sha256)",
      };
  const base = {
    workload: W2,
    run,
    cold: true as const,
    sha256: loaded.sha256,
    sha256_verified: loaded.verified,
    source: loaded.name,
    bytes: loaded.bytes.length,
    heap_baseline_bytes: heap(),
    user_agent: navigator.userAgent,
    at: new Date().toISOString(),
  };
  // A capture that cannot be read, or whose bytes are not the ones the collection names, is an `error` run: no other bytes stand in.
  if (!loaded.ok || !loaded.verified)
    return {
      ...base,
      expected: "admitted",
      outcome: "error",
      detail: loaded.detail,
      elapsed_ms: 0,
      scan_ms: null,
      commit_ms: null,
      request_count: 0,
      limit: null,
      changes_written: null,
      cursor_after: null,
      heap_peak_bytes: null,
      heap_after_bytes: null,
    };
  return runEngine(data, loaded.bytes, "admitted", {
    ...base,
    expected: "admitted",
  });
}

async function runOne(
  data: DataHarness,
  name: string,
  run: number,
  capture: CaptureSource | null,
): Promise<ProfileRun> {
  if (name === W2) return runCapture(data, run, capture);
  const workload = allWorkloads().find((w) => w.name === name);
  if (!workload) throw new Error(`unknown workload ${name}`);
  const sha256 = await sha256Hex(workload.body);
  const bytes = new TextEncoder().encode(workload.body);
  const base = {
    workload: name,
    run,
    cold: true as const,
    sha256,
    sha256_verified: sha256 === recordedHash.get(name),
    bytes: bytes.length,
    heap_baseline_bytes: heap(),
    user_agent: navigator.userAgent,
    at: new Date().toISOString(),
  };
  if (name.startsWith("W5-"))
    return runProcessing(bytes, { ...base, expected: "admitted" });
  return runEngine(
    data,
    bytes,
    name.startsWith("W7-") ? "refused" : "admitted",
    {
      ...base,
      expected: name.startsWith("W7-") ? "refused" : "admitted",
    },
  );
}

const NAMES = allWorkloads().map((w) => w.name);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

/** Removes the throw-away profiling databases through the data layer's own host (the one place a database is deleted: rule R16). */
async function deleteProfileDatabases(
  data: DataHarness,
): Promise<{ n: number; error: string | null }> {
  let n = 0;
  try {
    for (const name of await data.list())
      if (name.startsWith(`atlas-${PROFILE_ACCOUNT_PREFIX}`)) {
        data.close(name.slice("atlas-".length));
        await data.host.delete(name);
        n += 1;
      }
    return { n, error: null };
  } catch (error) {
    return { n, error: String(error).slice(0, 160) };
  }
}

/** An interrupted attempt, recorded as `killed` with the identity its reservation held (its capture's hash for W2). */
function killedRun(
  e: Envelope,
  name: string,
  run: number,
  at: string,
  why = "the page reloaded before the run finished (tab or process killed?)",
): ProfileRun {
  return {
    workload: name,
    run,
    cold: true,
    expected: name.startsWith("W7-") ? "refused" : "admitted",
    outcome: "killed",
    detail: `${why}; reserved at ${at}`,
    sha256: name === W2 ? (e.w2sha256 ?? "") : (recordedHash.get(name) ?? ""),
    sha256_verified: false,
    bytes: 0,
    elapsed_ms: 0,
    scan_ms: null,
    commit_ms: null,
    request_count: 0,
    limit: null,
    changes_written: null,
    cursor_after: null,
    heap_baseline_bytes: null,
    heap_peak_bytes: null,
    heap_after_bytes: null,
    user_agent: navigator.userAgent,
    at: new Date().toISOString(),
  };
}

/** A run whose own work threw: recorded as an `error` attempt with what it threw (its reservation ends with it, never left dangling). */
function thrownRun(e: Envelope, attempt: Attempt, error: unknown): ProfileRun {
  return {
    ...killedRun(e, attempt.name, attempt.run, ""),
    outcome: "error",
    detail: `the run threw: ${String(error).slice(0, 200)}`,
  };
}

/** The origin-wide collector guard (review 3 R5): ONE Web Lock for every page of this origin, whatever collection it would touch. */
export const COLLECTOR_LOCK = "atlas-profile-collector";
const NO_LOCKS =
  "this browser has no Web Locks (navigator.locks), so the page cannot establish that it is the only collector on this origin: it collects and changes nothing";
const BUSY =
  "another live page is collecting on this origin (another tab, or a duplicate of this one): this page only reads.";
const BUSY_ACTION =
  "a live page is collecting on this origin (another tab, or a duplicate of this one): wait for it to finish, or close it";

interface Guard {
  available: boolean;
  held(): boolean;
  hold(): Promise<boolean>;
  release(): void;
  scoped<T>(
    action: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }>;
}

/**
 * A collecting page HOLDS the guard from before it reads or creates either envelope until it is navigated away or closed (a reload
 * releases it; the next page waits briefly for it), so a second live page (another tab, or a duplicate of this one carrying the same
 * owner token) never collects beside it. A discrete action (restoring a capture, a take-over, clear, delete) runs under the guard for its
 * whole duration: the page's own when it holds it, otherwise one taken for that action alone. Without Web Locks nothing is collected or
 * changed: exclusion cannot be established, and it is never assumed.
 */
function collectorGuard(): Guard {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  let release: (() => void) | null = null;
  const take = () =>
    new Promise<boolean>((resolve) => {
      if (!locks) {
        resolve(false);
        return;
      }
      locks
        .request(COLLECTOR_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          return new Promise<void>((done) => {
            release = done;
            resolve(true);
          });
        })
        .catch(() => resolve(false));
    });
  return {
    available: Boolean(locks),
    held: () => release !== null,
    async hold() {
      if (release) return true;
      for (let i = 0; i < 20; i += 1) {
        if (await take()) return true;
        await sleep(150);
      }
      return false;
    },
    release() {
      const done = release;
      release = null;
      done?.();
    },
    async scoped<T>(action: () => Promise<T>) {
      if (release) return { ok: true as const, value: await action() };
      if (!locks) return { ok: false as const };
      let value: T | undefined;
      const granted = await locks.request(
        COLLECTOR_LOCK,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return false;
          value = await action();
          return true;
        },
      );
      return granted
        ? { ok: true as const, value: value as T }
        : { ok: false as const };
    },
  };
}

export async function mountProfilePage(data: DataHarness): Promise<void> {
  const root = document.getElementById("neutral-root") ?? document.body;
  root.replaceChildren();
  const params = new URLSearchParams(location.search);
  const status = el("p", { id: "profile-status" }, "Ready.");
  const ownership = el("p", { id: "profile-ownership" });
  const out = el("pre", { id: "profile-results" });
  // The tab's owner token: a tab whose sessionStorage refuses it only reads (nothing it does could be told apart from another tab's).
  let owner = "";
  let ownerError = "";
  try {
    owner = tabToken(sessionStorage, () => crypto.randomUUID());
  } catch (error) {
    ownerError = String(error).slice(0, 160);
  }
  const page = crypto.randomUUID();
  const guard = collectorGuard();
  // Results of runs whose reservation was gone when they finished: shown, never stored (design assessment D4).
  const stale: unknown[] = [];
  // One operation of this page at a time (its collection and its buttons), so none interleaves with another of the same page.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
  const now = () => new Date().toISOString();
  const readProtocol = () => readEnvelope(localStorage, PROTOCOL_KEY);
  const readManual = () => readEnvelope(localStorage, MANUAL_KEY);
  const readBoth = (): Collections => ({
    protocol: readProtocol(),
    manual: readManual(),
  });
  const shown = (read: Read) =>
    read.state === "present"
      ? exportResults(read.envelope)
      : read.state === "corrupt"
        ? { unreadable: read.error, raw: read.raw }
        : null;
  // The display shows each collection's owner, next attempt and reservation too (revision 4, R5b): what a recovery would act on.
  const refresh = () => {
    out.textContent = JSON.stringify(
      {
        protocol: exportDiagnostic(readProtocol()),
        manual: exportDiagnostic(readManual()),
      },
      null,
      2,
    );
  };
  /** A raw snapshot of both collections and of this page, for an operator's diagnostic copy (revision 4, B5). */
  const snapshot = () => {
    const raw = (key: string) => {
      try {
        return localStorage.getItem(key);
      } catch (error) {
        return `unreadable: ${String(error).slice(0, 160)}`;
      }
    };
    return {
      taken_at: new Date().toISOString(),
      page,
      owner_token: owner || null,
      collecting: guard.held(),
      protocol: exportDiagnostic(readProtocol()),
      manual: exportDiagnostic(readManual()),
      raw: { [PROTOCOL_KEY]: raw(PROTOCOL_KEY), [MANUAL_KEY]: raw(MANUAL_KEY) },
      results_not_stored: stale,
    };
  };
  // Who owns what, for BOTH collections (revision 4, R5b): a page that does not own a collection says so and offers only reading (and
  // the explicit take-over or recovery).
  const describeCollection = (kind: "protocol" | "manual", read: Read) => {
    if (read.state === "corrupt")
      return `The stored ${kind} collection is unreadable.`;
    if (read.state !== "present") return "";
    const e = read.envelope;
    const count =
      e.kind === "protocol"
        ? `${e.runs.length} of ${e.plan.length} attempts recorded`
        : `${e.runs.length} attempt(s) recorded`;
    const reserved = e.reserved
      ? `; ${e.reserved.name} run ${e.reserved.run} reserved at ${e.reserved.at}`
      : "";
    if (e.terminal)
      return `The ${kind} collection ${e.protocol_id} is ${e.terminal} (${count}).`;
    return e.owner === owner
      ? `This tab owns ${kind} collection ${e.protocol_id} (${count}${reserved}).`
      : `The ${kind} collection ${e.protocol_id} is owned by another tab (${count}${reserved}). This page does not run, recover, clear or delete it; "Take over or recover" is only for a tab that is gone.`;
  };
  const showOwnership = () => {
    ownership.textContent = [
      describeCollection("protocol", readProtocol()),
      describeCollection("manual", readManual()),
    ]
      .filter(Boolean)
      .join(" ");
  };
  // The operator's choice of collection for take-over, copying, clearing and capture restoration (revision 4, B1).
  const target = el(
    "select",
    { id: "profile-target" },
    el("option", { value: "auto" }, "The one the action applies to"),
    el("option", { value: "protocol" }, "The protocol"),
    el("option", { value: "manual" }, "The manual collection"),
  );
  const targetOf = (): Target =>
    target.value === "protocol" || target.value === "manual"
      ? target.value
      : "auto";
  // What was copied (or cleared) is also shown here, so a refused clipboard never loses it.
  const exported = el("textarea", {
    id: "profile-export",
    readOnly: true,
    rows: 6,
  });
  // The collected results are readable from the moment the page mounts (a run in progress included); `done` once the page settled.
  (window as unknown as { __profile: unknown }).__profile = {
    results: () => shown(readProtocol()),
    manual: () => shown(readManual()),
    diagnostic: () => snapshot(),
    exported: () => exported.value,
    owner: () => owner,
    collecting: () => guard.held(),
    stale: () => stale,
    done: false,
  };
  root.append(
    el("h1", {}, "Atlas profiling harness (fixture only)"),
    el(
      "p",
      {},
      "Each page load is ONE cold run. Not a product page; it is never packaged. Read docs/profiling-devices.md first.",
    ),
    status,
    ownership,
  );
  // Another tab's writes show here as they happen (a display only: every action still decides on what is stored when it runs).
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith("atlas-profile")) {
      refresh();
      showOwnership();
    }
  });

  const protocol = params.get("protocol") === "1";
  const wanted = params.get("w");
  const capture = captureFrom(params);
  const plan = protocolPlan(
    NAMES,
    (name) => (name === W2 || VALID_ENGINE_RUNS.includes(name) ? RUNS : 1),
    capture !== null,
  );
  const stop = (why: string) => {
    status.textContent = `Stopped: ${why}`;
    return null;
  };

  /**
   * Runs this page's attempt of a collection the page owns, under the collector guard: recover an interrupted one first, reserve, run,
   * and store the result only into the reservation this page made (its permit), never into whatever is stored by then.
   */
  const drive = async (
    key: string,
    first: Read,
    attemptOf: (e: Envelope) => { attempt: Attempt; index: number } | null,
  ): Promise<Envelope | null> => {
    let read = first;
    const decision = decide(read, owner);
    if (decision.action === "corrupt")
      return stop(
        `the stored collection is unreadable (${decision.error}); copy it below, then clear it explicitly. Nothing was changed.`,
      );
    if (decision.action === "foreign")
      return stop(
        `collection ${decision.envelope.protocol_id} belongs to another tab: this page does not run, recover or change it (use "Take over or recover" only if that tab is gone).`,
      );
    if (decision.action === "terminal") return decision.envelope;
    if (decision.action === "start") return stop("no collection to run");
    // "recover" or "ready": this tab owns the collection, and this page holds the collector guard.
    let e = decision.envelope;
    if (read.state !== "present") return stop("the collection vanished");
    if (e.reserved) {
      // The owner's own interrupted attempt: the same transition as a recovery, without a take-over (revision 4, B2).
      const reserved = e;
      const written = compareAndSet(
        localStorage,
        key,
        read.raw,
        recoverAbandoned(e, owner, now(), (r) =>
          killedRun(reserved, r.name, r.run, r.at),
        ),
      );
      if (!written.ok) return stop(written.error);
      e = written.envelope;
      read = readEnvelope(localStorage, key);
      if (read.state !== "present") return stop("the collection vanished");
    }
    const next = attemptOf(e);
    if (!next || e.terminal) return e;
    const reservedEnvelope = reserve(e, next.index, next.attempt, page, now());
    const reserved = compareAndSet(
      localStorage,
      key,
      read.raw,
      reservedEnvelope,
    );
    if (!reserved.ok) return stop(reserved.error);
    const permit: Permit = {
      protocol_id: e.protocol_id,
      owner,
      reservation: reservedEnvelope.reserved as Reservation,
    };
    status.textContent = `Running ${next.attempt.name} (run ${next.attempt.run}) ...`;
    const source: CaptureSource | null = e.w2sha256
      ? { sha256: e.w2sha256 }
      : null;
    let record: ProfileRun;
    try {
      record = await runOne(data, next.attempt.name, next.attempt.run, source);
    } catch (error) {
      record = thrownRun(e, next.attempt, error);
    }
    const before = readEnvelope(localStorage, key);
    const late = permitProblem(before, permit);
    if (late !== null || before.state !== "present") {
      stale.push({ permit, record, why: late });
      return stop(
        `the result of ${record.workload} run ${record.run} was NOT stored: ${late}. It is kept on this page only (window.__profile.stale()), never added to what is stored now.`,
      );
    }
    const stored = compareAndSet(
      localStorage,
      key,
      before.raw,
      complete(before.envelope, record, now()),
    );
    if (!stored.ok) return stop(`the result was NOT stored: ${stored.error}`);
    status.textContent = `${record.workload} run ${record.run}: ${record.outcome} (expected ${record.expected}), ${record.elapsed_ms} ms, hash ${record.sha256_verified ? "verified" : "MISMATCH"}`;
    return stored.envelope;
  };

  /** Takes the collector guard for this page's life, or says why not (nothing is read for a decision, or written, before it). */
  const becomeCollector = async (): Promise<boolean> => {
    if (!guard.available) return stop(NO_LOCKS) ?? false;
    if (!(await guard.hold())) return stop(BUSY) ?? false;
    return true;
  };
  /** A collecting page that stopped (or finished) lets go of the guard: it will do nothing more. */
  const finish = (): void => guard.release();

  const protocolRoute = async (): Promise<void> => {
    // A first look, read only, for the refusals a reader can be given at once.
    const look = readProtocol();
    if (
      look.state === "present" &&
      !look.envelope.terminal &&
      look.envelope.owner !== owner
    ) {
      stop(
        `collection ${look.envelope.protocol_id} belongs to another tab: this page does not run, recover or change it (use "Take over or recover" only if that tab is gone).`,
      );
      return;
    }
    if (look.state === "present" && look.envelope.terminal) {
      status.textContent = `Collection ${look.envelope.protocol_id} is ${look.envelope.terminal}: copy its results, then clear them before starting another.${look.envelope.terminal === "complete" ? " Protocol complete: copy the results below." : ""}`;
      return;
    }
    if (!(await becomeCollector())) return;
    // Under the guard, what is stored NOW decides (both collections).
    const admitted = admission("protocol", readProtocol(), readManual());
    if (!admitted.ok) {
      stop(admitted.why);
      return finish();
    }
    let read = readProtocol();
    if (read.state === "absent") {
      const started = compareAndSet(
        localStorage,
        PROTOCOL_KEY,
        null,
        newEnvelope({
          kind: "protocol",
          protocolId: crypto.randomUUID(),
          owner,
          workloadVersion: WORKLOAD_VERSION,
          w2sha256: capture?.sha256 ?? null,
          plan,
          machine: machine(),
          now: now(),
        }),
      );
      if (!started.ok) {
        stop(started.error);
        return finish();
      }
      read = readProtocol();
    }
    if (read.state !== "present") {
      stop("the collection vanished");
      return finish();
    }
    if (
      read.envelope.owner === owner &&
      (capture?.sha256 ?? null) !== read.envelope.w2sha256
    ) {
      status.textContent = `Stopped: this collection runs W2 capture ${read.envelope.w2sha256 ?? "(none)"}; the URL names ${capture?.sha256 ?? "none"}. The plan and capture never change after it starts.`;
      return finish();
    }
    if (read.envelope.terminal) {
      status.textContent = `Collection ${read.envelope.protocol_id} is ${read.envelope.terminal}: copy its results, then clear them before starting another.`;
      return finish();
    }
    const after = await drive(PROTOCOL_KEY, read, (e) =>
      e.plan[e.next]
        ? { attempt: e.plan[e.next] as Attempt, index: e.next }
        : null,
    );
    if (after?.terminal === "complete") {
      status.textContent += " Protocol complete: copy the results below.";
      finish();
    } else if (after && !after.terminal)
      // A fresh page load for the next run, so every run is cold; this page keeps the guard until it is replaced.
      setTimeout(() => location.reload(), 600);
    else finish();
  };

  const manualRoute = async (name: string): Promise<void> => {
    // The attempt's identity is checked before anything is reserved: a workload of this page and a run number.
    const runParam = params.get("run") ?? "1";
    if (!NAMES.includes(name) && name !== W2) {
      stop(
        `"${name}" is not a workload of this page: nothing was run or written.`,
      );
      return;
    }
    if (!/^[1-9][0-9]{0,3}$/.test(runParam)) {
      stop(
        `run "${runParam}" is not a run number: nothing was run or written.`,
      );
      return;
    }
    const run = Number(runParam);
    const look = admission("manual", readProtocol(), readManual());
    if (!look.ok) {
      stop(look.why);
      return;
    }
    if (!(await becomeCollector())) return;
    const admitted = admission("manual", readProtocol(), readManual());
    if (!admitted.ok) {
      stop(admitted.why);
      return finish();
    }
    let read = readManual();
    if (read.state === "absent") {
      const started = compareAndSet(
        localStorage,
        MANUAL_KEY,
        null,
        newEnvelope({
          kind: "manual",
          protocolId: `manual-${crypto.randomUUID()}`,
          owner,
          workloadVersion: WORKLOAD_VERSION,
          w2sha256: capture?.sha256 ?? null,
          plan: [],
          machine: machine(),
          now: now(),
        }),
      );
      if (!started.ok) {
        stop(started.error);
        return finish();
      }
      read = readManual();
    }
    if (read.state !== "present") {
      stop("the collection vanished");
      return finish();
    }
    const e0 = read.envelope;
    if (
      e0.owner === owner &&
      (capture?.sha256 ?? null) !== e0.w2sha256 &&
      name === W2
    ) {
      status.textContent = `Stopped: this manual collection runs W2 capture ${e0.w2sha256 ?? "(none)"}; the URL names ${capture?.sha256 ?? "none"}.`;
      return finish();
    }
    if (
      e0.owner === owner &&
      e0.runs.some((r) => r.workload === name && r.run === run)
    ) {
      stop(
        `${name} run ${run} is already recorded in this collection (the next unused run is ${nextUnusedRun(e0, name)}): nothing was run or written.`,
      );
      return finish();
    }
    // The identity is checked AGAIN after drive has recorded any interrupted attempt (revision 4, R5a/B3): a reloaded link whose own
    // reservation was just recorded as killed is never run a second time under the same identity.
    let used = false;
    let recorded: { outcome: string; next: number } | null = null;
    const after = await drive(MANUAL_KEY, read, (e) => {
      if (used) return null;
      used = true;
      const held = e.runs.find((r) => r.workload === name && r.run === run);
      if (held) {
        recorded = { outcome: held.outcome, next: nextUnusedRun(e, name) };
        return null;
      }
      return { attempt: { name, run }, index: e.next };
    });
    const duplicate = recorded as { outcome: string; next: number } | null;
    if (after && duplicate) {
      status.textContent = `${name} run ${run} is recorded (${duplicate.outcome}${duplicate.outcome === "killed" ? ": its attempt was interrupted and is never run again under its identity" : ""}): nothing was run. The next unused run is ${duplicate.next}.`;
      return finish();
    }
    // A manual page that ran keeps the guard until it is navigated away (the operator's next link); one that stopped lets it go.
    if (!after) finish();
  };

  await serial(async () => {
    if (!protocol && !wanted) return;
    if (!owner) {
      stop(
        `this tab's owner token cannot be kept in sessionStorage (${ownerError}): this page only reads.`,
      );
      return;
    }
    if (protocol) await protocolRoute();
    else if (wanted) await manualRoute(wanted);
  });
  showOwnership();

  const menu = el("ul", {});
  const manual = readManual();
  const manualEnvelope = manual.state === "present" ? manual.envelope : null;
  for (const name of capture ? [...NAMES, W2] : NAMES)
    menu.append(
      el(
        "li",
        {},
        el(
          "a",
          {
            href: `?w=${encodeURIComponent(name)}&run=${nextUnusedRun(manualEnvelope, name)}${captureQuery(capture)}`,
          },
          name,
        ),
      ),
    );
  /** The collections a clear is for: the chosen one, or both (revision 4, B5: clear is scoped). Deleting databases always checks both. */
  const kindsOf = (which: Target): Array<"protocol" | "manual"> =>
    which === "auto" ? ["protocol", "manual"] : [which];
  /** Why this page may not clear `kinds` or delete now (null: it may), from what is stored. */
  const refusal = (kinds: Array<"protocol" | "manual">): string | null => {
    if (!owner) return "this tab has no owner token";
    for (const kind of kinds) {
      const may = mayClear(readEnvelope(localStorage, KEY_OF[kind]), owner);
      if (!may.ok) return may.why;
    }
    return null;
  };
  /** A clear or delete: refused at once if ownership says so, then done under the guard after looking again. */
  const guardedClean =
    (
      kindsAt: () => Array<"protocol" | "manual">,
      action: (kinds: Array<"protocol" | "manual">) => Promise<string>,
    ) =>
    (): Promise<void> =>
      serial(async () => {
        const kinds = kindsAt();
        const refused = refusal(kinds);
        if (refused) {
          status.textContent = `Refused: ${refused}.`;
          return;
        }
        if (!guard.available) {
          status.textContent = `Refused: ${NO_LOCKS}.`;
          return;
        }
        const done = await guard.scoped(async () => {
          const again = refusal(kinds);
          return again ? `Refused: ${again}.` : action(kinds);
        });
        status.textContent = done.ok ? done.value : `Refused: ${BUSY_ACTION}.`;
      });

  /**
   * The W2 capture. The file is read and hashed first; then, under the guard, what is stored decides (revision 4, R5b): every unfinished
   * collection that pins a capture is consulted (`captureDecision`): with none the capture is kept for this tab; otherwise only the
   * owner restores exactly a collection's pinned capture, a file that is not a pin never replaces one, and two different pins need the
   * chosen "Collection". Acknowledged only after the kept record reads back and every restored collection is still what it was.
   */
  const pickCapture = (file: File): Promise<void> =>
    serial(async () => {
      let bytes: Uint8Array;
      let sha256: string;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        sha256 = await sha256Bytes(bytes);
      } catch (error) {
        status.textContent = `The W2 capture could not be read (the kept one, if any, is unchanged): ${String(error).slice(0, 160)}`;
        return;
      }
      if (!owner) {
        status.textContent =
          "The W2 capture was NOT kept: this tab has no owner token.";
        return;
      }
      if (!guard.available) {
        status.textContent = `The W2 capture was NOT kept: ${NO_LOCKS}.`;
        return;
      }
      const which = targetOf();
      const done = await guard.scoped(async () => {
        const decision = captureDecision(readBoth(), owner, sha256, which);
        if (decision.action === "refuse")
          return `The W2 capture was NOT replaced: ${decision.why}.`;
        try {
          const kept = await keepCapture(bytes, sha256, file.name);
          if (decision.action === "keep")
            return `W2 capture kept: ${kept.name}, ${kept.bytes} bytes, SHA-256 ${kept.sha256}`;
          // After the read-back, every restored collection must still be the one whose capture this restores.
          const current = readBoth();
          const moved = decision.restored.filter((r) => {
            const read = current[r.kind];
            return (
              read.state !== "present" ||
              read.envelope.protocol_id !== r.envelope.protocol_id ||
              read.envelope.owner !== owner ||
              read.envelope.w2sha256 !== sha256
            );
          });
          if (moved.length)
            return `The W2 capture was written, but the ${moved.map((m) => m.kind).join(" and ")} collection changed meanwhile: this tab keeps ${kept.name} (SHA-256 ${kept.sha256}); look at the collections again before a W2 run.`;
          const ids = decision.restored
            .map((r) => r.envelope.protocol_id)
            .join(" and ");
          const displaced = decision.displaced.length
            ? ` NOTE: this tab no longer keeps the capture of ${decision.displaced.map((d) => `${d.kind} collection ${d.envelope.protocol_id} (SHA-256 ${d.envelope.w2sha256})`).join(", ")}: pick that file again (with "Collection" set to it) before its next W2 run.`
            : "";
          return `W2 capture restored for collection ${ids}: ${kept.name}, ${kept.bytes} bytes, SHA-256 ${kept.sha256} (exactly the collection's capture; its plan, results and take-overs are unchanged). Open its link to continue.${displaced}`;
        } catch (error) {
          if (error instanceof CaptureKeepError && error.phase === "verify")
            return `The W2 capture was written but did NOT read back as picked: what this tab keeps is now UNCERTAIN (${error.message}); pick the file again before a W2 run.`;
          return `The W2 capture could not be kept (the previous one, if any, is unchanged): ${String(error).slice(0, 160)}`;
        }
      });
      status.textContent = done.ok
        ? done.value
        : `The W2 capture was NOT kept: ${BUSY_ACTION}.`;
    });

  /**
   * The explicit take-over or recovery of the chosen collection (revision 4, R5/B2): under the guard, the protocol or manual collection a
   * gone tab owns moves to this tab with a recorded take-over, and an attempt its page left reserved is recorded as one `killed` result in
   * the same write (this tab's own interrupted attempt is recorded without a take-over). Nothing runs; a live collecting page refuses it.
   */
  const takeOverOrRecover = (): Promise<void> =>
    serial(async () => {
      if (!owner) {
        status.textContent = "Not taken over: this tab has no owner token.";
        return;
      }
      const which = targetOf();
      const first = recoveryTarget(readBoth(), owner, which);
      if (!first.ok) {
        status.textContent = `Not taken over: ${first.why}.`;
        return;
      }
      if (!guard.available) {
        status.textContent = `Not taken over: ${NO_LOCKS}.`;
        return;
      }
      const done = await guard.scoped(async () => {
        const again = recoveryTarget(readBoth(), owner, which);
        if (!again.ok) return `Not taken over: ${again.why}.`;
        if (again.key !== first.key || again.read.raw !== first.read.raw)
          return "Not taken over: the stored collection changed; look at it again.";
        const e = again.read.envelope;
        const moved = compareAndSet(
          localStorage,
          again.key,
          again.read.raw,
          recoverAbandoned(e, owner, now(), (r) =>
            killedRun(
              e,
              r.name,
              r.run,
              r.at,
              e.owner === owner
                ? "its page ended before the attempt finished; recorded by this tab's recovery"
                : "its tab was lost before the attempt finished; recorded by this tab's take-over",
            ),
          ),
        );
        if (!moved.ok) return `Not taken over: ${moved.error}`;
        refresh();
        showOwnership();
        const m = moved.envelope;
        const head =
          e.owner === owner
            ? `This tab recovered collection ${m.protocol_id} (the ${again.kind} collection).`
            : `This tab now owns collection ${m.protocol_id} (recorded; the ${again.kind} collection).`;
        const killed = e.reserved
          ? ` Its interrupted attempt ${e.reserved.name} run ${e.reserved.run} is recorded as killed; it is never run again under that identity.`
          : "";
        const w2 = m.w2sha256
          ? ` Its W2 capture was kept only in the lost tab: choose the same file again (SHA-256 ${m.w2sha256}) to restore it here, then open its link to continue.`
          : "";
        const next =
          again.kind === "protocol"
            ? " Open the protocol link to continue."
            : " A further manual run takes an unused run number (the menu's links).";
        return `${head}${killed}${w2 || next}`;
      });
      status.textContent = done.ok
        ? done.value
        : "Not taken over: a live page is collecting on this origin (the collection's own page, or another tab); a take-over is only for a tab that is gone. Close or navigate that page first.";
    });

  /** Copies `text` and shows it in the box (the box keeps it when the clipboard refuses). */
  const copy = async (text: string, what: string): Promise<void> => {
    exported.value = text;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `Copied ${what}.`;
    } catch (error) {
      status.textContent = `The clipboard refused (${String(error).slice(0, 80)}): ${what} is in the box below; copy it from there.`;
    }
  };

  root.append(
    el("h2", {}, "Run"),
    el(
      "a",
      { href: `?protocol=1${captureQuery(capture)}` },
      capture
        ? "Start the full protocol (every workload, W2 included, five cold runs of each valid one)"
        : "Start the full protocol (every workload, five cold runs of each valid one; NO W2: choose the capture and name its w2sha256, see docs/profiling-devices.md)",
    ),
    el("h2", {}, "W2 capture"),
    el(
      "label",
      { htmlFor: "w2-capture" },
      "The hand-over's W2 capture (fixtures/W2-captured.<engine>.limit-1.json); it is kept in this tab for every W2 run",
    ),
    el("input", {
      type: "file",
      id: "w2-capture",
      accept: "application/json,.json",
      onchange: (event: Event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) void pickCapture(file);
      },
    }),
    menu,
    el("h2", {}, "Results"),
    el(
      "label",
      { htmlFor: "profile-target" },
      "Collection (for copying, clearing, take-over and restoring a capture)",
    ),
    target,
    el(
      "button",
      {
        type: "button",
        id: "profile-copy",
        onclick: () =>
          void serial(async () => {
            // The protocol's results file (what the validator reads); a manual collection as its diagnostic export, never a results file.
            const which = targetOf();
            const kind =
              which !== "auto"
                ? which
                : readProtocol().state !== "absent"
                  ? "protocol"
                  : "manual";
            const read = readEnvelope(localStorage, KEY_OF[kind]);
            await copy(
              JSON.stringify(
                kind === "protocol" ? shown(read) : exportDiagnostic(read),
                null,
                2,
              ),
              kind === "protocol"
                ? "the protocol's results"
                : "the manual collection (a diagnostic export)",
            );
          }),
      },
      "Copy results JSON",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-copy-diagnostic",
        onclick: () =>
          void serial(() =>
            copy(
              JSON.stringify(snapshot(), null, 2),
              "a diagnostic snapshot of both collections",
            ),
          ),
      },
      "Copy diagnostic snapshot",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-clear",
        onclick: guardedClean(
          () => kindsOf(targetOf()),
          async (kinds) => {
            // What is removed is shown in the box first: a clear never discards a collection the page has not shown.
            const raw: Record<string, string | null> = {};
            for (const kind of kinds)
              try {
                raw[KEY_OF[kind]] = localStorage.getItem(KEY_OF[kind]);
              } catch {
                raw[KEY_OF[kind]] = null;
              }
            exported.value = JSON.stringify(
              { cleared_at: now(), raw },
              null,
              2,
            );
            const removed: string[] = [];
            const failures: string[] = [];
            for (const kind of kinds)
              try {
                localStorage.removeItem(KEY_OF[kind]);
                removed.push(kind);
              } catch (error) {
                failures.push(`${kind} (${String(error).slice(0, 120)})`);
              }
            refresh();
            showOwnership();
            if (failures.length)
              return `NOT fully cleared: ${removed.length ? `removed ${removed.join(" and ")}; ` : ""}NOT removed ${failures.join("; ")}. What was stored is in the box below.`;
            return kinds.length === 2
              ? "Results cleared."
              : `Results cleared: the ${kinds[0]} collection only.`;
          },
        ),
      },
      "Clear results",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-delete-databases",
        onclick: guardedClean(
          () => ["protocol", "manual"],
          async () => {
            const deleted = await deleteProfileDatabases(data);
            return deleted.error
              ? `Deleting stopped after ${deleted.n} profiling database(s): ${deleted.error}`
              : `Deleted ${deleted.n} profiling database(s).`;
          },
        ),
      },
      "Delete profiling databases",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-take-over",
        onclick: () => void takeOverOrRecover(),
      },
      "Take over or recover the selected collection (only if its tab is gone)",
    ),
    el(
      "label",
      { htmlFor: "profile-export" },
      "What was last copied or cleared",
    ),
    exported,
    out,
  );
  refresh();
  (window as unknown as { __profile: { done: boolean } }).__profile.done = true;
}
