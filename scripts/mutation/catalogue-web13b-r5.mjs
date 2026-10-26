// Main reconciliation, 26 October 2026: WEB-13b MU-2501..MU-2551 are now MU-2586..MU-2636 (+85).
// Historical reports keep their original IDs; mutation patches, selectors and assertions are unchanged.
// WEB-13b revision 5's mutants (review 5, F-13b-1b and F-13b-1c; N1 under `delivery/handoffs/web13b-n1-approved-20261025.md`; the design
// assessment's sensitivity list), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` list after
// `catalogue-web13b-r4.mjs`. Each restores ONE part of a defect the revision corrected: an obligation retired by something other than the
// instance an act saw, a stop created or shown after the binding that met the failure ended. `expect` names the tests written for it, so
// only an assertion of those tests catches it; every test holds its sends and the delivery of the results it orders, on fake time.
//
// Considered and not selected (recorded for the reviewer): a mutant of `recordStop` (write-failure-marker.ts) that guards the marker but
// not the page's memory is equivalent in these worlds, because `markers.set` asks the same predicate before it attempts the marker and
// answers `obsolete`, so the memory is never reached; a mutant that drops `retireOwed`'s binding check is equivalent, because instances
// are numbered across bindings and a start under another binding clears the obligations, so an older binding's witness never matches.
import { sub } from "./data-catalogue.mjs";

const DISPATCHER = "src/data/engine/outbox-dispatcher.ts";
const ENGINE = "src/data/engine/sync-engine.ts";
const T_AUTH = "tests/data/outbox-settlement-authority.test.ts";
const T_FORBIDDEN = "tests/data/leader-forbidden.test.ts";
const T_N1 = "tests/data/engine-binding-authority.test.ts";

