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

/**
 * FIXTURE ONLY (never packaged; `check-no-fixture`). The device profiling page, `/profile-harness` (plan 7.5). One COLD run of one
 * workload per page load: it regenerates the workload in the page, verifies its SHA-256 against the recorded hashes, runs the
 * production processing path on it, records what it saw, and appends the record to this origin's localStorage so a person with a
 * device can collect runs across loads and copy one results file.
 *
 *   /profile-harness                       a menu and the collected results
 *   /profile-harness?w=W1&run=1            one cold run (W1, W3, W4, W6, W5-limit-N, W7-<name>)
 *   /profile-harness?protocol=1            every workload, five cold runs each, one page load per run
 *
 * What this page is NOT: the transport is an in-page function that hands the body to the engine, so the real stamped wrapper's extra
 * buffer copy is NOT present (the desktop runs with the real wrapper quantify it); the engine writes to this device's real
 * IndexedDB; memory figures are what the page itself can see (`performance.memory` exists in Chromium only) and the platform's own
 * tool (Android `dumpsys meminfo`, Xcode Instruments, `about:memory`, a task manager) is to be noted beside each run.
 */
const STORAGE_KEY = "atlas-profile-results";
const PROTOCOL_KEY = "atlas-profile-protocol";
const RUNNING_KEY = "atlas-profile-running";
const RUNS = 5;
const VALID_ENGINE_RUNS = ["W1", "W3", "W4", "W6"];
const PROFILE_ACCOUNT_PREFIX = "fffffff0-0000-4000-8000-";

export interface ProfileRun {
  workload: string;
  run: number;
  cold: true;
  expected: "admitted" | "refused";
  outcome: "admitted" | "refused" | "error" | "timeout" | "killed";
  detail: string;
  sha256: string;
  sha256_verified: boolean;
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

interface Collected {
  schema: 1;
  workload_version: number;
  recorded_at: string;
  machine: Record<string, unknown>;
  runs: ProfileRun[];
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

function load(): Collected {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (parsed?.schema === 1 && Array.isArray(parsed.runs)) return parsed;
  } catch {
    // start again
  }
  return {
    schema: 1,
    workload_version: WORKLOAD_VERSION,
    recorded_at: new Date().toISOString(),
    machine: machine(),
    runs: [],
  };
}
function save(collected: Collected): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collected));
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

async function runOne(
  data: DataHarness,
  name: string,
  run: number,
): Promise<ProfileRun> {
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

export async function mountProfilePage(data: DataHarness): Promise<void> {
  const root = document.getElementById("neutral-root") ?? document.body;
  root.replaceChildren();
  const params = new URLSearchParams(location.search);
  const status = el("p", { id: "profile-status" }, "Ready.");
  const out = el("pre", { id: "profile-results" });
  const refresh = () => {
    out.textContent = JSON.stringify(load(), null, 2);
  };
  root.append(
    el("h1", {}, "Atlas profiling harness (fixture only)"),
    el(
      "p",
      {},
      "Each page load is ONE cold run. Not a product page; it is never packaged. Read docs/profiling-devices.md first.",
    ),
    status,
  );

  const protocol = params.get("protocol") === "1";
  const wanted = params.get("w");
  if (protocol && !localStorage.getItem(PROTOCOL_KEY))
    localStorage.setItem(PROTOCOL_KEY, "0");
  const step = Number(localStorage.getItem(PROTOCOL_KEY) ?? "-1");
  let target: { name: string; run: number } | null = null;
  const plan: Array<{ name: string; run: number }> = [];
  for (const name of NAMES)
    for (let r = 1; r <= (VALID_ENGINE_RUNS.includes(name) ? RUNS : 1); r += 1)
      plan.push({ name, run: r });
  if (wanted) target = { name: wanted, run: Number(params.get("run") ?? "1") };
  else if (step >= 0 && step < plan.length) target = plan[step] ?? null;

  // A run that started and never finished (the OS killed the tab) is a RESULT: record it, and the protocol moves on.
  const unfinished = localStorage.getItem(RUNNING_KEY);
  if (unfinished) {
    localStorage.removeItem(RUNNING_KEY);
    try {
      const was = JSON.parse(unfinished) as { name: string; run: number };
      const collected = load();
      collected.runs.push({
        workload: was.name,
        run: was.run,
        cold: true,
        expected: was.name.startsWith("W7-") ? "refused" : "admitted",
        outcome: "killed",
        detail:
          "the page reloaded before the run finished (tab or process killed?)",
        sha256: recordedHash.get(was.name) ?? "",
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
      });
      save(collected);
    } catch {
      // an unreadable marker is dropped
    }
  }

  if (target) {
    status.textContent = `Running ${target.name} (run ${target.run}) ...`;
    // The protocol's step moves on BEFORE the run, so a run that kills the tab is not repeated for ever.
    if (!wanted && step >= 0)
      localStorage.setItem(PROTOCOL_KEY, String(step + 1));
    localStorage.setItem(
      RUNNING_KEY,
      JSON.stringify({ name: target.name, run: target.run }),
    );
    const record = await runOne(data, target.name, target.run);
    localStorage.removeItem(RUNNING_KEY);
    const collected = load();
    collected.runs.push(record);
    collected.recorded_at = new Date().toISOString();
    save(collected);
    status.textContent = `${target.name} run ${target.run}: ${record.outcome} (expected ${record.expected}), ${record.elapsed_ms} ms, hash ${record.sha256_verified ? "verified" : "MISMATCH"}`;
    if (!wanted && step >= 0) {
      if (step + 1 < plan.length) {
        // A fresh page load for the next run, so every run is cold.
        setTimeout(() => location.reload(), 600);
      } else {
        localStorage.removeItem(PROTOCOL_KEY);
        status.textContent += " Protocol complete: copy the results below.";
      }
    }
  }

  const menu = el("ul", {});
  for (const name of NAMES)
    menu.append(
      el(
        "li",
        {},
        el(
          "a",
          {
            href: `?w=${encodeURIComponent(name)}&run=${load().runs.filter((r) => r.workload === name).length + 1}`,
          },
          name,
        ),
      ),
    );
  root.append(
    el("h2", {}, "Run"),
    el(
      "a",
      { href: "?protocol=1" },
      "Start the full protocol (every workload, five cold runs of each valid one)",
    ),
    menu,
    el("h2", {}, "Results"),
    el(
      "button",
      {
        type: "button",
        onclick: async () => {
          await navigator.clipboard.writeText(JSON.stringify(load(), null, 2));
          status.textContent = "Copied.";
        },
      },
      "Copy results JSON",
    ),
    el(
      "button",
      {
        type: "button",
        onclick: () => {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(PROTOCOL_KEY);
          localStorage.removeItem(RUNNING_KEY);
          refresh();
          status.textContent = "Results cleared.";
        },
      },
      "Clear results",
    ),
    el(
      "button",
      {
        type: "button",
        onclick: async () => {
          status.textContent = `Deleted ${await deleteProfileDatabases(data)} profiling database(s).`;
        },
      },
      "Delete profiling databases",
    ),
    out,
  );
  refresh();
  (window as unknown as { __profile: unknown }).__profile = {
    results: load,
    done: true,
  };
}
