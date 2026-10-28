// WEB-13b revision 7's mutants (review 7 R7, family task-sync-navigation-draft-loss, incomplete_fix; design assessment C1-C4 and its
// mutation-sensitivity list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r6.mjs`. Each restores ONE part of the defect the revision corrected (the kept import observed the controller mounted
// when it opened, which a remount disposes) or removes one boundary of the cache-lifetime observation; `expect` names the tests written
// for it, so only an assertion of those tests catches it.
//
// Revision 8 (review 8 R7a/R7b): the entries whose code revision 8 rewrote are RE-ANCHORED at the corrected code with the same defect
// (MU-2657/2658/2659/2660/2664/2665/2668), and MU-2666 is RE-EXPRESSED (its old oracle rewarded the loss of input; see its entry). Ids,
// files and the defects restored are kept; revision 8's own mutants are in `catalogue-web13b-r8.mjs`.
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
const T_SNAP = "tests/data/snapshot-plans.test.ts";

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
    // Revision 8: the page runtime's service now also observes the durable streak (the L5 case above), so the evidence only a mounted
    // controller has is a fallback marker (`L5 (revision 8)`).
    expect:
      /L5: an admitted invalidation whose write failed|known only by its fallback marker at the cache's position/,
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
      "WEB-13b R7 (revision 7): a hidden session ignores the cache's witness (an invalidation and recovery nobody observed keep the old input)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    // Re-anchored in revision 8 (R7b): the comparison is of the invalidation witness with the session's basis.
    expect:
      /NO controller was published|publishes only the final valid state|the chooser's Browse is judged the same way|L4 control: opened before the cache was ever valid|waiting, the witness read past its basis|the witness ends it|the opening read is the basis/,
    patch: (t) =>
      sub(
        t,
        "          reading.invalidations !== null &&\n          reading.invalidations > basis),\n",
        "          false),\n",
      ),
  },
  {
    id: "MU-2658",
    title:
      "WEB-13b R7 (revision 7): reopening refreshes the session's basis to the cache's now (stale input legitimised on return)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    // Re-anchored in revision 8 (R7a): the read made when it is shown again ADOPTS what it finds instead of comparing it with the basis.
    expect:
      /it waits for a read made THEN|released after W18 -> W23: it closes/,
    patch: (t) =>
      sub(
        t,
        '      if (now > basis) release(which, "expired");\n      else if',
        "      if (now > basis) which.basis = now;\n      if",
      ),
  },
  {
    id: "MU-2659",
    title:
      "WEB-13b R7 (revision 7): facts not established yet end a hidden or waiting session (every remount, or every unread showing, discards the kept import)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    // Re-anchored in revision 8 (R7a): unknown readings are treated as an invalidation.
    expect:
      /L3 control: a remount|L5 control: facts that cannot be read|C3: not ready before its witness can be compared|WAITING|L1 control \(no invalidation\)|L2: .*\(control: no invalidation\)|L5 control: a failure streak of ANOTHER position|released unchanged|first fill only \(control\)|first fill while no controller is mounted keeps it/,
    patch: (t) =>
      sub(
        t,
        "        reading.invalidated ||\n        (basis !== null &&\n",
        "        reading.invalidated ||\n        reading.invalidations === null ||\n        (basis !== null &&\n",
      ),
  },
  {
    id: "MU-2660",
    title:
      "WEB-13b R7 (revision 7): a hidden session ignores a cache KNOWN to be invalid under the same witness (an admitted invalidation not yet written)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    // Re-anchored in revision 8 (R7b): the known-invalid reading among the readings judged.
    expect:
      /L5: an admitted invalidation not yet written|L5: an admitted invalidation whose write failed|durable streak of an admitted invalidation heard through the service|an invalid cache heard there ends a hidden session|KNOWN invalid when it is shown again|C3: shown through an invalidation, hidden while it stands|an invalidation seen while hidden ends it once/,
    patch: (t) =>
      sub(
        t,
        "        reading.invalidated ||\n        (basis !== null &&\n",
        "        (basis !== null &&\n",
      ),
  },
  {
    id: "MU-2661",
    title:
      "WEB-13b R7 (revision 7): a controller's cache lifetime never says known-invalid (a failed invalidation's streak, marker or hold is not published)",
    file: ENV,
    tests: [T_RET],
    // Revision 8: the page runtime's service now also observes the durable streak (the L5 case above), so the evidence only a mounted
    // controller has is a fallback marker (`L5 (revision 8)`).
    expect:
      /L5: an admitted invalidation whose write failed|known only by its fallback marker at the cache's position/,
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
      "WEB-13b R7 (revision 7): the sync facts do not carry the cache's witness (an unobserved invalidation and recovery are invisible)",
    file: FACTS,
    tests: [T_RET, T_SNAP],
    // Re-anchored in revision 8 (R7b): the facts carry the invalidation witness (revision 7: the generation).
    expect:
      /WIT-5 read as `invalidations`|L1: the tree gone|L2: the drop zone's kept import, remounted/,
    patch: (t) =>
      sub(
        t,
        "          invalidations: invalidationsOf(sync),\n",
        "          invalidations: 0,\n",
      ),
  },
  {
    id: "MU-2665",
    title:
      "WEB-13b R7 (revision 7): a shown session does not follow the cache it is shown against (a pending source's dialog kept open through a recovery ends once hidden)",
    file: KEPT,
    tests: [T_KEPT],
    // Re-anchored in revision 8: the shown session's basis follows the newest witness read.
    expect: /C3 control: shown through the invalidation AND the recovery/,
    patch: (t) =>
      sub(
        t,
        "    if (known !== null && (which.basis === null || known > which.basis))\n",
        "    if (known !== null && which.basis === null)\n",
      ),
  },
  // RE-EXPRESSED in revision 8 (review 8 R7a; design assessment C6). Revision 7's MU-2666 removed the `verifiable` precondition of a
  // reopening and was caught by the C3 oracle that EXPECTED the kept input to be discarded while the new controller's facts were unread
  // (the loss review 8 reproduced). The old intent, "kept input is not used before its cache can be compared", is now this mutant: the
  // session shown again does not wait for its verification (it is ready at once). Its oracles assert the SAME session with its input AND
  // the waiting state, so a mutant that deleted the input would be caught by them too: deletion is never rewarded.
  {
    id: "MU-2666",
    title:
      "WEB-13b R7a (revision 8, re-expressed): a kept session shown again is ready before its basis is verified (unverified input could be saved)",
    file: KEPT,
    tests: [T_KEPT, T_RET],
    expect:
      /C3: not ready before its witness can be compared|WAITING|the chooser's Browse while it waits|a read made at an EARLIER showing|shown again while nothing can verify it/,
    patch: (t) =>
      sub(t, "  which.pending = true;\n", "  which.pending = false;\n"),
  },
  {
    id: "MU-2667",
    title:
      "WEB-13b R7 (revision 7): the mounted controller does not publish its cache lifetime (nothing observes the cache for a kept import)",
    file: REACT,
    tests: [T_RET],
    // Revision 8: the page runtime's service now also observes the durable streak (the L5 case above), so the evidence only a mounted
    // controller has is a fallback marker (`L5 (revision 8)`).
    expect:
      /L1: remounted \(a NEW controller\)|L1 control \(no remount, the review's 422 control\)|cache hidden to be brought up to date|L5: an admitted invalidation whose write failed|known only by its fallback marker at the cache's position/,
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
      "WEB-13b R7 (revision 7): showing a kept session again does not judge the cache as it is then, while still hidden (a change no publication announced is missed)",
    file: KEPT,
    tests: [T_KEPT],
    // Re-anchored in revision 8: the judgement made before it is shown again. With a basis, the waiting judgement that follows makes the
    // same comparison (a second layer); without one, only this judgement sees a cache known to be invalid.
    expect: /KNOWN invalid when it is shown again/,
    patch: (t) =>
      sub(
        t,
        "    which.judge();\n    if (held !== which) return null;\n    resume(which, context);\n",
        "    resume(which, context);\n",
      ),
  },
];
