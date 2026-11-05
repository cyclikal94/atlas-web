// WEB-19's mutants (plan §7.5: the People activity timeline), in the form and under the rules of `data-catalogue.mjs`, which spreads them
// into its `UNIT` and `ENGINE` lists. Each is ONE deliberate defect on a copy of one source file; its named tests must fail on it and
// pass on the unmutated control. `sub` is the catalogue's own exactly-one-occurrence patcher. IDs MU-6101.. (checked free across every
// atlas-web worktree on 5 November 2026).
//
// Re-expressed from the plan's wording, with the reason:
//  - MU-6107 (a late answer of an earlier generation is applied): `invalidateSummaries` clears the timeline entry, so the entry-identity
//    check alone already refuses such an answer and dropping only the generation comparison is equivalent. The mutant removes the whole
//    "still the read that counts" check (generation AND entry), the defect the plan names.
//  - MU-6108 (a refresh stitches pages instead of re-walking): the re-walk replaces the held timeline in one step; the mutant shows the
//    new answer stitched onto what the view showed before (old rows not in the new answer kept after it).
import { sub } from "./data-catalogue.mjs";

const MODEL = "tests/features/people/activity-model.test.ts";
const TIMELINE = "tests/features/people/activity-timeline.test.tsx";
const SPEC = "tests/e2e/fixture.people-activity.spec.ts";

