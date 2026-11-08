// WEB-13b revision 8's mutants (review 8 R7a `regression` and R7b `incomplete_fix`, family task-sync-navigation-draft-loss; DA-N2
// `sync-quota-late-publication` and DA-N3 `recovery-counter-admission-after-binding-end`, assigned by WEB13B-R7B-N2-N3-ASSIGNMENT-20261027;
// design assessment C1-C6 and its T9 mutation list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its
// `UNIT` list after `catalogue-web13b-r7.mjs`. Each restores ONE part of a defect the revision corrected or removes one boundary of the
// correction; `expect` names the tests written for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): the fallback predicate of DA-N3's `recordStop` alone (`authorised` back to
// `() => service.live`) is equivalent while the check just before it stands (nothing runs between them), so MU-5158 restores both, as the
// pre-correction code had neither; the observer's notification of an unchanged value is equivalent (every judgement reads the newest
// value); `COMPOSITION_VERSION` was a name for the unchanged version 3 (the base merge of 5 November 2026 adopted the accepted base's name
// `COMPOSITION_BARRIER_VERSION` for it; its value is asserted by the schema test); the dialog's
// press-time check of `importStatus` (removed, a waiting session's Import is still refused) is a second layer behind its waiting state's
// disabled Import, and no schedule makes a shown session wait without its dialog rendering again (a session waits only when it is shown
// again, which mounts a new dialog), so that mutant is equivalent and MU-5150 is the observer's streak instead.
import { sub } from "./data-catalogue.mjs";

const KEPT = "src/features/calendars/import-kept.ts";
const DIALOG = "src/features/calendars/ImportDialog.tsx";
const OBSERVER = "src/data/ui/page-cache-observer.ts";
const SYNC_WRITERS = "src/data/plans/sync-writers.ts";
const RECOVERY_WRITERS = "src/data/plans/recovery-writers.ts";
const SCHEMA = "src/data/model/schema.ts";
const ENGINE = "src/data/engine/sync-engine.ts";
const JOB = "src/data/engine/recovery-job.ts";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";
const T_RET = "tests/features/calendars/import-retention.test.tsx";
const T_SNAP = "tests/data/snapshot-plans.test.ts";
const T_SCHEMA = "tests/data/schema.test.ts";
const T_BIND = "tests/data/engine-binding-authority.test.ts";

