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
//   fail_write_nth  { "<write>": [n, ...] }: make only the n-th attempt of the named write throw, counted across the run (revision 10,
//                review r9 H4e: "the first settled write of a stack succeeds, the second fails"); each failure is recorded as reached
//   join_ms      how long the runner's terminal procedure waits for the run's own work to end (default 15 s)
//   docker_fail  answer the named docker commands ("rm", "network rm", "volume rm", "ps") with a failure, without running them
//   stubborn_child  start, in each stack, one more owned process that ignores SIGTERM (a child whose shutdown is held);
//                "detached" puts it in a process group of its own, as Playwright starts browsers
//   fallback_ms  the runner's fallback finaliser delay after a signal (default 150 s)
//   report_error add one error to the report Playwright wrote, as its own global-error entry, before the runner judges it (review r7
//                H4c: a report whose cases all passed but that records an error, established before a later stop)
//   budget_over  report the stack's audited sign-in traffic as over the source budget (an injected fact, marked `injected`)
//
// Boundaries: prepare:start, oidc:started, sqlite:fetched, sqlite:accounts, backend:spawned, postgres:*, proxy:started,
// preview:spawned, preview:ready, playwright:spawned, and stack:judged (revision 8: the stack's report and budget are judged and
// checkpointed, its clean-up has not begun). Revision 9 (review r8 H4d): stack:settled (the stack's settled record is committed, the
// reaper has not been told the stack ended) and stack:ended (the reaper has been told; the run's summary does not have the stack yet).
// `fail_write` also names a stack record commit: "stack:started", "stack:launched", "stack:judged", "stack:settled". Revision 10 (review
// r9 H4e): stack:cleaned (the stack's clean-up has ended; its own end has not committed the settled record) and finish:settled (the
// terminal procedure has settled the current stack and has not joined the run's work). Both wait on the run-level stop, so after a
// signal only `hold_deaf` holds them.
//
// Revision 11 (review r10 H4f): the writes "summary-final" (a final summary only, counted apart from the partial ones, so
// `fail_write_nth: { "summary-final": [2] }` fails only the second final publication), "summary-copy" (the parent folder's copy of the
// final summary) and "summary-error" (the runner's fallback marker); and the boundary finish:marker (the summary could not be published
// and summary-error.json was attempted; the journal has not ended).
//
//   lose_journal  (revision 11) journal messages of the named types ("run-error") are not sent to the reaper, each recorded as reached
//                 (`journal:lost:<type>`): the runner's journal is not acknowledged, so a runner killed before the pipe was flushed
//                 loses what it last journalled, and the reaper must decide from what it can read
//
// Revision 12 (review r11 design assessment C3), read by the REAPER (reaper.mjs), which inherits the runner's environment:
//
//   reaper_publish_fail  { "summary.json": [n, ...], "reaper.json": [n, ...] }: the n-th attempt of the reaper to publish that output
//                 fails after its complete sibling was written (the output keeps what it held), recorded first as
//                 <run dir>/faults/reaper-publish-<output>-<n>.failed: the bounded republication can be held to one exact attempt
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
  const nth = spec.fail_write_nth ?? {};
  const lostJournal = list("lose_journal");
  const attempts = new Map();
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
    /** Is a journal message of `type` lost on its way to the reaper (`lose_journal`)? Recorded as reached when it is. */
    loseJournal(type) {
      if (!lostJournal.has(type)) return false;
      reached.push({ name: `journal:lost:${type}`, at: Date.now() });
      return true;
    },
    /** The report as the runner reads it, with an injected global error when `report_error` is set. */
    report(report) {
      if (!spec.report_error || !report) return report;
      return {
        ...report,
        errors: [
          ...(report.errors ?? []),
          {
            message:
              "injected report error (ATLAS_INTEGRATION_FAULTS report_error)",
          },
        ],
      };
    },
    /** The audited admissions, reported over the source budget when `budget_over` is set. */
    admissions(summary) {
      if (!spec.budget_over) return summary;
      return {
        ...summary,
        within_limit: false,
        sliding_peak_60s: summary.limit + 1,
        injected: "budget_over",
      };
    },
    write(kind) {
      const n = (attempts.get(kind) ?? 0) + 1;
      attempts.set(kind, n);
      if (failWrite.has(kind))
        throw new Error(`injected failure writing the ${kind} evidence`);
      if ((nth[kind] ?? []).includes(n)) {
        const name = `write:${kind}#${n}`;
        reached.push({ name, at: Date.now() });
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, `${file(name)}.failed`), `${Date.now()}\n`);
        throw new Error(
          `injected failure writing the ${kind} evidence (attempt ${n})`,
        );
      }
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
