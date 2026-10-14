// Qualification boundaries of the integration runner (WEB-08d review r6, H4): deterministic places where a qualification case can
// hold the runner, fail it or make an evidence write fail, so a cancellation or a failure lands exactly where the case says rather
// than wherever a sleep happens to end. Inactive unless ATLAS_INTEGRATION_FAULTS is set; no maintained caller sets it, and a run
// with faults says so in its summary.
//
//   ATLAS_INTEGRATION_FAULTS='{"hold":["postgres:readiness"],"fail":["preview:ready"],"fail_write":["admissions"],
//                              "docker_fail":["rm"],"stubborn_child":true,"fallback_ms":5000}'
//
//   hold         at the named boundary: write <run dir>/faults/<name>.reached, then wait until the stack is stopped (the wait ends
//                with the stop, like any other wait) or <name>.release appears
//   hold_deaf    the same, but the wait does not end with the stop (a preparation step that does not look at the stop), only on
//                <name>.release: the runner's own fallback finaliser then has to finish the run
//   fail         throw an injected error at the named boundary (a preparation error)
//   fail_write   make the named evidence write throw ("admissions", "summary")
//   docker_fail  answer the named docker commands ("rm", "network rm", "volume rm", "ps") with a failure, without running them
//   stubborn_child  start, in each stack, one more owned process that ignores SIGTERM (a child whose shutdown is held)
//   fallback_ms  the runner's fallback finaliser delay after a signal (default 150 s)
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cancelled } from "./ownership.mjs";

const file = (name) => name.replaceAll(/[^a-z0-9-]/gi, "-");

export function createFaults({
  text = process.env.ATLAS_INTEGRATION_FAULTS,
  dir,
}) {
  const spec = text ? JSON.parse(text) : {};
  const list = (key) => new Set(spec[key] ?? []);
  const hold = list("hold");
  const deaf = list("hold_deaf");
  const fail = list("fail");
  const failWrite = list("fail_write");
  const dockerFail = list("docker_fail");
  const reached = [];
  const folder = join(dir, "faults");

  return {
    active: Boolean(text),
    spec,
    reached,
    fallbackMs: spec.fallback_ms ?? 150_000,
    stubbornChild: Boolean(spec.stubborn_child),
    /** A qualification boundary: recorded when reached (only with faults active), then held or failed as the spec says. */
    async at(name, signal) {
      if (!text) return;
      reached.push({ name, at: Date.now() });
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${file(name)}.reached`), `${Date.now()}\n`);
      if (fail.has(name)) throw new Error(`injected failure at ${name}`);
      if (hold.has(name) || deaf.has(name)) {
        const release = join(folder, `${file(name)}.release`);
        while (!existsSync(release)) {
          if (hold.has(name) && signal?.aborted)
            throw new Cancelled(String(signal.reason?.reason ?? "aborted"));
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    },
    write(kind) {
      if (failWrite.has(kind))
        throw new Error(`injected failure writing the ${kind} evidence`);
    },
    /** A docker command named by its sub-command ("rm") or its first two words ("network rm", "volume ls"). */
    docker(args) {
      const two = args.slice(0, 2).join(" ");
      const name = dockerFail.has(two) ? two : args[0];
      return dockerFail.has(name)
        ? {
            status: 1,
            stdout: "",
            stderr: `injected failure of docker ${name}`,
          }
        : null;
    },
  };
}