export const UNIT_13B_R5 = [
  {
    id: "MU-2626",
    title:
      "WEB-13b F-13b-1b: the person's retry ends whatever obligation its drafts carry when it completes, not the instance it saw (review 5's overlapping retries: the older completion erases a NEW full disk's hold)",
    file: DISPATCHER,
    tests: [T_AUTH, T_FORBIDDEN],
    expect:
      /two overlapping retries after a visible full disk.*NEW hold stands|the other order:|restarts between the new full disk|a pause renewed at the SAME instant|two overlapping retries of the page's public outbox.*new hold stands/,
    patch: (t) =>
      sub(
        t,
        "      if (owed.get(localId)?.instance === instance) {\n",
        "      if (owed.has(localId)) {\n",
      ),
  },
  {
    id: "MU-2627",
    title:
      "WEB-13b F-13b-1b: an obligation is identified by its deadline instead of its instance (two full disks are both `Infinity`; two pauses met at one instant end together)",
    file: DISPATCHER,
    tests: [T_AUTH, T_FORBIDDEN],
    expect:
      /two overlapping retries after a visible full disk.*NEW hold stands|the other order:|restarts between the new full disk|a pause renewed at the SAME instant|two overlapping retries of the page's public outbox.*new hold stands/,
    patch: (t) =>
      sub(
        sub(
          t,
          "        .map(([draft, { instance }]) => [draft, instance] as const),\n",
          "        .map(([draft, { until }]) => [draft, until] as const),\n",
        ),
        "      if (owed.get(localId)?.instance === instance) {\n",
        "      if (owed.get(localId)?.until === instance) {\n",
      ),
  },
  {
    id: "MU-2628",
    title:
      "WEB-13b F-13b-1b: the retry's witness of what is owed is taken when its awaited work completes, not where the person's act is admitted",
    file: DISPATCHER,
    tests: [T_AUTH, T_FORBIDDEN],
    expect:
      /two overlapping retries after a visible full disk.*NEW hold stands|a retry made BEFORE the first full disk|restarts between the new full disk|a pause renewed at the SAME instant|two overlapping retries of the page's public outbox.*new hold stands/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    const owedSeen = explicit ? witnessOwed(localId) : null;\n",
          "    let owedSeen: OwedSeen | null = null;\n",
        ),
        "    if (owedSeen !== null) retireOwed(owedSeen);\n",
        "    owedSeen = explicit ? witnessOwed(localId) : null;\n    if (owedSeen !== null) retireOwed(owedSeen);\n",
      ),
  },
  {
    id: "MU-2629",
    title:
      "WEB-13b F-13b-1b: the retry of every draft clears the binding's obligations with the run's own schedule (one reason's clearance ends another)",
    file: DISPATCHER,
    tests: [T_AUTH],
    expect:
      /every draft: two overlapping retries after a visible full disk.*NEW hold stands|every draft, the run never interrupted/,
    patch: (t) =>
      sub(
        t,
        "        stalled.clear();\n        unreadable.clear();\n      }\n",
        "        stalled.clear();\n        unreadable.clear();\n        owed.clear();\n      }\n",
      ),
  },
  {
    id: "MU-2630",
    title:
      "WEB-13b F-13b-1b: a retry whose run a restart of the same binding replaced does not ask the run that stands to look again (the lifted draft waits for some other event)",
    file: DISPATCHER,
    tests: [T_AUTH],
    expect: /a restart of the same binding replaced still lifts the hold/,
    patch: (t) =>
      sub(
        t,
        "      if (explicit && ownership !== null && ownership === under) wake();\n",
        "",
      ),
  },
  {
    id: "MU-2631",
    title:
      "WEB-13b F-13b-1c: the fallback stop of a failure whose counter failed is created when only the SERVICE stands (review 5: an ended binding's marker stops the next owner)",
    file: DISPATCHER,
    tests: [T_AUTH, T_FORBIDDEN],
    expect:
      /delivered after the binding ENDED \(the service live\)|after the binding ended, nothing is held in the page's memory|the leader gives the binding up/,
    patch: (t) =>
      sub(
        t,
        "        authorised,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
        "        () => service.live,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
      ),
  },
  {
    id: "MU-2632",
    title:
      "WEB-13b F-13b-1c: a local write failure met by a binding that has ended is counted all the same (a request's failure after the unbind)",
    file: DISPATCHER,
    tests: [T_AUTH],
    expect: /after the binding ended, nothing is counted or recorded for it/,
    patch: (t) =>
      sub(
        t,
        '    if (!authorised()) return { when: "event" };\n    failedOperations.add(operation);',
        "    failedOperations.add(operation);",
      ),
  },
  {
    id: "MU-2633",
    title:
      "WEB-13b N1: the sync engine creates the fallback stop of a failure whose counter failed when only the SERVICE stands (the ended binding's `capture` marker stops the next owner)",
    file: ENGINE,
    tests: [T_N1],
    expect:
      /delivered after the binding ENDED: no capture marker|after the binding ended nothing is held in this tab/,
    patch: (t) =>
      sub(
        sub(
          t,
          '      if (!authorised()) return { when: "event" };\n      stop = true;',
          "      stop = true;",
        ),
        "        authorised,\n        { hold: () => holdMemory(key) },",
        "        () => service.live,\n        { hold: () => holdMemory(key) },",
      ),
  },
  {
    id: "MU-2634",
    title:
      "WEB-13b N1: a counter that commits the stop after the binding ended stops and shows `stopped` in the ended engine",
    file: ENGINE,
    tests: [T_N1],
    expect: /COMMITS the capture stop at its bound after the binding ended/,
    patch: (t) =>
      sub(
        t,
        '      if (!authorised()) return { when: "event" };\n      stop = result.stop;',
        "      stop = result.stop;",
      ),
  },
  {
    id: "MU-2635",
    title:
      "WEB-13b N1: a failure the sync engine meets after its binding ended is counted all the same (a page commit's failure whose sizing record outlived the binding)",
    file: ENGINE,
    tests: [T_N1],
    expect: /the binding ENDS while its sizing record is delivered/,
    patch: (t) =>
      sub(
        t,
        '    if (!authorised()) return { when: "event" };\n    let stop = false;',
        "    let stop = false;",
      ),
  },
  {
    id: "MU-2636",
    title:
      "WEB-13b N1: a page commit's failure is attributed to the run that stands when the sizing record returns, not the binding that met it (a display interruption loses the count)",
    file: ENGINE,
    tests: [T_N1],
    expect:
      /the same binding's run restarts while its sizing record is delivered/,
    patch: (t) =>
      sub(
        t,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of the patched source, not a template.
        '      `page:${captured.expectedPosition ?? ""}`,\n      run,\n    );',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the text of the patched source, not a template.
        '      `page:${captured.expectedPosition ?? ""}`,\n    );',
      ),
  },
];
