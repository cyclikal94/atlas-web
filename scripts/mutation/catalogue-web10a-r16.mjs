// WEB-10a revision 16's mutants (review 16, R30 `occurrence-correction-permission-admission`, R31 `task-time-precision-loss`; design
// assessment DA-A1..A3), in the form and under the rules of `data-catalogue.mjs`, which spreads them into its `UNIT` and `ENGINE` lists.
// They are kept here only because the catalogue reached Biome's 1 MiB file-size limit, past which it would no longer be checked. `sub` is
// the catalogue's own exactly-one-occurrence patcher (a function declaration, so the circular import is safe: it runs only when a mutant
// is applied).
import { sub } from "./data-catalogue.mjs";

/** Unit mutants (layers L1a and L1b), MU-2268..MU-2298. */
export const UNIT_R16 = [
  {
    id: "MU-2268",
    title:
      "WEB-10a rev 16 (R30/DA-A2): no cached denial is ever known (the writing transactions admit every save)",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/correction-permission.test.tsx",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect:
      /refused `denied`|refuses it|after the choice was shown|denied: no revision is queued|the queued body unchanged/,
    patch: (t) =>
      sub(
        t,
        `  return targets.some(\n    (target) =>\n      (target.requiresEdit && denied(target.resourceId)) ||`,
        `  return false && targets.some(\n    (target) =>\n      (target.requiresEdit && denied(target.resourceId)) ||`,
      ),
  },

  {
    id: "MU-2269",
    title:
      "WEB-10a rev 16 (R30): the facade's request snapshot drops `requiresEdit` (the transaction never sees what the command needs)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /refused `denied`/,
    patch: (t) =>
      sub(
        t,
        `      ...(target.requiresEdit ? { requiresEdit: true } : {}),\n`,
        ``,
      ),
  },

  {
    id: "MU-2270",
    title:
      "WEB-10a rev 16 (DA-A2): an edit of a queued command is not refused under a known denial (W3)",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect: /the queued body unchanged|before an edit of the queued revision/,
    patch: (t) =>
      sub(
        t,
        `  if (knownDenial(request.targets, cache, others))\n    return { kind: "refused", reason: "denied" };\n`,
        ``,
      ),
  },

  {
    id: "MU-2271",
    title:
      "WEB-10a rev 16 (DA-A2): the edit transaction (W3) reads no cached permission",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect: /the queued body unchanged|before an edit of the queued revision/,
    patch: (t) =>
      sub(
        t,
        `    const rows = await bulkGetWindowed(reader, "cache", ids);`,
        `    const rows = await bulkGetWindowed(reader, "cache", []);`,
      ),
  },

  {
    id: "MU-2272",
    title:
      "WEB-10a rev 16 (R30/DA-A2): a new save or a replacement is not refused under a known denial (W2, W4)",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/correction-permission.test.tsx",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect:
      /refused `denied`|refuses it|after the choice was shown|denied: no revision is queued/,
    patch: (t) =>
      sub(
        t,
        `  if (knownDenial(request.targets, facts.cache, facts.related))\n    return { kind: "refused", reason: "denied" };\n`,
        ``,
      ),
  },

  {
    id: "MU-2273",
    title:
      "WEB-10a rev 16 (R30): a correction does not say it needs write access to the occurrence",
    file: "src/features/tasks/model/commands.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/correction-permission.test.tsx",
    ],
    expect: /the occurrence denied|refuses it|after the choice was shown/,
    patch: (t) =>
      sub(
        t,
        `        versionChecked: true,\n        requiresEdit: true,\n      },\n      ...progress.map(`,
        `        versionChecked: true,\n      },\n      ...progress.map(`,
      ),
  },

  {
    id: "MU-2274",
    title:
      "WEB-10a rev 16 (DA-A2): a revision does not say it needs write access to the task's details",
    file: "src/features/tasks/model/commands.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect: /execution denied/,
    patch: (t) =>
      sub(
        t,
        `        role: "side_effect",\n        basis: "resource",\n        versionChecked: true,\n        requiresEdit: true,\n`,
        `        role: "side_effect",\n        basis: "resource",\n        versionChecked: true,\n`,
      ),
  },

  {
    id: "MU-2275",
    title:
      "WEB-10a rev 16 (DA-A2): a revision does not say it needs write access to the task",
    file: "src/features/tasks/model/commands.ts",
    tests: [
      "tests/features/tasks/write-admission.test.ts",
      "tests/features/tasks/task-revision-admission.test.tsx",
    ],
    expect: /with the task denied|the task denied/,
    patch: (t) =>
      sub(
        t,
        `        versionChecked: true,\n        requiresEdit: true,\n      },\n      {\n        resourceId: input.executionId,`,
        `        versionChecked: true,\n      },\n      {\n        resourceId: input.executionId,`,
      ),
  },

  {
    id: "MU-2276",
    title:
      "WEB-10a rev 16 (DA-A3): an archive does not say it needs write access to the task",
    file: "src/features/tasks/model/commands.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /an archive with the task denied/,
    patch: (t) =>
      sub(
        t,
        `        requiresEdit: true,\n      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "archive",`,
        `      },\n    ],\n    build: (bases: Bases) => ({\n      command: body(\n        {\n          kind: "archive",`,
      ),
  },

  {
    id: "MU-2277",
    title:
      "WEB-10a rev 16 (R30): the correction dialog offers Save under a known denial of the occurrence",
    file: "src/features/tasks/detail/CorrectionDialog.tsx",
    tests: ["tests/features/tasks/correction-permission.test.tsx"],
    expect: /Save is withheld with the reason/,
    patch: (t) =>
      sub(
        t,
        `            ) : !row.canEdit ? (`,
        `            ) : (false as boolean) ? (`,
      ),
  },

  {
    id: "MU-2278",
    title:
      "WEB-10a rev 16 (R30): Correct this day is offered under a known denial of the occurrence",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/correction-permission.test.tsx"],
    expect: /it is not offered, and says why/,
    patch: (t) =>
      sub(
        t,
        `          {row === null ? null : row.canEdit ? (`,
        `          {row === null ? null : (true as boolean) ? (`,
      ),
  },

  {
    id: "MU-2279",
    title:
      "WEB-10a rev 16 (R30): Save mine is offered under a known denial of the newer occurrence",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/correction-permission.test.tsx"],
    expect: /Save mine is withheld with the reason/,
    patch: (t) =>
      sub(
        t,
        `        {!offered ? null : !row.canEdit ? (`,
        `        {!offered ? null : (false as boolean) ? (`,
      ),
  },

  {
    id: "MU-2280",
    title:
      "WEB-10a rev 16 (R30/C3): Save mine treats every answer as a supersession (a refusal says nothing)",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/correction-permission.test.tsx"],
    expect: /it says why|it says so/,
    patch: (t) =>
      sub(
        t,
        `    if (outcome?.kind === "superseded") return;\n`,
        `    return;\n`,
      ),
  },

  {
    id: "MU-2281",
    title:
      "WEB-10a rev 16 (R30/C3): Save mine stays in progress after its answer",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    tests: ["tests/features/tasks/correction-permission.test.tsx"],
    expect: /edited elsewhere/,
    patch: (t) => sub(t, `    setReplacing(false);\n`, ``),
  },

  {
    id: "MU-2282",
    title:
      "WEB-10a rev 16 (S6): an edit of the queued revision overwrites whatever the queued change has become since the form read it",
    file: "src/features/tasks/form/TaskFormPage.tsx",
    tests: ["tests/features/tasks/task-revision-admission.test.tsx"],
    expect: /not overwritten from the older view/,
    patch: (t) =>
      sub(
        t,
        `              expectDraft: (now) =>`,
        `              _expectDraft: (now) =>`,
      ),
  },

  {
    id: "MU-2283",
    title:
      "WEB-10a rev 16 (R31): the form's own time edit keeps the loaded seconds",
    file: "src/features/tasks/form/TaskFormPage.tsx",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /a task at 07:30:45 whose time the person changes/,
    patch: (t) => sub(t, `                    keptTime: null,\n`, ``),
  },

  {
    id: "MU-2284",
    title:
      "WEB-10a rev 16 (R31): the dialog's own time edit keeps the loaded seconds",
    file: "src/features/tasks/detail/CorrectionDialog.tsx",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /an occurrence at 07:30:45 whose time the person changes/,
    patch: (t) => sub(t, `                  keptTime: null,\n`, ``),
  },

  {
    id: "MU-2285",
    title:
      "WEB-10a rev 16 (R31): a loaded definition keeps no time (review 16's truncation)",
    file: "src/features/tasks/model/form.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect:
      /alone sends 07:30:(01|45|59)|keeps the seconds|preset with seconds|alone queues schedule.time 07:30:45|kept time round-trips|comes back whole/,
    patch: (t) =>
      sub(t, `    keptTime: schedule.time,\n`, `    keptTime: null,\n`),
  },

  {
    id: "MU-2286",
    title:
      "WEB-10a rev 16 (R31): a correction keeps no time from its occurrence (review 16's truncation)",
    file: "src/features/tasks/model/correction.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect:
      /alone sends 07:30:(01|45|59)|never the task definition|keeps the seconds|45 seconds of its intended instant|alone queues time 07:30:45/,
    patch: (t) =>
      sub(
        t,
        `    keptTime: data.slot.intended_time,\n`,
        `    keptTime: null,\n`,
      ),
  },

  {
    id: "MU-2287",
    title:
      "WEB-10a rev 16 (R31): a correction is seeded with the task definition's time, not the occurrence's",
    file: "src/features/tasks/model/correction.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /never the task definition's time/,
    patch: (t) =>
      sub(
        t,
        `    keptTime: data.slot.intended_time,\n`,
        `    keptTime: data.definition.schedule.time,\n`,
      ),
  },

  {
    id: "MU-2288",
    title:
      "WEB-10a rev 16 (R31): a save sends the minute shown with :00 whatever was kept",
    file: "src/features/tasks/model/form.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect:
      /alone sends 07:30:(01|45|59)|keeps the seconds|alone queues|comes back whole|preset with seconds|45 seconds/,
    patch: (t) =>
      sub(
        t,
        `  if (keptTime !== null)\n    return HHMMSS.test(keptTime) ? { ok: true, time: keptTime } : { ok: false };\n`,
        ``,
      ),
  },

  {
    id: "MU-2289",
    title:
      "WEB-10a rev 16 (R31/C5): a restored time whose seconds are unknown is saved without confirmation",
    file: "src/features/tasks/model/form.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /waits for the person to confirm|legacy one waits/,
    patch: (t) => sub(t, `  if (timeUnconfirmed) return { ok: false };\n`, ``),
  },

  {
    id: "MU-2290",
    title:
      "WEB-10a rev 16 (R31/C5): a legacy recovery value's time is taken as confirmed",
    file: "src/features/tasks/model/recovery.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /waits for the person to confirm|legacy one waits/,
    patch: (t) =>
      sub(
        t,
        `      timeUnconfirmed: typeof raw.time === "string" && raw.time.trim() !== "",`,
        `      timeUnconfirmed: false,`,
      ),
  },

  {
    id: "MU-2291",
    title:
      "WEB-10a rev 16 (R31/C5): a restored correction takes the newer row's seconds",
    file: "src/features/tasks/model/recovery.ts",
    tests: ["tests/features/tasks/time-precision.test.tsx"],
    expect: /restores its OWN kept time/,
    patch: (t) => sub(t, `    out.keptTime = precision.keptTime;\n`, ``),
  },

  {
    id: "MU-2292",
    title:
      "WEB-10a rev 16 (DA-A1): a revision is rebuilt although the reviewed read denies the task's details",
    file: "src/features/tasks/register.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /the reviewed details denied|registry hands them/,
    patch: (t) =>
      sub(
        t,
        `  if (!current.can_edit || details?.can_edit === false) return null;`,
        `  if (!current.can_edit) return null;`,
      ),
  },

  {
    id: "MU-2293",
    title:
      "WEB-10a rev 16 (DA-A1): a revision is rebuilt although the reviewed read denies the task",
    file: "src/features/tasks/register.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /the reviewed task denied/,
    patch: (t) =>
      sub(
        t,
        `  if (!current.can_edit || details?.can_edit === false) return null;`,
        `  if (details?.can_edit === false) return null;`,
      ),
  },

  {
    id: "MU-2294",
    title:
      "WEB-10a rev 16 (DA-A1): the task's authorised read drops the details it returned",
    file: "src/features/tasks/register.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /keeps its details beside the reviewed task/,
    patch: (t) =>
      sub(
        t,
        `        related: detail.execution === null ? [] : [detail.execution],`,
        `        related: [],`,
      ),
  },

  {
    id: "MU-2295",
    title:
      "WEB-10a rev 16 (DA-A3): an archive is rebuilt although the reviewed read denies the task",
    file: "src/features/tasks/register.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /an archive: rebuilt for an editor/,
    patch: (t) => sub(t, `    !current.can_edit ||\n`, ``),
  },

  {
    id: "MU-2296",
    title:
      "WEB-10a rev 16 (DA-A1): the command registry does not hand the read's other rows to the rebuild",
    file: "src/data/outbox/registries.ts",
    tests: ["tests/features/tasks/write-admission.test.ts"],
    expect: /registry hands them/,
    patch: (t) =>
      sub(t, `rebuild?.(draft, current, related)`, `rebuild?.(draft, current)`),
  },

  {
    id: "MU-2297",
    title:
      "WEB-10a rev 16 (DA-A1): the data controller's save-as-new drops the read's other rows",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/current-read.test.ts"],
    expect: /other rows the read returned reach the rebuild/,
    patch: (t) =>
      sub(
        t,
        `commands.rebuild(draft, base, related)`,
        `commands.rebuild(draft, base)`,
      ),
  },

  {
    id: "MU-2298",
    title:
      "WEB-10a rev 16 (DA-A1): the queue's item dialog drops the read's other rows",
    file: "src/features/sync/ItemDetailDialog.tsx",
    tests: ["tests/features/sync/recovery-screens.test.tsx"],
    expect: /U-6b/,
    patch: (t) =>
      sub(
        t,
        `        current?.kind === "loaded" ? current.related : undefined,`,
        `        undefined,`,
      ),
  },
];