export const UNIT_WEB19 = [
  {
    id: "MU-6101",
    title:
      "WEB-19: the parser accepts a type outside the contract's eleven (the mock's sharing row)",
    file: "src/features/people/model/activity.ts",
    tests: [MODEL],
    expect: /a type outside the eleven/,
    patch: (t) =>
      sub(
        t,
        "  if (!oneOf(value.type, ACTIVITY_TYPES)) return null;\n  const type = value.type;\n  if (value.summary !== ACTIVITY_SUMMARIES[type]) return null;\n",
        "  const type = value.type as ActivityType;\n  if (oneOf(type, ACTIVITY_TYPES) && value.summary !== ACTIVITY_SUMMARIES[type]) return null;\n",
      ),
  },
  {
    id: "MU-6102",
    title:
      "WEB-19: the parser accepts a next_after that is not the last item's id",
    file: "src/features/people/model/activity.ts",
    tests: [MODEL],
    expect:
      /next_after that is not the last item's id|next_after on an empty page/,
    patch: (t) =>
      sub(
        t,
        "    if (!isUuid(body.next_after) || body.next_after !== items.at(-1)?.id)\n",
        "    if (!isUuid(body.next_after))\n",
      ),
  },
  {
    id: "MU-6103",
    title: "WEB-19: the parser accepts a summary that is not its type's phrase",
    file: "src/features/people/model/activity.ts",
    tests: [MODEL],
    expect: /a summary that is not its type's phrase/,
    patch: (t) =>
      sub(
        t,
        "  if (value.summary !== ACTIVITY_SUMMARIES[type]) return null;\n",
        "",
      ),
  },
  {
    id: "MU-6104",
    title:
      "WEB-19: a refused cursor (422) on Show older is treated as a failure instead of a restart from the first page",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /a 422 on Show older restarts from the first page/,
    patch: (t) =>
      sub(
        t,
        '      if (result.kind === "invalid") {\n',
        "      if (false) {\n",
      ),
  },
  {
    id: "MU-6105",
    title:
      "WEB-19: a 404 (access lost) is not applied: the earlier rows stay shown",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /a 404 \(access lost\) drops everything held/,
    patch: (t) =>
      sub(
        t,
        '      if (outcome.kind === "superseded" || !current()) return;\n',
        '      if (outcome.kind === "superseded" || !current()) return;\n      if (outcome.kind === "failed" && outcome.reason === "not_found") return;\n',
      ),
  },
  {
    id: "MU-6106",
    title:
      "WEB-19: an event id repeated across pages is shown twice (no deduplication)",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /an id repeated on the next page is kept once/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    for (const event of answer.items) {\n      if (seen.has(event.id)) continue;\n      seen.add(event.id);\n      items.push(event);\n    }\n    after = answer.next_after;",
          "    for (const event of answer.items) {\n      seen.add(event.id);\n      items.push(event);\n    }\n    after = answer.next_after;",
        ),
        "    for (const event of answer.items) {\n      if (seen.has(event.id)) continue;\n      seen.add(event.id);\n      items.push(event);\n    }\n    entry.state = {",
        "    for (const event of answer.items) {\n      seen.add(event.id);\n      items.push(event);\n    }\n    entry.state = {",
      ),
  },
  {
    id: "MU-6107",
    title:
      "WEB-19: an answer that arrives after an invalidation is applied as the person's timeline (the read's generation and entry are not checked)",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /an answer that arrives after an invalidation is never shown/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    isCurrentMemory(memory) &&\n    memory.summaryGeneration === entry.generation &&\n    memory.activity.get(personId) === entry\n",
          "    isCurrentMemory(memory)\n",
        ),
        "    if (!current()) return;\n    entry.state = state;\n",
        "    memory.activity.set(personId, { generation: memory.summaryGeneration, state });\n",
      ),
  },
  {
    id: "MU-6108",
    title:
      "WEB-19: a refresh stitches the new answer onto the rows shown before (a now-hidden row survives)",
    file: "src/features/people/activity/useActivity.ts",
    tests: [TIMELINE],
    expect: /a field that leaves this device \(by sync\) is withheld at once/,
    patch: (t) =>
      sub(
        t,
        "  shown.current = {\n    memory,\n    personId,\n    timeline: state.timeline,\n    checkedAt: state.checkedAt,\n  };\n  const held = state.timeline;\n",
        "  const before = shown.current?.timeline.items ?? [];\n  const stitched = { ...state.timeline, items: [...state.timeline.items, ...before.filter((e) => !state.timeline.items.some((h) => h.id === e.id))] };\n  shown.current = {\n    memory,\n    personId,\n    timeline: stitched,\n    checkedAt: state.checkedAt,\n  };\n  const held = stitched;\n",
      ),
  },
  {
    id: "MU-6109",
    title:
      "WEB-19: events are re-sorted by occurred_at instead of kept in the server's (commit) order",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /the server's order is kept when the times disagree/,
    patch: (t) =>
      sub(
        t,
        "      items,\n      next: after,\n",
        "      items: [...items].sort((a, b) => b.occurred_at - a.occurred_at),\n      next: after,\n",
      ),
  },
  {
    id: "MU-6110",
    title:
      "WEB-19: an archived, uncached or other person's field is linked as if it were the current item",
    file: "src/features/people/activity/ActivitySection.tsx",
    tests: [TIMELINE],
    expect: /a current cached field links to its editor/,
    patch: (t) =>
      sub(
        t,
        '  event.target.state === "current" &&\n  !event.target.archived &&\n  row !== null &&\n  row.kind === "field" &&\n  !row.archived &&\n  row.parent_id === personId;\n',
        '  event.target.state === "current";\n',
      ),
  },
  {
    id: "MU-6111",
    title: "WEB-19: going offline keeps the earlier rows shown",
    file: "src/features/people/activity/useActivity.ts",
    tests: [TIMELINE],
    expect: /offline: unavailable and nothing earlier shown/,
    patch: (t) =>
      sub(
        t,
        '  if (!env.online) {\n    shown.current = null;\n    return { status: "offline" };\n  }\n',
        '  if (!env.online && shown.current === null) {\n    return { status: "offline" };\n  }\n',
      ),
  },
  {
    id: "MU-6112",
    title:
      "WEB-19: the coverage start is taken from the oldest event, not coverage_started_at",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /coverage is the server's coverage_started_at/,
    patch: (t) =>
      sub(
        t,
        "      coverageStartedAt: coverage ?? 0,\n",
        "      coverageStartedAt: items.at(-1)?.occurred_at ?? coverage ?? 0,\n",
      ),
  },
  {
    id: "MU-6113",
    title:
      "WEB-19: an answer for another (canonical) person is shown under a merged alias's route",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /the route's person was merged/,
    patch: (t) =>
      sub(
        t,
        '      if (answer.person_id !== personId)\n        return { kind: "merged", canonicalId: answer.person_id };\n',
        "",
      ),
  },
  {
    id: "MU-6114",
    title:
      "WEB-19: while a re-read is on its way, a field this device no longer holds is still shown",
    file: "src/features/people/activity/ActivitySection.tsx",
    tests: [TIMELINE],
    expect: /a field that leaves this device \(by sync\) is withheld at once/,
    patch: (t) =>
      sub(
        t,
        '          withhold &&\n          event.target.kind === "field" &&\n',
        '          false &&\n          event.target.kind === "field" &&\n',
      ),
  },
  {
    id: "MU-6115",
    title: "WEB-19: no cap: Show older keeps reading past the 500 most recent",
    file: "src/features/people/activity/timeline.ts",
    tests: [TIMELINE],
    expect: /at most 500 events, then an honest note/,
    patch: (t) =>
      sub(
        t,
        "export const ACTIVITY_MAX = 500;\n",
        "export const ACTIVITY_MAX = 100_000;\n",
      ),
  },
  {
    id: "MU-6116",
    title: 'WEB-19: the reader\'s own changes are attributed to "Someone else"',
    file: "src/features/people/activity/describe.ts",
    tests: [MODEL, TIMELINE],
    expect:
      /actors: You, the username, Someone else|the eleven types, in the server's order/,
    patch: (t) =>
      sub(
        t,
        '    case "you":\n      return copy.ACTOR_YOU;\n',
        '    case "you":\n      return copy.ACTOR_SOMEONE_ELSE;\n',
      ),
  },
  {
    id: "MU-6117",
    title:
      "WEB-19: an invalidation does not clear the timeline (a synced change, a receipt or the refresh never read it again)",
    file: "src/features/people/memory.ts",
    tests: [TIMELINE],
    expect:
      /a synced change, a receipt \(queue counts\)|every 60 seconds while shown and visible/,
    patch: (t) => sub(t, "    this.activity.clear();\n", ""),
  },
];

