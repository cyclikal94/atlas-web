// The hand-over's evidence-backed publication (WEB-09c revision 3; review 3 R2, design assessment A7/E9). ONE pure projection builds every
// field of `results.json` and the whole of `report.md` from (a) the evidence the hand-over carries (`handoff/evidence/`), (b) its
// resolution by the evidence contract, and (c) a small context the evidence cannot hold (the candidate at hand-over time, the machine
// record, the API-types pin and the provisional constants), which `results.json` itself records. The assembler (scripts/profile-sync.mjs)
// writes what this projection returns; the validator (scripts/validate-profile-handoff.mjs) projects the carried evidence again with the
// recorded context and refuses a hand-over whose results or report differ in any field, so a published figure cannot disagree with its
// evidence even when SHA256SUMS was regenerated after an edit. Nothing here reads the stage's source directory, the clock or the machine.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CELL_STATUSES,
  CONTRACT_VERSION,
  RECORDED,
} from "./profile-contract.mjs";
import {
  COLLECTION_LOG,
  ENGINES,
  EVIDENCE_KEY,
  EVIDENCE_OWNER,
} from "./profile-evidence.mjs";
import {
  annotate,
  METHOD as ISOLATION_METHOD,
  readSamples,
  SAMPLE_INTERVAL_MS,
} from "./profile-isolation.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The context fields `results.json` records for the validator (everything else is projected from evidence and resolution). */
export function contextOf(results) {
  return {
    now: results?.candidate?.at_handoff ?? null,
    machine: results?.machine ?? null,
    pinned: results?.backend?.pin ?? null,
    configValues: results?.programme?.["P-12"]?.values ?? null,
    sourceFacts: results?.H9?.limit_in_use?.source_facts ?? null,
  };
}

/** What the snapshot phase's request is, from the candidate's source facts (scripts/lib/profile-source-facts.mjs; revision 5, review 5 R6). */
function snapshotAnswer(facts, config) {
  if (facts?.snapshot_requests === true)
    return `sent by the production composition (${facts.links.map((l) => l.file).join(" -> ")}): the recovery job asks /sync for snapshot pages, cursor-less and then at each staged position, with the limit its capture took from the persistent sizing ladder: the same rungs as delta (${config?.config?.initialLimitUnconstrained ?? "?"} unconstrained, ${config?.config?.initialLimitOther ?? "?"} otherwise, unknown memory included; step-down only; never above syncLimitMax ${config?.config?.syncLimitMax ?? "?"}). Only when the cache needs one (a first snapshot, a server-instructed restart, recovery); capability, identity, connectivity, admission and stops can withhold a request`;
  const failing = (facts?.links ?? [])
    .filter((l) => !l.holds)
    .map((l) => `${l.id} (${l.file})`);
  return `UNVERIFIED on this candidate: the source does not show ${failing.length ? failing.join(", ") : "the request path"}; no answer is given (neither sent nor not sent)`;
}

// ---- Revision 6 (review 6 R7): the acceptance scope of the hand-over, under the later human decision on device timing -------------------
// STAGED-ACCEPTANCE-20261011 (Kieran, 11 October 2026) moved the physical-device measurements to WEB-09d (before beta) and removed them as a
// prerequisite of BE-B1/BE-Q23 scoped technical completion. It is pinned by path and SHA-256 (the package does not read the orchestrator).
// What the hand-over can support is derived from its own resolution only; a generated package never records a review or an acceptance.
export const STAGED_ACCEPTANCE = {
  id: "STAGED-ACCEPTANCE-20261011",
  decided: "Kieran, 11 October 2026",
  repository: "atlas-orchestrator",
  brief: "delivery/handoffs/staged-acceptance-20261011.md",
  brief_sha256:
    "ed8bc85b3474b4dfddff06e5cc7cfab595a4ae01ebc7ad83a7efd49158ac1ca3",
  authority: "approval/staged-acceptance-20261011.json",
  authority_sha256:
    "812002ba25387c186e4d9e457d34a0304565dd173292f294336dcc098370ea63",
  supersedes:
    "the timing of OD-1 (10 October 2026: BE-B1/BE-Q23 waited for the device roster) and WEB-09c plan acceptance item 7; the physical-device measurements stay required, by WEB-09d before beta",
};
/** The BE-B1/BE-Q23 rows with a physical-device part this desktop record cannot answer (STAGED-ACCEPTANCE-20261011 §4), and that part. */
export const DEVICE_TRANSFERS = [
  [
    "BE-B1:2 real devices, named",
    "actual device, browser and OS identity on the named roster: the lowest-memory supported device per family, a mid-range mobile, browsers without a device-memory signal, the installed app",
  ],
  [
    "BE-B1:3 workloads with bytes, nodes and changes",
    "dense valid workload success (W2 included) on supported devices",
  ],
  [
    "BE-B1:4 multi-tab on every class",
    "multi-tab and installed-app-plus-tab scenarios, lifecycle, backgrounding and offline behaviour on every device class",
  ],
  [
    "BE-B1:5 metrics per run",
    "device memory with each platform's tools (dumpsys, Instruments, about:memory) and bounded processing on devices",
  ],
  [
    "BE-B1:6 derived values",
    "the derived values per device class and tab count, needs_finer_pagination for supported devices included",
  ],
  ["BE-B1:7 format", "a record whose figures are measured on real hardware"],
  ["BE-Q23:M1 roster", "the roster and its identities (as BE-B1:2)"],
  ["BE-Q23:M2 method", "the per-platform device method and tools"],
  ["BE-Q23:M4 granularity sweep", "the granularity sweep on each device class"],
  ["BE-Q23:M5 multi-tab scenarios", "as BE-B1:4"],
  [
    "BE-Q23:M7 cost of finer requests",
    "the device CPU cost of finer requests and affected performance",
  ],
  [
    "BE-Q23:M8 smallest unprocessable response",
    "the smallest response a supported device cannot process",
  ],
  ["BE-Q23:M9 derived values", "as BE-B1:6"],
];
const DEVICE_OWNER = `WEB-09d (physical devices before beta: transferred by ${STAGED_ACCEPTANCE.id}, not run)`;

