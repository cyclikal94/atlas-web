// docker-exec.mjs with REAL processes (a shell script stands in for the docker CLI): bounded, abortable unless it creates something,
// refused after the stop except for clean-up, a held descriptor kept by the command (WEB-08d revision 30).
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dockerExec } from "./docker-exec.mjs";
import { Cancelled } from "./ownership.mjs";

function fake(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "docker-exec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, "docker");
  // `sleep N` sleeps; `fd3` writes to descriptor 3; anything else prints its arguments and DOCKER_CONTEXT.
  writeFileSync(
    command,
    '#!/bin/sh\ncase "$1" in sleep) exec sleep "$2";; fd3) echo held >&3; exit 0;; fail) echo nope >&2; exit 3;; esac\necho "$* $DOCKER_CONTEXT"\n',
  );
  chmodSync(command, 0o755);
  return { dir, command };
}

test("a command's output and status, under the pinned context", async (t) => {
  const { command } = fake(t);
  const d = dockerExec({ command });
  assert.deepEqual(
    (({ status, stdout, timedOut }) => ({ status, stdout, timedOut }))(
      await d.run(["ps", "-a"]),
    ),
    { status: 0, stdout: "ps -a colima-atlas\n", timedOut: false },
  );
  const failed = await d.run(["fail"]);
  assert.equal(failed.status, 3);
  assert.equal(failed.stderr, "nope\n");
});

test("a command that does not end is stopped at its bound and reported timed out", async (t) => {
  const { command } = fake(t);
  const d = dockerExec({ command, graceMs: 200 });
  const started = Date.now();
  const r = await d.run(["sleep", "30"], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.status, null);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(d.active(), []);
});

test("a stop ends a waiting command with Cancelled; a creating one (abortable: false) finishes", async (t) => {
  const { command } = fake(t);
  const d = dockerExec({ command, graceMs: 200 });
  const stop = new AbortController();
  const waiting = d.run(["sleep", "30"], { signal: stop.signal });
  const creating = d.run(["sleep", "1"], {
    signal: stop.signal,
    abortable: false,
  });
  setTimeout(() => stop.abort("SIGTERM"), 100);
  await assert.rejects(waiting, Cancelled);
  assert.equal((await creating).status, 0);
  await assert.rejects(d.run(["ps"], { signal: stop.signal }), Cancelled);
});

test("after the latch only clean-up commands start", async (t) => {
  const { command } = fake(t);
  const d = dockerExec({ command });
  assert.equal(d.stop("SIGINT"), "SIGINT");
  await assert.rejects(d.run(["ps"]), Cancelled);
  assert.equal((await d.run(["ps"], { whenStopped: true })).status, 0);
});

test("a held descriptor is the command's fourth stdio entry", async (t) => {
  const { dir, command } = fake(t);
  const d = dockerExec({ command });
  const file = join(dir, "lock");
  const fd = openSync(file, "w");
  assert.equal((await d.run(["fd3"], { hold: fd })).status, 0);
  assert.equal(readFileSync(file, "utf8"), "held\n");
});