export const ENGINE_WEB19 = [
  {
    id: "MU-6151",
    title:
      "WEB-19: (REAL ENGINE) Show older does not move focus to the first new item",
    file: "src/features/people/activity/ActivitySection.tsx",
    spec: SPEC,
    grep: "E-AC8:",
    expect: /E-AC8: /,
    patch: (t) => sub(t, "      [asked]?.focus();\n", "      [asked];\n"),
  },
  {
    id: "MU-6152",
    title:
      "WEB-19: (REAL ENGINE) a field removed by /sync is still shown while the re-read is held",
    file: "src/features/people/activity/ActivitySection.tsx",
    spec: SPEC,
    grep: "E-AC4:",
    expect: /E-AC4: .*a field removed by \/sync is withheld at once/,
    patch: (t) =>
      sub(
        t,
        '          withhold &&\n          event.target.kind === "field" &&\n',
        '          false &&\n          event.target.kind === "field" &&\n',
      ),
  },
  {
    id: "MU-6153",
    title: "WEB-19: (REAL ENGINE) going offline keeps the earlier rows shown",
    file: "src/features/people/activity/useActivity.ts",
    spec: SPEC,
    grep: "E-AC5:",
    expect: /E-AC5: /,
    patch: (t) =>
      sub(
        t,
        '  if (!env.online) {\n    shown.current = null;\n    return { status: "offline" };\n  }\n',
        '  if (!env.online && shown.current === null) {\n    return { status: "offline" };\n  }\n',
      ),
  },
];