/** The three things the hand-over must keep apart (STAGED-ACCEPTANCE-20261011 §3), from its resolution and consumer map only. */
function acceptanceScope(resolution, failure, consumerMap) {
  const supports = resolution.complete === true && failure === false;
  const ids = (status) =>
    resolution.cells.filter((c) => c.status === status).map((c) => c.id);
  const counts = resolution.counts ?? {};
  const withheld = [];
  if (resolution.complete !== true)
    withheld.push(
      `the desktop programme is not complete: ${counts.missing ?? 0} missing, ${counts.invalid ?? 0} invalid, ${counts.failed ?? 0} failed, ${counts.failed_control ?? 0} failed control(s), ${counts.not_isolated ?? 0} not isolated (desktop_programme)`,
    );
  if (failure === true)
    withheld.push("a valid workload failed on a desktop engine (H8)");
  else if (failure === null)
    withheld.push("the desktop outcomes are incomplete, so H8 is undetermined");
  return {
    decision: STAGED_ACCEPTANCE,
    physical_devices_block_backend: false,
    physical_devices:
      "Not run: transferred to WEB-09d, which names the roster, operator and HTTPS set-up and runs them before beta. Missing phone and tablet results alone do not block BE-B1/BE-Q23 planning, implementation, independent technical review or scoped technical completion; WEB-09d's integrated pre-beta acceptance waits for them",
    desktop_decision: {
      supports,
      scope:
        "desktop-scoped development decisions only: one macOS machine, Playwright's Chromium, Firefox and WebKit; no device class, no mobile-safe limit, no supported-device floor, no all-platform conclusion that finer pagination is unnecessary",
      statement: supports
        ? "A complete, isolated desktop programme with no failure: once an independent review accepts this hand-over, it can, with each backend card's own required checks, support BE-B1/BE-Q23 scoped technical acceptance, device-sensitive choices marked provisional"
        : "This hand-over supports no desktop-scoped development decision and no acceptance claim",
      needs: supports
        ? [
            "an independent review that accepts this hand-over",
            "each backend card's own required checks (its SQLite/PostgreSQL, contract, release and published-types evidence)",
          ]
        : [],
      withheld_because: withheld,
    },
    package: {
      independently_reviewed: false,
      claims_acceptance: false,
      note: "Generated by scripts/profile-sync.mjs: this package records no review and no acceptance; a backend development completion record references the reviewed hand-over and states its desktop scope and the open WEB-09d obligations",
    },
    transferred_to_web09d: DEVICE_TRANSFERS.map(([item, part]) => ({
      item,
      physical_device: part,
      status: "not_run",
      owner: "WEB-09d",
      desktop_status: consumerMap[item]?.status ?? null,
    })),
    human_decisions: [
      {
        decision:
          "the supported-device roster: the floor device for each family (model, RAM, OS), the mid-range mobile, who runs the protocol and where, and the HTTPS hosting",
        owner: "Kieran or product, before WEB-09d's physical-device pass",
        basis:
          "OD-1's open items (10 October 2026); this record neither invents nor reduces the roster",
      },
      {
        decision:
          "any material contract or product choice BE-B1/BE-Q23 cannot settle from desktop evidence (for example a finer-delivery parameter or a page-size change, whose need on supported devices is undetermined: H9)",
        owner:
          "BE-B1/BE-Q23 mark device-sensitive choices provisional and take a material unresolved choice to Kieran",
        basis: `${STAGED_ACCEPTANCE.id} §3`,
      },
    ],
    held_failures: {
      cells: [...ids("failed"), ...ids("failed_control"), ...ids("invalid")],
      workload_failures: resolution.failures ?? [],
      rule: "A demonstrated functional, privacy, data-loss or valid-workload failure, a failed control or invalid evidence needs correction; missing mobile data is not permission to ignore it",
    },
  };
}

/** The first paragraph of the hand-over: its scope, what moved to WEB-09d, and what (if anything) it can support. */
function firstParagraph(scope) {
  return [
    `This record was taken on one macOS developer machine with Playwright's desktop engines: it is desktop-scoped evidence. No physical device, floor device, installed app or browser without a device-memory signal was profiled; those measurements are transferred to WEB-09d and have not run (${STAGED_ACCEPTANCE.id}, which supersedes the timing of OD-1, 10 October 2026). Every desktop figure is labelled as such and none stands for a device class.`,
    scope.desktop_decision.supports
      ? "The desktop programme is complete and isolated with no failure: once an independent review accepts this hand-over, it can, with each backend card's own required checks, support BE-B1/BE-Q23 scoped technical acceptance; missing phone and tablet results alone do not block that."
      : "The desktop programme is not complete or holds a failure (acceptance_scope.desktop_decision): this hand-over supports no desktop-scoped development decision and no acceptance claim.",
    "This record has not been independently reviewed and claims no acceptance.",
  ].join(" ");
}

/** A reader of the carried evidence that never throws: a malformed file is `null` (its cell in the resolution says why). */
function reader(dir) {
  const json = (rel) => {
    try {
      return existsSync(join(dir, rel))
        ? JSON.parse(readFileSync(join(dir, rel), "utf8"))
        : null;
    } catch {
      return null;
    }
  };
  const jsonl = (rel) => {
    try {
      return existsSync(join(dir, rel))
        ? readFileSync(join(dir, rel), "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .flatMap((l) => {
              try {
                const row = JSON.parse(l);
                return row && typeof row === "object" && !Array.isArray(row)
                  ? [row]
                  : [];
              } catch {
                return [];
              }
            })
        : [];
    } catch {
      return [];
    }
  };
  const list = (rel, prefix) =>
    existsSync(join(dir, rel))
      ? readdirSync(join(dir, rel))
          .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
          .sort()
          .flatMap((f) => {
            const value = json(`${rel}/${f}`);
            return value && typeof value === "object" && !Array.isArray(value)
              ? [value]
              : [];
          })
      : [];
  return { json, jsonl, list };
}

const enginesOf = (rows) => [...new Set(rows.map((r) => r.engine))].sort();

