import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LockTimeout,
  provenGone,
  startedAt,
  withHostLock,
} from "./host-lock.mjs";

/**
 * Review r7 DA-1 (revision 8): the lock the image owner records are decided under. It must exclude other PROCESSES (the runner, its
 * reaper, another invocation), and a holder is only ever displaced once it is proven gone.
 */
const dir = mkdtempSync(join(tmpdir(), "atlas-host-lock-"));
// A holder still waiting for its release when an assertion fails would keep this file alive: every child is ended at the end.
const children = new Set();
test.after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});
const module = fileURLToPath(new URL("./host-lock.mjs", import.meta.url));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await pause(20);
  }
};

/** A child process that takes the lock, writes `<mark>.in`, holds it until `<mark>.go` exists (or `holdMs`), then writes `<mark>.out`. */
function holder(path, mark, { holdMs = 0 } = {}) {
  const code = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withHostLock } from ${JSON.stringify(module)};
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    await withHostLock(${JSON.stringify(path)}, async () => {
      writeFileSync(${JSON.stringify(`${mark}.in`)}, String(Date.now()));
      const end = Date.now() + ${holdMs};
      while (${holdMs} > 0 ? Date.now() < end : !existsSync(${JSON.stringify(`${mark}.go`)})) await pause(10);
      writeFileSync(${JSON.stringify(`${mark}.out`)}, String(Date.now()));
    }, { timeoutMs: 20000 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: "ignore",
  });
  children.add(child);
  const exited = new Promise((r) =>
    child.on("exit", (status, signal) => r({ status, signal })),
  );
  return { child, exited };
}

test("two processes never hold the lock at once", async () => {
  const path = join(dir, "exclusive.lock");
  const a = holder(path, join(dir, "a"), { holdMs: 400 });
  const b = holder(path, join(dir, "b"), { holdMs: 400 });
  assert.deepEqual(await a.exited, { status: 0, signal: null });
  assert.deepEqual(await b.exited, { status: 0, signal: null });
  const span = (m) => [
    Number(readFileSync(join(dir, `${m}.in`), "utf8")),
    Number(readFileSync(join(dir, `${m}.out`), "utf8")),
  ];
  const [ai, ao] = span("a");
  const [bi, bo] = span("b");
  assert.ok(
    ao <= bi || bo <= ai,
    `the spans overlap: a ${ai}-${ao}, b ${bi}-${bo}`,
  );
  assert.equal(existsSync(path), false, "released");
});

test("a live holder is never displaced: the waiter gives up at its bound and says who holds it", async () => {
  const path = join(dir, "live.lock");
  const h = holder(path, join(dir, "live"));
  await until(() => existsSync(join(dir, "live.in")));
  let ran = false;
  await assert.rejects(
    withHostLock(
      path,
      async () => {
        ran = true;
      },
      { timeoutMs: 400 },
    ),
    (error) => error instanceof LockTimeout && error.holder.pid === h.child.pid,
  );
  assert.equal(ran, false);
  writeFileSync(join(dir, "live.go"), "");
  assert.deepEqual(await h.exited, { status: 0, signal: null });
});

test("a holder killed while holding is proven gone, and only then is its lock taken over", async () => {
  const path = join(dir, "killed.lock");
  const h = holder(path, join(dir, "killed"));
  await until(() => existsSync(join(dir, "killed.in")));
  let entered = 0;
  const waiting = withHostLock(
    path,
    async () => {
      entered = Date.now();
    },
    { timeoutMs: 10_000 },
  );
  await pause(300);
  assert.equal(entered, 0, "it waits while the holder lives");
  const killed = Date.now();
  h.child.kill("SIGKILL");
  await h.exited;
  await waiting;
  assert.ok(entered >= killed);
  assert.equal(
    existsSync(join(dir, "killed.out")),
    false,
    "the holder never finished",
  );
  assert.equal(existsSync(path), false);
});

test("an owner is proven gone only by a missing pid or a different start time; a table that cannot be read proves nothing", () => {
  const self = { pid: process.pid, started: startedAt(process.pid) };
  const local = (over) => ({ ...self, host: hostname(), ...over });
  assert.equal(provenGone(local({})), false, "this very process is alive");
  assert.equal(
    provenGone(local({}), () => null),
    true,
    "no such pid",
  );
  assert.equal(
    provenGone(local({}), () => "Thu Jan  1 00:00:00 1970"),
    true,
    "the pid was reused",
  );
  assert.equal(
    provenGone(local({}), () => {
      throw new Error("ps: operation not permitted");
    }),
    false,
    "unreadable table",
  );
  assert.equal(
    provenGone(local({ host: "another-host" }), () => null),
    false,
    "another host's process cannot be looked at",
  );
  assert.equal(
    provenGone(null, () => null),
    false,
    "an owner that cannot be read",
  );
  assert.equal(
    provenGone(local({ started: null }), () => null),
    false,
    "an owner without a start time",
  );
});

test("a waiter whose table reader cannot read never takes over, even from a dead owner", async () => {
  const path = join(dir, "doubt.lock");
  const h = holder(path, join(dir, "doubt"));
  await until(() => existsSync(join(dir, "doubt.in")));
  h.child.kill("SIGKILL");
  await h.exited;
  await assert.rejects(
    withHostLock(path, async () => {}, {
      timeoutMs: 300,
      look: () => {
        throw new Error("unreadable");
      },
    }),
    LockTimeout,
  );
  // With a table that can be read, the dead owner is proven gone.
  await withHostLock(path, async () => {});
  assert.equal(existsSync(path), false);
});

test("a stop ends the wait with its reason; the lock is released even when the work throws", async () => {
  const path = join(dir, "signal.lock");
  const h = holder(path, join(dir, "signal"));
  await until(() => existsSync(join(dir, "signal.in")));
  const controller = new AbortController();
  const waiting = withHostLock(path, async () => {}, {
    signal: controller.signal,
  });
  controller.abort(new Error("stopping"));
  await assert.rejects(waiting, /stopping/);
  writeFileSync(join(dir, "signal.go"), "");
  await h.exited;
  await assert.rejects(
    withHostLock(path, async () => {
      throw new Error("the work failed");
    }),
    /the work failed/,
  );
  assert.equal(existsSync(path), false);
});
