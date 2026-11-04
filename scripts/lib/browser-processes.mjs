// Which processes are the browser a profiling test drives, for its resident memory (WEB-09c review finding R4). Chromium's and Firefox's
// renderers and helpers are descendants of the browser the test worker launched. Playwright WebKit on macOS is different: its WebContent,
// Networking and GPU processes are XPC services that launchd starts (their parent is launchd, pid 1), so a walk down the worker's tree
// misses the very process that scans and allocates the page. They are found here through launchd's own record: every XPC service an app
// starts is bootstrapped in that app's PID domain, and `launchctl print pid/<host>` lists the domain's services with their pids (no root
// needed). A service is counted only when its pid is still the same process (a WebKit XPC executable of the same Playwright bundle as its
// host, started no earlier than the host), so a reused pid or another session's WebKit is never counted.
//
// Another WebKit session (another test run, Safari, Mail) is never in this host's domain: it is excluded by construction, not by a guess
// about who else is running. When launchd cannot be read for a host, the sample is INCOMPLETE and says why; it is never filled with zero.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

export const WEBKIT_HOST =
  /\/Playwright\.app\/Contents\/MacOS\/Playwright(\s|$)/;
export const WEBKIT_XPC =
  /\/com\.apple\.WebKit\.[A-Za-z]+\.xpc\/Contents\/MacOS\/com\.apple\.WebKit\.[A-Za-z.]+$/;
/** The sampling commands themselves are children of the worker while they run; they are not the browser. */
const SAMPLER_COMMAND = /^(\/bin\/)?ps\s|^(\/bin\/)?launchctl\s/;

export const SCOPE_DESCENDANTS =
  "the processes descending from the test worker (the browser and every child it started)";
export const SCOPE_WITH_LAUNCHD =
  "the processes descending from the test worker, plus every service in each Playwright WebKit host's launchd PID domain (launchctl print pid/<host>: WebContent, Networking, GPU), each checked to be a WebKit XPC executable of the host's own bundle started no earlier than the host";

/** `ps -axo pid=,ppid=,rss=,lstart=,command=` (C locale) as rows; `start` is the process's start (lstart, five words). */
export function parsePs(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 9) continue;
    const [pid, ppid, rss, ...rest] = words;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rss_kib: Number(rss),
      start: rest.slice(0, 5).join(" "),
      command: rest.slice(5).join(" "),
    });
  }
  return rows.filter(
    (r) =>
      Number.isInteger(r.pid) &&
      Number.isInteger(r.ppid) &&
      Number.isFinite(r.rss_kib),
  );
}

/** The `services = { ... }` block of `launchctl print pid/<pid>`: every service that has a running process. */
export function parseLaunchdServices(text) {
  const block = /\n\s*services = \{\n([\s\S]*?)\n\s*\}/.exec(`\n${text}`);
  if (!block) return null;
  const services = [];
  for (const line of block[1].split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+(\S+)\s*$/.exec(line);
    if (m && Number(m[1]) > 0)
      services.push({ pid: Number(m[1]), label: m[2] });
  }
  return services;
}

const bundleOf = (command) => {
  const executable = command.split(/\s+--/)[0];
  const at = executable.search(
    /\/(Playwright\.app|com\.apple\.WebKit\.[A-Za-z]+\.xpc)\//,
  );
  return at < 0 ? null : executable.slice(0, at);
};
const startMs = (start) => Date.parse(start);

/**
 * The browser's processes under `rootPid` (pure: `rows` from parsePs, `servicesOf(hostPid)` returning `{ ok, services, error }`). Returns
 * the resident set in KiB, every counted process with its role and identity, the scope, whether the inventory is complete, and why not.
 */
export function browserInventory(rows, rootPid, { servicesOf }) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map();
  for (const r of rows)
    children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const counted = new Map();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const r = stack.pop();
    if (counted.has(r.pid)) continue;
    if (!SAMPLER_COMMAND.test(r.command))
      counted.set(r.pid, { ...r, role: "descendant" });
    stack.push(...(children.get(r.pid) ?? []));
  }
  const errors = [];
  const hosts = [...counted.values()].filter((r) =>
    WEBKIT_HOST.test(r.command),
  );
  for (const host of hosts) {
    const listed = servicesOf(host.pid);
    if (!listed.ok) {
      errors.push(
        `launchd PID domain of WebKit host ${host.pid} unreadable: ${listed.error}`,
      );
      continue;
    }
    const bundle = bundleOf(host.command);
    for (const service of listed.services) {
      const row = byPid.get(service.pid);
      // A service that ended between the two reads is simply gone; a pid now held by something else is not counted.
      if (!row) continue;
      if (
        !WEBKIT_XPC.test(row.command) ||
        bundleOf(row.command) !== bundle ||
        !(startMs(row.start) >= startMs(host.start))
      ) {
        errors.push(
          `service ${service.label} of host ${host.pid} lists pid ${service.pid}, which is not that host's WebKit service (${row.command.slice(0, 80)}, started ${row.start})`,
        );
        continue;
      }
      if (!counted.has(row.pid))
        counted.set(row.pid, {
          ...row,
          role: `webkit-service ${service.label}`,
        });
    }
  }
  const list = [...counted.values()];
  return {
    rss_kib: list.reduce((n, r) => n + r.rss_kib, 0),
    processes: list.map((r) => ({
      pid: r.pid,
      start: r.start,
      rss_kib: r.rss_kib,
      role: r.role,
    })),
    webkit_hosts: hosts.length,
    scope: hosts.length > 0 ? SCOPE_WITH_LAUNCHD : SCOPE_DESCENDANTS,
    complete: errors.length === 0,
    errors,
  };
}

/** `launchctl print pid/<pid>`, parsed. */
export function launchdServices(pid) {
  try {
    const text = execFileSync("launchctl", ["print", `pid/${pid}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const services = parseLaunchdServices(text);
    return services
      ? { ok: true, services }
      : { ok: false, error: "no services block in launchctl's answer" };
  } catch (error) {
    return {
      ok: false,
      error: String(error.stderr || error)
        .trim()
        .slice(0, 160),
    };
  }
}

/** One sample of the browser's memory now (macOS and Linux `ps`; launchd only where a WebKit host runs, i.e. macOS). */
export function sampleBrowserMemory(rootPid = process.pid) {
  const text = execFileSync(
    "ps",
    ["-axo", "pid=,ppid=,rss=,lstart=,command="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return browserInventory(parsePs(text), rootPid, {
    servicesOf: launchdServices,
  });
}

const run = promisify(execFile);
/** The same sample without blocking the caller's event loop (the test worker keeps driving the page while it is taken). */
export async function sampleBrowserMemoryAsync(rootPid = process.pid) {
  const { stdout } = await run(
    "ps",
    ["-axo", "pid=,ppid=,rss=,lstart=,command="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const rows = parsePs(stdout);
  const hosts = new Map();
  for (const r of rows)
    if (WEBKIT_HOST.test(r.command)) {
      try {
        const answer = await run("launchctl", ["print", `pid/${r.pid}`], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        const services = parseLaunchdServices(answer.stdout);
        hosts.set(
          r.pid,
          services
            ? { ok: true, services }
            : { ok: false, error: "no services block in launchctl's answer" },
        );
      } catch (error) {
        hosts.set(r.pid, {
          ok: false,
          error: String(error.stderr || error)
            .trim()
            .slice(0, 160),
        });
      }
    }
  return browserInventory(rows, rootPid, {
    servicesOf: (pid) => hosts.get(pid) ?? { ok: false, error: "not read" },
  });
}