/** What the contention programme left: one JSON per engine per item, every status the resolution's. */
function contentionProgramme(r, statusOf) {
  const e = {
    unresolved: r.list("contention", "unresolved-leases."),
    retirements: r.list("contention", "retirements."),
    frozen: r
      .list("contention", "frozen-owner.")
      .filter((x) => x.id === "P-7 frozen owner"),
    frozenProduction: r.list("contention", "frozen-owner-production-wait."),
    yieldPolicy: r.list("contention", "yield-policy."),
    followers: r.list("contention", "follower-reads."),
  };
  const notRun =
    "not run in this record: the contention stage (scripts/profile-contention.mjs --evidence <dir>) did not leave its files";
  return {
    "P-6": e.unresolved.length
      ? {
          status: statusOf("P-6"),
          engines: enginesOf(e.unresolved),
          label:
            "desktop; two or more pages of one context through the real stamped wrapper; the network is a stub. A closed tab is the real cause (clean: the session's own pagehide retires the lease; killed: SIMULATED by neutralising that handler; crashed: a REAL Chromium renderer crash); a slowed response and a failing recording write are INJECTED. 'precondition_met' counts the scenarios in which the record already held another page's lease when the observing page was about to make its first request (read from atlas-auth just before it); 'saw_unresolved' counts the scenarios in which a cover the observing page committed AFTER the closure carried at least one unresolved lease of another page. They are read at different moments, so a lease that appears after the precondition read (a closing tab's own write racing the observer) counts in 'saw_unresolved' and not in 'precondition_met'; neither is a defect count",
          by_engine: Object.fromEntries(
            e.unresolved.map((x) => [
              x.engine,
              { scenarios: x.scenarios, by_cause: x.by_cause },
            ]),
          ),
          files: "contention/unresolved-leases.<engine>.json",
        }
      : { status: statusOf("P-6"), reason: notRun },
    "P-7": e.retirements.length
      ? {
          status: statusOf("P-7"),
          engines: enginesOf(e.retirements),
          label:
            "waits of an ordinary request, an exposure, an atlas-auth writer and a closing write (a logout's initiation) of one page against a back-to-back FIXTURE leader (pages 5 ms apart, a synthetic server latency) and with no leader; see the measurement rows named P-7 and contention/waits.jsonl. A frozen owner is a main-thread block in a page that holds atlas-auth (SYNTHETIC: a Playwright engine cannot freeze a page), with the writer's lock wait SCALED to 1 s so the give-up is observed many times, and a few runs at the PRODUCTION 20 s wait",
          frozen_owner: Object.fromEntries(
            e.frozen.map((x) => [
              x.engine,
              {
                gave_up: x.gave_up,
                of: x.of,
                scaled_lock_wait_ms: x.scaled_lock_wait_ms,
              },
            ]),
          ),
          frozen_owner_production_wait: Object.fromEntries(
            e.frozenProduction.map((x) => [x.engine, x.rows]),
          ),
          files: "contention/waits.jsonl, contention/frozen-owner*.json",
        }
      : { status: statusOf("P-7"), reason: notRun },
    "P-8": e.retirements.length
      ? {
          status: statusOf("P-8"),
          engines: enginesOf(e.retirements),
          label:
            "counted from the kernel's own trace in each page (activity.cancel, lease.retired, lease.retire_failed) while the P-7 scenarios ran; the counted events are kept in contention/retirements-trace.<engine>.json",
          by_engine: Object.fromEntries(
            e.retirements.map((x) => [x.engine, x.conditions]),
          ),
          files:
            "contention/retirements.<engine>.json, contention/retirements-trace.<engine>.json",
        }
      : { status: statusOf("P-8"), reason: notRun },
    "P-9": e.yieldPolicy.length
      ? {
          status: statusOf("P-9"),
          engines: enginesOf(e.yieldPolicy),
          label:
            "the FIXTURE leader with each yield policy (none, macrotask, scheduler.yield, idle); policies are fixture code (production supplies its own at WEB-09b); 'scheduler_yield' falls back to a macrotask where the engine has no scheduler.yield (engine_support in each file)",
          by_engine: Object.fromEntries(
            e.yieldPolicy.map((x) => [
              x.engine,
              { engine_support: x.engine_support, rows: x.rows },
            ]),
          ),
          files:
            "contention/yield-policy.<engine>.json, contention/yield-policy.jsonl",
        }
      : { status: statusOf("P-9"), reason: notRun },
    "P-13": e.followers.length
      ? {
          status: statusOf("P-13"),
          engines: enginesOf(e.followers),
          label:
            "healthy-follower reads caused by `atlas-sync` hints (R60): a FIXTURE leader, a healthy follower showing the outbox facade and the cache gate, and a writer recording and ending durable stops; counted by test-side instrumentation only (a wrapped BroadcastChannel and IDBDatabase.prototype.transaction in the follower page), every figure recomputable from contention/follower-reads-raw.<engine>.json",
          by_engine: Object.fromEntries(
            e.followers.map((x) => [x.engine, x.conditions]),
          ),
          files:
            "contention/follower-reads.<engine>.json, contention/follower-reads-raw.<engine>.json",
        }
      : { status: statusOf("P-13"), reason: notRun },
  };
}

export const W_IN_BE = {
  W1: "BE-B1 3(a) / BE-Q23 M3 W1: the approved schema-maximum dense batch (800 x 100-item checklists)",
  W2: "BE-B1 3(b) / BE-Q23 M3 W2: the server-maximal dense batch produced by the real backend",
  W3: "BE-B1 3(c) / BE-Q23 M3 W3: an ordinary text-heavy batch",
  W4: "BE-Q23 M3 W4: multi-batch amplification",
  W5: "BE-B1 3(e) / BE-Q23 M3 W5: snapshot pages at each candidate limit (processing path only)",
  W6: "BE-Q23 M3 W6: the largest single projection per kind",
  W7: "BE-Q23 M3 W7: malformed and oversize negative controls",
};

/** One line per status of a resolution: what a reader must see before any figure. */
const listOf = (resolution, status) =>
  resolution.cells
    .filter((c) => c.status === status)
    .map((c) => ({ id: c.id, reasons: c.reasons }));

/**
 * `results.json` of a hand-over: every field from the carried evidence, its resolution, and `context` ({ now, machine, pinned,
 * configValues, sourceFacts }). Deterministic: the same inputs give the same object, field for field.
 */