/** Real-engine mutants (L1c, whole-mutant, all browsers), MU-2299..MU-2303. */
export const ENGINE_R16 = [
  {
    id: "MU-2299",
    title:
      "WEB-10a N-T37: (REAL ENGINE) no cached denial is known to the writing transactions (another tab's committed denial is ignored)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T37: .*another tab committed",
    expect: /E-T37:/,
    patch: (t) =>
      sub(
        t,
        `  return targets.some(\n    (target) =>\n      (target.requiresEdit && denied(target.resourceId)) ||`,
        `  return false && targets.some(\n    (target) =>\n      (target.requiresEdit && denied(target.resourceId)) ||`,
      ),
  },

  {
    id: "MU-2300",
    title:
      "WEB-10a N-T37: (REAL ENGINE) the correction dialog offers Save after the permission is lost (review 16's defect)",
    file: "src/features/tasks/detail/CorrectionDialog.tsx",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T37: .*the permission lost while the dialog is open",
    expect: /E-T37:/,
    patch: (t) =>
      sub(
        t,
        `            ) : !row.canEdit ? (`,
        `            ) : (false as boolean) ? (`,
      ),
  },

  {
    id: "MU-2301",
    title:
      "WEB-10a N-T37: (REAL ENGINE) Correct this day is offered on a read-only occurrence (review 16's defect)",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T37: .*read-only occurrence",
    expect: /E-T37:/,
    patch: (t) =>
      sub(
        t,
        `          {row === null ? null : row.canEdit ? (`,
        `          {row === null ? null : (true as boolean) ? (`,
      ),
  },

  {
    id: "MU-2302",
    title:
      "WEB-10a N-T37: (REAL ENGINE) Save mine is offered under a denial delivered with the newer version (review 16's defect)",
    file: "src/features/tasks/detail/TaskDetail.tsx",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T37: .*a denial delivered with the newer version",
    expect: /E-T37:/,
    patch: (t) =>
      sub(
        t,
        `        {!offered ? null : !row.canEdit ? (`,
        `        {!offered ? null : (false as boolean) ? (`,
      ),
  },

  {
    id: "MU-2303",
    title:
      "WEB-10a N-T38: (REAL ENGINE) a save sends the minute shown with :00 whatever was kept (review 16's defect)",
    file: "src/features/tasks/model/form.ts",
    spec: "tests/e2e/fixture.tasks.spec.ts",
    grep: "E-T38: .*07:30:45: a change of",
    expect: /E-T38:/,
    patch: (t) =>
      sub(
        t,
        `  if (keptTime !== null)\n    return HHMMSS.test(keptTime) ? { ok: true, time: keptTime } : { ok: false };\n`,
        ``,
      ),
  },
];
