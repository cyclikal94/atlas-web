// WEB-10a revision 17's mutants (design assessment of 22 October 2026: DA17-N1 `occurrence-closure-permission-admission`, DA17-N2
// `anyone-first-record-permission-admission`), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its
// `UNIT` and `ENGINE` lists. Kept in their own module as revision 16's are (the catalogue is at Biome's 1 MiB file-size limit). `sub` is
// the catalogue's own exactly-one-occurrence patcher (a function declaration, so the circular import is safe).
import { sub } from "./data-catalogue.mjs";

const ADMISSION = "tests/features/tasks/closure-record-admission.test.ts";
const SCREENS = "tests/features/tasks/closure-record-screens.test.tsx";

/** Unit mutants (layers L1a and L1b), MU-2304..MU-2326. */
export const UNIT_R17 = [
  {
    id: "MU-2304",
    title:
      "WEB-10a rev 17 (DA17-N1): a closure does not say it needs write access to the occurrence (review 17's design-assessment defect)",
    file: "src/features/tasks/model/commands.ts",
    tests: [ADMISSION, SCREENS],
    expect:
      /a closure needs the occurrence|(close|reopen) with the occurrence denied|(Close without completing|Reopen) offered, then the occurrence denied unheard/,
    patch: (t) =>
      sub(
        t,
        `        versionChecked: true,\n        requiresEdit: true,\n      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "resolve",`,
        `        versionChecked: true,\n      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "resolve",`,
      ),
  },

  {
    id: "MU-2305",
    title:
      "WEB-10a rev 17 (DA17-N2): a record does not say that creating my stream needs the occurrence (review 17's design-assessment defect)",
    file: "src/features/tasks/model/commands.ts",
    tests: [ADMISSION, SCREENS],
    expect:
      /first record with no known participation|occurrence denied before its transaction|offered, then the occurrence denied unheard: no record|the registry states/,
    patch: (t) => sub(t, `        joinRequiresEdit: input.occurrenceId,\n`, ``),
  },

  {
    id: "MU-2306",
    title:
      "WEB-10a rev 17 (S10): a record does not say it writes my stream (a known denial of the stream is ignored)",
    file: "src/features/tasks/model/commands.ts",
    tests: [ADMISSION],
    expect: /my stream itself denied|a record and an exclusion write my stream/,
    patch: (t) =>
      sub(
        t,
        `        requiresEdit: true,\n        joinRequiresEdit: input.occurrenceId,\n`,
        `        joinRequiresEdit: input.occurrenceId,\n`,
      ),
  },

  {
    id: "MU-2307",
    title:
      "WEB-10a rev 17 (S10): an exclusion does not say it writes my stream",
    file: "src/features/tasks/model/commands.ts",
    tests: [ADMISSION],
    expect:
      /my stream denied: refused|a record and an exclusion write my stream|the registry states/,
    patch: (t) =>
      sub(
        t,
        `        basis: "progress_stream",\n        versionChecked: true,\n        requiresEdit: true,\n      },\n      // Named so the occurrence's outstanding work includes it`,
        `        basis: "progress_stream",\n        versionChecked: true,\n      },\n      // Named so the occurrence's outstanding work includes it`,
      ),
  },

  {
    id: "MU-2308",
    title:
      "WEB-10a rev 17 (DA17-N2): my participation is always taken as known (a first record never needs the occurrence)",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION, SCREENS],
    expect:
      /first record with no known participation|occurrence denied before its transaction|settled draft|rejected first record|offered, then the occurrence denied unheard: no record/,
    patch: (t) =>
      sub(
        t,
        `  const joined = (target: TargetSpec) =>\n    target.reviewedBase`,
        `  const joined = (target: TargetSpec) =>\n    true ||\n    target.reviewedBase`,
      ),
  },

  {
    id: "MU-2309",
    title:
      "WEB-10a rev 17 (S10/S11): my participation is never known (every record needs the occurrence, an existing participant's too)",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION, SCREENS],
    expect:
      /participation known from the cache|existing participant|admitted first record makes me a participant|second held record/,
    patch: (t) => sub(t, `        !joined(target) &&\n`, `        true &&\n`),
  },

  {
    id: "MU-2310",
    title:
      "WEB-10a rev 17 (DA17-N2): a settled draft (a rejected first record) is taken as my participation",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect: /settled draft|rejected first record/,
    patch: (t) =>
      sub(
        t,
        `        !isTerminal(draft) && draft.index_targets.includes(target.resourceId),`,
        `        draft.index_targets.includes(target.resourceId),`,
      ),
  },

  {
    id: "MU-2311",
    title:
      "WEB-10a rev 17 (S12): a replacement based on an authorised read of my stream is not taken as my participation",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect:
      /participation known from the cache, an unsettled draft or a reviewed read/,
    patch: (t) => sub(t, `    target.reviewedBase !== undefined ||\n`, ``),
  },

  {
    id: "MU-2312",
    title:
      "WEB-10a rev 17 (DA17-N2): the facade's request snapshot drops `joinRequiresEdit`",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect: /occurrence denied before its transaction|the snapshot keeps it/,
    patch: (t) =>
      sub(
        t,
        `      ...(target.joinRequiresEdit === undefined\n        ? {}\n        : { joinRequiresEdit: target.joinRequiresEdit }),\n    })),`,
        `    })),`,
      ),
  },

  {
    id: "MU-2313",
    title:
      "WEB-10a rev 17: a participation's requirement may name itself or a resource the request does not target",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect: /names another target of the request/,
    patch: (t) =>
      sub(
        t,
        `      throw new OutboxRequestError("join_requires_edit");`,
        `      void 0;`,
      ),
  },

  {
    id: "MU-2314",
    title:
      "WEB-10a rev 17 (S11): a new save (W2) reads no other draft as my participation",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect: /admitted first record makes me a participant/,
    patch: (t) =>
      sub(
        t,
        `  if (knownDenial(request.targets, facts.cache, facts.related))`,
        `  if (knownDenial(request.targets, facts.cache))`,
      ),
  },

  {
    id: "MU-2315",
    title:
      "WEB-10a rev 17 (S12): an edit of a queued command (W3) passes no other draft as my participation",
    file: "src/data/model/outbox.ts",
    tests: [ADMISSION],
    expect: /second held record/,
    patch: (t) =>
      sub(
        t,
        `  if (knownDenial(request.targets, cache, others))`,
        `  if (knownDenial(request.targets, cache))`,
      ),
  },

  {
    id: "MU-2316",
    title:
      "WEB-10a rev 17 (S12): the defaults review's confirmation rebuilds a stored draft without what its commands need",
    file: "src/data/model/review-confirmation.ts",
    tests: [ADMISSION, SCREENS],
    expect: /denied (unheard )?before the confirmation/,
    patch: (t) =>
      sub(
        t,
        `    targets: targetsOf(draft, basis, needs),`,
        `    targets: targetsOf(draft, basis),`,
      ),
  },

  {
    id: "MU-2317",
    title:
      "WEB-10a rev 17 (S12): the facade's confirmation ignores the slice's admission",
    file: "src/data/outbox/outbox.ts",
    tests: [ADMISSION, SCREENS],
    expect: /denied (unheard )?before the confirmation/,
    patch: (t) =>
      sub(
        t,
        `      admission?.({ ...found.draft, command: found.command }) ?? {},`,
        `      {},`,
      ),
  },

  {
    id: "MU-2318",
    title:
      "WEB-10a rev 17 (S12): the data controller confirms a defaults review without the registry's admission",
    file: "src/data/ui/env.ts",
    tests: [SCREENS],
    expect: /denied unheard before the confirmation/,
    patch: (t) =>
      sub(
        t,
        `      return facade.confirmDefaultsReview(localId, confirmation, (draft) =>\n        commands.admission(draft),\n      );`,
        `      return facade.confirmDefaultsReview(localId, confirmation);`,
      ),
  },

  {
    id: "MU-2319",
    title:
      "WEB-10a rev 17 (S12): the command registry states no admission for any kind",
    file: "src/data/outbox/registries.ts",
    tests: [ADMISSION, SCREENS],
    expect: /the registry states|denied (unheard )?before the confirmation/,
    patch: (t) =>
      sub(
        t,
        `    admission: (draft) =>\n      specs.get(commandKind(draft))?.admission?.(draft) ?? {},`,
        `    admission: () => ({}),`,
      ),
  },

  {
    id: "MU-2320",
    title:
      "WEB-10a rev 17 (S12): the task registry's admission of a stored record omits the participation's requirement",
    file: "src/features/tasks/register.ts",
    tests: [ADMISSION, SCREENS],
    expect: /the registry states|denied (unheard )?before the confirmation/,
    patch: (t) =>
      sub(
        t,
        `        ? { [stream]: { requiresEdit: true, joinRequiresEdit: occurrence } }`,
        `        ? { [stream]: { requiresEdit: true } }`,
      ),
  },

  {
    id: "MU-2321",
    title:
      "WEB-10a rev 17: the task registry's admission of a stored revision omits its details (a side effect)",
    file: "src/features/tasks/register.ts",
    tests: [ADMISSION],
    expect: /the registry states/,
    patch: (t) =>
      sub(
        t,
        `      for (const id of Object.keys(draft.side_effect_bases ?? {}))\n        needs[id] = { requiresEdit: true };\n`,
        ``,
      ),
  },

  {
    id: "MU-2322",
    title:
      "WEB-10a rev 17 (DA17-N1, S1): Close/Reopen under a denial shown on screen asks the outbox",
    file: "src/features/tasks/actions.ts",
    tests: [SCREENS],
    expect: /Close under a shown denial/,
    patch: (t) =>
      sub(
        t,
        `        row.canEdit\n          ? enqueue(commands.resolve(`,
        `        true\n          ? enqueue(commands.resolve(`,
      ),
  },

  {
    id: "MU-2323",
    title:
      "WEB-10a rev 17 (DA17-N2, S1): a first Anyone record under a denial shown on screen asks the outbox",
    file: "src/features/tasks/actions.ts",
    tests: [SCREENS],
    expect: /a first Anyone record under a shown denial/,
    patch: (t) =>
      sub(
        t,
        `        if (firstAnyoneStream && !row.canEdit) return denied();\n`,
        ``,
      ),
  },

  {
    id: "MU-2324",
    title:
      "WEB-10a rev 17 (S10): every record under a denial shown on screen is refused (an existing participant's too)",
    file: "src/features/tasks/actions.ts",
    tests: [SCREENS],
    expect: /a first Anyone record under a shown denial/,
    patch: (t) =>
      sub(
        t,
        `        if (firstAnyoneStream && !row.canEdit) return denied();`,
        `        if (!row.canEdit) return denied();`,
      ),
  },

  {
    id: "MU-2325",
    title:
      "WEB-10a rev 17 (S12): an edit (W3) takes the edited draft and its dependants as my participation",
    file: "src/data/plans/outbox.ts",
    tests: [ADMISSION, SCREENS],
    expect: /denied (unheard )?before the confirmation|second held record/,
    patch: (t) =>
      sub(
        t,
        `          if (draft !== undefined && row.created_seq < draft.created_seq)\n            fold.add(row);`,
        `          fold.add(row);`,
      ),
  },

  {
    id: "MU-2326",
    title:
      "WEB-10a rev 17 (S12): an edit (W3) reads no other draft that writes my stream",
    file: "src/data/plans/outbox.ts",
    tests: [ADMISSION],
    expect: /second held record/,
    patch: (t) =>
      sub(
        t,
        `    return { draft, cache, others: [...others.values()] };`,
        `    return { draft, cache, others: [] };`,
      ),
  },
];