export function projectResults({ evidenceDir, resolution, context }) {
  const r = reader(evidenceDir);
  const {
    now,
    machine: machineRecord,
    pinned,
    configValues,
    sourceFacts,
  } = context;
  const item = (name) =>
    resolution.items[name] ?? { status: "not_run", cells: 0, satisfied: 0 };
  const statusOf = (name) => item(name).status;
  const { derived } = resolution;
  const failure = derived.desktop_valid_workload_failure;
  const stages = Object.fromEntries(
    (existsSync(join(evidenceDir, "stages"))
      ? readdirSync(join(evidenceDir, "stages"))
          .filter((f) => f.endsWith(".json"))
          .sort()
      : []
    ).map((f) => [f.replace(/\.json$/, ""), r.json(`stages/${f}`) ?? {}]),
  );
  const measurements = r.jsonl("measurements.jsonl");
  const values = r.jsonl("values.jsonl");
  const byName = (name) => values.filter((v) => v.name === name);
  const memory = r.list("memory", "P-11.");
  const w2Memory = r.list("w2", "P-W2.");
  const w2Captures = existsSync(join(evidenceDir, "w2"))
    ? readdirSync(join(evidenceDir, "w2"))
        .filter((f) => /^W2-captured\..+\.json$/.test(f))
        .sort()
    : [];
  const w2Hashes = Object.fromEntries(
    w2Captures.map((f) => [
      f,
      sha256(readFileSync(join(evidenceDir, "w2", f))),
    ]),
  );
  const bundleRecord = r.json("bundle-delta.json");
  const integrationSummary = r.json("integration-run/summary.json");

  // Isolation, per cell (review R1): every timing, rate, memory and footprint cell judged over its own window by its own stage's samples.
  const judgedCells = resolution.cells.filter((c) => c.isolation);
  const verdicts = Object.fromEntries(
    ["clean", "idle_foreign", "contaminated", "unknown"].map((v) => [
      v,
      judgedCells.filter((c) => c.isolation.verdict === v).length,
    ]),
  );
  const isolationSummary = {
    judged_cells: judgedCells.length,
    ...verdicts,
    all_clean: judgedCells.length > 0 && verdicts.clean === judgedCells.length,
  };
  // The tests themselves, for the reader (informational: completeness is judged per cell above).
  const testsByStage = {};
  for (const t of r.jsonl(COLLECTION_LOG)) {
    const stage = typeof t.stage === "string" ? t.stage : "unknown";
    testsByStage[stage] = [...(testsByStage[stage] ?? []), t];
  }
  const tests = Object.entries(testsByStage)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([stage, list]) => {
      const file = join(evidenceDir, "isolation", `${stage}.jsonl`);
      let samples = [];
      try {
        samples = existsSync(file) ? readSamples(file) : [];
      } catch {
        samples = [];
      }
      try {
        return annotate({ rows: [], tests: list, samples }).tests;
      } catch {
        return list.map((t) => ({ ...t, isolation: { verdict: "unknown" } }));
      }
    });

  const w2 = byName("P-W2 capture");
  const backendSeen = byName("backend");
  const pq2 = byName("P-Q2 quota reserve inputs");
  const shell = {
    dist: r.json("shell/dist.json"),
    "dist-fixture": r.json("shell/dist-fixture.json"),
  };
  const programme = contentionProgramme(r, statusOf);
  const named = (prefix) =>
    measurements
      .filter((m) => typeof m.name === "string" && m.name.startsWith(prefix))
      .map((m) => m.name)
      .filter((n, i, a) => a.indexOf(n) === i);
  const capturesResolved = resolution.cells
    .filter((c) => c.kind === "w2-capture")
    .every((c) => c.status === "ok");
  // The admission lists come from the resolved outcome cells (the very outcomes the contract judged), in run order per engine.
  const outcomesOf = (pred) =>
    Object.fromEntries(
      ENGINES.map((engine) => [
        engine,
        resolution.cells
          .filter((c) => c.kind === "outcome" && c.engine === engine && pred(c))
          .map((c) => c.outcome ?? null),
      ]),
    );
  const w1Outcomes = outcomesOf(
    (c) => c.source === "p11" && c.workload === "W1",
  );
  const w2Outcomes = outcomesOf((c) => c.source === "w2-cold");
  const w2Live = Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      resolution.cells.find(
        (c) =>
          c.kind === "outcome" && c.engine === engine && c.source === "w2-live",
      )?.outcome ?? null,
    ]),
  );
  const devicePage = Object.fromEntries(
    ENGINES.map((engine) => [
      engine,
      r.json(`device-page/results.${engine}.json`),
    ]),
  );
  const deviceValidation = Object.fromEntries(
    resolution.cells
      .filter((c) => c.kind === "device-file")
      .map((c) => [
        `results.${c.engine}.json`,
        { status: c.status, reasons: c.reasons },
      ]),
  );

  // ---- the consumer map: every BE-B1 item (1 to 7) and BE-Q23 row (M0 to M9), with what this record answers ------------------------------
  const provenanceStatus =
    integrationSummary?.backend &&
    backendSeen.length > 0 &&
    resolution.outcomes_complete
      ? "measured"
      : "partial";
  const desktop = "desktop-playwright";
  const entry = (status, answeredBy, reason, owner, extra = {}) => ({
    status,
    answered_by: answeredBy,
    reason,
    owner,
    environment: extra.environment ?? desktop,
    claims_device_class: extra.claims_device_class ?? false,
    ...extra,
  });
  // Revision 6 (review 6 R7): the physical-device part of a row is WEB-09d's (STAGED-ACCEPTANCE-20261011), not a prerequisite of BE-B1/BE-Q23.
  const devicesOwner = `WEB-09c (desktop, this record); ${DEVICE_OWNER}`;
  const consumerMap = {
    "BE-B1:1 provenance": entry(
      provenanceStatus,
      ["H0", "candidate", "backend"],
      "atlas-web commit, tree and source fingerprint, the API-types pin, the backend tag, binary hash and the api_version the server reported, date, operator, raw traces retained",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-B1:2 real devices, named": entry(
      "transferred",
      ["H1"],
      "no physical device was profiled: this record is one desktop machine; the device measurements are WEB-09d's (STAGED-ACCEPTANCE-20261011; OD-1 had escalated the roster on 10 October 2026)",
      DEVICE_OWNER,
      { claims_device_class: false },
    ),
    "BE-B1:3 workloads with bytes, nodes and changes": entry(
      "partial",
      ["H3", "P-2", "P-11", "P-W2"],
      `W1, W3 to W7 generated and hashed; W2 captured from the real /sync${capturesResolved ? "" : " (NOT complete: see P-W2)"}; delta pages at limit 50 and mixed ordinary/dense delta pages (3(d)) are not generated; the Q9 co-resident shapes (3(g)) only as P-5 and P-Q`,
      devicesOwner,
    ),
    "BE-B1:4 multi-tab on every class": entry(
      "partial",
      ["H5", "P-6", "P-7", "P-8", "P-9", "P-13"],
      "desktop two- and three-page cases with a FIXTURE leader and synthetic delays only; takeover mid-snapshot is WEB-09b's, a real freeze WEB-08c's, the installed app plus a tab and every mobile class WEB-09d's physical-device pass (not run)",
      `WEB-09b (production leader), WEB-08c (real freeze), ${DEVICE_OWNER}`,
    ),
    "BE-B1:5 metrics per run": entry(
      "partial",
      ["H2", "P-11", "P-W2", "P-Q"],
      "desktop: Chromium heap (CDP), the browser's RSS attributed per run (its own processes; on macOS WebKit with its WebContent, Networking and GPU services from the host's launchd domain; BROWSER-PROCESS RSS, not device memory and not server RSS), scan and commit times, outcomes, five cold runs; IndexedDB bytes only as Chromium's exact figure and the obfuscated estimate elsewhere; the device tools (dumpsys, Instruments, about:memory) are WEB-09d's (not run)",
      devicesOwner,
    ),
    "BE-B1:6 derived values": entry(
      "partial",
      ["H9", "C1", "C3", "C5"],
      "desktop D(engine), W1/W2 admission at limit 1 on desktop, the limit in use per phase (source: delta from the sizing constants, snapshot from the production composition's source facts; production snapshot requests were not measured, WEB-09b/WEB-09d), per-request overhead (P-4), the validator's use of maxItems (source); needs_finer_pagination is UNDETERMINED for supported devices",
      devicesOwner,
    ),
    "BE-B1:7 format": entry(
      "partial",
      [
        "results.json",
        "resolution.json",
        "report.md",
        "evidence/",
        "SHA256SUMS",
      ],
      "machine-readable results, the resolved evidence contract, the evidence itself, a short report and checksums exist; the statement that every figure is measured on real hardware CANNOT be made (desktop only)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M0 provenance": entry(
      provenanceStatus,
      ["H0", "candidate", "backend"],
      "as BE-B1:1",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M1 roster": entry(
      "transferred",
      ["H1"],
      "no physical device, installed app or browser without a device-memory signal was profiled; the roster and its runs are WEB-09d's (STAGED-ACCEPTANCE-20261011)",
      DEVICE_OWNER,
    ),
    "BE-Q23:M2 method": entry(
      "partial",
      ["H2"],
      "the desktop method is stated (heap in Chromium only, the browser's attributed RSS, GC before baseline and after, five cold runs, outcome per run); the per-platform device tools are part of the device package, not run",
      devicesOwner,
    ),
    "BE-Q23:M3 fixtures": entry(
      capturesResolved ? "measured" : "partial",
      ["H3", "fixtures/hashes.json", "fixtures/W2-hashes.json"],
      capturesResolved
        ? "generator source and SHA-256 of W1, W3 to W7; the W2 bytes captured from the real /sync in every engine (limits 1 and 80), hashed, parsed and resolved against their records"
        : "generator source and SHA-256 of W1, W3 to W7; W2 not captured and resolved in every engine (see P-W2)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M4 granularity sweep": entry(
      "partial",
      ["P-2", "P-11 (W5 in the device page)", "P-W2"],
      "desktop engines: the graded dense ladder 100/200/400/800 and the batches-per-page ladder (W5 1..80); no finer parameter exists (BE-Q23 unshipped), so only the limit axis; no device class",
      devicesOwner,
    ),
    "BE-Q23:M5 multi-tab scenarios": entry(
      "partial",
      ["H5", "P-6 to P-9", "P-13"],
      "as BE-B1:4",
      `WEB-09b, WEB-08c, ${DEVICE_OWNER}`,
    ),
    "BE-Q23:M6 bounded processing as built": entry(
      "measured",
      ["H6"],
      "a byte scan with no object graph, one element decoded at a time inside the commit, chunked writes; results only WITHOUT a finer-delivery parameter (none exists)",
      "WEB-09c",
      { environment: "source" },
    ),
    "BE-Q23:M7 cost of finer requests": entry(
      statusOf("P-4") === "measured" ? "partial" : "not_run",
      ["P-4", "P-10", "P-3", "P-9"],
      "desktop per-request overhead (pre-issue, lease and lock, request, record) on loopback and behind a 250 ms proxy delay; a 10,000-resource snapshot is WEB-09b's and was not run",
      `WEB-09b (snapshot); device CPU: ${DEVICE_OWNER}`,
    ),
    "BE-Q23:M8 smallest unprocessable response": entry(
      "partial",
      ["H8"],
      failure === null
        ? "desktop: UNDETERMINED, the desktop programme's outcomes are incomplete (see desktop_programme); the answer for supported devices is WEB-09d's (not run)"
        : failure
          ? "desktop: valid workloads failed (see H8.desktop_answer); the answer for supported devices is WEB-09d's (not run)"
          : "desktop: no valid workload failed on any desktop engine of this programme, whose outcomes are complete; the answer for supported devices is WEB-09d's (not run)",
      devicesOwner,
    ),
    "BE-Q23:M9 derived values": entry(
      "partial",
      ["H9"],
      "desktop D(engine) and W1/W2 admission at limit 1; the limit in use per phase; needs_finer_pagination undetermined for supported devices; validator and maxItems answered from source",
      devicesOwner,
    ),
  };

  const scope = acceptanceScope(resolution, failure, consumerMap);
  const desktopProgramme = {
    contract_version: CONTRACT_VERSION,
    complete: resolution.complete,
    outcomes_complete: resolution.outcomes_complete,
    counts: resolution.counts,
    cells: resolution.cells.length,
    missing: listOf(resolution, "missing"),
    invalid: listOf(resolution, "invalid"),
    failed: listOf(resolution, "failed"),
    failed_controls: listOf(resolution, "failed_control"),
    not_isolated: listOf(resolution, "not_isolated"),
    unavailable: listOf(resolution, "unavailable"),
    note: "every required observation of the evidence contract (scripts/lib/profile-contract.mjs, resolution.json) resolved against the evidence this hand-over carries (evidence/); a partial hand-over is valid only as a partial one: its validator exits 1 (2 with --allow-partial when nothing is invalid or a failed control), and nothing is concluded from what is absent",
  };

  return {
    schema: 3,
    title: `${EVIDENCE_KEY} — WEB-09c measurement hand-over`,
    evidence_key: EVIDENCE_KEY,
    owner: EVIDENCE_OWNER,
    first_paragraph: firstParagraph(scope),
    acceptance_scope: scope,
    projection:
      "every field below but the context (candidate.at_handoff, machine, backend.pin, programme.P-12.values) is projected from evidence/ and resolution.json by scripts/lib/profile-projection.mjs; the validator projects them again and refuses any difference",
    candidate: {
      at_handoff: now,
      stages: Object.fromEntries(
        Object.entries(stages).map(([stage, x]) => [
          stage,
          {
            source_fingerprint: x.candidate?.source_fingerprint ?? null,
            commit: x.candidate?.commit ?? null,
            status_porcelain: x.candidate?.status_porcelain ?? null,
            invocation: x.invocation ?? null,
            started_at: x.started_at ?? null,
            action_started_at: x.action_started_at ?? null,
            action_finished_at: x.action_finished_at ?? null,
            finished_at: x.finished_at ?? null,
            exit_status: x.exit_status ?? null,
            sealed: x.sealed === true,
            sampler: x.sampler ?? null,
            load_at_start: x.load_at_start ?? null,
            load_at_end: x.load_at_end ?? null,
          },
        ]),
      ),
    },
    backend: {
      pin: pinned,
      integration_runner: integrationSummary?.backend ?? null,
      reported_by_server: backendSeen.map(({ engine, health, revision }) => ({
        engine,
        health: health ?? null,
        revision: revision ?? null,
      })),
    },
    machine: machineRecord,
    H0: {
      status: "measured",
      provenance: machineRecord?.atlas_web ?? null,
      candidate_fingerprint: now?.source_fingerprint ?? null,
      node: machineRecord?.node ?? null,
      playwright: machineRecord?.playwright ?? null,
      backend: `configured target ${pinned?.backend_tag} (${pinned?.backend_commit}); use each measurement's recorded backend attribution (historical results may differ)`,
      api_pin: "contract-pin.json",
      date: machineRecord?.recorded_at ?? null,
      operator: "the Running-phase agent; no person has reviewed this record",
    },
    H1: {
      status: "transferred",
      reason:
        "no physical device was profiled. OD-1 (10 October 2026) escalated the roster; STAGED-ACCEPTANCE-20261011 (11 October 2026) transferred the physical-device measurements to WEB-09d, which runs them before beta once the roster (real devices, installed apps, the lowest-memory supported device per family, a mid-range mobile, browsers without deviceMemory), its operator and the HTTPS set-up are named; not run",
      roster: [
        {
          device: "developer machine",
          os: machineRecord?.os ?? null,
          cpu: machineRecord?.cpu ?? null,
          cores: machineRecord?.cores ?? null,
          memory_gib: machineRecord?.memory_gib ?? null,
          engines: machineRecord?.engines ?? null,
          // What each desktop engine reported as navigator.deviceMemory on THIS machine. A null here is that engine's desktop behaviour,
          // not evidence from a supported device without the signal: no such device was profiled (H1 transferred to WEB-09d).
          device_memory_signal_by_engine: Object.fromEntries(
            ENGINES.map((engine) => [
              engine,
              devicePage[engine]?.machine?.device_memory_gib ?? null,
            ]),
          ),
          installed_app: false,
        },
      ],
    },
    H2: {
      status: "partial",
      method:
        "peak and retained JS heap (Chromium only, CDP) and the browser's resident set (ps) across receive, scan, validate, stage and commit; the processes counted are the browser's own: the test worker's descendants and, for WebKit on macOS, every service in each WebKit host's launchd PID domain (WebContent, Networking, GPU), each checked against pid reuse (scripts/lib/browser-processes.mjs); every run records its process set, every sample, failed samples and whether its attribution was complete, and a run without complete attribution is not memory evidence. BROWSER-PROCESS RSS: not device memory, not server RSS. Five cold runs (a new browser context each); idle baseline recorded before the run; outcome per run; the modelled figure is WEB-03's (A:3483-3497) beside each measured one, labelled modelled",
      modelled: {
        "W1 at limit 1":
          "150.75 MiB (WEB-03's combined check, 120.6 % of its R, rejected by that model; this client does not apply that check, it bounds processing instead)",
      },
      memory_files: [
        ...memory.map((m) => `memory/P-11.${m.engine}.json`),
        ...w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      ],
      memory_cells: Object.fromEntries(
        CELL_STATUSES.map((s) => [
          s,
          resolution.cells.filter((c) => c.kind === "memory" && c.status === s)
            .length,
        ]),
      ),
    },
    H3: {
      status: capturesResolved ? "measured" : "partial",
      fixtures: RECORDED.workloads,
      w2_captured: w2,
      w2_capture_hashes: w2Hashes,
      w2_observed_bound: byName("P-W2 observed bound"),
      w2_limits_probe: byName("W2-limits"),
      in_backend_terms: W_IN_BE,
      note: "W1 reproduces the design's 455,214 nodes and 5.83 MiB (tests/profiling/workloads.test.ts); W2 is the server-maximal dense batch the released backend produced through put_field (checklist values) and a grant, captured from the real /sync",
    },
    H4: {
      status: "partial",
      reason:
        "desktop engines only: the page-size ladder (100/200/400/800 changes, ordinary and dense) is P-2; the batch ladder 1 to 80 is W5 in the device page",
      measurement_names: named("P-2"),
    },
    H5: {
      status: "partial",
      measured:
        "two and three pages of one context with a FIXTURE leader syncing back to back while another page makes ordinary requests, exposures and closing writes (P-6 to P-9), and a healthy follower reading on hints (P-13), desktop, synthetic delays; the outbox drain with a second tab (E-O4, functional)",
      reason:
        "a second tab taking over mid-snapshot (WEB-09b), a REAL freeze or back/forward cache (WEB-08c), an installed app plus a tab and every mobile class need the production leader and real devices",
    },
    H6: {
      status: "measured",
      design:
        "bounded processing as built: a byte scan builds no object graph (pass 1), one element is decoded at a time inside the commit transaction (pass 2), writes are chunked, only ids of interest to local work are remembered; the working set is one element, never the page. No backend finer-delivery parameter exists (BE-Q23 unshipped), so the build is described without one.",
    },
    H7: {
      status: "partial",
      reason:
        "only the `limit` axis exists (no finer parameter): the per-page costs are P-2 and P-4; a 10,000-resource snapshot is WEB-09b's and was not run",
      per_request_lease_cost:
        "P-4 (pre-issue, stamping and post-response segments)",
    },
    H8: {
      status: "partial",
      desktop_valid_workload_failure: failure,
      derived_from: resolution.outcomes_complete
        ? "a desktop programme whose outcomes are complete (desktop_programme.outcomes_complete)"
        : "an INCOMPLETE desktop programme: only failures it holds are facts; their absence is not",
      desktop_answer:
        failure === null
          ? "UNDETERMINED: the desktop programme's outcomes are incomplete (see desktop_programme), so the absence of a failure in it is not evidence that none would occur"
          : failure
            ? { failures: resolution.failures }
            : "no valid workload (W1, W3, W4, W6 in five cold runs; W2 live and in five cold runs; the device page's runs) was refused or failed on any desktop engine of this programme",
      negative_controls_not_fulfilled: desktopProgramme.failed_controls,
      reason:
        "for supported mobile devices the answer is WEB-09d's physical-device pass (transferred, not run)",
    },
    H9: {
      status: "partial",
      limit_in_use: {
        delta: `${configValues?.config?.initialLimitUnconstrained ?? "?"} at the unconstrained initial rung, ${configValues?.config?.initialLimitOther ?? "?"} for every other class; step-down only (step-up ${configValues?.config?.stepUpAfterSuccesses === null ? "disabled" : "enabled"}); never above syncLimitMax ${configValues?.config?.syncLimitMax ?? "?"}`,
        // Revision 5 (review 5 R6): the snapshot phase's request is read from the candidate's source facts, never a constant; what the
        // programme did NOT measure is said apart from it.
        snapshot: snapshotAnswer(sourceFacts, configValues),
        snapshot_requests: sourceFacts?.snapshot_requests ?? null,
        snapshot_measured: false,
        snapshot_measurement:
          "NOT measured by this programme: its fixture leader seeds a delta cache and W5 exercises snapshot-shaped processing only, so production first-snapshot, adoption and recovery performance and the limits a production snapshot really used are not evidence here; WEB-09b owns production leadership, snapshot and recovery, WEB-09d integrated and supported-device acceptance",
        source: "src/data/model/config.ts (constants.md)",
        source_facts: sourceFacts ?? null,
      },
      client_validator_consumes_SyncPage_batches_maxItems: false,
      reason_validator:
        "decision D-10: the scanner enforces its own bounds (80 batches, 800 changes per batch) and does not rely on the contract's batches.maxItems; no file under src/ reads `maxItems` (only the comment of syncLimitMax names it)",
      desktop_D_largest_dense_changes_committed:
        derived.desktop_D_largest_dense_changes_committed,
      desktop_D_basis:
        "the largest dense P-2 page whose commit series, and the series of every smaller dense page, RESOLVED in that engine (exact sample count, raw support, window, isolation); null when the smallest did not",
      w1_outcomes_at_limit_1: w1Outcomes,
      w2_outcomes_at_limit_1: w2Outcomes,
      w2_live_outcome: w2Live,
      outcomes_basis:
        "the outcome of every resolved outcome cell (null where the cell did not resolve), in run order per engine",
      // false only from a COMPLETE programme with no failure; otherwise null (a failure is a fact in H8, not by itself a diagnosis).
      desktop_needs_finer_pagination: derived.desktop_needs_finer_pagination,
      needs_finer_pagination: `undetermined for supported devices; desktop: ${
        derived.desktop_needs_finer_pagination === false
          ? "no valid workload failed on a desktop engine of this complete, isolated programme, so the desktop engines do not need it"
          : failure
            ? "UNDETERMINED: a valid workload failed on a desktop engine (H8); that failure is a fact, but it does not by itself establish finer pagination as the remedy"
            : "UNDETERMINED, the desktop programme is not complete (see desktop_programme)"
      }`,
    },
    programme: {
      "P-1": {
        ...(bundleRecord && typeof bundleRecord === "object"
          ? bundleRecord
          : { reason: "the bundle stage did not run in this record" }),
        status: statusOf("P-1"),
      },
      "P-1S": {
        status: statusOf("P-1S"),
        label:
          "Chromium only, CDP network and CPU throttling: EMULATED throttling, not a device; reported, not judged; every cold run judged for isolation over its own window",
        results: shell,
      },
      "P-2": { status: statusOf("P-2"), names: named("P-2") },
      "P-3": {
        status: statusOf("P-3"),
        caveat:
          "ephemeral Playwright profile; the hint is passed through Dexie's `chromeTransactionDurability` option; whether Firefox and WebKit act on it was not determined",
      },
      "P-4": {
        status: statusOf("P-4"),
        layer: "integration, released backend on loopback",
      },
      "P-5": {
        status: statusOf("P-5"),
        measured:
          "maxInFlight 1, 200 drafts and 201 dense drafts, 20 runs each",
        omitted:
          "maxInFlight 2 and 3 (D-18 fixes 1: a declared omission, not a measurement), and the outbox drain's own effect on a second page's waits (the sync leader's effect is P-7 and P-9)",
      },
      ...programme,
      "P-10": {
        status: statusOf("P-10"),
        conclusion:
          "the stamped request time-out (30 s) against the measured durations; see the rows named P-10",
      },
      "P-11": {
        status: statusOf("P-11"),
        note: "desktop engines through the real wrapper; physical devices not run (H1: WEB-09d's)",
      },
      "P-W2": {
        status: statusOf("P-W2"),
        layer:
          "the released backend (put_field with checklist values and a grant, then the real /sync) on a desktop engine; the captured bytes then processed through the production path in five cold runs per engine",
        captures: w2,
        processing_files: w2Memory.map((m) => `w2/P-W2.${m.engine}.json`),
      },
      "W2-limits": { status: statusOf("W2-limits") },
      device: {
        status: statusOf("device"),
        note: "the device page's whole protocol on each desktop engine (39 distinct runs over 19 workloads, W2 from that engine's capture): the route a device operator follows, not a device run",
      },
      "P-12": {
        status: "provisional",
        file: "handoff/constants.md",
        values: configValues,
      },
      "P-Q": {
        status: statusOf("P-Q"),
        note: "footprints measured; Firefox and Safari report an obfuscated estimate",
        by_engine: Object.fromEntries(
          byName("P-Q footprints").map((v) => [v.engine, v]),
        ),
      },
      "P-Q2": {
        status: statusOf("P-Q2"),
        note: "the atlas-auth burst, each engine's estimate step and the ledger overhead; the reserve itself (8 MiB) is NOT changed: a desktop figure cannot set a device constant",
        by_engine: Object.fromEntries(pq2.map((v) => [v.engine, v])),
      },
    },
    consumer_map: consumerMap,
    desktop_programme: desktopProgramme,
    isolation: {
      method: `${ISOLATION_METHOD} Each cell is judged over its own window by the load samples of its OWN stage only; a stage whose sampler was not ready before its action, did not write its final sample after it, wrote malformed samples or whose clock went backwards judges all its cells unknown.`,
      sampling_interval_ms: SAMPLE_INTERVAL_MS,
      summary: isolationSummary,
      tests,
      applicability:
        "a timing, rate, memory or footprint figure is applicable as an isolated desktop measurement only when its cell is `ok` (its window `clean`); any other verdict qualifies it (it was, or may have been, taken beside other heavy work, or its coverage is unknown). Shapes, byte counts, hashes and admission outcomes do not depend on isolation. A 5 s poll cannot prove that no short foreign job ran between two samples: final timings need a protected controller",
    },
    // OD-1 is kept as the decision of record for the desktop scope and the roster's open items; its timing is superseded (revision 6, R7).
    escalations: [
      {
        id: "OD-1",
        decided: "Desktop now; escalate roster (Kieran, 10 October 2026)",
        status: "timing superseded",
        superseded_by: `${STAGED_ACCEPTANCE.id} (${STAGED_ACCEPTANCE.decided}): ${STAGED_ACCEPTANCE.supersedes}`,
        needed_before: "WEB-09d's physical-device pass",
        needed: [
          "the named floor device for each family (model, RAM, OS)",
          "the mid-range mobile",
          "who runs the protocol and where",
          "the HTTPS hosting choice (a local CA the device trusts, or Android `adb reverse`; an external tunnel is the operator's call)",
        ],
        current:
          "BE-B1 item 2 and BE-Q23 M1 are transferred to WEB-09d and not run; needs_finer_pagination is undetermined for supported devices; missing physical-device results alone do not block BE-B1/BE-Q23 scoped technical completion (acceptance_scope)",
      },
    ],
    retake_on_composed_client: [
      "P-6 to P-9 and P-13 (the FIXTURE leader becomes WEB-09b's production leader)",
      "P-4 (per-request lease cost with production leadership)",
      "multi-tab H5 (takeover mid-snapshot; installed app plus a tab)",
    ],
    device_page_validation: deviceValidation,
    measurement_rows: measurements.length,
  };
}

/** `report.md`: generated from `results.json`, the resolution and the carried measurement rows only (the validator regenerates it). */
export function renderReport({ results, resolution, evidenceDir }) {
  const measurements = reader(evidenceDir).jsonl("measurements.jsonl");
  const now = results.candidate.at_handoff ?? {};
  const pinned = results.backend.pin ?? {};
  const machineRecord = results.machine ?? {};
  const integrationBackend = results.backend.integration_runner;
  const derived = resolution.derived;
  const failure = derived.desktop_valid_workload_failure;
  const desktopProgramme = results.desktop_programme;
  const isolationSummary = results.isolation.summary;
  const cellOf = new Map(resolution.cells.map((c) => [c.id, c]));
  const table = measurements
    .map((m) => {
      const cell = cellOf.get(`${m.name}[${m.engine}]`);
      return `| ${m.name} | ${m.engine} | ${m.n} | ${m.p50} | ${m.p95} | ${m.max} | ${cell ? `${cell.status}${cell.isolation ? ` (${cell.isolation.verdict})` : ""}` : "not a required cell"} |`;
    })
    .join("\n");
  const statusLine = resolution.complete
    ? "**Desktop programme: COMPLETE and ISOLATED.** Every required cell of the evidence contract resolved, and Every load-dependent cell was taken with no other heavy work on the controller. Physical-device measurements are transferred to WEB-09d and not run (H1)."
    : `**Desktop programme: ${resolution.outcomes_complete ? "outcomes complete, NOT ISOLATED" : "INCOMPLETE"}.** This is a partial hand-over: of ${resolution.cells.length} required cells, ${resolution.counts.missing} missing, ${resolution.counts.invalid} invalid, ${resolution.counts.failed} failed, ${resolution.counts.failed_control} failed control(s), ${resolution.counts.not_isolated} not isolated. No desktop conclusion is drawn from what is absent.`;
  const head = (list) =>
    list.length
      ? `${list
          .slice(0, 40)
          .map((c) => `${c.id} (${c.reasons.join("; ")})`)
          .join(
            "; ",
          )}${list.length > 40 ? `; and ${list.length - 40} more (resolution.json)` : ""}`
      : "none";
  const completenessSection = [
    `* Desktop programme complete: **${resolution.complete}** (outcomes complete: ${resolution.outcomes_complete}). Contract version ${CONTRACT_VERSION}; ${resolution.cells.length} required cells: ${Object.entries(
      resolution.counts,
    )
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")}.`,
    `* Missing: ${head(desktopProgramme.missing)}.`,
    `* Invalid: ${head(desktopProgramme.invalid)}.`,
    `* Failed: ${head(desktopProgramme.failed)}.`,
    `* Negative controls not fulfilled: ${head(desktopProgramme.failed_controls)}.`,
    `* Not isolated: ${head(desktopProgramme.not_isolated)}.`,
    `* Unavailable by declared capability: ${head(desktopProgramme.unavailable)}.`,
    `* Isolation of ${isolationSummary.judged_cells} judged cells: ${isolationSummary.clean} clean, ${isolationSummary.idle_foreign} idle_foreign, ${isolationSummary.contaminated} contaminated, ${isolationSummary.unknown} unknown (load samples every ${SAMPLE_INTERVAL_MS / 1000} s).`,
    `* H8 (a valid workload failed on a desktop engine): ${failure === null ? "undetermined" : failure}. H9 desktop needs finer pagination: ${derived.desktop_needs_finer_pagination === null ? "undetermined" : derived.desktop_needs_finer_pagination}. D(engine): ${JSON.stringify(derived.desktop_D_largest_dense_changes_committed)}.`,
  ].join("\n");
  // Revision 6 (review 6 R7): the acceptance scope, rendered from results.acceptance_scope (STAGED-ACCEPTANCE-20261011 §3's three parts).
  const scope = results.acceptance_scope;
  const acceptanceSection = [
    `Decision: ${scope.decision.id} (${scope.decision.decided}; ${scope.decision.repository} \`${scope.decision.brief}\`, SHA-256 \`${scope.decision.brief_sha256}\`; authority \`${scope.decision.authority}\`, SHA-256 \`${scope.decision.authority_sha256}\`). It supersedes ${scope.decision.supersedes}.`,
    "",
    `* **Desktop-scoped development decision:** ${scope.desktop_decision.supports ? "supported" : "NOT supported"}. ${scope.desktop_decision.statement}.${scope.desktop_decision.needs.length ? ` Needs: ${scope.desktop_decision.needs.join("; ")}.` : ""}${scope.desktop_decision.withheld_because.length ? ` Withheld because: ${scope.desktop_decision.withheld_because.join("; ")}.` : ""} Scope: ${scope.desktop_decision.scope}.`,
    `* **Physical-device measurements:** ${scope.physical_devices}.`,
    ...scope.transferred_to_web09d.map(
      (t) =>
        `  * ${t.item} (desktop: ${t.desktop_status}): ${t.physical_device}; ${t.owner}, ${t.status}`,
    ),
    "* **Material choices that need an informed human decision:**",
    ...scope.human_decisions.map(
      (h) => `  * ${h.decision}. Owner: ${h.owner} (${h.basis}).`,
    ),
    `* **Held failures:** ${scope.held_failures.cells.length ? `${scope.held_failures.cells.slice(0, 40).join("; ")}${scope.held_failures.cells.length > 40 ? `; and ${scope.held_failures.cells.length - 40} more (resolution.json)` : ""}` : "no failed, failed-control or invalid cell"}; ${scope.held_failures.workload_failures.length ? `${scope.held_failures.workload_failures.length} valid-workload failure(s) on a desktop engine (H8)` : "no valid-workload failure held"}. ${scope.held_failures.rule}.`,
    `* **This package:** independently reviewed: ${scope.package.independently_reviewed}; claims acceptance: ${scope.package.claims_acceptance}. ${scope.package.note}.`,
  ].join("\n");
  return `# ${results.title}

${results.first_paragraph}

Every figure below is \`measured\` (taken by this programme in the stated environment), \`partial\`, \`not_run\`, \`transferred\` (to its named owner, not run) or \`escalated\` (with the reason), or \`modelled\` (WEB-03's arithmetic). Nothing here is a pass mark. Playwright contexts are ephemeral profiles: \`durability: "strict"\` is not measured against a real on-disk profile. Browser-process RSS is not device memory and not server RSS. Server RSS, Node-only runs, emulated devices, single-tab results presented as multi-tab, and \`limit\`-only step-down presented as proof that finer delivery is unnecessary are **not** claimed.

${statusLine}

Candidate: commit ${now.commit}, tree ${now.tree}, source fingerprint ${now.source_fingerprint}. Backend: ${pinned.backend_tag} (${pinned.backend_commit}); release archive SHA-256 (as the integration runner verified it) ${integrationBackend?.sha256 ?? "not recorded (integration stage not run)"}.

Machine: ${machineRecord.os}, ${machineRecord.cpu}, ${machineRecord.cores} cores, ${machineRecord.memory_gib} GiB, Node ${machineRecord.node}, ${machineRecord.playwright}; engines ${JSON.stringify(machineRecord.engines)}.

## Completeness and isolation (read before any figure)

${completenessSection}

## Acceptance scope (what this hand-over can and cannot support)

${acceptanceSection}

## What the backend authors can use (consumer map)

| Item | Status | Answered by | Reason | Owner |
| --- | --- | --- | --- | --- |
${Object.entries(results.consumer_map)
  .map(
    ([k, v]) =>
      `| ${k} | ${v.status} | ${v.answered_by.join(", ")} | ${v.reason} | ${v.owner} |`,
  )
  .join("\n")}

## Status by item

${Object.entries(results)
  .filter(([k]) => /^H\d$/.test(k))
  .map(
    ([k, v]) =>
      `* **${k}**: ${v.status}${v.reason ? ` (${v.reason})` : ""}${v.measured ? ` (${v.measured})` : ""}`,
  )
  .join("\n")}

## Programme

${Object.entries(results.programme)
  .map(
    ([k, v]) =>
      `* **${k}**: ${v.status}${v.reason ? `. ${v.reason}` : ""}${v.note ? `. ${v.note}` : ""}${v.caveat ? `. ${v.caveat}` : ""}${v.label ? `. ${v.label}` : ""}${v.omitted ? `. Not measured: ${v.omitted}` : ""}`,
  )
  .join("\n")}

## Measurements (milliseconds unless the name says otherwise; p50, p95 and max)

The last column is the row's cell in the evidence contract: \`ok\` (resolved and isolated) or why not, with its isolation verdict. Only \`ok\` figures are isolated desktop measurements.

| Measurement | Engine | n | p50 | p95 | max | Cell |
| --- | --- | --- | --- | --- | --- | --- |
${table}

The evidence itself is in \`evidence/\` (raw samples \`evidence/raw/\`, per-run memory \`evidence/memory/\` and \`evidence/w2/\`, the device page's own results \`evidence/device-page/\`, the contention files \`evidence/contention/\`, the throttled shell boot \`evidence/shell/\`, the stage records \`evidence/stages/\`, the load samples \`evidence/isolation/\`), every cell's resolution in \`resolution.json\`, and the recorded fixture hashes in \`fixtures/hashes.json\` and \`fixtures/W2-hashes.json\`. \`node scripts/validate-profile-handoff.mjs --handoff <this directory>\` resolves the evidence and projects this report again.
`;
}
