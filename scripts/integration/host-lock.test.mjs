import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { holderOf, intentOf, LockTimeout, withHostLock } from "./host-lock.mjs";

/**
 * Review r7 DA-1 (revision 8): the lock the image owner records are decided under. It must exclude other PROCESSES (the runner, its
 * reaper, another invocation). Review r8 DA-1a (revision 9): it is the kernel's lock on a file that is never moved: no waiter ever
 * takes it over, a holder's death releases it only once nothing the holder handed it to still runs.
 *
 * Labelled adaptations (revision 9): revision 8 asserted that the lock PATH was gone after a release (`existsSync(path) === false`);
 * the path is now a stable file that is never removed, so the same intent ("released: nobody holds it") is asserted by obtaining
 * the lock at once (`free(path)`). Revision 8's `provenGone` and table-reader (`look`) cases tested the takeover decision, which no
 * longer exists: their intent (doubt never displaces a holder) is now structural, and is asserted by the live-holder, dead-holder,
 * multi-claimant and inherited-descriptor cases below.
 */
const dir = mkdtempSync(join(tmpdir(), "atlas-host-lock-"));
// A holder still waiting for its release when an assertion fails would keep this file alive: every child is ended at the end.
const children = new Set();
test.after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});
const module = fileURLToPath(new URL("./host-lock.mjs", import.meta.url));
/** Nobody holds the lock: it is obtained at once. */
const free = async (path) => {
  let got = false;
  await withHostLock(
    path,
    async () => {
      got = true;
    },
    { timeoutMs: 0 },
  );
  return got;
};
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
  assert.equal(await free(path), true, "released");
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

test("a holder killed while holding releases the lock (the kernel's), and only then does a waiter enter", async () => {
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
  assert.equal(await free(path), true);
});

test("a live holder's identity, unreadable or not, is only a diagnostic: the timeout says so, and nothing is displaced", async () => {
  const path = join(dir, "identity.lock");
  const h = holder(path, join(dir, "identity"));
  await until(() => existsSync(join(dir, "identity.in")));
  assert.equal(holderOf(path)?.pid, h.child.pid);
  // Scribble over the diagnostic: the kernel's lock does not read it.
  writeFileSync(path, "not json");
  let ran = false;
  await assert.rejects(
    withHostLock(
      path,
      async () => {
        ran = true;
      },
      { timeoutMs: 200 },
    ),
    (error) =>
      error instanceof LockTimeout &&
      error.holder === null &&
      /could not be read/.test(error.message),
  );
  assert.equal(ran, false);
  writeFileSync(join(dir, "identity.go"), "");
  assert.deepEqual(await h.exited, { status: 0, signal: null });
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
  assert.equal(await free(path), true);
});

// ---- review r8 DA-1a (revision 9) ---------------------------------------------------------------------------------------------------

/** A child that writes `<mark>.start`, then takes the lock and behaves as `holder` does. `die`: it exits while holding. */
function claimant(path, mark, { die = false } = {}) {
  const code = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withHostLock } from ${JSON.stringify(module)};
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    writeFileSync(${JSON.stringify(`${mark}.start`)}, String(Date.now()));
    await withHostLock(${JSON.stringify(path)}, async () => {
      writeFileSync(${JSON.stringify(`${mark}.in`)}, String(Date.now()));
      if (${die}) process.exit(0);
      while (!existsSync(${JSON.stringify(`${mark}.go`)})) await pause(10);
      writeFileSync(${JSON.stringify(`${mark}.out`)}, String(Date.now()));
    }, { timeoutMs: 30000, pollMs: 5 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: "ignore",
  });
  children.add(child);
  const exited = new Promise((r) =>
    child.on("exit", (status, signal) => r({ status, signal })),
  );
  return { child, exited, mark };
}

test("DA-1a (review r8): a dead holder, two claimants and a third arrival: exactly one is ever inside, each in turn", async () => {
  const path = join(dir, "takeover.lock");
  const at = (name) => join(dir, `takeover-${name}`);
  const a = claimant(path, at("A"));
  await until(() => existsSync(`${a.mark}.in`));
  // Two claimants find A's lock held and wait.
  const r = claimant(path, at("R"));
  const b = claimant(path, at("B"));
  await until(
    () => existsSync(`${r.mark}.start`) && existsSync(`${b.mark}.start`),
  );
  await pause(200);
  const inside = (list) =>
    list.filter(
      (c) => existsSync(`${c.mark}.in`) && !existsSync(`${c.mark}.out`),
    );
  // Names, not process objects: a failure then says who was inside.
  const names = (list) => list.map((p) => p.mark.split("-").at(-1));
  assert.deepEqual(names(inside([r, b])), [], "nobody enters while A lives");
  // A dies holding the lock (it never leaves its callback).
  a.child.kill("SIGKILL");
  await a.exited;
  await until(() => inside([r, b]).length === 1);
  const first = inside([r, b])[0];
  const second = first === r ? b : r;
  // A third process arrives while the first claimant is inside.
  const c = claimant(path, at("C"));
  await until(() => existsSync(`${c.mark}.start`));
  await pause(300);
  assert.deepEqual(
    names(inside([r, b, c])),
    names([first]),
    "the second claimant and the new arrival both wait",
  );
  writeFileSync(`${first.mark}.go`, "");
  await until(() => inside([second, c]).length === 1);
  const next = inside([second, c])[0];
  await pause(200);
  assert.deepEqual(names(inside([r, b, c])), names([next]));
  writeFileSync(`${next.mark}.go`, "");
  const last = next === c ? second : c;
  await until(() => inside([last]).length === 1);
  writeFileSync(`${last.mark}.go`, "");
  for (const p of [r, b, c])
    assert.deepEqual(await p.exited, { status: 0, signal: null });
  const span = (p) => [
    Number(readFileSync(`${p.mark}.in`, "utf8")),
    Number(readFileSync(`${p.mark}.out`, "utf8")),
  ];
  const spans = [r, b, c].map(span).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i += 1)
    assert.ok(
      spans[i - 1][1] <= spans[i][0],
      `callbacks overlap: ${JSON.stringify(spans)}`,
    );
  assert.equal(existsSync(`${a.mark}.out`), false, "A never finished");
  assert.equal(await free(path), true);
});

