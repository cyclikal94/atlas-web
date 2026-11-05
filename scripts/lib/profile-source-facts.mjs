// The SOURCE facts behind the hand-over's answer about snapshot requests (WEB-09c revision 5; review 5 R6, design assessment DA-S1, A4).
// H9 used to say, as a constant, that this client sends no snapshot ("production starts no engine yet"): true before WEB-09b, false on
// every candidate that composes production leadership, and nothing in the projection or the validator could notice, because both repeated
// the same text. Here the answer is read from the candidate's code instead: each link of the path from the production entry to the
// `/sync` request of a snapshot page is checked in the file that makes it (comments removed, so a comment can neither make nor break a
// link), with the sizing rungs the request's `limit` comes from. A link that no longer holds makes the answer UNVERIFIED, never the old
// claim, and never a claim that the path exists.
//
// These are facts about the code, not measurements: the profiling programme's fixture leader seeds a delta cache, and W5 exercises
// snapshot-shaped processing only, so production first-snapshot, adoption and recovery performance stay unmeasured here (WEB-09b owns
// production leadership, snapshot and recovery; WEB-09d integrated and supported-device acceptance).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The code alone: block and line comments removed (a `//` inside a string such as a URL is kept). */
const code = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Each link: the file that makes it, what it establishes, and the code that must be there (in order, where order matters). */
export const SNAPSHOT_LINKS = Object.freeze([
  {
    id: "entry_boots",
    file: "src/main.tsx",
    states: "the production entry calls boot and never turns the leader off",
    holds: (t) =>
      /import \{ boot \} from "\.\/app\/boot";/.test(t) &&
      /\bboot\(\{/.test(t) &&
      !t.includes("dataLeader"),
  },
  {
    id: "boot_leads_by_default",
    file: "src/app/boot.tsx",
    states:
      "boot starts the data leader after the session starts unless asked not to (default on)",
    holds: (t) => {
      const start = t.indexOf("await session.start(");
      const lead = t.indexOf("dataLeader.start(session");
      return (
        /const leads = options\.dataLeader !== false;/.test(t) &&
        start > -1 &&
        lead > start
      );
    },
  },
  {
    id: "shim_starts_leader",
    file: "src/app/data-leader.ts",
    states: "the boot shim starts production leadership",
    holds: (t) => /startDataLeader\(session/.test(t),
  },
  {
    id: "leader_loads_browser_leader",
    file: "src/data/leader/start.ts",
    states: "production leadership loads the browser leader",
    holds: (t) => t.includes('import("../ui/browser-leader")'),
  },
  {
    id: "browser_leader_starts_sync_leader",
    file: "src/data/ui/browser-leader.ts",
    states: "the browser leader creates and starts the sync leader",
    holds: (t) => {
      const create = t.indexOf("createSyncLeader(");
      return create > -1 && t.indexOf("leader.start()") > create;
    },
  },
  {
    id: "sync_leader_composes_recovery_job",
    file: "src/data/leader/leader.ts",
    states: "the sync leader composes the recovery job",
    holds: (t) =>
      /export function createSyncLeader\(/.test(t) &&
      /createRecoveryJob\(\{/.test(t),
  },
  {
    id: "recovery_job_requests_snapshot_pages",
    file: "src/data/engine/recovery-job.ts",
    states:
      "the recovery job takes the snapshot path unless a catch-up applies, and asks /sync with the limit it captured",
    holds: (t) => {
      const path = t.indexOf('let path: RecoveryPath = "snapshot";');
      const url = t.indexOf('deps.apiUrl("/sync")');
      const limit = t.indexOf(
        'url.searchParams.set("limit", String(capture.limit));',
      );
      return path > -1 && url > path && limit > url;
    },
  },
  {
    id: "capture_limit_from_sizing",
    file: "src/data/plans/recovery-writers.ts",
    states:
      "the captured limit is the persistent sizing rung (initial rung by device class when none is persisted), never above syncLimitMax",
    holds: (t) =>
      /sync\.sizing\.class === null \? initialState\(input\.signals\) : sync\.sizing/.test(
        t,
      ) &&
      t.includes("limit: Math.min(sizing.limit, DATA_CONFIG.syncLimitMax)"),
  },
  {
    id: "initial_rung_by_class",
    file: "src/data/model/sizing.ts",
    states:
      "the initial rung is initialLimitUnconstrained for 8 GiB or more of reported memory and initialLimitOther otherwise (unknown included)",
    holds: (t) =>
      /return memory >= 8 \? "unconstrained" : "constrained";/.test(t) &&
      /deviceClass === "unconstrained"\s*\?\s*config\.initialLimitUnconstrained\s*:\s*config\.initialLimitOther/.test(
        t,
      ),
  },
]);

/**
 * The facts of the candidate at `root`: every link with whether it holds, and `snapshot_requests`: true only when every link holds (the
 * production composition sends snapshot requests whose limit is the sizing rung), null otherwise (the code no longer shows it; the
 * answer is unverified, not "no").
 */
export function snapshotSourceFacts(root = ROOT) {
  const links = SNAPSHOT_LINKS.map((link) => {
    let holds = false;
    try {
      holds = link.holds(code(readFileSync(join(root, link.file), "utf8")));
    } catch {
      holds = false;
    }
    return { id: link.id, file: link.file, states: link.states, holds };
  });
  return {
    snapshot_requests: links.every((l) => l.holds) ? true : null,
    links,
  };
}
