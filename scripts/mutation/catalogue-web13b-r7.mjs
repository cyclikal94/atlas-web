// WEB-13b revision 7's mutants (review 7 R7, family task-sync-navigation-draft-loss, incomplete_fix; design assessment C1-C4 and its
// mutation-sensitivity list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r6.mjs`. Each restores ONE part of the defect the revision corrected (the kept import observed the controller mounted
// when it opened, which a remount disposes) or removes one boundary of the cache-lifetime observation; `expect` names the tests written
// for it, so only an assertion of those tests catches it.
//
// Considered and not selected (recorded for the reviewer): notifying the page's listeners for a publication that is not the newest is
// equivalent, because every judgement reads the newest publication (`pageCacheLifetime.get()`); keeping an ended session's subscriptions is
// equivalent for the cache (a late judgement of an ended session only ends it again and never touches the held one) and is caught for the
// route and the identity by the revision 6 subscription-count test.
import { sub } from "./data-catalogue.mjs";

const KEPT = "src/features/calendars/import-kept.ts";
const SOURCES = "src/features/calendars/CalendarSources.tsx";
const LIFETIME = "src/data/ui/cache-lifetime.ts";
const ENV = "src/data/ui/env.ts";
const FACTS = "src/data/plans/facts.ts";
const REACT = "src/data/ui/react.tsx";
const T_RET = "tests/features/calendars/import-retention.test.tsx";
const T_KEPT = "tests/features/calendars/import-kept.test.ts";