export const UNIT_13B_R8 = [
  // ---- R7b: the durable invalidation witness -------------------------------------------------------------------------------------
  {
    id: "MU-5142",
    title:
      "WEB-13b R7b (revision 8): W18 invalidates without moving the invalidation witness",
    file: SYNC_WRITERS,
    tests: [T_SNAP],
    expect: /WIT-1 W18 moves the witness by one/,
    patch: (t) =>
      sub(t, "        cache_invalidation_seq: nextInvalidation(sync),\n", ""),
  },
  {
    id: "MU-5143",
    title:
      "WEB-13b R7b (revision 8): W24 abandons a valid cache without moving the invalidation witness",
    file: RECOVERY_WRITERS,
    tests: [T_SNAP],
    expect: /WIT-3 W24: an abandonment under a VALID cache moves it/,
    patch: (t) =>
      sub(
        t,
        "              cache_invalidation_seq: nextInvalidation(sync),\n",
        "",
      ),
  },
  {
    id: "MU-5144",
    title:
      "WEB-13b R7b (revision 8): W24 counts every abandonment as an invalidation (an empty attempt's restart ends a first fill's kept import)",
    file: RECOVERY_WRITERS,
    tests: [T_SNAP],
    expect: /WIT-3 W24: an abandonment under a VALID cache moves it/,
    patch: (t) =>
      sub(
        t,
        '        ...CLEARED_STAGING,\n        phase: "snapshot",\n        // A `valid` cache abandoned',
        '        ...CLEARED_STAGING,\n        cache_invalidation_seq: nextInvalidation(sync),\n        phase: "snapshot",\n        // A `valid` cache abandoned',
      ),
  },
  {
    id: "MU-5145",
    title:
      "WEB-13b R7b (revision 8): the activation (W23) resets the invalidation witness (the history before a refill is forgotten)",
    file: RECOVERY_WRITERS,
    tests: [T_SNAP],
    expect: /WIT-4 a first fill keeps it/,
    patch: (t) =>
      sub(
        t,
        '        phase: "delta",\n        cache_status: "valid",\n',
        '        phase: "delta",\n        cache_status: "valid",\n        cache_invalidation_seq: 0,\n',
      ),
  },
  {
    id: "MU-5146",
    title:
      "WEB-13b R7b (revision 8): the account schema stays at the version before the witness barrier (an older build that invalidates without the witness may still write)",
    file: SCHEMA,
    tests: [T_SCHEMA],
    // Re-anchored at the base merge of 5 November 2026 (same defect): the barrier is version 5, after the accepted base's version 4
    // (WEB-09c's `delta_staging`), so "stays at the version before it" is 4 now (it was 3 when the barrier was 4).
    expect:
      /version 5 \(WEB-13b revision 8\) is the invalidation-witness barrier/,
    patch: (t) =>
      sub(
        t,
        "export const SCHEMA_VERSION = 5;\n",
        "export const SCHEMA_VERSION = 4;\n",
      ),
  },
  // ---- R7b: the kept session's basis -------------------------------------------------------------------------------------------
  {
    id: "MU-5147",
    title:
      "WEB-13b R7b (revision 8): a HIDDEN session follows the cache like a shown one (revision 7's first-valid adoption: a later invalidation is adopted)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /the witness ends it|NO controller was published|L4 control: opened before the cache was ever valid|first fill, W18 and a refill/,
    patch: (t) =>
      sub(
        t,
        "  if (which.shown && !which.pending) {\n",
        "  if (!which.pending) {\n",
      ),
  },
  {
    id: "MU-5151",
    title:
      "WEB-13b R7b (revision 8): the read made when the session opened is not its basis (a session hidden before any reading adopts a later one)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /the opening read is the basis whenever it lands/,
    // Re-anchored in revision 9 (R7c): the judgement's adoption of the opening read (a rebinding keeps its own, for the old observation).
    patch: (t) =>
      sub(
        t,
        "  // The read made when it opened is what the database said then, whenever it lands.\n  if (which.opening) which.basis ??= which.observer?.get().opening ?? null;\n",
        "",
      ),
  },
  {
    id: "MU-5152",
    title:
      "WEB-13b R7b (revision 8): the kept session does not observe the page runtime's service (nothing observes the cache while no controller is mounted)",
    file: KEPT,
    tests: [T_KEPT],
    expect:
      /observed while no controller is mounted|heard through the service|the observation ends with the service/,
    // Re-anchored in revision 9 (R7c): the observation begun at the opening.
    patch: (t) =>
      sub(
        t,
        "    observer: observing ? observeCache(service) : null,\n",
        "    observer: null,\n",
      ),
  },
  {
    id: "MU-5154",
    title:
      "WEB-13b R7a (revision 8, re-expressed in revision 9): what an ended service read still stands for its database (a stale reading verifies a waiting session; since R7c, when no publication verifies, it ENDS a session shown through the refresh it no longer describes)",
    file: OBSERVER,
    tests: [T_KEPT],
    // Re-expressed in revision 9 (R7c): the same patch SURVIVED (driver run 2026-10-28T09-54-29.553Z-fc5c2a04) once publications stopped
    // verifying; its consequence now is a stale `invalidated` ending a session at its hiding.
    expect: /what an ENDED service last read no longer stands/,
    patch: (t) =>
      sub(t, "    set({ invalidations: null, invalidated: false });\n", ""),
  },
  // ---- R7a: the waiting session --------------------------------------------------------------------------------------------------
  {
    id: "MU-5148",
    title:
      "WEB-13b R7a (revision 8): the drop zone's Browse while its kept session waits opens a fresh picker",
    file: KEPT,
    tests: [T_KEPT],
    expect: /the chooser's Browse while it waits shows the SAME session/,
    patch: (t) =>
      sub(
        t,
        '    ? current({ kind: "chooser" }, context)\n',
        '    ? ((editor) => (held?.pending ? null : editor))(\n        current({ kind: "chooser" }, context),\n      )\n',
      ),
  },
  {
    id: "MU-5149",
    title:
      "WEB-13b R7a (revision 8): a read made at an earlier showing verifies a later one",
    file: KEPT,
    tests: [T_KEPT],
    expect:
      /a read made at an EARLIER showing|agreeing verifies nothing; the next showing's read does/,
    // Re-anchored in revision 9 (R7c): the showing's ticket in `verify`.
    patch: (t) =>
      sub(
        t,
        "      which.ticket !== ticket ||\n      !which.pending ||\n",
        "      !which.pending ||\n",
      ),
  },
  {
    id: "MU-5150",
    title:
      "WEB-13b R7b (revision 8): the page runtime's observation ignores an admitted invalidation's durable streak (only the status is read)",
    file: OBSERVER,
    tests: [T_KEPT],
    expect:
      /a durable streak of an admitted invalidation heard through the service/,
    patch: (t) =>
      sub(
        t,
        '            now.value.cacheStatus === "invalid" || now.value.invalidating,\n',
        '            now.value.cacheStatus === "invalid",\n',
      ),
  },
  {
    id: "MU-5153",
    title:
      "WEB-13b R7a (revision 8): an unverified cache under a cached source is the E9 refresh (the open dialog closes and discards)",
    file: DIALOG,
    tests: [T_RET],
    expect: /its cache becomes unverified/,
    patch: (t) =>
      sub(
        t,
        '    if (unverified) return { state: { kind: "waiting" }, refreshing: false };\n',
        "",
      ),
  },
  {
    id: "MU-5159",
    title:
      "WEB-13b R7a (revision 8): a session ended for an invalidation while it waited leaves its dialog open (a dead session shown)",
    file: DIALOG,
    tests: [T_RET],
    expect: /released after W18 -> W23: it closes/,
    patch: (t) =>
      sub(
        t,
        '    if ((!refreshing && status !== "expired") || closed.current) return;\n',
        "    if (!refreshing || closed.current) return;\n",
      ),
  },
  {
    id: "MU-5160",
    title:
      "WEB-13b R7a (revision 8): a waiting session's dialog presents its source and offers Import (unverified permission shown)",
    file: DIALOG,
    tests: [T_RET],
    expect: /shown again while nothing can verify it/,
    patch: (t) =>
      sub(
        t,
        '    status === "pending" ? { kind: "waiting" } : sourceState.state;\n',
        "    sourceState.state;\n",
      ),
  },
  // ---- DA-N2 / DA-N3 ------------------------------------------------------------------------------------------------------------
  {
    id: "MU-5155",
    title:
      "WEB-13b DA-N2 (revision 8): the quota stop is published after the sizing wait whatever run stands now",
    file: ENGINE,
    tests: [T_BIND],
    expect:
      /the binding ENDED during the sizing wait: nothing is shown|a successor started during the wait keeps its own state/,
    patch: (t) =>
      sub(
        t,
        '      if (run === null || run !== ownership || !alive(id) || !service.live)\n        return { when: "event" };\n',
        "",
      ),
  },
  {
    id: "MU-5156",
    title:
      "WEB-13b DA-N3 (revision 8): the recovery job admits a fresh failure count after its binding ended",
    file: JOB,
    tests: [T_BIND],
    expect:
      /no count is admitted \(the streak stays 2\)|the successor binding is not stopped/,
    patch: (t) =>
      sub(
        t,
        '    if (!authorised()) return { when: "event" };\n    let stopNow = false;\n',
        "    let stopNow = false;\n",
      ),
  },
  {
    id: "MU-5157",
    title:
      "WEB-13b DA-N3 (revision 8): a count admitted while the binding stood, delivered after it ended, still stops the ended binding",
    file: JOB,
    tests: [T_BIND],
    expect: /a count ADMITTED while the binding stood/,
    patch: (t) =>
      sub(
        t,
        '      if (!authorised()) return { when: "event" };\n      stopNow = result.stop;\n',
        '      if (!service.live) return { when: "event" };\n      stopNow = result.stop;\n',
      ),
  },
  {
    id: "MU-5158",
    title:
      "WEB-13b DA-N3 (revision 8): a counter that failed after the binding ended creates the fallback stop (marker or memory) for the next owner",
    file: JOB,
    tests: [T_BIND],
    expect:
      /a counter that FAILS after the binding ended creates no fallback stop/,
    patch: (t) =>
      sub(
        t,
        '    } catch {\n      if (!authorised()) return { when: "event" };\n      stopNow = true;\n      stoppedVersion = null;\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        authorised,\n',
        '    } catch {\n      if (!service.live) return { when: "event" };\n      stopNow = true;\n      stoppedVersion = null;\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => service.live,\n',
      ),
  },
];
