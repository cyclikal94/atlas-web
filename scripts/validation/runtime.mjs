import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export function fingerprint(root) {
  const names = execFileSync(
    "git",
    ["ls-files", "-c", "-o", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const files = {};
  for (const name of [...new Set(names)].sort()) {
    // Phase reports and generated evidence are never source inputs.
    if (name.startsWith(".agtx/")) continue;
    try {
      files[name] = sha(readFileSync(join(root, name)));
    } catch (error) {
      if (error.code === "ENOENT") files[name] = "deleted";
      else throw error;
    }
  }
  return {
    sha256: sha(JSON.stringify(files)),
    files,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
export function newRun(parent) {
  const path = join(
    parent,
    "runs",
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}
export function json(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function positiveInteger(value, name, max = 4) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  return n;
}
export async function pool(items, jobs, action) {
  let cursor = 0;
  let stopped = false;
  const results = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (!stopped && cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await action(items[index], index);
        } catch (error) {
          stopped = true;
          results[index] = { error: String(error.stack ?? error) };
        }
      }
    }),
  );
  return results;
}

// Own process groups only. SIGINT/SIGTERM stops jobs as well as preview grandchildren.
// `base` (optional) replaces process.env as every child's environment, and `root`/`base` may be functions read at each start: the
// held-operation runner's frozen execution environment and private snapshot (WEB-08d revision 28). Without them nothing changes.
export function processes(root, { env: base = null } = {}) {
  const children = new Set();
  const groups = new Set();
  let cancelled = false;
  const stop = (signal) => {
    for (const id of groups) {
      try {
        process.kill(-id, signal);
      } catch (error) {
        if (error.code === "ESRCH") groups.delete(id);
      }
    }
  };
  const cancel = () => {
    cancelled = true;
    stop("SIGTERM");
    setTimeout(() => stop("SIGKILL"), 2000).unref();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  function start(command, args, env = {}) {
    if (cancelled) throw new Error("validation cancelled");
    const child = spawn(command, args, {
      cwd: typeof root === "function" ? root() : root,
      env: {
        ...(typeof base === "function" ? base() : (base ?? process.env)),
        ...env,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    if (child.pid) groups.add(child.pid);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const done = new Promise((resolve) => {
      child.once("error", (error) => {
        output += String(error);
      });
      child.once("close", (code, signal) => {
        children.delete(child);
        if (child.pid) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") groups.delete(child.pid);
          }
        }
        resolve({ code: code ?? 1, signal, output });
      });
    });
    return {
      child,
      done,
      get output() {
        return output;
      },
    };
  }
  return {
    start,
    run: (command, args, env) => start(command, args, env).done,
    get cancelled() {
      return cancelled;
    },
    async close() {
      cancel();
      // Await group shutdown before removing signal handlers.
      const deadline = Date.now() + 3000;
      while ((children.size || groups.size) && Date.now() < deadline) {
        stop(0);
        await new Promise((r) => setTimeout(r, 25));
      }
      stop("SIGKILL");
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}

export async function isolatedPool(items, jobs, mayParallelise, action) {
  const results = new Array(items.length);
  for (let cursor = 0; cursor < items.length; ) {
    const start = cursor;
    const parallel = mayParallelise(items[cursor]);
    cursor++;
    if (parallel)
      while (cursor < items.length && mayParallelise(items[cursor])) cursor++;
    const batch = await pool(
      items.slice(start, cursor),
      parallel ? jobs : 1,
      (item, index) => action(item, start + index),
    );
    batch.forEach((result, index) => {
      results[start + index] = result;
    });
    if (batch.some((result) => result?.error)) break;
  }
  return results;
}