test("DA-1a: a holder that dies while a command it issued under the lock still runs keeps the lock until that command ends", async () => {
  const path = join(dir, "inherited.lock");
  const mark = join(dir, "inherited");
  const ownership = fileURLToPath(new URL("./ownership.mjs", import.meta.url));
  // The holder issues a command through the runner's own owned-process path (`exec` with `hold`), then dies before it answers.
  const code = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withHostLock } from ${JSON.stringify(module)};
    import { createOwner } from ${JSON.stringify(ownership)};
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const owner = createOwner();
    await withHostLock(${JSON.stringify(path)}, async (held) => {
      void owner.exec("command", process.execPath, ["-e", ${JSON.stringify(
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(`${mark}.cmd`)}, String(process.pid)); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(`${mark}.go`)})) { fs.writeFileSync(${JSON.stringify(`${mark}.cmd-out`)}, String(Date.now())); clearInterval(t); } }, 10);`,
      )}], { hold: held.fd, timeoutMs: 60000 });
      while (!existsSync(${JSON.stringify(`${mark}.cmd`)})) await pause(10);
      process.exit(0);
    });
  `;
  const h = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: "ignore",
  });
  children.add(h);
  await new Promise((r) => h.on("exit", r));
  const command = Number(readFileSync(`${mark}.cmd`, "utf8"));
  endAtFileEnd(command);
  let entered = 0;
  const waiting = withHostLock(
    path,
    async () => {
      entered = Date.now();
    },
    { timeoutMs: 20_000, pollMs: 5 },
  );
  await pause(400);
  assert.equal(
    entered,
    0,
    "the holder is dead, but the command it issued under the lock still runs: nobody enters",
  );
  writeFileSync(`${mark}.go`, "");
  await waiting;
  const ended = Number(readFileSync(`${mark}.cmd-out`, "utf8"));
  assert.ok(entered >= ended, "entered only after the command ended");
});
/** End a command pid at the end of the file (it may outlive a failed assertion). */
function endAtFileEnd(pid) {
  test.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  });
}

test("DA-1a: a cancelled waiter's work is never called, even when the lock becomes free just after", async () => {
  const path = join(dir, "cancelled.lock");
  const h = claimant(path, join(dir, "cancelled"));
  await until(() => existsSync(`${h.mark}.in`));
  const controller = new AbortController();
  let ran = false;
  const waiting = withHostLock(
    path,
    async () => {
      ran = true;
    },
    { signal: controller.signal, pollMs: 5 },
  );
  await pause(50);
  controller.abort(new Error("stopping"));
  writeFileSync(`${h.mark}.go`, "");
  await assert.rejects(waiting, /stopping/);
  await h.exited;
  await pause(50);
  assert.equal(ran, false);
});

test("DA-1a: unfinished work is told to the next holder; settled work is not; an unreadable note is never 'nothing'", async () => {
  const path = join(dir, "intent.lock");
  await withHostLock(path, async (held) => {
    assert.equal(held.previous, null);
    held.note({ op: "release", key: "k", step: "remove_image" });
  });
  await withHostLock(path, async (held) => {
    assert.equal(held.previous?.op, "release");
    assert.equal(held.previous?.step, "remove_image");
    assert.equal(typeof held.previous?.holder?.token, "string");
    held.settle();
  });
  await withHostLock(path, async (held) => {
    assert.equal(held.previous, null, "settled");
  });
  writeFileSync(`${path}.intent`, "{ torn");
  assert.match(intentOf(path)?.unreadable ?? "", /JSON/);
});

test("DA-1a: the same process's two attempts exclude each other too (separate opens of one lock)", async () => {
  const path = join(dir, "same.lock");
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const first = withHostLock(path, () => gate);
  await pause(20);
  await assert.rejects(
    withHostLock(path, async () => {}, { timeoutMs: 100 }),
    LockTimeout,
  );
  release();
  await first;
  assert.equal(await free(path), true);
});