export const UNIT_13B_R7 = [
  // Two layers hold this invariant: the continuous observation and the generation compared when the session is shown again. A remount
  // followed by W18 → W23 leaves a durable trace (the generation), so the comparison alone still ends the session (L1/L2 pass under this
  // mutant); only a known-invalid interval that leaves NO durable trace (L5, a failed invalidation's streak, later gone) needs the observer.
  {
    id: "MU-2656",
    title:
      "WEB-13b R7 (revision 7): the kept import observes the controller mounted when it opened (a remount disposes it; the later invalidation is missed)",
    file: SOURCES,
    tests: [T_RET],
    expect: /L5: an admitted invalidation whose write failed/,
    patch: (t) =>
      sub(
        t,
        "      cache: pageCacheLifetime,\n",
        "      cache: {\n        get: () => env.cacheLifetime.get(),\n        subscribe: (listener) => env.cacheLifetime.subscribe(listener),\n      },\n",
      ),
  },
  {
    id: "MU-2657",
    title:
      "WEB-13b R7 (revision 7): a hidden session ignores the cache's generation (an invalidation and recovery nobody observed keep the old input)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /L1: the tree gone|NO controller was published|publishes only the final valid state|the chooser's Browse is judged the same way|first valid one is adopted/,
    patch: (t) =>
      sub(
        t,
        "  return life.generation === which.generation;\n",
        "  return true;\n",
      ),
  },
  {
    id: "MU-2658",
    title:
      "WEB-13b R7 (revision 7): reopening refreshes the session's generation to the cache's now (stale input legitimised on return)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect: /L1: the tree gone|the chooser's Browse is judged the same way/,
    patch: (t) =>
      sub(
        t,
        "      (verifiable(which, life) && survives(which, life, context)))\n",
        "      (verifiable(which, life) &&\n        ((which.generation = life?.generation ?? which.generation),\n        survives(which, life, context))))\n",
      ),
  },
  {
    id: "MU-2659",
    title:
      "WEB-13b R7 (revision 7): facts not established yet end a hidden session (every remount discards the kept import)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /L3 control: a remount|L5 control: facts that cannot be read|L1 control \(no invalidation\)|L2: .*\(control: no invalidation\)|L5 control: a failure streak of ANOTHER position/,
    patch: (t) =>
      sub(
        t,
        "  if (life.generation === null) return true;\n  if (which.generation === null) {\n",
        "  if (life.generation === null) return false;\n  if (which.generation === null) {\n",
      ),
  },
  {
    id: "MU-2660",
    title:
      "WEB-13b R7 (revision 7): a hidden session ignores a cache KNOWN to be invalid under the same generation (an admitted invalidation not yet written)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /L5: an admitted invalidation not yet written|L5: an admitted invalidation whose write failed/,
    patch: (t) => sub(t, "  if (life.invalidated) return false;\n", ""),
  },
  {
    id: "MU-2661",
    title:
      "WEB-13b R7 (revision 7): a controller's cache lifetime never says known-invalid (a failed invalidation's streak, marker or hold is not published)",
    file: ENV,
    tests: [T_RET],
    expect: /L5: an admitted invalidation whose write failed/,
    patch: (t) =>
      sub(
        t,
        '    const invalidated = cache === "invalid" || engine?.invalidating === true;\n',
        "    const invalidated = false as boolean;\n",
      ),
  },
  {
    id: "MU-2662",
    title:
      "WEB-13b R7 (revision 7): hiding a session does not judge the cache as it is then (an invalidation a shown dialog stayed open through is kept)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /C3: shown through an invalidation/,
    patch: (t) => sub(t, "  else which.judge();\n", ""),
  },
  {
    id: "MU-2663",
    title:
      "WEB-13b R7 (revision 7): a withdrawn controller's publication stays the page's (a disposed controller still speaks for the cache)",
    file: LIFETIME,
    tests: [T_KEPT],
    expect:
      /late publications after it was withdrawn|a late or replayed withdrawal/,
    patch: (t) => sub(t, "    sources.splice(at, 1);\n", ""),
  },
  {
    id: "MU-2664",
    title:
      "WEB-13b R7 (revision 7): the sync facts do not carry the cache's generation (an unobserved invalidation and recovery are invisible)",
    file: FACTS,
    tests: [T_RET],
    expect: /L1: the tree gone|L2: the drop zone's kept import, remounted/,
    patch: (t) =>
      sub(
        t,
        "          recoveryGeneration: sync.recovery_generation,\n",
        "          recoveryGeneration: 0,\n",
      ),
  },
  {
    id: "MU-2665",
    title:
      "WEB-13b R7 (revision 7): a shown session does not follow the valid cache it is shown against (a pending source's dialog kept open through a recovery ends once hidden)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /C3 control: shown through the invalidation AND the recovery/,
    patch: (t) =>
      sub(
        t,
        "    if (life.valid && life.generation !== null)\n      which.generation = life.generation;\n",
        "    if (life.valid && life.generation !== null)\n      which.generation ??= life.generation;\n",
      ),
  },
  {
    id: "MU-2666",
    title:
      "WEB-13b R7 (revision 7): a kept session is shown again before its generation can be compared (a new controller's unread facts)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /C3: not shown again before its generation can be compared/,
    patch: (t) =>
      sub(
        t,
        "      (verifiable(which, life) && survives(which, life, context)))\n",
        "      survives(which, life, context))\n",
      ),
  },
  {
    id: "MU-2667",
    title:
      "WEB-13b R7 (revision 7): the mounted controller does not publish its cache lifetime (nothing observes the cache for a kept import)",
    file: REACT,
    tests: [T_RET],
    expect:
      /L1: remounted \(a NEW controller\)|L1 control \(no remount, the review's 422 control\)|cache hidden to be brought up to date|L5: an admitted invalidation whose write failed/,
    patch: (t) =>
      sub(
        t,
        "  useEffect(() => publishCacheLifetime(env.cacheLifetime), [env]);\n",
        "",
      ),
  },
  {
    id: "MU-2668",
    title:
      "WEB-13b R7 (revision 7): showing a kept session again does not judge the cache as it is then (a change no publication announced is missed)",
    file: KEPT,
    tests: [T_KEPT],
    expect: /the chooser's Browse is judged the same way/,
    patch: (t) =>
      sub(
        t,
        "      (verifiable(which, life) && survives(which, life, context)))\n",
        "      verifiable(which, life))\n",
      ),
  },
];
