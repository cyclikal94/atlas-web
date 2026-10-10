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
  type CaptureSource,
  captureFrom,
  captureQuery,
  loadCapture,
  protocolPlan,
  storeCapture,
  W2,
} from "./profile-capture";
import {
  type Attempt,
  compareAndSet,
  complete,
  decide,
  type Envelope,
  exportResults,
  MANUAL_KEY,
  mayClear,
  newEnvelope,
  PROTOCOL_KEY,
  type Read,
  readEnvelope,
  recoverInterrupted,
  reserve,
  tabToken,
  takeOver,
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
 * killed tab's attempt is recorded once, as `killed`, by the owner's next load, and nothing is skipped. Another tab (or a duplicate of the
 * owner's tab, which the page's Web Lock refuses) only reads and says why. The results file is the envelope's runs, all of one protocol.
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
    heap_peak_bytes: measured.peak,
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
async function deleteProfileDatabases(data: DataHarness): Promise<number> {
  let n = 0;
  for (const name of await data.list())
    if (name.startsWith(`atlas-${PROFILE_ACCOUNT_PREFIX}`)) {
      data.close(name.slice("atlas-".length));
      await data.host.delete(name);
      n += 1;
    }
  return n;
}

/** An interrupted attempt, recorded as `killed` with the identity its reservation held (its capture's hash for W2). */
function killedRun(
  e: Envelope,
  name: string,
  run: number,
  at: string,
): ProfileRun {
  return {
    workload: name,
    run,
    cold: true,
    expected: name.startsWith("W7-") ? "refused" : "admitted",
    outcome: "killed",
    detail: `the page reloaded before the run finished (tab or process killed?); reserved at ${at}`,
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

/**
 * Holds a Web Lock named for the collection for this page's whole life: a second live page with the same owner token (a duplicated tab
 * copies sessionStorage) does not get it and only reads. A reload releases the old page's lock; the new page waits briefly for it.
 */
async function holdPageLock(id: string): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return true;
  for (let i = 0; i < 20; i += 1) {
    const granted = await new Promise<boolean>((resolve) => {
      void locks.request(
        `atlas-profile-${id}`,
        { ifAvailable: true },
        (lock) => {
          resolve(lock !== null);
          return lock ? new Promise<void>(() => undefined) : undefined;
        },
      );
    });
    if (granted) return true;
    await sleep(150);
  }
  return false;
}

export async function mountProfilePage(data: DataHarness): Promise<void> {
  const root = document.getElementById("neutral-root") ?? document.body;
  root.replaceChildren();
  const params = new URLSearchParams(location.search);
  const status = el("p", { id: "profile-status" }, "Ready.");
  const ownership = el("p", { id: "profile-ownership" });
  const out = el("pre", { id: "profile-results" });
  const owner = tabToken(sessionStorage, () => crypto.randomUUID());
  const page = crypto.randomUUID();
  const now = () => new Date().toISOString();
  const readProtocol = () => readEnvelope(localStorage, PROTOCOL_KEY);
  const readManual = () => readEnvelope(localStorage, MANUAL_KEY);
  const shown = (read: Read) =>
    read.state === "present"
      ? exportResults(read.envelope)
      : read.state === "corrupt"
        ? { unreadable: read.error, raw: read.raw }
        : null;
  const refresh = () => {
    out.textContent = JSON.stringify(
      { protocol: shown(readProtocol()), manual: shown(readManual()) },
      null,
      2,
    );
  };
  // The collected results are readable from the moment the page mounts (a run in progress included); `done` once the page settled.
  (window as unknown as { __profile: unknown }).__profile = {
    results: () => shown(readProtocol()),
    manual: () => shown(readManual()),
    owner: () => owner,
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

  const protocol = params.get("protocol") === "1";
  const wanted = params.get("w");
  const capture = captureFrom(params);
  const plan = protocolPlan(
    NAMES,
    (name) => (name === W2 || VALID_ENGINE_RUNS.includes(name) ? RUNS : 1),
    capture !== null,
  );

  /** Runs this page's attempt of a collection the page owns: recover an interrupted one first, reserve, run, store. */
  const drive = async (
    key: string,
    first: Read,
    attemptOf: (e: Envelope) => { attempt: Attempt; index: number } | null,
  ): Promise<Envelope | null> => {
    let read = first;
    const stop = (why: string) => {
      status.textContent = `Stopped: ${why}`;
      return null;
    };
    const decision = decide(read, owner);
    if (decision.action === "corrupt")
      return stop(
        `the stored collection is unreadable (${decision.error}); copy it below, then clear it explicitly. Nothing was changed.`,
      );
    if (decision.action === "foreign")
      return stop(
        `collection ${decision.envelope.protocol_id} belongs to another tab: this page does not run, recover or change it (use "Take over" only if that tab is gone).`,
      );
    if (decision.action === "terminal") return decision.envelope;
    if (decision.action === "start") return stop("no collection to run");
    // "recover" or "ready": this tab owns the collection.
    let e = decision.envelope;
    if (!(await holdPageLock(e.protocol_id)))
      return stop(
        "another live page of this tab's collection holds it (a duplicated tab?): this page only reads.",
      );
    if (read.state !== "present") return stop("the collection vanished");
    if (e.reserved) {
      const r = e.reserved;
      const written = compareAndSet(
        localStorage,
        key,
        read.raw,
        recoverInterrupted(e, killedRun(e, r.name, r.run, r.at), now()),
      );
      if (!written.ok) return stop(written.error);
      e = written.envelope;
      read = readEnvelope(localStorage, key);
      if (read.state !== "present") return stop("the collection vanished");
    }
    const next = attemptOf(e);
    if (!next || e.terminal) return e;
    const reserved = compareAndSet(
      localStorage,
      key,
      read.raw,
      reserve(e, next.index, next.attempt, page, now()),
    );
    if (!reserved.ok) return stop(reserved.error);
    status.textContent = `Running ${next.attempt.name} (run ${next.attempt.run}) ...`;
    const source: CaptureSource | null = e.w2sha256
      ? { sha256: e.w2sha256 }
      : null;
    const record = await runOne(
      data,
      next.attempt.name,
      next.attempt.run,
      source,
    );
    const before = readEnvelope(localStorage, key);
    if (before.state !== "present")
      return stop("the collection vanished during the run");
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

  if (protocol) {
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
      if (!started.ok) status.textContent = `Stopped: ${started.error}`;
      read = readProtocol();
    }
    if (
      read.state === "present" &&
      read.envelope.owner === owner &&
      (capture?.sha256 ?? null) !== read.envelope.w2sha256
    )
      status.textContent = `Stopped: this collection runs W2 capture ${read.envelope.w2sha256 ?? "(none)"}; the URL names ${capture?.sha256 ?? "none"}. The plan and capture never change after it starts.`;
    else if (read.state === "present" && read.envelope.terminal) {
      status.textContent = `Collection ${read.envelope.protocol_id} is ${read.envelope.terminal}: copy its results, then clear them before starting another.${read.envelope.terminal === "complete" ? " Protocol complete: copy the results below." : ""}`;
    } else if (read.state !== "absent") {
      const after = await drive(PROTOCOL_KEY, read, (e) =>
        e.plan[e.next]
          ? { attempt: e.plan[e.next] as Attempt, index: e.next }
          : null,
      );
      if (after?.terminal === "complete")
        status.textContent += " Protocol complete: copy the results below.";
      else if (after && !after.terminal)
        // A fresh page load for the next run, so every run is cold.
        setTimeout(() => location.reload(), 600);
    }
  } else if (wanted) {
    let read = readManual();
    if (read.state === "absent") {
      compareAndSet(
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
      read = readManual();
    }
    if (
      read.state === "present" &&
      read.envelope.owner === owner &&
      (capture?.sha256 ?? null) !== read.envelope.w2sha256 &&
      wanted === W2
    )
      status.textContent = `Stopped: this manual collection runs W2 capture ${read.envelope.w2sha256 ?? "(none)"}; the URL names ${capture?.sha256 ?? "none"}.`;
    else {
      const once = {
        attempt: { name: wanted, run: Number(params.get("run") ?? "1") },
      };
      let used = false;
      await drive(MANUAL_KEY, read, (e) => {
        if (used) return null;
        used = true;
        return { ...once, index: e.next };
      });
    }
  }

  // Who owns what: a page that does not own the active collection says so and offers only reading (and the explicit take-over).
  const active = readProtocol();
  if (active.state === "present" && !active.envelope.terminal)
    ownership.textContent =
      active.envelope.owner === owner
        ? `This tab owns collection ${active.envelope.protocol_id} (${active.envelope.runs.length} of ${active.envelope.plan.length} attempts recorded).`
        : `Collection ${active.envelope.protocol_id} is owned by another tab (${active.envelope.runs.length} of ${active.envelope.plan.length} attempts recorded). This page does not run, recover, clear or delete anything.`;

  const menu = el("ul", {});
  const manual = readManual();
  const manualRuns = manual.state === "present" ? manual.envelope.runs : [];
  for (const name of capture ? [...NAMES, W2] : NAMES)
    menu.append(
      el(
        "li",
        {},
        el(
          "a",
          {
            href: `?w=${encodeURIComponent(name)}&run=${manualRuns.filter((r) => r.workload === name).length + 1}${captureQuery(capture)}`,
          },
          name,
        ),
      ),
    );
  const guarded = (action: () => void | Promise<void>) => async () => {
    for (const read of [readProtocol(), readManual()]) {
      const may = mayClear(read, owner);
      if (!may.ok) {
        status.textContent = `Refused: ${may.why}.`;
        return;
      }
    }
    await action();
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
      onchange: async (event: Event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) return;
        // The capture of an active collection never changes after it starts.
        const read = readProtocol();
        if (read.state === "present" && !read.envelope.terminal) {
          status.textContent =
            "The W2 capture was NOT replaced: a collection is active, and its capture never changes after it starts.";
          return;
        }
        try {
          const kept = await storeCapture(file, file.name);
          status.textContent = `W2 capture kept: ${kept.name}, ${kept.bytes} bytes, SHA-256 ${kept.sha256}`;
        } catch (error) {
          status.textContent = `The W2 capture could not be kept (the previous one, if any, is unchanged): ${String(error).slice(0, 160)}`;
        }
      },
    }),
    menu,
    el("h2", {}, "Results"),
    el(
      "button",
      {
        type: "button",
        onclick: async () => {
          const read = readProtocol();
          await navigator.clipboard.writeText(
            JSON.stringify(shown(read), null, 2),
          );
          status.textContent = "Copied.";
        },
      },
      "Copy results JSON",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-clear",
        onclick: guarded(() => {
          localStorage.removeItem(PROTOCOL_KEY);
          localStorage.removeItem(MANUAL_KEY);
          refresh();
          status.textContent = "Results cleared.";
        }),
      },
      "Clear results",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-delete-databases",
        onclick: guarded(async () => {
          status.textContent = `Deleted ${await deleteProfileDatabases(data)} profiling database(s).`;
        }),
      },
      "Delete profiling databases",
    ),
    el(
      "button",
      {
        type: "button",
        id: "profile-take-over",
        onclick: () => {
          const read = readProtocol();
          if (read.state !== "present" || read.envelope.terminal) return;
          if (read.envelope.owner === owner) return;
          const moved = compareAndSet(
            localStorage,
            PROTOCOL_KEY,
            read.raw,
            takeOver(read.envelope, owner, now()),
          );
          status.textContent = moved.ok
            ? "This tab now owns the collection (recorded). Open the protocol link to continue."
            : `Not taken over: ${moved.error}`;
        },
      },
      "Take over the active collection (only if its tab is gone)",
    ),
    out,
  );
  refresh();
  (window as unknown as { __profile: { done: boolean } }).__profile.done = true;
}