/** Real-engine mutants (L1c, whole-mutant, all browsers), MU-2327..MU-2329. */
export const ENGINE_R17 = [
  {
    id: "MU-2327",
    title:
      "WEB-10a N-T39: (REAL ENGINE) a closure does not say it needs the occurrence (the design assessment's DA17-N1)",
    file: "src/features/tasks/model/commands.ts",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T39: .*(Close without completing|Reopen): another tab committed",
    expect: /E-T39:/,
    patch: (t) =>
      sub(
        t,
        `        versionChecked: true,\n        requiresEdit: true,\n      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "resolve",`,
        `        versionChecked: true,\n      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "resolve",`,
      ),
  },

  {
    id: "MU-2328",
    title:
      "WEB-10a N-T39: (REAL ENGINE) a record does not say that creating my stream needs the occurrence (DA17-N2)",
    file: "src/features/tasks/model/commands.ts",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T39: .*first record of an Anyone occurrence: another tab committed",
    expect: /E-T39:/,
    patch: (t) => sub(t, `        joinRequiresEdit: input.occurrenceId,\n`, ``),
  },

  {
    id: "MU-2329",
    title:
      "WEB-10a N-T39: (REAL ENGINE) my participation is never known (an existing participant needs the occurrence to record)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T39: .*existing participant",
    expect: /E-T39:/,
    patch: (t) => sub(t, `        !joined(target) &&\n`, `        true &&\n`),
  },
];
