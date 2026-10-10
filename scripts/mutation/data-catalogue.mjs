// The WEB-09a mutation catalogue (plan 8.12): each entry is ONE deliberate defect, applied to a COPY of one source file, and the named
// tests must FAIL on it. The real tree is never edited (see vitest.mutant.config.ts); the unmutated control for the same tests runs
// beside it, so a test that "catches" a mutant is also shown to pass without it.
//
// `patch(text)` returns the mutated text. `sub` refuses a patch whose anchor is missing or ambiguous, so a refactor that moves the
// code a mutant targets fails LOUDLY here instead of silently turning the mutant into a no-op ("patch applied" is asserted).

export class PatchError extends Error {}

/** Replaces exactly ONE occurrence of `from` (a string or a RegExp with no `g` flag). Throws when there is none or more than one. */
export function sub(text, from, to) {
  if (typeof from === "string") {
    const first = text.indexOf(from);
    if (first < 0)
      throw new PatchError(`anchor not found: ${from.slice(0, 80)}`);
    if (text.indexOf(from, first + 1) >= 0)
      throw new PatchError(`anchor is ambiguous: ${from.slice(0, 80)}`);
    return text.slice(0, first) + to + text.slice(first + from.length);
  }
  const matches = [...text.matchAll(new RegExp(from.source, `${from.flags}g`))];
  if (matches.length !== 1)
    throw new PatchError(`pattern matched ${matches.length} times: ${from}`);
  return text.replace(from, to);
}

const GUARD_TESTS = [
  "tests/data/commit-guard.test.ts",
  "tests/data/service-g1.test.ts",
  "tests/data/guards.test.ts",
  "tests/data/engine-outcomes.test.ts",
  "tests/data/commit-page.test.ts",
];
const OUTBOX_MODEL_TESTS = [
  "tests/data/outbox-model.test.ts",
  "tests/data/outcomes-model.test.ts",
  "tests/data/outbox-plans.test.ts",
];
const OUTBOX_RUN_TESTS = [
  "tests/data/outbox-dispatcher.test.ts",
  "tests/data/outbox-answers.test.ts",
  "tests/data/outbox-plans.test.ts",
];
const PAGE_TESTS = [
  "tests/data/commit-page.test.ts",
  "tests/data/reconcile.test.ts",
  "tests/data/engine-outcomes.test.ts",
];
const FENCE_TESTS = [
  "tests/data/fence.test.ts",
  "tests/data/form-recovery.test.ts",
  "tests/data/wipe-coordination.test.ts",
  "tests/data/consent-real.test.ts",
];
const PORT_TESTS = [
  "tests/data/ports.test.ts",
  "tests/data/wipe-coordination.test.ts",
  "tests/data/consent-real.test.ts",
  "tests/data/fence.test.ts",
];

/** The mutants run by vitest over the production source in the fake world (layers L1a and L1b). */
export const UNIT = [
  // ---- the commit guard -----------------------------------------------------------------------------------------------------
  {
    id: "MU-01",
    title: "G1: the commit target is not tied to the request's stamped account",
    file: "src/data/engine/account-service.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(t, "if (captured.account !== this.account)", "if (false)"),
  },
  {
    id: "MU-02",
    title:
      "G2: the synchronous pre-check against the page's identity is removed",
    file: "src/data/engine/account-service.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(
        t,
        /if \(\s*identity === null \|\|\s*identity\.account_id !== captured\.account \|\|\s*identity\.epoch !== captured\.epoch\s*\)\s*return this\.drop\("identity_changed", "g2"\);/,
        "",
      ),
  },
  {
    id: "MU-03",
    title: "G3-INC: the incarnation check is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(t, "return sync.incarnation_id !== incarnationId;", "return false;"),
  },
  {
    id: "MU-04",
    title: "G3-CLS: the `closing` check is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(t, 'if (sync.draft_fence?.closing === true) return "closing";', ""),
  },
  {
    id: "MU-05",
    title: "G3-CAS: the cursor compare-and-set is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(
        t,
        'if (sync.cursor !== (captured.expectedPosition ?? null)) return "position";',
        "",
      ),
  },
  {
    id: "MU-06",
    title: "G3-GEN: the recovery-generation check is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(
        t,
        /if \(sync\.recovery_generation !== \(captured\.recoveryGeneration \?\? 0\)\)\s*return "generation";/,
        "",
      ),
  },
  {
    id: "MU-07",
    title: "G3-OWN: the ownership-token check is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(
        t,
        /if \(\s*\(sync\.owner\?\.ownership_token \?\? null\) !==\s*\(captured\.ownershipToken \?\? null\)\s*\)\s*return "owner";/,
        "",
      ),
  },
  {
    id: "MU-08",
    title: "G3-EPO: the epoch-mirror check is removed",
    file: "src/data/model/guards.ts",
    tests: GUARD_TESTS,
    patch: (t) => sub(t, "sync.stamp.epoch > captured.epoch", "false"),
  },
  {
    id: "MU-09",
    title: "G4b: the epoch is not published when a page observes it",
    file: "src/data/engine/account-service.ts",
    tests: GUARD_TESTS,
    patch: (t) =>
      sub(
        t,
        /\} else if \(identity\.epoch > service\.lastEpoch\) \{\s*void service\.publish\(identity\.epoch\);\s*\}/,
        "}",
      ).replace("void service.publish(identity.epoch);", ""),
  },
  {
    id: "MU-10",
    title:
      "G4a: the service is not closed when the page's identity leaves the account",
    file: "src/data/engine/account-service.ts",
    tests: GUARD_TESTS,
    patch: (t) => sub(t, 'service.dispose("identity");', ""),
  },
  {
    id: "MU-11",
    title:
      "the latch is never set: a wiped or closed account can be reopened by a late writer",
    file: "src/data/store/registry.ts",
    tests: [
      "tests/data/open.test.ts",
      "tests/data/commit-guard.test.ts",
      "tests/data/wipe-coordination.test.ts",
    ],
    patch: (t) =>
      sub(t, 'setLatch(account, options?.latch ?? "closed_for_deletion");', ""),
  },

  // ---- the fence and the closing write ----------------------------------------------------------------------------------------
  {
    id: "MU-12",
    title: "FEN: the fence check is removed from enqueue",
    file: "src/data/model/outbox.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        'const refusal = fenceRefusal(facts.sync);\n  if (refusal !== null) return { kind: "refused", reason: refusal };\n  const resolved',
        "const resolved",
      ),
  },
  {
    id: "MU-13",
    title: "FEN: the fence check is removed from the in-place edit",
    file: "src/data/model/outbox.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        'const refusal = fenceRefusal(sync);\n  if (refusal !== null) return { kind: "refused", reason: refusal };\n  if (draft.status !== "queued")',
        'if (draft.status !== "queued")',
      ),
  },
  {
    id: "MU-14",
    title: "CLS: the `closing` check is removed from the form-recovery save",
    file: "src/data/plans/form-recovery.ts",
    tests: FENCE_TESTS,
    // Re-anchored in revision 14 (the lease check now stands between the `closing` check and the capture it orders): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        /if \(sync\?\.draft_fence\?\.closing === true\)\s*return \{ result: \{ kind: "refused" \} \};(?=\s*\/\/ In the step that decides what is written)/,
        "",
      ),
  },
  {
    id: "MU-15",
    title: "form recovery's transaction scope does not include sync_state",
    file: "src/data/plans/builders.ts",
    tests: FENCE_TESTS,
    patch: (t) =>
      sub(
        t,
        /const scope: StoreName\[\] = \[\s*\.\.\.new Set<StoreName>\(\[\.\.\.spec\.scope, "sync_state"\]\),\s*\];\s*const mode = spec\.mode \?\? "readwrite";/,
        'const scope: StoreName[] = [\n    ...new Set<StoreName>([\n      ...spec.scope,\n      ...(spec.name === "data.saveFormRecovery" ? [] : ["sync_state" as const]),\n    ]),\n  ];\n  const mode = spec.mode ?? "readwrite";',
      ),
  },

  // ---- the page, the receipt and the overlay ----------------------------------------------------------------------------------
  {
    id: "MU-16",
    title:
      "the request_seq comparison of the live-edge no_publication rule is not strict",
    file: "src/data/model/reconcile.ts",
    tests: PAGE_TESTS,
    patch: (t) =>
      sub(
        t,
        "facts.requestSeq > e.no_publication_floor",
        "facts.requestSeq >= e.no_publication_floor",
      ),
  },
  {
    id: "MU-17",
    title: "submitted_at_page_seq is overwritten on a resend",
    file: "src/data/plans/outbox.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        /const missing = candidateRows\(draft, sync\.page_seq\)\.filter\(\s*\(row\) => !have\.has\(row\.resource_id\),\s*\);/,
        "const missing = candidateRows(draft, sync.page_seq);",
      ),
  },
  {
    id: "MU-18",
    title:
      "receipt condition 0 is removed: a duplicate or late receipt is applied",
    file: "src/data/model/outcomes.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        /\/\/ 0: the draft is found with status exactly `in_flight`;[^\n]*\n {2}if \(draft === undefined\) return \{ kind: "noop", reason: "not_found" \};\n {2}if \(draft\.status !== "in_flight"\)\n {4}return \{ kind: "noop", reason: "not_in_flight" \};/,
        'if (draft === undefined) return { kind: "noop", reason: "not_found" };',
      ),
  },
  {
    id: "MU-19",
    title:
      "the receipt's cache_status condition is removed: an overlay shows over a hidden cache",
    file: "src/data/model/outcomes.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        /row\.resolved !== "no_publication" &&\s*valid\s*\) \{/,
        'row.resolved !== "no_publication"\n    ) {',
      ),
  },
  {
    id: "MU-20",
    title: "release (a) is skipped: a mention does not clear the overlay",
    file: "src/data/model/reconcile.ts",
    tests: PAGE_TESTS,
    patch: (t) =>
      sub(
        t,
        "row = { ...row, last_mentioned_page_seq: facts.pageSeq, display: null };",
        "row = { ...row, last_mentioned_page_seq: facts.pageSeq };",
      ),
  },

  // ---- what the dispatcher counts and keeps -----------------------------------------------------------------------------------
  {
    id: "MU-21",
    title: "an unsent request (not_sent) is counted as a failed attempt",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        'case "not_sent": {\n          await unclaim(service, claimed);',
        'case "not_sent": {\n          return failure(id, service, claimed.draft, { stage: "network" });\n          await unclaim(service, claimed);',
      ),
  },
  {
    id: "MU-22",
    title: "a stale answer removes the draft",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        '        case "stale":\n',
        '        case "stale":\n          await service.store.run(discardDraft, { incarnationId: service.incarnationId, localId: claimed.draft.local_id });\n          return { when: "now" };\n',
      ).replace(
        'from "../plans/outbox";',
        'from "../plans/outbox";\nimport { discardDraft } from "../plans/outbox";',
      ),
  },
  {
    id: "MU-23",
    title: "an auth_state answer removes the draft",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        '        case "auth_state":\n',
        '        case "auth_state":\n          await service.store.run(discardDraft, { incarnationId: service.incarnationId, localId: claimed.draft.local_id });\n          return { when: "event" };\n',
      ).replace(
        'from "../plans/outbox";',
        'from "../plans/outbox";\nimport { discardDraft } from "../plans/outbox";',
      ),
  },
  {
    id: "MU-24",
    title:
      "the compatibility pause is removed: queued writes are sent whatever the server says",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        "function compatGate(): DispatcherState | null {\n    const compat = deps.compat.get();",
        "function compatGate(): DispatcherState | null {\n    return null;\n    const compat = deps.compat.get();",
      ),
  },
  {
    id: "MU-25",
    title:
      "an unconfirmed compatibility (unknown, unreachable) is treated as supported",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        'default:\n        return { kind: "held", reason: "compat_unconfirmed" };',
        "default:\n        return null;",
      ),
  },
  {
    id: "MU-26",
    title:
      "unclaim is removed: a draft that never reached the wire stays frozen in flight",
    file: "src/data/plans/outbox.ts",
    tests: OUTBOX_RUN_TESTS,
    patch: (t) =>
      sub(
        t,
        /decide: \(\{ reads, input \}\) => \{\n {4}if \(reads === undefined \|\| reads\.status !== "in_flight"\)/,
        'decide: ({ reads, input }) => {\n    if (true || reads === undefined || reads.status !== "in_flight")',
      ),
  },
  {
    id: "MU-27",
    title: "the version-base recompute after a cascade is removed",
    file: "src/data/model/outbox.ts",
    tests: OUTBOX_MODEL_TESTS,
    patch: (t) =>
      sub(
        t,
        "export function recomputeVersions(input: RecomputeInput): Recomputed {\n",
        "export function recomputeVersions(input: RecomputeInput): Recomputed {\n  if (input) return { puts: [], deletes: [] };\n",
      ),
  },
  {
    id: "MU-28",
    title:
      "enqueue reads its version base outside its own transaction (a stale base is reused)",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-plans.test.ts",
      "tests/data/outbox-answers.test.ts",
      "tests/data/outbox-dispatcher.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        /read: async \(reader, input\) => \(\{\n {4}existing: await reader\.get\("drafts", input\.localId\),\n {4}touched: await readTouched\(\n {6}reader,\n {6}input\.request\.targets\.map\(\(target\) => target\.resourceId\),\n {6}new Set\(\[input\.localId\]\),\n {4}\),\n {2}\}\),/,
        `read: async (reader, input) => {
    const fresh = {
      existing: await reader.get("drafts", input.localId),
      touched: await readTouched(
        reader,
        input.request.targets.map((target) => target.resourceId),
        new Set([input.localId]),
      ),
    };
    const slot = globalThis as unknown as { __stale?: Map<string, never> };
    slot.__stale ??= fresh.touched.versions as Map<string, never>;
    return { existing: fresh.existing, touched: { ...fresh.touched, versions: slot.__stale as never } };
  },`,
      ),
  },

  // ---- the page commit ---------------------------------------------------------------------------------------------------------
  {
    id: "MU-29",
    title:
      "a page is committed in pieces: a failed write in the middle is swallowed and the rest commits",
    file: "src/data/plans/commit-page.ts",
    tests: PAGE_TESTS,
    patch: (t) =>
      sub(
        t,
        /\n {8}await flush\(ready\);\n/,
        "\n        if (index === 0) await flush(ready);\n        else await flush(ready).catch(() => undefined);\n",
      ),
  },
  {
    id: "MU-30",
    title: "the page's next_cursor is altered before it is stored",
    file: "src/data/plans/commit-page.ts",
    tests: PAGE_TESTS,
    patch: (t) =>
      sub(t, "cursor: scan.nextCursor,", 'cursor: scan.nextCursor + "~",'),
  },
  {
    id: "MU-31",
    title: "an empty page does not commit (a renewed cursor is lost)",
    file: "src/data/plans/commit-page.ts",
    tests: PAGE_TESTS,
    patch: (t) =>
      sub(
        t,
        "    const { scan } = input;\n    let revision",
        '    const { scan } = input;\n    if (scan.totalChanges === 0)\n      return { result: { kind: "committed", pageSeq: sync.page_seq, changes: 0, revision: null, hasMore: scan.hasMore, stats: { mentioned: 0, resolvedNoPublication: 0, heldReleased: 0, unavailable: 0 } } };\n    let revision',
      ),
  },

  // ---- retry --------------------------------------------------------------------------------------------------------------------
  {
    id: "MU-32",
    title: "a paused caller is resumed by an UNRELATED caller's success",
    file: "src/data/plans/retry-state.ts",
    tests: [
      "tests/data/retry.test.ts",
      "tests/data/retry-plans.test.ts",
      "tests/data/engine-outcomes.test.ts",
      "tests/data/outbox-answers.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      sync: { ...sync, read_retry_states: states },\n      result: { state: next },",
        '      sync: {\n        ...sync,\n        read_retry_states:\n          input.outcome.kind === "success" ? { [input.caller]: next } : states,\n      },\n      result: { state: next },',
      ),
  },
  {
    id: "MU-33",
    title:
      "the local-write streak is keyed by the KIND of operation, not its identity",
    file: "src/data/plans/retry-state.ts",
    tests: [
      "tests/data/retry.test.ts",
      "tests/data/engine-outcomes.test.ts",
      "tests/data/outbox-dispatcher.test.ts",
      "tests/data/outbox-answers.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "const failed = recordWriteFailure(sync, input.operation);",
        'const failed = recordWriteFailure(sync, input.operation.split(":")[0] as string);',
      ),
  },

  // ---- sizing and the floor ----------------------------------------------------------------------------------------------------
  {
    id: "MU-34",
    title: "an oversize response steps the page size down",
    file: "src/data/model/sizing.ts",
    tests: ["tests/data/sizing.test.ts", "tests/data/engine-sizing.test.ts"],
    patch: (t) =>
      sub(t, 'case "oversize":\n    case "quota":', 'case "quota":').replace(
        'case "allocation_failed":',
        'case "oversize":\n    case "allocation_failed":',
      ),
  },
  {
    id: "MU-35",
    title: "a quota failure steps the page size down",
    file: "src/data/model/sizing.ts",
    tests: ["tests/data/sizing.test.ts", "tests/data/engine-sizing.test.ts"],
    patch: (t) =>
      sub(t, 'case "oversize":\n    case "quota":', 'case "oversize":').replace(
        'case "allocation_failed":',
        'case "quota":\n    case "allocation_failed":',
      ),
  },
  {
    id: "MU-36",
    title: "the floor is reached on the FIRST failure at the lowest rung",
    file: "src/data/model/sizing.ts",
    tests: ["tests/data/sizing.test.ts", "tests/data/engine-sizing.test.ts"],
    patch: (t) =>
      sub(t, "action: hits >= config.floorAfter ?", "action: hits >= 1 ?"),
  },

  // ---- the registered ports and the wipe -----------------------------------------------------------------------------------------
  {
    id: "MU-37",
    title:
      "baselineDigest answers null (nothing to consent to) while there is work and no fence",
    file: "src/data/ports/ports-impl.ts",
    tests: PORT_TESTS,
    patch: (t) =>
      sub(
        t,
        "return read.liveCount === 0 ? EMPTY_DIGEST : NO_CONSENT_DIGEST;",
        "return read.liveCount === 0 ? EMPTY_DIGEST : (null as never);",
      ),
  },
  {
    id: "MU-38",
    title: "releasing a fence clears another operation's fence",
    file: "src/data/plans/fence.ts",
    tests: PORT_TESTS,
    patch: (t) =>
      sub(
        t,
        / {6}fence === null \|\|\n {6}!fence\.operation_ids\.includes\(input\.operationId\)\n {4}\)\n {6}return \{ result: \{ kind: "noop" \} \};/,
        '      fence === null\n    )\n      return { result: { kind: "noop" } };',
      ),
  },
  {
    id: "MU-39",
    title: "the stale-fence rule ignores an operation that is still pending",
    file: "src/data/plans/fence.ts",
    tests: PORT_TESTS,
    patch: (t) =>
      sub(
        t,
        "!stale || input.hasPendingOperation || !input.sessionStarted",
        "!stale || !input.sessionStarted",
      ),
  },
  {
    id: "MU-41",
    title: "exists answers false when indexedDB.databases() fails",
    file: "src/data/ports/account-database.ts",
    tests: PORT_TESTS,
    patch: (t) =>
      sub(
        t,
        "const listed = (await deps.host.list()).includes(name);",
        "const listed = (await deps.host.list().catch(() => [] as string[])).includes(name);",
      ),
  },
  {
    id: "MU-42",
    title: "a deleted account's write-failure markers are left behind",
    file: "src/data/ports/account-database.ts",
    tests: PORT_TESTS,
    patch: (t) => sub(t, "deps.markers.clearAccount(account);", ""),
  },
  {
    id: "MU-43",
    title: "user input is refused as early as cache pages",
    file: "src/data/model/quota.ts",
    tests: [
      "tests/data/quota.test.ts",
      "tests/data/engine-outcomes.test.ts",
      "tests/data/outbox-answers.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        'return free - estimatedBytes < config.quotaReserveBytes / 2 ? "refuse" : "ok";',
        'return free < config.quotaReserveBytes + estimatedBytes ? "refuse" : "ok";',
      ),
  },
  {
    id: "MU-44",
    title:
      "the profile label is shown without checking the epoch it was verified for",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/profile.test.ts", "tests/data/ui-env.test.ts"],
    patch: (t) =>
      sub(
        t,
        /return verified\.account === identity\.account_id &&\s*verified\.epoch === identity\.epoch\s*\? verified\.username\s*: null;/,
        "return verified.account === identity.account_id ? verified.username : null;",
      ),
  },
  {
    id: "MU-45",
    title: "the page scanner accepts a bad escape and an over-deep value",
    file: "src/data/scan/scan.ts",
    tests: [
      "tests/data/scan.test.ts",
      "tests/data/validate.test.ts",
      "tests/data/commit-page.test.ts",
    ],
    patch: (t) =>
      sub(t, 'fail("syntax", "bad escape");', "/* tolerated */;").replace(
        'if (depth > config.maxDepth) fail("limit", "nesting too deep");',
        "",
      ),
  },
  {
    id: "MU-46",
    title:
      "G2b: the identity comparison inside the transaction body is removed",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard.test.ts"],
    patch: (t) =>
      sub(
        t,
        /return current\(\)\n {10}\? plan\.decide\(reads, input\)/,
        "return true\n          ? plan.decide(reads, input)",
      ),
  },

  // ---- the revision (R1 to R8): each defect the independent review found, as a mutant that its test must catch ---------------------
  {
    id: "MU-49",
    title:
      "G5: the persistence hold is not taken (a commit is judged by this page's own copy of the identity alone)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard.test.ts"],
    patch: (t) =>
      sub(
        t,
        "hold = await this.deps.persistence.hold(captured.account, captured.epoch);",
        'hold = { kind: "held", release: () => undefined };',
      ),
  },
  {
    id: "MU-50",
    title:
      "G5: the hold is released BEFORE the data transaction completes (a settlement can be ordered between the verdict and the persistence)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    try {\n      // The wait for the hold took time: the account may have been closed on this page meanwhile.",
        "    hold.release();\n    try {\n      // The wait for the hold took time: the account may have been closed on this page meanwhile.",
      ),
  },
  {
    id: "MU-51",
    title:
      "G5: a `stale` verdict at the record does not drop the commit (the hold only waits for the lock)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard.test.ts"],
    patch: (t) =>
      sub(
        t,
        'if (hold.kind === "stale") return this.drop("identity_changed", "g5");',
        "",
      ),
  },
  {
    id: "MU-52",
    title:
      "R1: a recovery capture the store refused as superseded is reported as saved",
    file: "src/data/ports/form-recovery.ts",
    tests: [
      "tests/data/form-recovery.test.ts",
      "tests/data/form-recovery-overlap.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        'return result.kind === "superseded" ? "failed" : "saved";',
        'return "saved";',
      ),
  },
  {
    id: "MU-53",
    title:
      "R3: a window of candidates that was exhausted with no pick does not carry its position to the next turn",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/queue-working-set.test.ts"],
    patch: (t) =>
      sub(
        t,
        "if (!picked && moreAfter && last !== undefined) next = last.row.created_seq;",
        "void moreAfter;",
      ),
  },
  {
    id: "MU-54",
    title:
      "R3: a candidate is not held back by an EARLIER draft that shares a target with it (FIFO per resource is lost)",
    file: "src/data/model/dispatch.ts",
    tests: [
      "tests/data/queue-working-set.test.ts",
      "tests/data/outbox-answers.test.ts",
      // The dispatcher now hands the rule the EARLIEST sharing draft of each target, for which the age check is redundant; the pure
      // rule is still held to the whole-population answer, with later drafts in the list, by the fold's property test (revision 9).
      "tests/data/related-fold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      other.created_seq < row.created_seq &&\n      !isTerminal(other) &&",
        "      !isTerminal(other) &&",
      ),
  },
  {
    id: "MU-55",
    title:
      "R4: the browser coming back online does not end the sync caller's pause",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-resume.test.ts"],
    patch: (t) => sub(t, "deps.onOnline(cameOnline)", "deps.onOnline(wake)"),
  },
  {
    id: "MU-56",
    title:
      "R5: a stopped page operation is not enforced from the durable record on a start (the durable streak of a PAGE's operation is never read)",
    file: "src/data/plans/sync-writers.ts",
    tests: [
      "tests/data/engine-resume.test.ts",
      "tests/data/engine-sizing.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        /\(sync\.local_write_streaks\[operation\] \?\? 0\) >=\s*DATA_CONFIG\.localWritePauseAfter \|\|/,
        "(operation === CAPTURE_OPERATION && (sync.local_write_streaks[operation] ?? 0) >= DATA_CONFIG.localWritePauseAfter) ||",
      ),
  },
  {
    id: "MU-57",
    title:
      "R5: `online` clears a local-write stop (it is not a connectivity problem)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "if (ownership !== null) void resume(undefined, false);",
        "if (ownership !== null) void resume(undefined, true);",
      ),
  },
  {
    id: "MU-58",
    title: "R7: the quota guard ignores the bytes of writes already in flight",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-writes.test.ts"],
    // Re-anchored in revision 13 (the guard judges against a ledger now) and in revision 18: the mutated meaning is unchanged.
    patch: (t) => sub(t, "Math.max(0, figure - held)", "figure"),
  },
  {
    id: "MU-59",
    title: "R7: a supersession is not held to the quota reserve",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/quota-writes.test.ts"],
    // Re-anchored in revisions 12 and 13 (R25 moved the three growth paths under `admitted`, which now also takes the save's identity): the mutated meaning is unchanged, a supersession is run without any reservation.
    patch: (t) =>
      sub(
        t,
        "    // A supersession stores a new command, so it grows the stores like an enqueue and is held to the same reserve.\n    return admitted<SupersedeOutcome>(\n      next,\n      localId,\n      async (reservation, maxBytes) => {",
        "    const unreserved = (_request, _localId, attempt) =>\n      attempt({ settle: () => undefined }, Number.MAX_SAFE_INTEGER);\n    return unreserved(\n      next,\n      localId,\n      async (reservation, maxBytes) => {",
      ),
  },
  {
    id: "MU-60",
    title:
      "R8: a start that was coalesced into an old generation's loop is never run when that loop unwinds",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-lifecycle.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (id !== generation && alive(generation))\n        void tick(generation, "start");',
        "",
      ),
  },
  {
    id: "MU-61",
    title:
      "R6: a receipt that removes a draft leaves its body behind (a body outlives its draft)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-plans.test.ts"],
    patch: (t) =>
      sub(
        t,
        '              // A body never outlives its draft.\n              w.delete("draft_commands", decision.draftDelete),',
        "",
      ),
  },
  {
    id: "MU-62",
    title:
      "R4: an offline-to-online change that is only read at a wake (no `online` event) does not end the sync caller's pause",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-resume.test.ts"],
    patch: (t) =>
      sub(
        t,
        "if (transition) cameOnline();",
        "if (false as boolean) cameOnline();",
      ),
  },
  // ---- revision 6 (the second revision review): R2, R1, R7, R5, R6 ----------------------------------------------------------
  {
    id: "MU-63",
    title:
      "R2: at expiry the hold gives up the lock at once, without waiting for the work registered with it (a commit that is already committing can then land after a settlement)",
    file: "src/session/kernel/persistence.ts",
    tests: [
      "tests/data/commit-guard-expiry.test.ts",
      "tests/session/persistence.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    if (unresolved === 0) {\n      giveBack();",
        "    if (true as boolean) {\n      giveBack();",
      ),
  },
  {
    id: "MU-64",
    title:
      "R2: the revocation signal is not handed to the store (a queued transaction is not aborted when the hold runs out)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard-expiry.test.ts"],
    patch: (t) =>
      sub(t, "        { signal: hold.revoked },\n", "        {},\n"),
  },
  {
    id: "MU-65",
    title:
      "R2: the decision does not consult the hold's validity (a store that ignores the signal can still persist after the revocation)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard-expiry.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (!hold.valid())\n          return {",
        "        if (false as boolean)\n          return {",
      ),
  },
  {
    id: "MU-66",
    title:
      "R2: the transaction is not registered with the hold (the lock is given up at expiry while the transaction may still be committing)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard-expiry.test.ts"],
    patch: (t) => sub(t, "      hold.track(running);\n", ""),
  },
  {
    id: "MU-67",
    title:
      "R2: after the bound the hold still says it is valid (valid() reads only whether it was released)",
    file: "src/session/kernel/persistence.ts",
    tests: ["tests/session/persistence.test.ts"],
    patch: (t) =>
      sub(
        t,
        "valid: () => !closing && !finished && !revoked.aborted,",
        "valid: () => !closing && !finished,",
      ),
  },
  {
    id: "MU-68",
    title:
      "R2 (revision 7): the stall report gives the lock up (the first two revisions' drain): a transaction that is still committing can land after a settlement that was let in ahead of it",
    file: "src/session/kernel/persistence.ts",
    tests: [
      "tests/data/commit-guard-expiry.test.ts",
      "tests/data/commit-guard.test.ts",
      "tests/session/persistence.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        'if (!finished && unresolved > 0) deps.emit("persistence.stalled");',
        'if (!finished && unresolved > 0) {\n          deps.emit("persistence.stalled");\n          giveBack();\n        }',
      ),
  },
  {
    id: "MU-69",
    title:
      "R2: a transaction that is already invalid at the moment the service would start it is started anyway",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/commit-guard-expiry.test.ts"],
    patch: (t) =>
      sub(t, 'if (!hold.valid()) return this.drop("unverified", "g5");', ""),
  },
  {
    id: "MU-70",
    title:
      "R1: captures are admitted by their sequence number alone (the writer generation is ignored)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-overlap.test.ts",
      "tests/data/form-recovery.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "  if (incomingGen !== storedGen) return incomingGen > storedGen;\n",
        "",
      ),
  },
  {
    id: "MU-71",
    title:
      "R1: the same content saved again does not move the order record (an earlier capture with other content can then land above it)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-overlap.test.ts",
      "tests/data/form-recovery.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        return after\n          ? {",
        "        return false as boolean\n          ? {",
      ),
  },
  {
    id: "MU-72",
    title:
      "R1: every capture claims a new writer generation (the claim is not shared by the page's handle)",
    file: "src/data/ports/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-overlap.test.ts",
      "tests/data/form-recovery.test.ts",
    ],
    patch: (t) =>
      sub(t, "    if (writer.claim === null) {", "    if (true as boolean) {"),
  },
  {
    id: "MU-73",
    title:
      "R1: the claim of a writer generation ignores `closing` (a claim is written while the account is signing out)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-overlap.test.ts",
      "tests/data/form-recovery-quota.test.ts",
      "tests/data/fence.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        /if \(sync\?\.draft_fence\?\.closing === true\)\s*return \{ result: \{ kind: "refused" \} \};\s*(?=\/\/ Without the row that holds the counter)/,
        "",
      ),
  },
  {
    id: "MU-74",
    title:
      "R1: a claim keeps the stored sequence number in the new generation (the claimant's first capture is not after its own claim)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-overlap.test.ts",
      "tests/data/form-recovery.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        /\.\.\.stored,\s*writer_gen: gen,\s*capture_seq: 0,/,
        "...stored, writer_gen: gen,",
      ),
  },
  {
    id: "MU-75",
    title:
      "R7: a write that lands while others are already in the ledger is not added to it (concurrent landings lose a debit)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger.test.ts"],
    // Re-anchored in revision 13 (the guard judges against a ledger now): the mutated meaning is unchanged.
    // Re-anchored in revision 16: the one place a write's bytes enter the landed ledger is `landHold`, in the ledger's module.
    patch: (t) =>
      sub(
        t,
        "      landed: landed.landed + hold.bytes,",
        "      landed: landed.landed,",
      ),
  },
  {
    id: "MU-76",
    title:
      "R7: an invalidation (another tab's data_changed) also forgets the ledger of this tab's own recent writes",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-ledger.test.ts"],
    // Re-anchored in revision 13 (the guard judges against a ledger now): the mutated meaning is unchanged.
    // Re-expressed in revision 15: the guard no longer has a ledger of its own (`local`), which the original replacement also cleared.
    // Re-anchored in revision 17: an invalidation drops the readings (`dropReadings`), the cache and the request on its way.
    patch: (t) =>
      sub(
        t,
        "      dropReadings();\n    },\n    close() {",
        "      dropReadings();\n      void shared.update(() => ({\n        state: { holds: {}, landed: null },\n        result: undefined,\n      }));\n    },\n    close() {",
      ),
  },
  {
    id: "MU-77",
    title:
      "R7: the cap is a sum, not a minimum (an estimate that already shows the writes counts them twice)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-ledger.test.ts"],
    // Re-anchored in revision 13 (the guard judges against a ledger now): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "Math.min(figure, Math.max(0, landed.base - landed.landed))",
        "Math.max(0, figure - landed.landed)",
      ),
  },
  {
    id: "MU-78",
    title:
      "R5: a stop only this tab's memory holds is not offered to the capture gate (an ordinary wake sends the page again)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-resume.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      stoppedOperations: operationsOf(memoryStops.keys(), service).filter(",
        "      stoppedOperations: operationsOf(false as boolean ? memoryStops.keys() : [], service).filter(",
      ),
  },
  {
    id: "MU-79",
    title:
      "R5: a stop and a start of the engine (an ownership change in a tab that stays alive) forgets the memory-only stops",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-resume.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      lifted.clear();\n      lastOnline = deps.online();",
        "      lifted.clear();\n      memoryStops.clear();\n      lastOnline = deps.online();",
      ),
  },
  {
    id: "MU-80",
    title:
      "R5: the dispatcher forgets its memory-only stalled drafts when it is started again in the same tab",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...stops.operations(service),\n  ];",
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...([] as string[]),\n  ];",
      ),
  },
  {
    id: "MU-81",
    title:
      "R6: a draft that would leave is deleted although another of its effects still shows an overlay (the windows cannot see each other)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/reconcile-windows.test.ts",
      "tests/data/commit-page-bounded.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        // RE-ANCHORED by WEB-09b (the window's reconciliation moved into `reconcileEffectWindow`, two spaces shallower): the same defect.
        "      if (await hasOtherDisplaying(reader, owner, inWindow, window))\n        others.add(owner);",
        "      if (false as boolean && (await hasOtherDisplaying(reader, owner, inWindow, window)))\n        others.add(owner);",
      ),
  },
  {
    id: "MU-82",
    title:
      "R6: the effects of a window are reconciled in the reverse of the key order (a draft's flags move at the wrong effect)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: ["tests/data/reconcile-windows.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      await effectWindow(rows);\n      const last",
        "      await effectWindow([...rows].reverse());\n      const last",
      ),
  },
  {
    id: "MU-83",
    title:
      "R6: the lookup of what a page names finds only tracked versions, never a pending effect",
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/commit-page.test.ts",
      "tests/data/commit-page-bounded.test.ts",
      "tests/data/engine-outcomes.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    for (const effect of rows) hits.add(effect.resource_id);\n",
        "",
      ),
  },
  {
    id: "MU-84",
    title:
      'R6: the question "does an outstanding draft still target this resource" looks at the first window of headers only',
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/reconcile-windows.test.ts",
      "tests/data/commit-page-bounded.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    if (headers.length < window) return false;\n  }\n}\n\n/** Whether `owner`",
        "    return false;\n  }\n}\n\n/** Whether `owner`",
      ),
  },
  {
    id: "MU-85",
    title:
      "R6: a final page does not visit every effect (the live edge never resolves an effect the page does not name)",
    file: "src/data/plans/commit-page.ts",
    tests: [
      "tests/data/commit-page-bounded.test.ts",
      "tests/data/commit-page.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "const liveEdge = !scan.hasMore && input.captured.requestSeq !== null;",
        "const liveEdge = false as boolean;",
      ),
  },
  {
    id: "MU-86",
    title:
      "R6: the visible queue ignores its window's cursor (every window re-reads from the start, as a cumulative limit did)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/queue-working-set.test.ts"],
    patch: (t) =>
      sub(
        t,
        "const start = input.after ?? null;",
        "const start = null as number | null;",
      ),
  },
  {
    id: "MU-87",
    title:
      "R6: moving to the next window of the queue ADDS it to the rows already held (the windows are not replaced)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/queue-working-set.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      limit: pageSize,\n      after,",
        "      limit: pageSize * (trail.length + 1),\n      after: null,",
      ),
  },
  // ---- revision 7 (the third revision review): R2 --------------------------------------------------------------------------
  {
    id: "MU-88",
    title:
      "R2 (revision 7): release() gives the lock up at once, whatever the registered work (a consumer can release under a transaction it has not seen end)",
    file: "src/session/kernel/persistence.ts",
    tests: ["tests/session/persistence.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    closing = true;\n    if (unresolved === 0) giveBack();",
        "    closing = true;\n    giveBack();",
      ),
  },
  {
    id: "MU-89",
    title:
      "R2 (revision 7): the lock goes when the FIRST registered promise settles, not the last",
    file: "src/session/kernel/persistence.ts",
    tests: ["tests/session/persistence.test.ts"],
    patch: (t) =>
      sub(
        t,
        "if (unresolved === 0 && (closing || revoked.aborted)) giveBack();",
        "if (closing || revoked.aborted) giveBack();",
      ),
  },
  {
    id: "MU-90",
    title:
      "R2 (revision 7): a rejected registered promise is not counted as settled (the lock is never given back after an aborted transaction)",
    file: "src/session/kernel/persistence.ts",
    tests: [
      "tests/session/persistence.test.ts",
      "tests/data/commit-guard-expiry.test.ts",
    ],
    patch: (t) =>
      sub(t, "promise.then(settled, settled);", "promise.then(settled);"),
  },
  // ---- revision 7 (the third revision review): R5 ----------------------------------------------------------------------------
  {
    id: "MU-91",
    title:
      "R5 (revision 7): the capture gate reads no durable streak for the capture write (three recorded failures do not stop the next capture)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-capture-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      (sync.local_write_streaks[operation] ?? 0) >=\n        DATA_CONFIG.localWritePauseAfter ||",
        "      (operation !== CAPTURE_OPERATION &&\n        (sync.local_write_streaks[operation] ?? 0) >=\n          DATA_CONFIG.localWritePauseAfter) ||",
      ),
  },
  {
    id: "MU-92",
    title:
      "R5 (revision 7): the capture gate ignores the fallback markers and the stops only this tab holds for the capture write",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-capture-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      input.stoppedOperations?.includes(operation) === true ||\n      markerOf(operation) === "marked";',
        '      (operation !== CAPTURE_OPERATION &&\n        (input.stoppedOperations?.includes(operation) === true ||\n          markerOf(operation) === "marked"));',
      ),
  },
  {
    id: "MU-93",
    title:
      "R5 (revision 7): the engine offers the gate only the page operations of its markers and memory stops (the capture write's stop never reaches it)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-capture-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "operation === CAPTURE_OPERATION ||\n          operation === READ_RETRY_OPERATION ||",
        "operation === READ_RETRY_OPERATION ||",
      ),
  },
  {
    id: "MU-94",
    title:
      "R5 (revision 7): a successful capture write does not clear its own streak (failures that are not consecutive accumulate to a stop)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-capture-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        local_write_streaks: onLocalWriteSuccess(\n          sync.local_write_streaks,\n          CAPTURE_OPERATION,\n        ),",
        "        local_write_streaks: sync.local_write_streaks,",
      ),
  },
  {
    id: "MU-95",
    title:
      "R5 (revision 7): a stop of the capture write is reported as the page's operation (the explicit retry then clears the wrong operation)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-capture-stop.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      stopped(CAPTURE_OPERATION)\n        ? CAPTURE_OPERATION\n",
        "      stopped(CAPTURE_OPERATION)\n        ? pageOperation\n",
      ),
  },
  // ---- revision 7 (the third revision review): R6 ----------------------------------------------------------------------------
  {
    id: "MU-96",
    title:
      "R6 (revision 7): the initial lookup is the revision-6 one: every pending effect of every id it asks about in ONE unbounded read (one resource's 350 receipt effects come back together)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/reconcile-windows.test.ts",
      "tests/data/commit-page-bounded.test.ts",
    ],
    patch: (t) =>
      sub(
        sub(
          t,
          "let remaining = ids.filter((id) => !hits.has(id));",
          "let remaining = [...ids];",
        ),
        "      remaining,\n      allowed,\n",
        "      remaining,\n",
      ),
  },
  {
    id: "MU-97",
    title:
      "R6 (revision 7): a lookup round that came back full is taken for complete (the ids behind a heavy resource are never asked about)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/reconcile-windows.test.ts",
      "tests/data/commit-page-bounded.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "if (rows.length < allowed) break;",
        "if (true as boolean) break;",
      ),
  },
  {
    id: "MU-98",
    title:
      "R6 (revision 7): the lookup asks about the effects of ids that already have a tracked version (reads that answer nothing)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: ["tests/data/reconcile-windows.test.ts"],
    patch: (t) =>
      sub(
        t,
        "let remaining = ids.filter((id) => !hits.has(id));",
        "let remaining = [...ids];",
      ),
  },

  // ---- R12 (revision 8): the durable closing flag is a precondition of a deletion ----------------------------------------------
  {
    id: "MU-101",
    title:
      "R12 (revision 8): the wipe goes on without the durable closing flag (the failed write is not a reason to stop: the revision-7 behaviour)",
    file: "src/session/kernel/wipe.ts",
    tests: [
      "tests/session/wipe-closing.test.ts",
      "tests/data/wipe-closing.test.ts",
    ],
    patch: (t) =>
      sub(t, "if (!(await this.confirmClosing(account))) {", "if (false) {"),
  },
  {
    id: "MU-102",
    title:
      "R12 (revision 8): any answer but `unconfirmed` counts as the flag (a port that swallows its failure and resolves with nothing authorises the deletion)",
    file: "src/session/kernel/wipe.ts",
    tests: ["tests/session/wipe-closing.test.ts"],
    patch: (t) =>
      sub(
        t,
        'if (answer === "closing") return true;',
        'if (answer !== "unconfirmed") return true;',
      ),
  },
  {
    id: "MU-103",
    title: "R12 (revision 8): a port that REJECTS is taken for the flag",
    file: "src/session/kernel/wipe.ts",
    tests: ["tests/session/wipe-closing.test.ts"],
    patch: (t) =>
      sub(
        t,
        '        answer = "unconfirmed";\n      }',
        '        answer = "closing";\n      }',
      ),
  },
  {
    id: "MU-104",
    title:
      "R12 (revision 8): the closing flag is asked for ONCE (a transient abort is never asked again, so every transient fault leaves the wipe waiting for the next boot)",
    file: "src/session/kernel/wipe.ts",
    tests: [
      "tests/session/wipe-closing.test.ts",
      "tests/data/wipe-closing.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "const attempts = Math.max(1, k.config.closingWriteAttempts);",
        "const attempts = 1;",
      ),
  },
  {
    id: "MU-105",
    title:
      "R12 (revision 8): the adapter swallows a failed closing transaction and answers `closing` (the revision-7 `setClosing`)",
    file: "src/data/ports/ports-impl.ts",
    tests: [
      "tests/data/wipe-coordination.test.ts",
      "tests/data/wipe-closing.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        // The transaction failed (an abort, an error, the quota, a database that closed under it).\n",
        "        confirmed = true;\n",
      ),
  },
  {
    id: "MU-106",
    title:
      "R12 (revision 8): `wipe_imminent` is announced although the flag is not set (a tab acts on a flag that is not there)",
    file: "src/data/ports/ports-impl.ts",
    tests: ["tests/data/wipe-coordination.test.ts"],
    patch: (t) => sub(t, "      if (!confirmed) {", "      if (false) {"),
  },
  {
    id: "MU-107",
    title:
      "R12 (revision 8): a data layer that could not be loaded is answered `closing` by the static shim",
    file: "src/data/ports/deletion-ports.ts",
    tests: ["tests/data/ports.test.ts"],
    patch: (t) =>
      sub(
        t,
        'The wipe does not go on without one.\n          return "unconfirmed";',
        'The wipe does not go on without one.\n          return "closing";',
      ),
  },

  // ---- R11 (revision 8): the ordinary invalidation is bounded ----------------------------------------------------------------
  {
    id: "MU-108",
    title:
      "R11 (revision 8): the invalidation reads EVERY pending effect at once and builds the whole-population array (the revision-7 invalidation: 350 rows in one read)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/invalidation-bounded.test.ts"],
    patch: (t) =>
      sub(
        t,
        /const dropped = await clearOverlayDisplays\(\s*reader,\s*sink,\s*input\.window \?\? DATA_CONFIG\.queueWorkingSet,\s*\);/,
        `const every = await reader.list("pending_effects");
    const showing = every.filter((row) => row.display !== null);
    if (showing.length > 0)
      await sink.bulkPut(
        "pending_effects",
        showing.map((row) => ({ ...row, display: null })),
      );
    const dropped = showing.length;`,
      ),
  },
  {
    id: "MU-109",
    title:
      "R11 (revision 8): the windowed walk stops after the FIRST window (the overlays beyond it are never dropped)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: ["tests/data/invalidation-bounded.test.ts"],
    patch: (t) => sub(t, "if (rows.length < size) break;", "if (true) break;"),
  },
  {
    id: "MU-110",
    title:
      "R11 (revision 8): the walk reads a window and then does not write it back (the overlays stay; the count is still right)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: ["tests/data/invalidation-bounded.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      await sink.bulkPut(\n        "pending_effects",\n        showing.map((row) => ({ ...row, display: null })),\n      );\n      cleared += showing.length;',
        "      cleared += showing.length;",
      ),
  },

  // ---- R10 (revision 8): a failed write of an admitted invalidation ----------------------------------------------------------
  {
    id: "MU-111",
    title:
      "R10 (revision 8): a failed invalidation write is swallowed (`{when: event}`, no failure state, no retry, no recovery request: the revision-7 behaviour)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      return invalidationFailure(id, service, captured, reason, out.failure);",
        '      return { when: "event" };',
      ),
  },
  {
    id: "MU-112",
    title:
      "R10 (revision 8): the retained invalidation is never retried (the next step asks the server again and the position is never written)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) => sub(t, "if (retained !== null) {", "if (false) {"),
  },
  {
    id: "MU-113",
    title:
      "R10 (revision 8): the retained invalidation is retried under a FRESH stamp of the current state instead of the one it was admitted under (a stale invalidating response then hides a newer valid cache)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        return invalidate(id, service, held.captured, held.reason, gateSaw);",
        "        return invalidate(\n          id,\n          service,\n          service.capture(identity.epoch, {\n            requestSeq: capture.requestSeq,\n            ownershipToken: ownership?.token ?? null,\n            recoveryGeneration: capture.recoveryGeneration,\n            expectedPosition: capture.cursor,\n          }),\n          held.reason,\n          gateSaw,\n        );",
      ),
  },
  {
    id: "MU-114",
    title:
      "R10 (revision 8): the facts ignore the invalidation's durable failure streak (another tab, or a reload, shows the cache)",
    file: "src/data/plans/facts.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/ui-env.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "(sync.local_write_streaks[invalidateOperation(sync.cursor)] ?? 0) >\n            0,",
        "false,",
      ),
  },
  {
    id: "MU-115",
    title:
      "R10 (revision 8): the controller ignores the invalidation's fallback marker (a reload with the counter unwritable shows the cache)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (\n        marker === "marked" ||\n        heldInMemory(',
        "      if (\n        heldInMemory(",
      ),
  },
  {
    id: "MU-116",
    title:
      "R10 (revision 8): the cache gate ignores a stop on the write of an admitted invalidation (the database says valid, so the cache is open)",
    file: "src/data/model/status.ts",
    tests: [
      "tests/data/status.test.ts",
      "tests/data/engine-invalidation-failure.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        'inputs.cache === "unverified" ||\n    inputs.engine?.invalidating === true',
        'inputs.cache === "unverified"',
      ),
  },
  {
    id: "MU-117",
    title:
      "R10 (revision 8): the capture gate does not enforce a stop of the invalidation write (a wake after the stop sends a request nobody consented to)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "              : stopped(invalidation) &&\n                  input.liftedOperations?.includes(invalidation) !== true\n                ? invalidation\n                : null)();",
        "              : null)();",
      ),
  },
  {
    id: "MU-118",
    title:
      "R10 (revision 8): the engine offers the capture gate no stop of the invalidation write (the marker and the tab's memory are ignored)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        '          operation.startsWith("page:") ||\n          operation.startsWith(INVALIDATE_PREFIX),',
        '          operation.startsWith("page:"),',
      ),
  },
  {
    id: "MU-119",
    title:
      "R10 (revision 8): a quota failure of the invalidation write leaves no marker (a reload shows the cache while the write is outstanding)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        deps.markers,\n        service,\n        operation,\n        () => service.live,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
        "        undefined,\n        service,\n        operation,\n        () => service.live,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
      ),
  },
  {
    id: "MU-120",
    title:
      "R10 (revision 8): a successful invalidation does not clear its own failure streak (a stale streak keeps the cache hidden and counts towards a stop)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "local_write_streaks: onLocalWriteSuccess(\n          sync.local_write_streaks,\n          invalidateOperation(sync.cursor),\n        ),",
        "local_write_streaks: sync.local_write_streaks,",
      ),
  },
  {
    id: "MU-121",
    title:
      "R10 (revision 8): a failed invalidation write is counted under the PAGE's operation (a stop of the page's commit that the cache gate cannot tell from a failure to commit)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "return localFailure(id, service, failure, operation);",
        "return localFailure(\n      id,\n      service,\n      failure,\n      `page:$" +
          '{captured.expectedPosition ?? ""}`,\n    );',
      ),
  },
  {
    id: "MU-122",
    title:
      "R10 (revision 8): a stop of the invalidation write does not say so (`invalidating` is missing from the stopped state, so the cache gate opens)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        ...(operation.startsWith(INVALIDATE_PREFIX)\n          ? { invalidating: true as const }\n          : {}),",
        "",
      ),
  },
  {
    id: "MU-123",
    title:
      "R10 (revision 8): a page that commits does not clear the invalidation's streak at the old position",
    file: "src/data/plans/commit-page.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "local_write_streaks: onLocalWriteSuccess(\n          onLocalWriteSuccess(sync.local_write_streaks, operation),\n          // A page that commits moves the position on: an admitted invalidation's failures at the old one are moot (R10).\n          invalidateOperation(input.captured.expectedPosition),\n        ),",
        "local_write_streaks: onLocalWriteSuccess(sync.local_write_streaks, operation),",
      ),
  },

  // ---- R10 (revision 9): the hold, and a retry that lifts the stop without erasing what hides the cache ------------------------
  {
    id: "MU-127",
    title:
      "R10 (revision 9): an explicit retry of an admitted invalidation's write ERASES its streak, marker and memory stop before the write has succeeded (the revision-8 behaviour: the cache is shown again if connectivity goes or the persistence hold cannot verify the commit)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "if (operation?.startsWith(INVALIDATE_PREFIX) === true) {",
        "if (false) {",
      ),
  },
  {
    id: "MU-128",
    title:
      "R10 (revision 9): the first failed write of an admitted invalidation records no hold (the cache is hidden only by the counter, the marker or the stop: an offline wake with nothing durable shows it)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        '    addHold(service, operation);\n    if (failure.cause === "quota") {',
        '    if (failure.cause === "quota") {',
      ),
  },
  {
    id: "MU-129",
    title:
      "R10 (revision 9): an explicit retry lifts nothing (the stop is neither erased nor lifted: the retry can never write the invalidation)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "                lifted.set(\n                  memoryStopKey(service, operation),\n                  config.localWritePauseAfter,\n                );",
        "",
      ),
  },
  {
    id: "MU-130",
    title:
      "R10 (revision 9): the capture gate ignores a lifted stop (the revision-8 gate: only erasing the record lets a retry through)",
    file: "src/data/plans/sync-writers.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "              : stopped(invalidation) &&\n                  input.liftedOperations?.includes(invalidation) !== true\n                ? invalidation",
        "              : stopped(invalidation)\n                ? invalidation",
      ),
  },
  {
    id: "MU-131",
    title:
      "R10 (revision 9): a retry's cycle gets ONE attempt, not the bound of every local write (the streak stays above the bound, so the first failure stops it)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) => sub(t, "        stop = left <= 1;", "        stop = true;"),
  },
  {
    id: "MU-132",
    title:
      "R10 (revision 9): a start of the engine does not end a retry's cycle (a lifted stop outlives the run it was lifted in, so a wake after an ownership change attempts the write nobody asked for)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/controller-invalidation-hold.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      lifted.clear();\n      lastOnline = deps.online();",
        "      lastOnline = deps.online();",
      ),
  },
  {
    id: "MU-133",
    title:
      "R10 (revision 9): the controller ignores the engine's hold (only the facts and the marker are read: a memory-only failure shows the cache)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        /heldInMemory\(\s*current\.account,\s*current\.service\.incarnationId,\s*value\.invalidateOperation,\s*\)/,
        "false",
      ),
  },
  {
    id: "MU-134",
    title:
      "R10 (revision 9): a leader that detaches takes its holds with it (leadership lost: a failure only its memory held is forgotten and the cache is shown)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // Re-anchored in revision 14 (the detach function is bound to its attachment, one level less nested): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "        carry(next.engine);\n        leader = {};",
        "        leader = {};",
      ),
  },
  {
    id: "MU-135",
    title:
      "R10 (revision 9): the controller's hold is not keyed by POSITION (a hold of an older cursor hides a newer valid cache)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        hold.incarnationId === incarnationId &&\n        hold.operation === operation,",
        "        hold.incarnationId === incarnationId,",
      ),
  },
  {
    id: "MU-136",
    title:
      "R10 (revision 9): the controller's hold is keyed by position only, not by account and incarnation (another account's, or a deleted database's, hold hides this cache)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        hold.account === account &&\n        hold.incarnationId === incarnationId &&\n        hold.operation === operation,",
        "        hold.operation === operation,",
      ),
  },
  {
    id: "MU-137",
    title:
      "R10 (revision 9): the engine's state reports the hold only on the stop (the revision-8 state: an offline wake, a retry in flight and a paced wait say nothing)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    return service !== null && operationsOf(holds.keys(), service).length > 0\n      ? { ...plain, invalidating: true }\n      : plain;",
        "    return plain;",
      ),
  },
  {
    id: "MU-138",
    title:
      "R10 (revision 9): the status model hides the cache only for a STOPPED engine that says it is invalidating (the revision-8 gate)",
    file: "src/data/model/status.ts",
    tests: ["tests/data/status.test.ts"],
    patch: (t) =>
      sub(
        t,
        'inputs.cache === "unverified" ||\n    inputs.engine?.invalidating === true',
        'inputs.cache === "unverified" ||\n    (inputs.engine?.kind === "stopped" && inputs.engine.invalidating === true)',
      ),
  },
  {
    id: "MU-139",
    title:
      "R10 (revision 9): an explicit retry forgets the hold (the cache is shown from the retry until the write lands or fails again)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "                lifted.set(\n                  memoryStopKey(service, operation),",
        "                dropHolds(service);\n                lifted.set(\n                  memoryStopKey(service, operation),",
      ),
  },
  {
    id: "MU-140",
    title:
      "R10 (revision 9): a successful write does not end its hold (a stale hold hides every state of the engine for good)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    dropHolds(service, operation);\n    if (stoppedOperation === operation) stoppedOperation = null;",
        "    if (stoppedOperation === operation) stoppedOperation = null;",
      ),
  },
  {
    id: "MU-141",
    title:
      "R10 (revision 9): a capture does not forget the holds of positions the cache has moved past (a superseded hold keeps the engine's state saying it is invalidating)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    for (const operation of operationsOf(holds.keys(), service))\n      if (operation !== invalidateOperation(capture.cursor))\n        dropHolds(service, operation);",
        "",
      ),
  },
  {
    id: "MU-142",
    title:
      "R10 (revision 9): a stop restored from the durable streak, the marker or the tab's memory is not adopted as a hold (after a reload an offline wake no longer says the cache is invalidating)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (operation?.startsWith(INVALIDATE_PREFIX) === true)\n          addHold(service, operation);",
        "",
      ),
  },
  {
    id: "MU-143",
    title:
      "R10 (revision 9): a retained stamp of an older epoch is applied (and refused by the plan, which parks the engine) instead of being let go so the server is asked again under the current one",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/controller-invalidation-hold.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        held.incarnationId === service.incarnationId &&\n        held.captured.epoch === identity.epoch",
        "        held.incarnationId === service.incarnationId",
      ),
  },
  {
    id: "MU-144",
    title:
      "R10 (revision 9): a failed counter write leaves a retry's cycle lifted (the stop is recorded and every later wake still attempts the write)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      stop = true;\n      lifted.delete(key);\n      const recorded = recordStop(",
        "      stop = true;\n      const recorded = recordStop(",
      ),
  },
  {
    id: "MU-145",
    title:
      "R10 (revision 9): a quota failure of a lifted write leaves the cycle lifted (every later wake attempts it again)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      lifted.delete(memoryStopKey(service, operation));\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => service.live,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
        "      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => service.live,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
      ),
  },
  {
    id: "MU-146",
    title:
      "R10 (revision 9): the engine does not offer the lifted stops to the capture gate (a retry cannot proceed past a stop it did not erase)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      liftedOperations: operationsOf(lifted.keys(), service),\n",
        "",
      ),
  },
  {
    id: "MU-147",
    title:
      "R10 (revision 9): a wipe's `closing` gate ends the hold (a cache that is known to be invalid is shown again while a deletion is under way)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        'if (reason === "phase" || reason === "cache_status" || reason === "absent")\n      dropHolds(service);',
        'if (\n      reason === "phase" ||\n      reason === "cache_status" ||\n      reason === "absent" ||\n      reason === "closing"\n    )\n      dropHolds(service);',
      ),
  },
  {
    id: "MU-148",
    title:
      "R10 (revision 9): a gate that says the position is settled (the cache is already invalid, or in the snapshot phase) does not end the hold",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        'if (reason === "phase" || reason === "cache_status" || reason === "absent")\n      dropHolds(service);',
        'if (reason === "phase" || reason === "cache_status" || reason === "absent")\n      void 0;',
      ),
  },
  {
    id: "MU-149",
    title:
      "R10 (revision 9): the controller does not follow the engine's holds (a hold added or ended does not recompute the cache state until something else does)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    // Re-anchored in revision 13 (`followLeader` carries the subscriptions now): the mutated meaning is unchanged.
    patch: (t) =>
      sub(t, "      leader.engine?.invalidations.subscribe(recompute),\n", ""),
  },
  {
    id: "MU-150",
    title:
      "R10 (revision 9): the state is not republished when a hold is added or ended (it says so only from the next transition: a state-only reader sees an open cache in between)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        t,
        "  const republish = (): void => {\n    const current = store.get();",
        "  const republish = (): void => {\n    if (true as boolean) return;\n    const current = store.get();",
      ),
  },
  {
    id: "MU-151",
    title:
      "R10 (revision 9): a retry's lifted stop is offered for EVERY operation, not only the invalidation's (the capture write's and a page's stops can be lifted without being cleared)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-invalidation-failure.test.ts"],
    patch: (t) =>
      sub(
        sub(
          t,
          "      stopped(CAPTURE_OPERATION)\n        ? CAPTURE_OPERATION\n",
          "      stopped(CAPTURE_OPERATION) &&\n      input.liftedOperations?.includes(CAPTURE_OPERATION) !== true\n        ? CAPTURE_OPERATION\n",
        ),
        "            : stopped(pageOperation)\n              ? pageOperation\n",
        "            : stopped(pageOperation) &&\n                input.liftedOperations?.includes(pageOperation) !== true\n              ? pageOperation\n",
      ),
  },

  {
    id: "MU-154",
    title:
      "R10 (revision 9): an admitted invalidation whose FIRST commit cannot be verified (the persistence hold is unavailable) records no hold (the cache the server said is invalid is displayable while the hold cannot verify)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        addHold(service, invalidateOperation(captured.expectedPosition));\n      } else {",
        "      } else {",
      ),
  },
  {
    id: "MU-155",
    title:
      "R10 (revision 9): an admitted invalidation whose first commit cannot be verified is NOT retained (the server is asked again at every paced step, and the position is never written from the answer it already gave)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/engine-invalidation-failure.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        retained = {\n          account: service.account,\n          incarnationId: service.incarnationId,\n          captured,\n          reason,\n        };\n        addHold(service, invalidateOperation(captured.expectedPosition));",
        "        addHold(service, invalidateOperation(captured.expectedPosition));",
      ),
  },
  {
    id: "MU-156",
    title:
      "R13 (revision 10): an open database whose facts are not established reads as `unknown` (the revision-9 behaviour): the gate is open while the first read of the sync facts is pending or has failed, and the retained cache is shown",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-facts-gate.test.ts",
      "tests/data/cache-gate-facts.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        'if (value === null) return "unverified";',
        'if (value === null) return "unknown";',
      ),
  },
  {
    id: "MU-157",
    title:
      "R13 (revision 10): the status model does not hide an `unverified` cache: the gate opens although the display state is not established",
    file: "src/data/model/status.ts",
    tests: [
      "tests/data/status.test.ts",
      "tests/features/sync/screens.test.tsx",
      "tests/data/controller-facts-gate.test.ts",
    ],
    patch: (t) => sub(t, '    inputs.cache === "unverified" ||\n', ""),
  },
  {
    id: "MU-158",
    title:
      "R13 (revision 10): a failed read of the facts ERASES what the last good read said (the established state is dropped when the read fails): a state that read valid is hidden again until the read is made again",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        '} else if (read.status === "unavailable" && read.reason === "error") {\n          scheduleReread(service);',
        '} else if (read.status === "unavailable" && read.reason === "error") {\n          established = null;\n          scheduleReread(service);',
      ),
  },
  {
    id: "MU-159",
    title:
      "R13 (revision 10): a failed read of the facts is NOT made again (a failed live query has ended, so nothing would ever read the display state of that database again)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-facts-gate.test.ts",
      "tests/data/cache-gate-facts.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "          scheduleReread(service);\n        }\n        recompute();",
        "        }\n        recompute();",
      ),
  },
  {
    id: "MU-160",
    title:
      "R13 (revision 10): the paced re-read does not double its wait (a constant 250 ms hammering of a failing store)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "DATA_CONFIG.factsReadRetryMs * 2 ** rereadFailures,",
        "DATA_CONFIG.factsReadRetryMs,",
      ),
  },
  {
    id: "MU-161",
    title:
      "R13 (revision 10): the paced re-read's wait has no largest value (it doubles for as long as the failure lasts)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "DATA_CONFIG.factsReadRetryMaxMs,\n        DATA_CONFIG.factsReadRetryMs * 2 ** rereadFailures,",
        "Number.MAX_SAFE_INTEGER,\n        DATA_CONFIG.factsReadRetryMs * 2 ** rereadFailures,",
      ),
  },
  {
    id: "MU-162",
    title:
      "R13 (revision 10): a read that lands does not start the pacing over (the next failure waits where the last one left off)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "          rereadFailures = 0;\n          cancelReread();",
        "          cancelReread();",
      ),
  },
  {
    id: "MU-163",
    title:
      "R13 (revision 10): a new binding keeps what the previous one established (an account, an incarnation or a returning identity is shown on the strength of another database's facts)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    established = null;\n    rereadFailures = 0;\n    current = null;",
        "    rereadFailures = 0;\n    current = null;",
      ),
  },
  {
    id: "MU-164",
    title:
      "R13 (revision 10): the browser coming back (`online`, another tab's hint) does not make the failed read again at once",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) => sub(t, "    else rereadFacts();\n", "\n"),
  },
  {
    id: "MU-165",
    title:
      "R13 (revision 10): making the failed read again at once leaves the paced re-read standing (two reads for one failure)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        cancelReread();\n        watchFacts();",
        "        watchFacts();",
      ),
  },
  {
    id: "MU-166",
    title:
      "R13 (revision 10): the chip's last-synced time is blanked while the facts cannot be read",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-facts-gate.test.ts"],
    patch: (t) =>
      sub(
        t,
        "lastSyncedAt: established?.lastSyncedAt ?? null,",
        "lastSyncedAt: null,",
      ),
  },
  {
    id: "MU-167",
    title:
      "R14 (revision 10): the list page is not held to the approved bound (a caller can ask for any size, so one read can again return the whole list)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "Math.min(\n      DATA_CONFIG.listPage,\n      limit === undefined || Number.isNaN(limit)\n        ? DATA_CONFIG.listPage\n        : Math.floor(limit),\n    ),",
        "Math.min(\n      Number.MAX_SAFE_INTEGER,\n      limit === undefined || Number.isNaN(limit)\n        ? Number.MAX_SAFE_INTEGER\n        : Math.floor(limit),\n    ),",
      ),
  },
  {
    id: "MU-168",
    title:
      "R14 (revision 10): the list page never says there is a next page (the records beyond the first page are unreachable)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(t, "      rows.length === limit &&\n", "      false &&\n"),
  },
  {
    id: "MU-169",
    title:
      "R14 (revision 10): the list page ignores its cursor (every page is the first)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      ...(input.after === undefined || input.after === null\n        ? {}\n        : { after: input.after }),\n",
        "",
      ),
  },
  {
    id: "MU-170",
    title:
      "R14 (revision 10): a list under a parent does not hold the kind (rows of every kind under the parent are listed)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      input.parentId === undefined ? {} : { match: { kind: input.kind } };",
        "      {};",
      ),
  },
  {
    id: "MU-171",
    title:
      "R14 (revision 10): the list page reads one row more than the page (the look-ahead is read with it, and a batch exceeds the bound)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      ...match,\n      limit,\n    });",
        "      ...match,\n      limit: limit + 1,\n    });",
      ),
  },
  {
    id: "MU-172",
    title:
      "R14 (revision 10): the overlay of a page is read in ONE unbounded window (every effect of the shown resources in one batch)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        rows.map((row) => row.id),\n        DATA_CONFIG.queueWorkingSet,",
        "        rows.map((row) => row.id),\n        Number.MAX_SAFE_INTEGER,",
      ),
  },
  {
    id: "MU-173",
    title:
      "R14 (revision 10): the overlay lookup does not walk the rest of the resource a window ended in (changes beyond the first window of a resource are never folded)",
    file: "src/data/plans/overlay-windows.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(t, "    for (;;) {", "    for (let once = 0; once < 0; once += 1) {"),
  },
  {
    id: "MU-174",
    title:
      "R14 (revision 10): the overlay lookup drops only the resource a window ended in and not those before it (resources already complete are read again and counted twice)",
    file: "src/data/plans/overlay-windows.ts",
    tests: ["tests/data/resource-list.test.ts"],
    patch: (t) =>
      sub(
        t,
        "remaining = remaining.filter((id) => id > open);",
        "remaining = remaining.filter((id) => id !== open);",
      ),
  },
  {
    id: "MU-175",
    title:
      "R14 (revision 10): the fold's tie-break is lost (two changes with the same instant: the one delivered last wins, so the result depends on the window it came in)",
    file: "src/data/model/overlay.ts",
    tests: ["tests/data/overlay-fold.test.ts"],
    patch: (t) =>
      sub(
        t,
        "(effect.created_at === held.at && effect.local_id > held.id);",
        "(effect.created_at === held.at);",
      ),
  },
  {
    id: "MU-176",
    title:
      "R14 (revision 10): the fold takes the change DELIVERED last, not the latest by (created_at, local_id) (the result depends on the order the windows deliver them)",
    file: "src/data/model/overlay.ts",
    tests: ["tests/data/overlay-fold.test.ts"],
    patch: (t) =>
      sub(
        t,
        "  held === null ||\n  held === undefined ||",
        "  true ||\n  held === undefined ||",
      ),
  },
  {
    id: "MU-177",
    title:
      "R14 (revision 10): the hook drops its cursor (a screen cannot move past the first page)",
    file: "src/data/ui/react.tsx",
    tests: ["tests/data/hooks.test.tsx"],
    patch: (t) =>
      sub(
        t,
        "            ...(options.after === undefined ? {} : { after: options.after }),\n",
        "",
      ),
  },
  {
    id: "MU-182",
    title:
      "R15 (revision 11): the marker module reports no change another page makes (an already-open follower is never told of a fallback marker, so a cache only the marker says is invalid stays displayed)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-events.test.ts",
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "      if (feed === undefined) return () => undefined;\n      return feed.subscribe((key) => {",
        "      return feed.subscribe(() => {\n        return;\n      });\n      return feed.subscribe((key) => {",
      ),
  },
  {
    id: "MU-183",
    title:
      "R15 (revision 11): the controller does not listen to the marker feed (the marker is read only when something else makes it recompute, the review's schedule)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "    deps.markers?.subscribe(onMarkerChange) ?? (() => undefined),\n",
        "",
      ),
  },
  {
    id: "MU-184",
    title:
      "R15 (revision 11): the notification is trusted instead of prompting a check: the controller only recomputes, so a marker that goes opens the cache on the strength of the facts read before it, with no read begun after the change",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "      established = null;\n      rereadFailures = 0;\n      cancelReread();\n      watchFacts();\n      recompute();\n    };",
        "      recompute();\n    };",
      ),
  },
  {
    id: "MU-185",
    title:
      "R15 (revision 11): the controller does not drop what the facts established before it reads again (a pending or failed read leaves the cache displayable on the facts read before the marker went)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "      established = null;\n      rereadFailures = 0;\n      cancelReread();\n      watchFacts();",
        "      rereadFailures = 0;\n      cancelReread();\n      watchFacts();",
      ),
  },
  {
    id: "MU-186",
    title:
      "R15 (revision 11): the controller drops what was established but never reads again (the cache is hidden for good: fail closed with no way back after the marker goes)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "      cancelReread();\n      watchFacts();\n      recompute();\n    };",
        "      cancelReread();\n      recompute();\n    };",
      ),
  },
  {
    id: "MU-187",
    title:
      "R15 (revision 11): the controller looks again at ANY marker of the account, not the position's (another position's or an unrelated operation's marker hides the cache and re-reads the facts)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        "        : change.touches(bound.account, value.invalidateOperation);",
        "        : change.touches(bound.account);",
      ),
  },
  {
    id: "MU-188",
    title:
      "R15 (revision 11): a change answers for every account (another account's marker hides this account's cache and re-reads its facts)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-events.test.ts",
      "tests/data/controller-marker-follower.test.ts",
      "tests/data/cache-gate-marker.test.tsx",
    ],
    patch: (t) =>
      sub(
        t,
        /if \(parsed\.account !== account\) return false;\s+return operation === undefined \|\| parsed\.operation === operation;/,
        "return operation === undefined || key.endsWith(operation);",
      ),
  },
  {
    id: "MU-189",
    title:
      "R15 (revision 11): a cleared storage (a null key) is not reported (a marker that a `clear()` took away leaves the follower hidden on a record that is gone, or an unnoticed one displayed)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-events.test.ts",
      "tests/data/controller-marker-follower.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        if (key !== null && !key.startsWith(MARKER_PREFIX)) return;",
        "        if (key === null || !key.startsWith(MARKER_PREFIX)) return;",
      ),
  },
  {
    id: "MU-190",
    title:
      "R15 (revision 11): keys that are not markers are reported (any use of the origin's storage makes every open follower re-read its facts)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-events.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (key !== null && !key.startsWith(MARKER_PREFIX)) return;\n",
        "",
      ),
  },
  {
    id: "MU-191",
    title:
      "R15 (revision 11): the window feed does not check the storage area (a `sessionStorage` event is taken for a change of the markers)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-events.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (\n          area !== undefined &&\n          event.storageArea !== (area as unknown as Storage)\n        )\n          return;\n",
        "",
      ),
  },
  {
    id: "MU-192",
    title:
      "R15 (revision 11): the controller's marker subscription is never released (a disposed controller keeps listening, and keeps reading the facts of a database it no longer follows)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-marker-follower.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    deps.markers?.subscribe(onMarkerChange) ?? (() => undefined),\n",
        "    (deps.markers?.subscribe(onMarkerChange), () => undefined),\n",
      ),
  },
  {
    id: "MU-196",
    title:
      "R16 (revision 12): a notification of the identity already being worked on starts the work again (the identity is an event, not a key: the session publishes a new object at every evaluation, and each request it sends makes more of them)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
      "tests/data/profile.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    if (key === (work?.key ?? null)) return;\n",
        "    if (key === null) {\n      work = null;\n      return;\n    }\n",
      ),
  },
  {
    id: "MU-197",
    title:
      "R16 (revision 12): a failed task is never scheduled again (no back-off timer)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        if (!w.state.paused && live(w))\n          later(w, nextDelay(w.failures, random(), config));\n",
        "",
      ),
  },
  {
    id: "MU-198",
    title:
      "R16 (revision 12): a sustained failure never pauses the caller (it asks on the 60 s back-off for ever)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(t, "        if (!w.state.paused && live(w))", "        if (live(w))"),
  },
  {
    id: "MU-199",
    title:
      "R16 (revision 12): an unrecognised answer is counted as a failure of the network (three of them never pause the caller, and the sustained duration does)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        await record(w, { kind: outcome });",
        '        await record(w, { kind: "failure" });',
      ),
  },
  {
    id: "MU-200",
    title:
      'R16 (revision 12): `online` ends a pause that three unrecognised answers caused (a connectivity event is taken for the caller\'s own "Retry now")',
    file: "src/data/model/retry.ts",
    tests: [
      "tests/data/identity-retry-state.test.ts",
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "  if (state.unrecognised_streak >= config.unrecognisedPauseAfter) return null;\n",
        "",
      ),
  },
  {
    id: "MU-201",
    title:
      "R16 (revision 12): `online` does not end a pending back-off (the caller waits out its timer although the browser is reachable again)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        w.quiet = 0;\n        clear(w);\n      }\n      wake(w);\n    })();",
        "        w.quiet = 0;\n      }\n      wake(w);\n    })();",
      ),
  },
  {
    id: "MU-202",
    title:
      "R16 (revision 12): a wake that arrives while an attempt is under way is lost (a database that opens during the first attempt of a mirror that had nothing to write to is never noticed)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (w.running) w.again = true;\n    else consider();",
        "    if (w.running) return;\n    consider();",
      ),
  },
  {
    id: "MU-203",
    title:
      "R16 (revision 12): a quiet outcome (a read that was not sent) is counted as a failure of the network",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) => sub(t, '      case "quiet":\n', '      case "quiet_":\n'),
  },
  {
    id: "MU-204",
    title:
      "R16 (revision 12): a request the session closed (or a task with nothing to ask) is asked again on a timer instead of waiting for an event (the spin of the review, paced but unbounded)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        '      case "wait":\n        return;',
        '      case "wait":\n        later(w, 1_000);\n        return;',
      ),
  },
  {
    id: "MU-205",
    title:
      "R16 (revision 12): the durable entry is never read (a reload, a second tab and a paused database are all invisible to a page that starts)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        '    if (w.adopted === service) return "adopted";\n    try {',
        '    return "adopted";\n    try {',
      ),
  },
  {
    id: "MU-206",
    title:
      "R16 (revision 12): what the page counted before its database was open is not folded into the durable entry (the count restarts at the first write)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        now,\n        known,\n      });",
        "        now,\n      });",
      ),
  },
  {
    id: "MU-207",
    title:
      "R16 (revision 12): the durable entry is keyed by the caller only, not by the sign-in (an earlier epoch's pause holds a new epoch)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        / {4}`\$\{deps\.caller\}:\$\{identity\.epoch\}`;/,
        "    deps.caller;",
      ),
  },
  {
    id: "MU-208",
    title:
      "R16 (revision 12): an earlier sign-in's entries are not dropped when a later one records (every re-authentication leaves an entry behind)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        / {8}supersedes: `\$\{deps\.caller\}:`,\n {8}outcome,\n/,
        "        outcome,\n",
      ),
  },
  {
    id: "MU-209",
    title:
      "R16 (revision 12): a page that starts while a back-off is under way asks at once (a reload restarts the schedule, and a page reloaded every second asks every second)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (w.state.backing_off_since !== null) {",
        "        if (false) {",
      ),
  },
  {
    id: "MU-210",
    title:
      "R16 (revision 12): a success always writes its retry entry (the healthy path writes to the database on every read)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-task.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) => sub(t, "      isInitialReadRetry(known)", "      false"),
  },
  {
    id: "MU-211",
    title:
      "R16 (revision 12): a success does not learn what the database holds before deciding to write (a database that opened during the read is written to although there was nothing to clear)",
    file: "src/data/engine/identity-task.ts",
    tests: [
      "tests/data/identity-reads-session.test.ts",
      "tests/data/identity-task.test.ts",
    ],
    patch: (t) =>
      sub(t, '    if (outcome.kind === "success") await adopt(w);\n', ""),
  },
  {
    id: "MU-212",
    title:
      "R16 (revision 12): the status classifier calls nothing a failure of the network or the server (a 503 and a 429 count as unrecognised answers, and three of them pause the caller)",
    file: "src/data/ui/identity-reads.ts",
    tests: [
      "tests/data/identity-reads-adapters.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) => sub(t, "isFailureStatus(status) || status === 408", "false"),
  },
  {
    id: "MU-213",
    title:
      "R16 (revision 12): a request the session closed is a failure of the network (a revoked credential is retried on the back-off and counted against the caller)",
    file: "src/data/ui/identity-reads.ts",
    tests: [
      "tests/data/identity-reads-adapters.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        '      case "auth_state":\n        return { kind: "closed" };\n    }\n  }\n  // The body',
        '      case "auth_state":\n        return { kind: "failure" };\n    }\n  }\n  // The body',
      ),
  },
  {
    id: "MU-214",
    title:
      "R16 (revision 12): the status of an answer to `GET /me` is ignored (every answer that is not a body is a failure of the network, as the production adapter used to flatten it)",
    file: "src/data/ui/identity-reads.ts",
    tests: [
      "tests/data/identity-reads-adapters.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      return { kind: classifyStatus(response.status) };",
        '      return { kind: "failure" };',
      ),
  },
  {
    id: "MU-215",
    title:
      "R17 (revision 12): the profile source reads its persisted name when it starts and not when the database opens (an offline start, whose database opens a moment later, never shows the name verified for this epoch)",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/profile-hydration.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        deps.onService?.(show) ?? (() => undefined),\n",
        "        () => undefined,\n",
      ),
  },
  {
    id: "MU-216",
    title:
      "R17 (revision 12): a hydrating read is not checked against the identity after it returns (a name read for an epoch the identity has left is shown for it)",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/profile-hydration.test.ts"],
    patch: (t) => sub(t, "        !isCurrent(identity) ||\n", ""),
  },
  {
    id: "MU-217",
    title:
      "R17 (revision 12): a name persisted for ANY epoch is hydrated (an older or newer sign-in's name is shown)",
    file: "src/data/engine/profile-source.ts",
    tests: [
      "tests/data/profile-hydration.test.ts",
      "tests/data/profile.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "        if (persisted !== null && persisted.verified_epoch === identity.epoch)",
        "        if (persisted !== null)",
      ),
  },
  {
    id: "MU-218",
    title:
      "R17 (revision 12): a name verified before the database was open is never written to it when it opens (the persisted profile of a page that verified first is never there for the next offline start)",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/profile-hydration.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        await persist(identity, verified.username);",
        "        void verified;",
      ),
  },
  {
    id: "MU-219",
    title:
      "R17 (revision 12): a name already persisted for this epoch is written again whenever the database opens",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/profile-hydration.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        persisted === null ||\n        persisted.verified_epoch !== identity.epoch ||\n        persisted.username !== verified.username\n",
        "        true\n",
      ),
  },
  {
    id: "MU-220",
    title:
      "R17 (revision 12): the controller does not tell the profile source and the device mirror that the database opened (neither reads or writes until something else wakes it)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/profile-hydration.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    onService: (listener: () => void) => {\n      const offs = [\n        serviceStore.subscribe(listener),\n        lookedForStore.subscribe(listener),\n      ];\n      return () => {\n        for (const off of offs) off();\n      };\n    },",
        "    onService: () => () => undefined,",
      ),
  },
  // ---- revision 9 (the review of the eighth revision: R16 to R21) -------------------------------------------------------------
  {
    id: "MU-224",
    title:
      "R16 (revision 9): a caller does not wait for the page's look for the database (a page that starts asks before it can read the budget of an earlier page)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "=== true) {\n      w.waitingForBinding = true;",
        "=== true && false) {\n      w.waitingForBinding = true;",
      ),
  },
  {
    id: "MU-225",
    title:
      "R16 (revision 9): the controller never says the look for the database is pending (the production composition asks the profile before the database is attached)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      openServiceOf(account) === null &&\n      (lookedFor !== account || current !== null),",
        "      false,",
      ),
  },
  {
    id: "MU-226",
    title:
      "R16 (revision 9): the controller does not tell the readers that the look has finished (a page whose database does not exist waits for ever)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/identity-reads-session.test.ts",
      "tests/data/identity-task.test.ts",
    ],
    patch: (t) =>
      sub(t, "    lookedForStore.set(lookedForStore.get() + 1);\n", ""),
  },
  {
    id: "MU-227",
    title:
      "R16 (revision 9): every notification of the identity starts the look for the database again (the session publishes one at every evaluation, so the look never finishes)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (attaching?.account === identity.account_id) return;\n",
        "",
      ),
  },
  {
    id: "MU-228",
    title:
      "R16 (revision 9): what a page counted before its database appeared is not written when it does (a pause held only in memory is lost at the next reload)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      if (!sameReadRetry(w.state, stored.state)) await persist(w, service);",
        "      void persist;",
      ),
  },
  {
    id: "MU-229",
    title:
      "R16 (revision 9): the end of the page's look for a database wakes nothing (a caller that waited for it never asks)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      w.waitingForBinding = false;\n      wake(w);\n",
        "      w.waitingForBinding = false;\n",
      ),
  },
  {
    id: "MU-230",
    title:
      "R16 (revision 9): a budget that cannot be read is taken for an empty one (the caller asks although the database may say it is paused)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-task.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      return stands(w, service) ? "failed" : "stale";\n    }\n  };\n\n  const persist',
        '      w.adopted = service;\n      return "adopted";\n    }\n  };\n\n  const persist',
      ),
  },
  {
    id: "MU-231",
    title:
      "R16 (revision 9): persistReadRetry ignores what the page knew (the record keeps its own, and a paused memory is never written)",
    file: "src/data/plans/retry-state.ts",
    tests: [
      "tests/data/identity-retry-state.test.ts",
      "tests/data/identity-task.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      sync.read_retry_states[input.caller] ?? initialReadRetry(),\n      input.known,\n    );",
        "      sync.read_retry_states[input.caller] ?? initialReadRetry(),\n      initialReadRetry(),\n    );",
      ),
  },
  {
    id: "MU-232",
    title:
      "R16 (revision 9): persistReadRetry leaves an earlier sign-in's entries behind",
    file: "src/data/plans/retry-state.ts",
    tests: ["tests/data/identity-retry-state.test.ts"],
    patch: (t) =>
      sub(
        t,
        "          input.caller,\n          next,\n          input.supersedes,\n          isInitialReadRetry(next),",
        "          input.caller,\n          next,\n          undefined,\n          isInitialReadRetry(next),",
      ),
  },
  {
    id: "MU-233",
    title:
      "R18 (revision 9): the profile check does not look at the type of `username` (a number, a null or an object is a label)",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts", "tests/data/profile.test.ts"],
    patch: (t) =>
      sub(
        t,
        '  if (typeof username !== "string") return null;',
        "  if (username === undefined) return null;",
      ),
  },
  {
    id: "MU-234",
    title:
      "R18 (revision 9): the profile check does not compare `id` with the account (another account's profile is this account's label)",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts", "tests/data/profile.test.ts"],
    patch: (t) => sub(t, "  if (id !== account) return null;\n", ""),
  },
  {
    id: "MU-235",
    title:
      "R18 (revision 9): a `current` that is merely truthy marks the current row of the sessions list",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) =>
      sub(
        t,
        '    if (typeof flag !== "boolean") return null;',
        "    if (flag === undefined) return null;",
      ),
  },
  {
    id: "MU-236",
    title:
      "R18 (revision 9): two rows that say they are the current session are accepted (the first one is taken)",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) => sub(t, "      if (current !== null) return null;\n", ""),
  },
  {
    id: "MU-237",
    title:
      "R18 (revision 9): the device id is not checked (a null, a number or an object is a verified device)",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) =>
      sub(
        t,
        'typeof deviceId === "string" && deviceId.trim().length > 0',
        "deviceId !== undefined",
      ),
  },
  {
    id: "MU-238",
    title:
      "R18 (revision 9): a row of the sessions list that is not an object is skipped (a null element beside a valid current row is accepted)",
    file: "src/data/model/identity-bodies.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) =>
      sub(
        t,
        '    if (typeof row !== "object" || row === null) return null;',
        '    if (typeof row !== "object" || row === null) continue;',
      ),
  },
  {
    id: "MU-239",
    title:
      "R18 (revision 9): the profile source takes a body that is not a profile for a success (the task completes, the caller's history is cleared and it is never asked again)",
    file: "src/data/engine/profile-source.ts",
    tests: ["tests/data/identity-bodies.test.ts", "tests/data/profile.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      deps.trace?.emit("data.profile_rejected");\n      return "unrecognised";',
        '      deps.trace?.emit("data.profile_rejected");\n      return "done";',
      ),
  },
  {
    id: "MU-240",
    title:
      "R18 (revision 9): the profile adapter hands any 200 body to its consumer (no runtime check of the contract's body)",
    file: "src/data/ui/identity-reads.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) =>
      sub(
        t,
        '        return parseAccountIdentity(data, account) === null\n          ? { kind: "unrecognised" }\n          : { kind: "ok", value: data };',
        '        return { kind: "ok", value: data };',
      ),
  },
  {
    id: "MU-241",
    title:
      "R18 (revision 9): the device adapter takes the first truthy `current` row's `device_id` whatever it is (the revision-8 adapter: null, numeric and truthy values verify a device, a null row throws)",
    file: "src/data/ui/identity-reads.ts",
    tests: ["tests/data/identity-bodies.test.ts"],
    patch: (t) =>
      sub(
        t,
        '        const deviceId = parseCurrentDeviceId(result.value.sessions);\n        return deviceId === null\n          ? { kind: "unrecognised" }\n          : { kind: "ok", value: deviceId };',
        '        const deviceId = (\n          result.value.sessions as Array<{ current?: unknown; device_id?: string }>\n        ).find((row) => row.current)?.device_id;\n        return deviceId === undefined\n          ? { kind: "unrecognised" }\n          : { kind: "ok", value: deviceId };',
      ),
  },
  {
    id: "MU-242",
    title:
      "R19 (revision 9): the network/5xx class is `500` and `429` only (a gateway's `502` or `504` is an unrecognised answer: three stop ordinary sync and `online` does not resume it)",
    file: "src/data/model/retry.ts",
    tests: [
      "tests/data/engine-bookkeeping.test.ts",
      "tests/data/identity-retry-state.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "  status >= 500 || status === 429;",
        "  status === 500 || status === 429;",
      ),
  },
  {
    id: "MU-243",
    title:
      "R19 (revision 9): ordinary sync recognises `500` and `429` by status and sends every other 5xx to the unrecognised branch",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (isFailureStatus(status))\n",
        "    if (status === 500 || status === 429)\n",
      ),
  },
  {
    id: "MU-244",
    title:
      "R19 (revision 9): the specified `device_capacity` outcome is not decided from its code (it is an ordinary outage, retried and never shown)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (code === "device_capacity") {',
        '      if (code === "device_capacity" && false) {',
      ),
  },
  {
    id: "MU-245",
    title:
      "R20 (revision 9): what the page counted is not carried into the record (`known` is never passed: a failed or unverified write loses the clock of the outage)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) => sub(t, "      ...(known === null ? {} : { known }),\n", ""),
  },
  {
    id: "MU-246",
    title:
      "R20 (revision 9): a retry record that cannot be written is swallowed (the schedule goes on with no bound: 64 requests in an hour, and nothing in the record)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (out.kind === "failed")\n        return bookkeepingStop(service, READ_RETRY_OPERATION, out.failure);\n',
        "",
      ),
  },
  {
    id: "MU-247",
    title:
      "R20 (revision 9): a pause that only this page's memory holds is not enforced (the step asks again as if the record had been written)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (counted?.paused === true) {",
        "    if (counted?.paused === true && false) {",
      ),
  },
  {
    id: "MU-248",
    title:
      "R20 (revision 9): the count the database could not take is never kept (`unsaved` is not set: nothing bounds an outage that cannot be recorded)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      unsaved = {\n        account: service.account,\n        incarnationId: service.incarnationId,\n        state: counted,\n      };\n",
        "",
      ),
  },
  {
    id: "MU-249",
    title:
      "R20 (revision 9): a sizing record that cannot be written is ignored (the ladder cannot step, and the same page is asked for and allocated again at once)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        '    if (record.kind === "failed") {',
        '    if (record.kind === "failed" && false) {',
      ),
  },
  {
    id: "MU-250",
    title:
      "R20 (revision 9): a counter that cannot be written because the storage is full is stopped as a local write failure and not as the full storage it is",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        '    if (cause === "quota") {\n      setState({ kind: "stopped", cause: "storage_full" });\n      return { when: "event" };\n    }\n    lifted.delete(memoryStopKey(service, operation));\n    const recorded = recordStop(',
        "    lifted.delete(memoryStopKey(service, operation));\n    const recorded = recordStop(",
      ),
  },
  {
    id: "MU-251",
    title:
      "R20 (revision 9): the stop of a counter that cannot be written is never recorded in the account's marker (a reload sends the request again)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      deps.markers,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => holdMemory(memoryStopKey(service, operation)) },\n    );",
        "      undefined,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => holdMemory(memoryStopKey(service, operation)) },\n    );",
      ),
  },
  {
    id: "MU-252",
    title:
      "R20 (revision 9): the engine does not offer the retry-record stop of its markers to the capture gate (a reload and every later wake ignore it)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "          operation === READ_RETRY_OPERATION ||\n          operation === SIZING_OPERATION ||",
        "          operation === SIZING_OPERATION ||",
      ),
  },
  {
    id: "MU-253",
    title:
      "R20 (revision 9): the engine does not offer the sizing stop of its markers to the capture gate",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "          operation === READ_RETRY_OPERATION ||\n          operation === SIZING_OPERATION ||",
        "          operation === READ_RETRY_OPERATION ||",
      ),
  },
  {
    id: "MU-254",
    title:
      "R20 (revision 9): the capture gate does not enforce a stop of the retry record",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(t, "        : stopped(READ_RETRY_OPERATION)\n", "        : false\n"),
  },
  {
    id: "MU-255",
    title:
      "R20 (revision 9): the capture gate does not enforce a stop of the sizing record",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(t, "          : stopped(SIZING_OPERATION)\n", "          : false\n"),
  },
  {
    id: "MU-256",
    title:
      "R20 (revision 9): the caller's own Retry now does not end a pause that only this page counted",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "              // What only this page counted ends the way the record's does.\n              unsaved = null;\n",
        "",
      ),
  },
  {
    id: "MU-257",
    title:
      "R20 (revision 9): `online` does not end a pause by duration that only this page counted",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (unsaved !== null && resumeOnOnline(unsaved.state, config) !== null)\n      unsaved = null;\n",
        "",
      ),
  },
  {
    id: "MU-258",
    title:
      "R20 (revision 9): a page that applies does not clear what only the page counted (the next outage inherits the clock of an earlier one)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      unverified = 0;\n      unsaved = null;\n      behind = value.hasMore;",
        "      unverified = 0;\n      behind = value.hasMore;",
      ),
  },
  {
    id: "MU-259",
    title:
      "Revision 9 (found by the tests of R19): a wake that arrives while a sync step runs costs the step its own schedule (a back-off, an idle poll or a retry that the step decided on is never made, and nothing wakes the engine again)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        sub(
          t,
          '      deps.trace?.emit("data.sync_tick", { why, coalesced: true });\n      // Remembered, not dropped (R22)',
          '      deps.trace?.emit("data.sync_tick", { why, coalesced: true });\n      (globalThis as { __lostWake?: boolean }).__lostWake = true;\n      // Remembered, not dropped (R22)',
        ),
        '      schedule(id, next);\n    } catch {\n      // A defect in a step must never kill the loop silently or spin: stop visibly.\n      deps.trace?.emit("data.sync_step_failed");',
        '      if ((globalThis as { __lostWake?: boolean }).__lostWake) {\n        (globalThis as { __lostWake?: boolean }).__lostWake = false;\n        return;\n      }\n      schedule(id, next);\n    } catch {\n      // A defect in a step must never kill the loop silently or spin: stop visibly.\n      deps.trace?.emit("data.sync_step_failed");',
      ),
  },
  {
    id: "MU-260",
    title:
      "Revision 9 (found by the tests of R19): the same in the dispatcher (a draft's back-off after a failed send is never scheduled when a wake arrived during the step)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-dispatcher.test.ts"],
    patch: (t) =>
      sub(
        sub(
          t,
          "    if (busy) {\n",
          "    if (busy) {\n      (globalThis as { __lostWake?: boolean }).__lostWake = true;\n",
        ),
        '      schedule(id, next);\n    } catch {\n      // A defect in a step must never kill the loop silently or spin: stop visibly.\n      deps.trace?.emit("data.outbox_step_failed");',
        '      if ((globalThis as { __lostWake?: boolean }).__lostWake) {\n        (globalThis as { __lostWake?: boolean }).__lostWake = false;\n        return;\n      }\n      schedule(id, next);\n    } catch {\n      // A defect in a step must never kill the loop silently or spin: stop visibly.\n      deps.trace?.emit("data.outbox_step_failed");',
      ),
  },
  {
    id: "MU-261",
    title:
      "R21 (revision 9): the fold keeps the LATEST draft of a target as its earliest (a draft is held back by a LATER draft, or sent ahead of an earlier one)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      row.created_seq < this.earliest.created_seq",
        "      row.created_seq > this.earliest.created_seq",
      ),
  },
  {
    id: "MU-262",
    title:
      "R21 (revision 9): the fold keeps the EARLIEST draft of a target as its latest (a new draft waits on the wrong draft)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "row.created_seq > this.latest.created_seq",
        "row.created_seq < this.latest.created_seq",
      ),
  },
  {
    id: "MU-263",
    title:
      "R21 (revision 9): the fold keeps the LOWEST base as the floor of the version record (the record falls below what a standing draft is built on)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "(row.bases[this.id] as number) > (this.floor.bases[this.id] as number)",
        "(row.bases[this.id] as number) < (this.floor.bases[this.id] as number)",
      ),
  },
  {
    id: "MU-264",
    title:
      "R21 (revision 9): the fold counts settled drafts (an acknowledged, rejected or superseded draft holds back, or is waited on)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) => sub(t, "    if (isTerminal(row)) return;\n", ""),
  },
  {
    id: "MU-265",
    title:
      "R21 (revision 9): the stand-ins for the other drafts leave out the draft with the highest base (the version record is recomputed too low)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    for (const row of [this.latest, this.floor])",
        "    for (const row of [this.latest])",
      ),
  },
  {
    id: "MU-266",
    title:
      "R21 (revision 9): a windowed walk stops after its first window (a population larger than a window is only partly met: the queue is not fully reachable)",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) => sub(t, "    if (rows.length < size) return;", "    return;"),
  },
  {
    id: "MU-267",
    title:
      "R21 (revision 9): a windowed walk asks the store for the whole population in every window (no read is bounded)",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    const rows = await reader.byIndex(store, index, key, size, at * size);",
        "    const rows = await reader.byIndex(store, index, key);",
      ),
  },
  {
    id: "MU-268",
    title:
      "R21 (revision 9): the earliest draft of a target is read again for every candidate that shares it (the whole population once per candidate: 50,200 rows for one window)",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) => sub(t, "      known.set(id, earliest);\n", ""),
  },
  {
    id: "MU-269",
    title:
      "R21 (revision 9): the cascade's own members are counted among the other drafts that stand on a version (a discarded draft keeps the record up)",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (!exclude.has(row.local_id)) fold.add(row);",
        "        fold.add(row);",
      ),
  },
  {
    id: "MU-270",
    title:
      "R21 (revision 9): a draft that is paused and also in a defaults review is counted twice among those that need the person",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (isSendableStatus(row.status) && row.review_block === null)\n          needsPerson += 1;",
        "        if (isSendableStatus(row.status)) needsPerson += 1;",
      ),
  },
  {
    id: "MU-271",
    title:
      "R21 (revision 9): the queue is held from the NEWEST defaults review and not the oldest (drafts behind an earlier review are sent)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "holdFrom === null || row.created_seq < holdFrom",
        "holdFrom === null || row.created_seq > holdFrom",
      ),
  },
  {
    id: "MU-272",
    title:
      "R21 (revision 9): a back-off that the dispatcher itself set (a Retry-After, a stop) is ignored when the waiting drafts are counted",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "          blocked.get(row.local_id) ?? durableNotBefore(row, DATA_CONFIG);",
        "          durableNotBefore(row, DATA_CONFIG);",
      ),
  },
  {
    id: "MU-273",
    title:
      "R21 (revision 9): Retry now for every retrying draft skips those backing off (only the paused ones are resumed)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        'for (const state of ["paused", "backing_off"] as const) {',
        'for (const state of ["paused"] as const) {',
      ),
  },
  {
    id: "MU-274",
    title:
      "R21 (revision 9): Retry now for every retrying draft also resumes drafts that are no longer in flight",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) => sub(t, '            match: { status: "in_flight" },\n', ""),
  },
  {
    id: "MU-275",
    title:
      "R21 (revision 9): a singleton plan's streaming `apply` is never run (the streamed writes of Retry now are lost)",
    file: "src/data/plans/builders.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "            return (spec.apply as NonNullable<typeof spec.apply>)(sink, {\n              sync: reads.sync,\n              reads: reads.reads,\n              input,\n              result: decision.result,\n              reader,\n            });",
        "            return decision.result;",
      ),
  },
  {
    id: "MU-276",
    title:
      "R21 (revision 9): the conflict inbox keeps one draft too few (it cannot say there is more)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    const keep = input.limit + 1;",
        "    const keep = input.limit;",
      ),
  },
  {
    id: "MU-277",
    title:
      "R21 (revision 9): the conflict inbox does not keep the OLDEST drafts when it trims (a newer review is shown before an older one)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      found.sort((a, b) => a.draft.created_seq - b.draft.created_seq);\n",
        "",
      ),
  },
  {
    id: "MU-278",
    title:
      "R21 (revision 9): the summary does not count a held acknowledgement that has no outcome to show (`unavailable_outcome`)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (row.held_pending_cache || row.unavailable_outcome) held += 1;",
        "        if (row.held_pending_cache) held += 1;",
      ),
  },
  {
    id: "MU-279",
    title:
      "R21 (revision 9): the drafts that target a resource the cache holds are read although none of them can be projected",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (base === undefined)\n      await walkIndex(",
        "    if (true as boolean)\n      await walkIndex(",
      ),
  },
  {
    id: "MU-283",
    title:
      "R20 (revision 9): a retry record dropped because its stamp no longer stands (the identity or the epoch moved on) is ignored and its count is kept (a count that belonged to an earlier sign-in pauses a later one)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-bookkeeping.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (out.kind === "dropped" && out.reason !== "unverified")\n        return dropped(out.reason);\n      unsaved = {',
        "      unsaved = {",
      ),
  },
  {
    id: "MU-284",
    title:
      "R22 (revision 10): the sync engine remembers no wake that arrives while a step runs (an identity that moved during a decode, a connectivity change, a retry: the engine sleeps until some other event)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (why === "wake") wakes.notify(eligibility());\n      else if (why !== "timer" && why !== "now" && why !== "start") {\n        wakes.signal();\n        if (why === "retry") retried = true;\n      }\n',
        "\n",
      ),
  },
  {
    id: "MU-285",
    title:
      "R22: the sync engine remembers the wake but does not evaluate again when the step left nothing scheduled",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (woken && (retry || !stopped)) return { when: "now" };\n',
        "      if (woken && (retry || !stopped)) return next;\n",
      ),
  },
  {
    id: "MU-286",
    title:
      "R22: the sync engine lets a wake that arrived during a step end the step own deadline (a back-off after a failure is skipped and the request is asked again at once)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    const retry = retried;\n    receiptNudged = false;\n    retried = false;\n",
        '    const retry = retried;\n    receiptNudged = false;\n    retried = false;\n    if (woken) return { when: "now" };\n',
      ),
  },
  {
    id: "MU-287",
    title:
      "R22: every notification counts as news, whether or not what a step reads has changed (a republished identity feeds itself: a request that makes the session publish is asked again)",
    file: "src/data/engine/pending-wake.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) => sub(t, "      if (signature === seen) return;\n", ""),
  },
  {
    id: "MU-288",
    title:
      "R22: the eligibility of the sync engine does not include the epoch of the identity (a new sign-in during a step is not news)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      identity?.epoch,\n      deps.online(),\n    ].join("|");',
        '      deps.online(),\n    ].join("|");',
      ),
  },
  {
    id: "MU-289",
    title:
      "R22: the eligibility of the sync engine does not include connectivity (going offline during a step is not news)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      identity?.epoch,\n      deps.online(),\n    ].join("|");',
        '      identity?.epoch,\n    ].join("|");',
      ),
  },
  {
    id: "MU-290",
    title:
      "R22: the eligibility of the sync engine does not include the liveness of the service (a database that ended during a step is not news)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) => sub(t, "      service?.live,\n", ""),
  },
  {
    id: "MU-291",
    title:
      "R22: a receipt nudge that arrives while a sync step runs is dropped (the schedule of the step clears the timer it set)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (busy) {\n          receiptNudged = true;\n          return;\n        }",
        "        if (busy) return;",
      ),
  },
  {
    id: "MU-292",
    title:
      "R22: a receipt nudge shortens a back-off (the request that failed is asked again after the receipt pace, not at its own deadline)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      next.ms > config.syncReceiptMs &&\n      store.get().kind === "idle"\n',
        "      next.ms > config.syncReceiptMs\n",
      ),
  },
  {
    id: "MU-293",
    title:
      "R22: an online event during a sync step is not remembered (the resumed caller waits for some other event)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        'why !== "timer" && why !== "now" && why !== "start"',
        'why !== "timer" && why !== "now" && why !== "start" && why !== "online"',
      ),
  },
  {
    id: "MU-294",
    title: "R22: a Retry now and a nudge during a sync step are not remembered",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        'why !== "timer" && why !== "now" && why !== "start"',
        'why !== "timer" && why !== "now" && why !== "start" && why !== "retry" && why !== "nudge"',
      ),
  },
  {
    id: "MU-295",
    title:
      "R22: a receipt nudge of a run that ended survives into the next run (its first step is shortened to the receipt pace)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      receiptNudged = false;\n      retried = false;\n",
        "      retried = false;\n",
      ),
  },
  {
    id: "MU-296",
    title:
      "R22: a step does not begin with a clean latch (a wake that was pending before it is carried into it)",
    file: "src/data/engine/pending-wake.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    begin(signature) {\n      pending = false;\n      seen = signature;",
        "    begin(signature) {\n      seen = signature;",
      ),
  },
  {
    id: "MU-297",
    title:
      "R22 (dispatcher): an explicit act that arrives while a step runs (a save, online, Retry now) is not remembered: a draft saved during an empty read is never sent",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        'if (why === "signal") wakes.signal();',
        'if (why === "signal") void 0;',
      ),
  },
  {
    id: "MU-298",
    title:
      "R22 (dispatcher): a notification that arrives while a step runs is not remembered (an identity, compatibility or connectivity change is missed)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        'else if (why === "notified") wakes.notify(eligibility());',
        'else if (why === "notified") void 0;',
      ),
  },
  {
    id: "MU-299",
    title:
      "R22 (dispatcher): the schedule of the step is kept whatever arrived while it ran (the lost wake of the review)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (!wakes.take()) return next;",
        "    if (wakes.take() || true) return next;",
      ),
  },
  {
    id: "MU-300",
    title:
      "R22 (dispatcher): the honoured wake does not begin the queue again from its oldest draft (a scan that was continuing goes on from where it stopped)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '    // The wake began the queue again, as `wake()` says: from the oldest draft, with the rescan back-off forgotten.\n    scanAfter = undefined;\n    fruitlessCycles = 0;\n    return { when: "now" };',
        '    return { when: "now" };',
      ),
  },
  {
    id: "MU-301",
    title:
      "R22 (dispatcher): the eligibility does not include the API-compatibility fact (a queue that must pause is not told)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      deps.online(),\n      deps.compat.get().status,\n    ].join("|");',
        '      deps.online(),\n    ].join("|");',
      ),
  },
  {
    id: "MU-302",
    title:
      "R22 (dispatcher): the eligibility does not include the epoch of the identity (a draft left behind by a new sign-in)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      identity?.epoch,\n      deps.online(),\n      deps.compat.get().status,",
        "      deps.online(),\n      deps.compat.get().status,",
      ),
  },
  {
    id: "MU-303",
    title:
      "R22 (dispatcher): a save is treated as a notification (it counts only if what a step reads changed, which a save does not)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        'void tick(generation, "signal");',
        'void tick(generation, "notified");',
      ),
  },
  {
    id: "MU-304",
    title:
      "R22 (dispatcher): online and Retry now are treated as notifications (they change nothing a step reads)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(t, 'void tick(id, "signal");', 'void tick(id, "notified");'),
  },
  {
    id: "MU-305",
    title: "R22 (dispatcher): the eligibility does not include connectivity",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      identity?.epoch,\n      deps.online(),\n      deps.compat.get().status,",
        "      identity?.epoch,\n      deps.compat.get().status,",
      ),
  },
  {
    id: "MU-306",
    title:
      "R22 (dispatcher): the eligibility does not include the liveness of the service",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) => sub(t, "      service?.live,\n", ""),
  },
  {
    id: "MU-307",
    title:
      "R21 (revision 10): the stopped drafts are looked up in ONE read, whatever the window (501 headers in a single batch)",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "  const size = Math.max(1, window);\n  const out: LocalId[] = [];",
        "  const size = Math.max(1, ids.length);\n  const out: LocalId[] = [];",
      ),
  },
  {
    id: "MU-308",
    title:
      "R21 (revision 10): a stop that names a draft that no longer exists stops a draft that is not there",
    file: "src/data/plans/bounded-reads.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      if (row) out.push(row.local_id);",
        '      out.push(row?.local_id ?? "gone");',
      ),
  },
  {
    id: "MU-309",
    title:
      "R21 (revision 10): the window of the saved changes of a new resource keeps the NEWEST (the create that introduces the resource is dropped from it)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "(held) => held.created_seq > row.created_seq,",
        "(held) => held.created_seq < row.created_seq,",
      ),
  },
  {
    id: "MU-310",
    title:
      "R21 (revision 10): the exact size of the population does not count the headers before the cursor",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    this.total += 1;\n    if (row.created_seq <= this.after) return;",
        "    if (row.created_seq <= this.after) return;\n    this.total += 1;",
      ),
  },
  {
    id: "MU-311",
    title:
      "R21 (revision 10): a window never says that more follow (the changes beyond the first 100 are unreachable)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "return this.later > this.kept.length && last !== undefined",
        "return false && last !== undefined",
      ),
  },
  {
    id: "MU-312",
    title:
      "R21 (revision 10): a window that exactly fills the population says that more follow (an empty next window)",
    file: "src/data/model/related.ts",
    tests: [
      "tests/data/related-fold.test.ts",
      "tests/data/outbox-bounded-reads.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "return this.later > this.kept.length && last !== undefined",
        "return this.later >= this.kept.length && last !== undefined",
      ),
  },
  {
    id: "MU-313",
    title:
      "R21 (revision 10): the merged read walks the drafts of a resource the cache holds",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    if (base === undefined)\n      await walkIndex(",
        "    await walkIndex(",
      ),
  },
  {
    id: "MU-314",
    title:
      "R21 (revision 10): the merged read counts every draft of the resource, settled ones included",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        '(draft.status === "queued" || draft.status === "in_flight") &&\n            draft.target_resource_ids.includes(input.id)',
        "draft.target_resource_ids.includes(input.id)",
      ),
  },
  {
    id: "MU-315",
    title:
      "R21 (revision 10): the merged read has no window (every saved change of a new resource is collected and its bodies joined)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "new OldestDrafts(WINDOW, input.after ?? null)",
        "new OldestDrafts(Number.MAX_SAFE_INTEGER, input.after ?? null)",
      ),
  },
  {
    id: "MU-316",
    title:
      "R21 (revision 10): the merged read says how many changes it returned, not how many there are",
    file: "src/data/model/overlay.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "createsTotal: window.total ?? creates.length,",
        "createsTotal: creates.length,",
      ),
  },
  {
    id: "MU-317",
    title:
      "R21 (revision 10): the hook does not pass the cursor on (every window is the first)",
    file: "src/data/ui/react.tsx",
    tests: ["tests/data/hooks.test.tsx"],
    patch: (t) =>
      sub(
        t,
        "            ...(after === undefined || after === null ? {} : { after }),\n",
        "",
      ),
  },
  {
    id: "MU-318",
    title:
      "R21 (revision 10): the hook does not read again when the cursor moves (a mounted screen stays on its first window)",
    file: "src/data/ui/react.tsx",
    tests: ["tests/data/hooks.test.tsx"],
    patch: (t) => sub(t, "    [id, after],\n  );", "    [id],\n  );"),
  },
  {
    id: "MU-319",
    title:
      "R21 (revision 10): the merged read ignores the cursor (every window is the first)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-bounded-reads.test.ts"],
    patch: (t) =>
      sub(
        t,
        "new OldestDrafts(WINDOW, input.after ?? null)",
        "new OldestDrafts(WINDOW, null)",
      ),
  },
  {
    id: "MU-320",
    title:
      "R16 (revision 10): a look that FAILS is taken for an answer (the identity readers are released, and a remount starts a fresh in-memory budget over a database that may hold a durable pause)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "attaching = null;\n      lookAgain(account);",
        "attaching = null;\n      finishedLooking(account);",
      ),
  },
  {
    id: "MU-321",
    title:
      "R16 (revision 10): a look that failed is started again by every notification of the identity (the session publishes one at every evaluation)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(t, "    if (lookFailed === identity.account_id) return;\n", ""),
  },
  {
    id: "MU-322",
    title:
      "R16 (revision 10): the look is made again at a constant pace (250 ms for ever) instead of backing off",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "DATA_CONFIG.factsReadRetryMs * 2 ** lookFailures,",
        "DATA_CONFIG.factsReadRetryMs,",
      ),
  },
  {
    id: "MU-323",
    title:
      "R16 (revision 10): the pace of the look has no ceiling (it doubles for ever)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    const wait = Math.min(\n      DATA_CONFIG.factsReadRetryMaxMs,\n      DATA_CONFIG.factsReadRetryMs * 2 ** lookFailures,\n    );",
        "    const wait = DATA_CONFIG.factsReadRetryMs * 2 ** lookFailures;",
      ),
  },
  {
    id: "MU-324",
    title:
      "R16 (revision 10): the timer of a failed look is not cancelled when the account is left or the controller is disposed",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    if (lookTimer !== null) clearTimer(lookTimer);\n    lookTimer = null;",
        "    lookTimer = null;",
      ),
  },
  {
    id: "MU-325",
    title:
      "R16 (revision 10): the failure of the look at one account is remembered against the next account the page shows (and against this one when it returns: its look is never started)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "    if (lookFailed !== null) forgetFailedLook();\n    void attach(identity.account_id);",
        "    void attach(identity.account_id);",
      ),
  },
  {
    id: "MU-326",
    title:
      "R16 (revision 10): a look that lands does not end the failure it follows (a later notification of the same identity never looks again)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(t, "    if (lookFailed === account) forgetFailedLook();\n", ""),
  },
  {
    id: "MU-327",
    title:
      "R16 (revision 10): a failed look is not visible to the screens (the summary does not say it could not be read)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      summary.set(ERROR);\n      recompute();\n      if (attaching?.id === mine)",
        "      recompute();\n      if (attaching?.id === mine)",
      ),
  },
  {
    id: "MU-328",
    title:
      "R16 (revision 10): online and the hint of another tab do not look again after a failed look",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "if (identity !== null && (current === null || !current.service.live))\n      void attach(identity.account_id);",
        "if (\n      identity !== null &&\n      (current === null || !current.service.live) &&\n      lookFailed === null\n    )\n      void attach(identity.account_id);",
      ),
  },
  {
    id: "MU-329",
    title: "R16 (revision 10): the person Try again (retryLoad) does not look",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env-look.test.ts",
      "tests/data/identity-reads-session.test.ts",
    ],
    patch: (t) =>
      sub(
        t,
        "      if (identity !== null) void attach(identity.account_id);\n    },\n    showNextQueue",
        "      if (identity !== null) void 0;\n    },\n    showNextQueue",
      ),
  },
  {
    id: "MU-332",
    title:
      "R22 (revision 10, found by E-C6): a wake that arrives while a step runs is evaluated even after the step decided a STOP (the state a landed invalidation leaves with no recovery job, stopped / no_recovery, is replaced by the gate's word, waiting / cache_not_valid, depending on how many wakes arrived)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (woken && (retry || !stopped)) return { when: "now" };',
        '      if (woken) return { when: "now" };',
      ),
  },
  {
    id: "MU-333",
    title:
      "R22 (revision 10): an explicit Retry now that arrives while a step decides a stop is not evaluated (the person lifted the stop and nothing looks at it)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (woken && (retry || !stopped)) return { when: "now" };',
        '      if (woken && !stopped) return { when: "now" };',
      ),
  },
  {
    id: "MU-334",
    title:
      "R22 (revision 10): a receipt nudge during a step that decided a stop is looked at after the receipt pace (an engine that is stopped asks, and the stop it left is replaced by the gate's word)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      if (receipt && !stopped)\n        return { when: "after", ms: config.syncReceiptMs };',
        '      if (receipt) return { when: "after", ms: config.syncReceiptMs };',
      ),
  },
  {
    id: "MU-335",
    title:
      "R22 (revision 10): the explicit retry of a run that ended survives into the next run (its first step evaluates a stop it decided)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/pending-wake.test.ts"],
    patch: (t) =>
      sub(
        t,
        "      receiptNudged = false;\n      retried = false;\n",
        "      receiptNudged = false;\n",
      ),
  },
  // ---- R23 (revision 11): an ordinary wake does not end a back-off's deadline or the blocking capacity stop ----------------------
  {
    id: "MU-336",
    title:
      "R23 (revision 11): a notification and an immediate nudge start a step whatever the engine is waiting for (five notifications after a Retry-After of 60 s make six requests in a second, and a capacity stop is asked again by them)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        '      case "nudge":\n        return !holding();',
        '      case "nudge":\n        return true;',
      ),
  },
  {
    id: "MU-337",
    title:
      "R23 (revision 11): `online` leaves the blocking capacity stop (the event is an automatic retry of an answer that has no automatic retry)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        '        return !(holding() && store.get().kind === "stopped");',
        "        return true;",
      ),
  },
  {
    id: "MU-338",
    title:
      "R23 (revision 11): `online` is refused while a back-off stands (the allowed act that ends a back-off, one request each, no longer works)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        '        return !(holding() && store.get().kind === "stopped");',
        "        return !holding();",
      ),
  },
  {
    id: "MU-339",
    title:
      "R23 (revision 11): a receipt nudge replaces the timer that holds a back-off with the receipt pace (the established 60 s delay becomes 2 s)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        "        if (holding()) return;\n        clearTimer();",
        "        clearTimer();",
      ),
  },
  {
    id: "MU-340",
    title:
      "R23 (revision 11): a held condition outlives its service (a back-off or a capacity stop decided for a database that has ended or been replaced still refuses the next wake)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        "isHeld(store.get()) && heldUnder !== null && heldUnder === serviceKey();",
        "isHeld(store.get());",
      ),
  },
  {
    id: "MU-341",
    title:
      "R23 (revision 11): the service a hold was decided under is never recorded (no condition is ever held: every ordinary wake is admitted)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        "if (isHeld(shown)) heldUnder = serviceKey();",
        "if (isHeld(shown)) heldUnder = null;",
      ),
  },
  {
    id: "MU-342",
    title:
      "R23 (revision 11): the blocking capacity stop is not a held condition (a notification, a nudge or a receipt asks the server again)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        '(state.kind === "stopped" && state.cause === "device_capacity")',
        "false",
      ),
  },
  {
    id: "MU-343",
    title:
      "R23 (revision 11): a back-off is not a held condition (a notification, a nudge or a receipt ends the server's Retry-After)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/wake-admission.test.ts"],
    patch: (t) =>
      sub(
        t,
        'const isHeld = (state: EngineState): boolean =>\n    state.kind === "backing_off" ||',
        "const isHeld = (state: EngineState): boolean =>\n    false ||",
      ),
  },
  // ---- R16 (revision 11): what a look found belongs to one binding ---------------------------------------------------------------
  {
    id: "MU-344",
    title:
      "R16 (revision 11): the answer of a look outlives the binding it described (the service closes and the sign-in moves on: the readers ask without reading the durable budget of the reopened database)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-binding.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    lookedFor = null;\n    serviceStore.set(null);",
        "    serviceStore.set(null);",
      ),
  },
  {
    id: "MU-345",
    title:
      'R16 (revision 11): a new look leaves the earlier answer standing (a look that is pending or fails is taken for the older answer: an earlier "there is none" lets the readers ask over a database another tab has since created)',
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-binding.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    attaching = { account, id: mine };\n    // A new look makes every earlier answer unknown (R16, revision 11), whichever account it was about and however it ends: only a\n    // look that LANDS (`finishedLooking`) says again what is there. A bound service that is still live answers for itself.\n    lookedFor = null;\n",
        "    attaching = { account, id: mine };\n",
      ),
  },
  {
    id: "MU-346",
    title:
      "R16 (revision 11): in the production composition (the real session, two tabs) the answer of a look outlives its binding: a back-off timer that falls due after the service ended asks on the page's memory without reading the durable count",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/identity-reads-session.test.ts"],
    patch: (t) =>
      sub(
        t,
        "    lookedFor = null;\n    serviceStore.set(null);",
        "    serviceStore.set(null);",
      ),
  },
  // ---- the review of the eleventh revision (R24 to R27) -------------------------------------------------------------------------
  {
    id: "MU-350",
    title:
      "R24 (revision 12): the replacement's key is not checked against the drafts that exist (a supersession overwrites an unrelated draft, and with the old draft's own key puts and deletes the replacement)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /key of|keys? already|refused/,
    patch: (t) =>
      sub(
        t,
        '  if (existing !== undefined) return { kind: "refused", reason: "key_in_use" };\n',
        "",
      ),
  },
  {
    id: "MU-351",
    title:
      "R24 (revision 12): the plan does not read the draft under the replacement's key (the transaction cannot see a collision, however the decision is written)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /key|retry|retried|supersession/,
    patch: (t) =>
      sub(
        t,
        '    const existing = await reader.get("drafts", input.localId);',
        "    const existing = undefined as DraftRow | undefined;",
      ),
  },
  {
    id: "MU-352",
    title:
      "R24 (revision 12): any draft under the key is taken for the completed supersession (a retry that is not the same save, or another command that uses the key, is answered `superseded`)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /EDITED|DIFFERENT|another endpoint|builder that throws|a retry after|the old draft gone/,
    patch: (t) =>
      sub(
        t,
        "    if (existing !== undefined && isSameSave(request, existing))",
        "    if (existing !== undefined)",
      ),
  },
  {
    id: "MU-353",
    title:
      "R24 (revision 12): a retry of a completed supersession is never recognised (the lost completion's retry is answered `not_found` although the replacement is stored)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /lost|ordinary retry|reload|concurrent|at once|the old draft gone/,
    patch: (t) =>
      sub(
        t,
        "    if (existing !== undefined && isSameSave(request, existing))",
        "    if (\n      existing !== undefined &&\n      isSameSave(request, existing) &&\n      (false as boolean)\n    )",
      ),
  },
  {
    id: "MU-354",
    title:
      "R24 (revision 12): a retry of a completed supersession is reported as WRITTEN by the plan (the facade debits the quota reserve for bytes that were never written)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ordinary retry|debited nothing|writes nothing/,
    patch: (t) =>
      sub(
        t,
        "          paused: decision.paused,\n          duplicate: true,",
        "          paused: decision.paused,\n          duplicate: false,",
      ),
  },
  {
    id: "MU-355",
    title:
      "R24 (revision 12): the facade settles a retry of a completed supersession as WRITTEN (the quota reserve is debited and its cached free space dropped for nothing)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ordinary retry|debited nothing|writes nothing/,
    patch: (t) => sub(t, "written = !result.duplicate;", "written = true;"),
  },
  {
    id: "MU-356",
    title:
      "R24 (revision 12): the dependants that a completed supersession paused are not found again (a retry reports none, and the caller never learns that changes need review)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-supersede-keys.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ordinary retry|dependants it paused/,
    patch: (t) =>
      sub(
        t,
        'dependant.last_error?.stage === "dependency_superseded"',
        'dependant.last_error?.stage === "never"',
      ),
  },
  {
    id: "MU-357",
    title:
      "R25 (revision 12): text is counted in UTF-16 code units, not UTF-8 bytes (a 300,000-character CJK command is charged 300,000 bytes, not 900,000)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /UTF-8|CJK|character by character|lone surrogate|\.length|utf8|real one/,
    patch: (t) =>
      sub(
        t,
        "    } else bytes += 3;\n  }\n  return bytes;\n}",
        "    } else bytes += 3;\n  }\n  return text.length;\n}",
      ),
  },
  {
    id: "MU-358",
    title:
      "R25 (revision 12): the estimate probes only the empty bases (a command that carries its base cannot be built, and the estimate falls to the allowance)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the estimate is the larger|reserves 1 time|reserves 1 times/,
    patch: (t) =>
      sub(
        t,
        "for (const bases of [{}, widest]) {",
        "for (const bases of [{}]) {",
      ),
  },
  {
    id: "MU-359",
    title:
      "R25 (revision 12): the plan's size guard never refuses (a command larger than the reservation is written under the allowance)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /refused as quota|at the bound|same bound|exact size|bound/,
    // Re-anchored in revision 14 (`overBound` takes the admission): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        'return bytes > admission.maxBytes ? { kind: "too_large", bytes } : null;',
        "return null;",
      ),
  },
  {
    id: "MU-360",
    title:
      "R25 (revision 12): the enqueue plan does not apply the reservation's bound (an enqueue is admitted at the estimate whatever it builds)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /enqueue/,
    // Re-anchored in revision 13 (`overBound` takes the composed write): the mutated meaning is unchanged.
    // Re-anchored in revision 14 (`overBound` takes the admission; an admission with no bound is the old `undefined`): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "    const over = overBound(input, {\n      draft: planned.draft,\n      command: planned.command,\n      versionPuts: planned.versionPuts,",
        "    const over = overBound({}, {\n      draft: planned.draft,\n      command: planned.command,\n      versionPuts: planned.versionPuts,",
      ),
  },
  {
    id: "MU-361",
    title:
      "R25 (revision 12): the edit plan does not apply the reservation's bound (an edit of a queued draft is admitted at the estimate whatever it builds)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /edit/,
    // Re-anchored in revision 13 (`overBound` takes the composed write): the mutated meaning is unchanged.
    // Re-anchored in revision 14 (`overBound` takes the admission; an admission with no bound is the old `undefined`): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "    const over = overBound(input, {\n      draft: planned.draft,\n      command: planned.command,\n      versionPuts: [],",
        "    const over = overBound({}, {\n      draft: planned.draft,\n      command: planned.command,\n      versionPuts: [],",
      ),
  },
  {
    id: "MU-362",
    title:
      "R25 (revision 12): the supersede plan does not apply the reservation's bound (a supersession is admitted at the estimate whatever it builds)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /supersede/,
    // Re-anchored in revision 13 (`overBound` takes the composed write): the mutated meaning is unchanged.
    // Re-anchored in revision 14 (`overBound` takes the admission; an admission with no bound is the old `undefined`): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "    const over = overBound(input, {\n      draft: decision.draft,",
        "    const over = overBound({}, {\n      draft: decision.draft,",
      ),
  },
  {
    id: "MU-363",
    title:
      "R25 (revision 12): the facade passes a `too_large` answer through to its caller instead of admitting the write again at its real size",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /control|real|room|written|bound|admitted/,
    // Re-anchored in revision 14 (the facade also admits a save again when its hold ended; this mutant still passes a `too_large` answer through): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        'result.kind !== "too_large" && result.kind !== "lease_lapsed"',
        'result.kind !== "lease_lapsed"',
      ),
  },
  {
    id: "MU-364",
    title:
      "R25 (revision 12): the write is admitted again at the SAME bound (the size the plan reported is ignored, so a command the estimate could not size is refused for ever)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /control|room|written|bound/,
    // Re-anchored in revision 14 (the answer is narrowed beside the lapsed one): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "bound = (result as { bytes: number }).bytes + SIZE_SLACK_BYTES;",
        "bound += 0;",
      ),
  },
  {
    id: "MU-365",
    title:
      "R25 (revision 12): the number of times a write is admitted again is not bounded in practice (an impure builder is admitted again dozens of times)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /NOT pure/,
    patch: (t) => sub(t, "const SIZE_ROUNDS = 3;", "const SIZE_ROUNDS = 1000;"),
  },
  {
    id: "MU-366",
    title:
      "R25 (revision 12): the first reservation ignores the estimate (every base-dependent write is admitted twice: the pre-estimate no longer saves the second reservation)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /reserves 1 time/,
    // Re-anchored in revision 13 (the estimate takes the save's identity): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "    let bound = estimateDraftBytes(request, {\n      localId,\n      accountId: service.account,\n    });",
        "    let bound = 4096;",
      ),
  },
  {
    id: "MU-367",
    title: "R25 (revision 12): the display patch is left out of a draft's size",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-size.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a draft is its command/,
    patch: (t) =>
      sub(
        t,
        "    : DRAFT_ALLOWANCE_BYTES + body + patch;",
        "    : DRAFT_ALLOWANCE_BYTES + body;",
      ),
  },
  {
    id: "MU-368",
    title:
      "R26 (revision 12): the sync engine's ownership listener closes over the shared timer and is never removed (an obsolete signal's abort clears the current run's idle deadline)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R26, sync engine/,
    patch: (t) =>
      sub(
        t,
        '      bindAbort(generation, next.signal);\n      setState({ kind: "waiting", reason: "cache_not_valid" });',
        '      next.signal.addEventListener("abort", () => {\n        clearTimer();\n        resolveWaiters();\n      });\n      setState({ kind: "waiting", reason: "cache_not_valid" });',
      ),
  },
  {
    id: "MU-369",
    title:
      "R26 (revision 12): the dispatcher's ownership listener closes over the shared timer and is never removed (an obsolete signal's abort clears the current run's retry deadline)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R26, dispatcher/,
    patch: (t) =>
      sub(
        t,
        '      bindAbort(generation, next.signal);\n      setState({ kind: "idle" });',
        '      next.signal.addEventListener("abort", () => {\n        clearTimer();\n        resolveWaiters();\n      });\n      setState({ kind: "idle" });',
      ),
  },
  {
    id: "MU-370",
    title:
      "R26 (revision 12): the sync engine's stop() leaves the ownership listener attached",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ONE listener/,
    patch: (t) =>
      sub(
        t,
        "      retained = null;\n      unbindAbort();\n",
        "      retained = null;\n",
      ),
  },
  {
    id: "MU-371",
    title:
      "R26 (revision 12): a restart of the sync engine does not release the listener of the run it replaces (listeners accumulate on a long-lived signal)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ONE listener/,
    patch: (t) =>
      sub(
        t,
        "  const bindAbort = (id: number, signal: AbortSignal): void => {\n    unbindAbort();\n",
        "  const bindAbort = (id: number, signal: AbortSignal): void => {\n",
      ),
  },
  {
    id: "MU-372",
    title:
      "R26 (revision 12): the dispatcher's stop() leaves the ownership listener attached",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ONE listener/,
    patch: (t) =>
      sub(
        t,
        "      ownership = null;\n      unbindAbort();\n",
        "      ownership = null;\n",
      ),
  },
  {
    id: "MU-373",
    title:
      "R26 (revision 12): a restart of the dispatcher does not release the listener of the run it replaces",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ONE listener/,
    patch: (t) =>
      sub(
        t,
        "  const bindAbort = (id: number, signal: AbortSignal): void => {\n    unbindAbort();\n",
        "  const bindAbort = (id: number, signal: AbortSignal): void => {\n",
      ),
  },
  {
    id: "MU-374",
    title:
      "R27 (revision 12): the sync step issues its request without judging its eligibility again after the quota read (a stop, an aborted ownership, offline, a disposed service or a moved identity still send)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R27, sync engine/,
    patch: (t) =>
      sub(
        t,
        '    if (eligible !== "yes")\n      return { when: eligible === "ended" ? "event" : "now" };\n',
        "",
      ),
  },
  {
    id: "MU-375",
    title:
      "R27 (revision 12): connectivity is not part of the sync step's last eligibility test (a step that went offline during the quota read still sends)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /going offline|offline during the read/,
    patch: (t) =>
      sub(
        t,
        'if (!service.live || !deps.online()) return "moved";',
        'if (!service.live) return "moved";',
      ),
  },
  {
    id: "MU-376",
    title:
      "R27 (revision 12): the service's liveness is not part of the sync step's last eligibility test (a service disposed during the quota read still sends)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the service disposed|the identity leaving/,
    patch: (t) =>
      sub(
        t,
        'if (!service.live || !deps.online()) return "moved";',
        'if (!deps.online()) return "moved";',
      ),
  },
  {
    id: "MU-377",
    title:
      "R27 (revision 12): the identity (account and epoch) is not part of the sync step's last eligibility test (a step whose epoch moved during the quota read sends under the old one)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /new epoch of the same account/,
    patch: (t) =>
      sub(
        t,
        '    return identity !== null &&\n      identity.account_id === service.account &&\n      identity.epoch === epoch\n      ? "yes"\n      : "moved";',
        '    return identity !== null ? "yes" : "moved";',
      ),
  },
  {
    id: "MU-378",
    title:
      "R27 (revision 12): the run's liveness is judged after the capture's gated answer is published (a stopped run's step overwrites `not_started`)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the capture read: a gated answer/,
    patch: (t) =>
      sub(
        t,
        '    if (!alive(id)) return { when: "event" };\n    if (capture.kind === "gated")\n      return gated(\n        service,\n        capture.reason,\n        capture.operation,\n        capture.operations,\n        capture.version,\n      );\n',
        '    if (capture.kind === "gated")\n      return gated(\n        service,\n        capture.reason,\n        capture.operation,\n        capture.operations,\n        capture.version,\n      );\n    if (!alive(id)) return { when: "event" };\n',
      ),
  },
  {
    id: "MU-379",
    title:
      "R27 (revision 12): a capture read that fails after the run ended is counted and published into the stopped run",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the capture read failing after stop\(\) \(a closed store\)/,
    patch: (t) =>
      sub(
        t,
        '      if (!alive(id)) return { when: "event" };\n      return localFailure(id, service, error, CAPTURE_OPERATION);',
        "      return localFailure(id, service, error, CAPTURE_OPERATION);",
      ),
  },
  {
    id: "MU-380",
    title:
      "R27 (revision 12): a request refused after the run ended is counted and published into the run that stands (stamped refusals advance the next run's back-off)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /refused after stop|unsent request of a run that ended/,
    patch: (t) =>
      sub(
        t,
        '      if (!alive(id)) return { when: "event" };\n      return requestError(id, service, captured, error);',
        "      return requestError(id, service, captured, error);",
      ),
  },
  {
    id: "MU-381",
    title:
      "R27 (revision 12): an unread 503 body is published as the capacity stop after the run ended",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /unread 503 body/,
    patch: (t) =>
      sub(
        t,
        '      if (!alive(id)) return { when: "event" };\n      if (code === "device_capacity") {',
        '      if (code === "device_capacity") {',
      ),
  },
  {
    id: "MU-382",
    title:
      "R27 (revision 12): a queue read that fails after the dispatcher's run ended is published into the stopped run",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the queue read failing after stop\(\) \(a closed store\)/,
    patch: (t) =>
      sub(
        t,
        '      if (!alive(id)) return { when: "event" };\n      return localFailure(id, service, error, QUEUE_OPERATION);',
        "      return localFailure(id, service, error, QUEUE_OPERATION);",
      ),
  },
  {
    id: "MU-383",
    title:
      "R27 (revision 12): an unsent request of a dispatcher run that ended advances the next run's quiet back-off",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an unsent request of a run that ended|refused as not_sent/,
    patch: (t) =>
      sub(
        t,
        '          await unclaim(service, claimed);\n          if (!alive(id)) return { when: "event" };\n          // Quiet, bounded, NEVER counted: nothing was sent.',
        "          await unclaim(service, claimed);\n          // Quiet, bounded, NEVER counted: nothing was sent.",
      ),
  },
  {
    id: "MU-384",
    title:
      "R27 (revision 12): a request the session refused as not covered, after the dispatcher's run ended, publishes the session state into the stopped run",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /refused as not_covered after stop/,
    patch: (t) =>
      sub(
        t,
        '          await unclaim(service, claimed);\n          if (!alive(id)) return { when: "event" };\n          setState({ kind: "waiting", reason: "session" });\n          const ms = nextDelay(',
        '          await unclaim(service, claimed);\n          setState({ kind: "waiting", reason: "session" });\n          const ms = nextDelay(',
      ),
  },
  {
    id: "MU-385",
    title:
      "R27 (revision 12): a request the session refused as closed, after the dispatcher's run ended, publishes the session state into the stopped run",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /refused as closed after stop/,
    patch: (t) =>
      sub(
        t,
        '          await unclaim(service, claimed);\n          if (!alive(id)) return { when: "event" };\n          setState({ kind: "waiting", reason: "session" });\n          return { when: "event" };',
        '          await unclaim(service, claimed);\n          setState({ kind: "waiting", reason: "session" });\n          return { when: "event" };',
      ),
  },
  {
    id: "MU-390",
    title:
      "R27 (revision 12): a continuation of the sync engine's `online` resume that outlived its run resets the NEW run's failure count (its back-off starts over)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-ownership-lifetime.test.ts"],
    expect: /stale `online` continuation/,
    patch: (t) =>
      sub(
        t,
        '      if (!alive(id)) return;\n      failures = 0;\n      void tick(id, "online");',
        '      failures = 0;\n      if (alive(id)) void tick(id, "online");',
      ),
  },
  {
    id: "MU-391",
    title:
      "R25 (revision 13): the header as stored (its defaults context, defaults revision, kind and identifiers) is not part of the write's measure",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /defaults context/,
    patch: (t) =>
      sub(
        t,
        "  const header = plainJsonBytes({ ...write.draft, display_patch: null });",
        "  const header: number | null = 0;",
      ),
  },
  {
    id: "MU-392",
    title: "R25 (revision 13): the version rows a save writes are not measured",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /version rows a save writes are measured/,
    patch: (t) =>
      sub(
        t,
        "  const versions = plainJsonBytes(write.versionPuts);",
        "  const versions: number | null = 0;",
      ),
  },
  {
    id: "MU-393",
    title:
      "R25 (revision 13): the identifiers are not counted again for the index entries and the candidate rows a claim writes",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /identifiers are counted again/,
    patch: (t) =>
      sub(
        t,
        "identifiers * IDENTIFIER_COPIES + rewrites",
        "identifiers * 0 + rewrites",
      ),
  },
  {
    id: "MU-394",
    title:
      "R25 (revision 13): the dependants a supersession rewrites add nothing to the measure",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dependants/,
    patch: (t) =>
      sub(
        t,
        "    rewritten *\n    (REWRITTEN_DEPENDANT_BYTES +",
        "    0 *\n    (REWRITTEN_DEPENDANT_BYTES +",
      ),
  },
  {
    id: "MU-395",
    title:
      "R25 (revision 13): a value JSON cannot carry exactly (a Map, a Date, a typed array, a class instance) is measured as the JSON it turns into, an undercount, instead of refused",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /cannot be measured is never a small write/,
    patch: (t) =>
      sub(
        t,
        "    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null)\n      return null;\n",
        "",
      ),
  },
  {
    id: "MU-396",
    title:
      "R25 (revision 13): the estimate before the transaction is the command's share alone (the header is not composed)",
    file: "src/data/model/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the estimate grows by at least/,
    patch: (t) =>
      sub(
        t,
        "      if (resolved === null)\n        bytes = draftBytes(built.command, built.displayPatch);",
        "      if (resolved === null || true)\n        bytes = draftBytes(built.command, built.displayPatch);",
      ),
  },
  {
    id: "MU-397",
    title:
      "R25 (revision 13): an edit of a queued draft is not measured against what was reserved (it writes whatever the header now holds)",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an edit that keeps the context it already holds/,
    // Re-anchored in revision 14 (`overBound` takes the admission): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "    const over = overBound(input, {\n      draft: planned.draft,\n      command: planned.command,\n      versionPuts: [],\n    });",
        "    const over = null as ReturnType<typeof overBound>;",
      ),
  },
  {
    id: "MU-398",
    title:
      "R25 (revision 13): a supersession does not count the dependants it rewrites",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dependants/,
    patch: (t) =>
      sub(
        t,
        "      versionPuts: decision.versionPuts,\n      rewritten: decision.draftPuts.length,\n",
        "      versionPuts: decision.versionPuts,\n",
      ),
  },
  {
    id: "MU-399",
    title:
      "R25 (revision 13): the enqueue plan's measure leaves the defaults context out of the row it composed (a context is stored and never counted)",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /defaults context/,
    patch: (t) =>
      sub(
        t,
        "      draft: planned.draft,\n      command: planned.command,\n      versionPuts: planned.versionPuts,\n    });",
        "      draft: { ...planned.draft, defaults_context: null },\n      command: planned.command,\n      versionPuts: planned.versionPuts,\n    });",
      ),
  },
  {
    id: "MU-400",
    title:
      "R25 (revision 13): the supersede plan's measure leaves the defaults context out of the row it composed",
    file: "src/data/plans/outbox.ts",
    tests: [
      "tests/data/outbox-quota-context.test.ts",
      "tests/data/outbox-quota-size.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /defaults context/,
    patch: (t) =>
      sub(
        t,
        "      draft: decision.draft,\n      command: decision.command,\n      versionPuts: decision.versionPuts,\n      rewritten: decision.draftPuts.length,\n    });",
        "      draft: { ...decision.draft, defaults_context: null },\n      command: decision.command,\n      versionPuts: decision.versionPuts,\n      rewritten: decision.draftPuts.length,\n    });",
      ),
  },
  {
    id: "MU-401",
    title:
      "R28 (revision 13): independent guards over one estimate source no longer share a ledger (each page-local guard has its own, as before the finding)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /SAME estimate source/,
    // Re-expressed in revision 15: the guard no longer imports `createMemoryLedger` (it keeps no ledger of its own), so the patch adds it.
    patch: (t) =>
      sub(
        sub(
          t,
          "  EMPTY_LEDGER,\n  type LedgerChange,",
          "  createMemoryLedger,\n  EMPTY_LEDGER,\n  type LedgerChange,",
        ),
        "const shared = options.ledger ?? ledgerFor(options.storage);",
        "const shared = options.ledger ?? createMemoryLedger();",
      ),
  },
  {
    id: "MU-402",
    title:
      "R28 (revision 13): the holds recorded in the ledger are not subtracted from the free space (another page's reservation is invisible)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /exactly one page is admitted|three pages, room for two/,
    patch: (t) =>
      sub(
        t,
        "      if (token !== mine) held += hold.bytes;",
        "      if (token !== mine) held += 0 * hold.bytes;",
      ),
  },
  {
    id: "MU-403",
    title:
      "R28 (revision 13): the ledger of landed writes does not cap a lagging estimate (a second page's stale estimate is believed)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /estimate LAGS|no hint is needed|overlapping reservations of one page/,
    patch: (t) =>
      sub(
        t,
        "? Math.min(figure, Math.max(0, landed.base - landed.landed))",
        "? figure",
      ),
  },
  {
    id: "MU-406",
    title:
      "R28 (revision 13): a hold in the origin's ledger has no lease (a page that dies with a reservation outstanding holds its bytes for ever)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /its hold stands while the lease runs/,
    // Re-anchored in revision 14 (the lease is named before the hold is composed): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "              const until = shared.shared\n                ? now + leaseMs\n                : Number.POSITIVE_INFINITY;",
        "              const until = Number.POSITIVE_INFINITY;",
      ),
  },
  {
    id: "MU-407",
    title:
      "R28 (revision 13): a lapsed hold is still counted when the ledger is read",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /its hold stands while the lease runs/,
    patch: (t) => sub(t, "      now < hold.until &&\n", "      true &&\n"),
  },
  {
    id: "MU-408",
    title:
      "R28 (revision 13): the ledger of landed writes never ends (the estimate is never trusted again)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    // Re-anchored in revision 17: the entry is retired one estimate lifetime after its `until`, and a reading that began after `until`
    // ignores it, so a never-retired entry shows only as a record that stands for ever (and that new landings merge into).
    expect: /(ends one estimate lifetime|nothing is counted for ever)/,
    patch: (t) =>
      sub(
        t,
        "    } else if (now >= reaches(landed) + limits.ttlMs) {",
        "    } else if (false) {",
      ),
  },
  {
    id: "MU-409",
    title:
      "R28 (revision 13): a write that landed is not recorded in the ledger of landed writes (its bytes are in no ledger once its hold ends)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /in the holds or in the landed ledger|outlives its lease|estimate LAGS/,
    patch: (t) =>
      sub(
        t,
        '          outcome === "written"\n            ? landHold(',
        "          false\n            ? landHold(",
      ),
  },
  {
    id: "MU-410",
    title: "R28 (revision 13): a settlement does not release the hold",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /once the other settles without writing|idempotent/,
    // Re-anchored in revision 16 (the settlement is `conclude`, which takes the reservation's own hold out before it judges the rest).
    patch: (t) =>
      sub(
        t,
        "      const { [held.token]: _own, ...others } = state.holds;\n",
        "      const others = state.holds;\n",
      ),
  },
  {
    id: "MU-411",
    title:
      "R28 (revision 13): a change the guard gave up waiting for is applied late (a phantom promise nobody holds)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /not applied late/,
    // Re-anchored in revision 14 (the guard asks twice; this mutant is the call `through` abandons, not the renewal\'s): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        "        ticket.abandoned = true;\n        if (error === silent || attempt >= tries) throw new LedgerUnavailable();",
        "        if (error === silent || attempt >= tries) throw new LedgerUnavailable();",
      ),
  },
  {
    id: "MU-412",
    title:
      "R28 (revision 13): the guard never gives up waiting for an origin ledger that does not answer (a save waits for ever)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /does not ANSWER within the wait/,
    patch: (t) =>
      sub(
        t,
        "              timer = setTimeout(() => reject(silent), waitMs);",
        "              timer = undefined;",
      ),
  },
  {
    id: "MU-415",
    title: "R28 (revision 13): the guard does not close the ledger it opened",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`close` closes what the page opened/,
    patch: (t) =>
      sub(
        t,
        "      for (const wake of [...pauses]) wake();\n      shared.close();",
        "      for (const wake of [...pauses]) wake();",
      ),
  },
  {
    id: "MU-416",
    title:
      "R28 (revision 13): the production guard is not wired to the origin's IndexedDB ledger (each page keeps its own)",
    file: "src/data/ui/production-quota.ts",
    tests: ["tests/data/production-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /wired to the origin's ledger|two pages of one origin/,
    patch: (t) =>
      sub(
        t,
        '  const ledger =\n    typeof storage?.estimate === "function"\n      ? createIdbLedger(options?.factory, locks)\n      : undefined;',
        "  const ledger = undefined as ReturnType<typeof createIdbLedger>;",
      ),
  },
  {
    id: "MU-417",
    title:
      "R28 (revision 13): the origin ledger's change is not ONE transaction (it reads in one and writes in another, so two pages lose an update)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /it is ONE transaction/,
    patch: (t) =>
      sub(
        t,
        '    update: (change) => run("readwrite", change),',
        '    update: (change) =>\n      run("readonly", (state) => ({ state: null, result: state })).then(\n        (stale) => run("readwrite", () => change(stale)),\n      ),',
      ),
  },
  {
    id: "MU-418",
    title:
      "R28 (revision 13): a call of the origin ledger that never completes holds up every call behind it for good",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /never answered is given up/,
    patch: (t) =>
      sub(t, "          }, STUCK_MS);", "          }, 1_000_000_000);"),
  },
  {
    id: "MU-419",
    title:
      "R28 (revision 13): an impossible figure in a stored ledger record is trusted",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /impossible figure/,
    patch: (t) => sub(t, "        finite(entry.bytes) &&\n", ""),
  },
  {
    id: "MU-420",
    title:
      "R28 (revision 13): the origin ledger holds its connection when another page asks to change or delete the database",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /versionchange. makes the ledger let go/,
    patch: (t) =>
      sub(
        t,
        "        db.onversionchange = () => {\n          db.close();\n",
        "        db.onversionchange = () => {\n",
      ),
  },
  {
    id: "MU-421",
    title:
      "R28 (revision 13): `close` of the origin ledger leaves its connection open",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`close` closes the connection the page opened/,
    patch: (t) =>
      sub(
        t,
        "        (db) => db.close(),\n        () => undefined,",
        "        () => undefined,\n        () => undefined,",
      ),
  },
  {
    id: "MU-422",
    title:
      "R28 (revision 13): the origin ledger's transactions wait for the disk",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /READ-ONLY transaction/,
    patch: (t) =>
      sub(
        t,
        '        transaction = db.transaction(STORE, mode, { durability: "relaxed" });',
        "        transaction = db.transaction(STORE, mode);",
      ),
  },
  {
    id: "MU-423",
    title:
      "R28 (revision 13): a read of the origin ledger is a read-write transaction (it blocks every other page's change)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-ledger-idb.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /READ-ONLY transaction/,
    patch: (t) =>
      sub(
        t,
        '      run("readonly", (state) => ({ state: null, result: read(state) })),',
        '      run("readwrite", (state) => ({ state: null, result: read(state) })),',
      ),
  },
  {
    id: "MU-424",
    title:
      "R29 (revision 13): the provider builds an ACTIVE controller in its state initialiser (a render React discards leaves its subscriptions behind)",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /Strict Mode mount holds exactly what a plain mount holds/,
    patch: (t) =>
      sub(t, "    { start: false },\n  );", "    { start: true },\n  );"),
  },
  {
    id: "MU-425",
    title:
      "R29 (revision 13): the provider's effect does not start the controller (the replay of an effect leaves it stopped)",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /visible controller is LIVE/,
    patch: (t) =>
      sub(
        t,
        "    env.start();\n    return () => env.dispose();",
        "    return () => env.dispose();",
      ),
  },
  {
    id: "MU-426",
    title:
      "R29 (revision 13): the provider's effect cleanup does not dispose the controller (it outlives the tree)",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /unmounting leaves no subscription/,
    patch: (t) =>
      sub(
        t,
        "    env.start();\n    return () => env.dispose();",
        "    env.start();\n    return () => undefined;",
      ),
  },
  {
    id: "MU-427",
    title:
      "R29 (revision 13): a stop does not end the lifetime a runtime was asked for in (a runtime that arrives after it is kept)",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the two imports arriving|an unmount BEFORE the import arrives/,
    patch: (t) =>
      sub(
        t,
        "      running = false;\n      lifetime += 1;",
        "      running = false;",
      ),
  },
  {
    id: "MU-428",
    title:
      "R29 (revision 13): a runtime that arrives for a stopped lifetime is not recognised as stale",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the two imports arriving|an unmount BEFORE the import arrives/,
    patch: (t) =>
      sub(t, "        if (asked !== lifetime) {", "        if (false) {"),
  },
  {
    id: "MU-429",
    title:
      "R29 (revision 13): the provider does not close the sync channel it opened when it stops",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /unmounting leaves no subscription, listener or channel/,
    patch: (t) =>
      sub(
        t,
        "      channel.close();\n      quota.close?.();",
        "      quota.close?.();",
      ),
  },
  {
    id: "MU-430",
    title:
      "R29 (revision 13): the provider does not dispose the browser runtime it kept when it stops",
    file: "src/data/ui/react.tsx",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the two imports arriving|plain mount: one runtime/,
    patch: (t) =>
      sub(
        t,
        "      dispose();\n      browser?.dispose();\n      browser = null;",
        "      dispose();\n      browser = null;",
      ),
  },
  {
    id: "MU-431",
    title:
      "R29 (revision 13): a stop leaves the look that was under way, so a restart believes the database is already being looked for and never loads",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /restart loads a runtime of its own|the two imports arriving/,
    patch: (t) =>
      sub(
        t,
        "    attaching = null;\n    forgetFailedLook();\n    // `carried` is NOT forgotten",
        "    forgetFailedLook();\n    // `carried` is NOT forgotten",
      ),
  },
  {
    id: "MU-432",
    title:
      "R29 (revision 13): a stop keeps the memo of the runtime it loaded (a restart reuses a runtime that was disposed)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /restart loads a runtime of its own/,
    patch: (t) =>
      sub(
        t,
        "    runtime = null;\n    // A look that was under way",
        "    // A look that was under way",
      ),
  },
  {
    id: "MU-433",
    title:
      "R29 (revision 13): a load that fails after a restart began its own erases the newer load",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /AFTER a restart began its own/,
    patch: (t) =>
      sub(
        t,
        "          if (runtime === loading) runtime = null;",
        "          runtime = null;",
      ),
  },
  {
    id: "MU-434",
    title:
      "R29 (revision 13): a stop does not release the controller's subscriptions",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /releases everything|a stopped controller starts again|unmounting leaves no subscription/,
    patch: (t) =>
      sub(
        t,
        "    for (const off of offs) off();\n    offs = [];\n    for (const off of leaderOffs) off();\n    leaderOffs = [];\n    unbind();",
        "    offs = [];\n    for (const off of leaderOffs) off();\n    leaderOffs = [];\n    unbind();",
      ),
  },
  {
    id: "MU-435",
    title: "R29 (revision 13): a second `start()` subscribes again",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /is idempotent/,
    patch: (t) =>
      sub(
        t,
        "  const start = (): void => {\n    if (active) return;",
        "  const start = (): void => {",
      ),
  },
  {
    id: "MU-436",
    title:
      "R29 (revision 13): a restart does not read connectivity again (a change while nothing listened is lost)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/provider-lifetime.test.tsx",
      "tests/data/provider-runtime-lifetime.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a restart reads connectivity again/,
    patch: (t) =>
      sub(
        t,
        "    // Connectivity and the leader may have moved while nothing was listening (a stop and a start): say what is true now.\n    recompute();\n",
        "    // Connectivity and the leader may have moved while nothing was listening (a stop and a start): say what is true now.\n",
      ),
  },
  {
    id: "MU-437",
    title:
      "R29 (revision 13): constructing the sync channel opens a browser channel at once",
    file: "src/data/engine/sync-channel.ts",
    tests: ["tests/data/sync-channel-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /constructing one opens nothing/,
    patch: (t) =>
      sub(
        t,
        "  };\n  return {\n    post(message) {",
        "  };\n  open();\n  return {\n    post(message) {",
      ),
  },
  {
    id: "MU-438",
    title:
      "R29 (revision 13): `close` of the sync channel does not close the browser channel",
    file: "src/data/engine/sync-channel.ts",
    tests: ["tests/data/sync-channel-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`close` closes the browser channel/,
    patch: (t) =>
      sub(
        t,
        "      try {\n        closing.close();\n      } catch {\n        // Already closed.\n      }\n",
        "",
      ),
  },
  {
    id: "MU-439",
    title:
      "R29 (revision 13): `close` of the sync channel leaves its message handler attached",
    file: "src/data/engine/sync-channel.ts",
    tests: ["tests/data/sync-channel-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`close` closes the browser channel/,
    patch: (t) => sub(t, "      closing.onmessage = null;\n", ""),
  },
  {
    id: "MU-440",
    title:
      "R29 (revision 13): the browser composition does not close the sync channel it opened when it is disposed",
    file: "src/data/ui/browser-env.ts",
    tests: ["tests/data/browser-env-dispose.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /opens the sync channel for its wipe responder/,
    patch: (t) =>
      sub(
        t,
        "      // The channel this composition opened is let go with it (R29): nothing keeps listening after the page stops.\n      channel.close();\n",
        "      // The channel this composition opened is let go with it (R29): nothing keeps listening after the page stops.\n",
      ),
  },
  {
    id: "MU-446",
    title:
      "R28 (revision 13): an entry of the origin's ledger that ends further ahead than its own lifetime allows (the clock moved back) is trusted, and holds the space for as long as the clock was moved",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-origin-ledger.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ends further ahead than its own lifetime allows/,
    patch: (t) =>
      sub(
        t,
        "            (hold.until === Number.POSITIVE_INFINITY ||\n              hold.until - now <= limits.leaseMs)",
        "            true",
      ),
  },
  {
    id: "MU-447",
    title:
      "R28 (revision 13): the ledger of landed writes whose end is further ahead than one estimate lifetime (the clock moved back) is trusted",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ends further ahead than its own lifetime allows/,
    // Re-anchored in revision 17: the entry whose end is further ahead than one lifetime is clamped, not dropped (`rebased`).
    patch: (t) =>
      sub(
        t,
        "    } else if (landed.until - now > limits.ttlMs) {",
        "    } else if (false) {",
      ),
  },
  {
    id: "MU-448",
    title:
      "R25 (revision 13): the command and the display patch are measured by their canonical JSON, which turns a Map, a Set or a typed array into `{}` (the clone stores what they hold: an undercount, instead of a refusal)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /inside the COMMAND/,
    patch: (t) =>
      sub(
        t,
        "  const body = plainJsonBytes(command);",
        "  const body = utf8Length(canonicalJson(command));",
      ),
  },
  {
    id: "MU-449",
    title:
      "R25 (revision 13): the display patch is measured by its canonical JSON (a Map in it is counted as {})",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /inside the DISPLAY PATCH/,
    patch: (t) =>
      sub(
        t,
        "      : plainJsonBytes(displayPatch);",
        "      : utf8Length(canonicalJson(displayPatch));",
      ),
  },
  {
    id: "MU-450",
    title:
      "R25 (revision 14): a NAMED property of an array is not counted (the array is measured by its members only: a structured clone keeps the property, IndexedDB retains 900,000 bytes of a two-byte list)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(NAMED property|named property)/,
    patch: (t) =>
      sub(
        t,
        "      payload += element ? size : utf8Length(JSON.stringify(key)) + 1 + size;",
        "      payload += element ? size : 0;",
      ),
  },
  {
    id: "MU-451",
    title:
      "R25 (revision 14): a hole of an array is not counted (JSON says it is a null, and a bound is never smaller)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hole is counted as the null JSON says it is/,
    patch: (t) => sub(t, "      payload += holes * 4;", "      payload += 0;"),
  },
  {
    id: "MU-452",
    title:
      "R25 (revision 14): an accessor is run and measured as plain data (a getter can answer differently when the write is measured and when it is stored)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an accessor is not plain data/,
    patch: (t) =>
      sub(
        t,
        '      if (descriptor === undefined || !("value" in descriptor)) return null;',
        "      if (descriptor === undefined) return null;",
      ),
  },
  {
    id: "MU-453",
    title:
      "R25 (revision 14): every property of an array is an element (a named property is not told from an index, and its key is not counted)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(NAMED property|named property)/,
    patch: (t) =>
      sub(
        t,
        "      const element = array && isArrayIndex(key);",
        "      const element = array;",
      ),
  },
  {
    id: "MU-454",
    title:
      "R25 (revision 14): a non-canonical key (`01`) is taken for an array index (re-anchored in revision 22: `isArrayIndex` moved to `snapshot.ts`, where the size measure and the snapshot share it)",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a property that is not an array index is named/,
    patch: (t) =>
      sub(
        t,
        "  /^(?:0|[1-9]\\d*)$/.test(key) && Number(key) < 0xffffffff;",
        "  /^\\d+$/.test(key) && Number(key) < 0xffffffff;",
      ),
  },
  {
    id: "MU-455",
    title:
      "R25 (revision 14): the largest array index (`4294967295`, which is a property and not an element) is taken for an index (re-anchored in revision 22: `isArrayIndex` moved to `snapshot.ts`, where the size measure and the snapshot share it)",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/outbox-quota-context.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a property that is not an array index is named/,
    patch: (t) =>
      sub(
        t,
        "  /^(?:0|[1-9]\\d*)$/.test(key) && Number(key) < 0xffffffff;",
        "  /^(?:0|[1-9]\\d*)$/.test(key);",
      ),
  },
  {
    id: "MU-456",
    title:
      "R28 (revision 14): `live()` does not end a third of a lease before the hold can lapse (a write that begins has no time to land while the other pages still count it)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ends a third of a lease BEFORE the hold itself can lapse/,
    patch: (t) =>
      sub(t, "time() < held.until - thirdMs);", "time() < held.until);"),
  },
  {
    id: "MU-457",
    title: "R28 (revision 14): a settled reservation is still live",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a settled reservation is no longer live/,
    patch: (t) =>
      sub(t, "    !held.settled &&\n    !held.lost &&", "    !held.lost &&"),
  },
  {
    id: "MU-458",
    title:
      "R28 (revision 14): a hold that was lost can be live again (a clock moved back brings a removed hold back)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /stays lost/,
    patch: (t) =>
      sub(t, "    !held.settled &&\n    !held.lost &&", "    !held.settled &&"),
  },
  {
    id: "MU-459",
    title:
      "R28 (revision 14): a renewal does not extend the lease (the hold lapses under a live writer)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /still in the ledger, and the other page still refused/,
    patch: (t) =>
      sub(
        t,
        "          const until = now + leaseMs;",
        "          const until = hold.until;",
      ),
  },
  {
    id: "MU-460",
    title:
      "R28 (revision 14): the renewal timer is never armed (no reservation is ever renewed)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(still in the ledger, and the other page still refused|the timer is the guard's alone|goes with the settlement)/,
    patch: (t) =>
      sub(
        t,
        "    if (renewTimer !== undefined || tracked.size === 0) return;",
        "    return;",
      ),
  },
  {
    id: "MU-461",
    title:
      "R28 (revision 14): a renewal revives a hold another page removed (the writer's permission returns with space another page was admitted into)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /revives nothing/,
    patch: (t) =>
      sub(
        t,
        "          const hold = live.state.holds[held.token];",
        "          const hold = live.state.holds[held.token] ?? { bytes: 0, until: 0 };",
      ),
  },
  {
    id: "MU-462",
    title: "R28 (revision 14): a hold found gone is not recorded as lost",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /stays lost/,
    patch: (t) =>
      sub(
        t,
        '      if (answer === "gone") {\n        held.lost = true;\n        untrack(held);',
        '      if (answer === "gone") {\n        untrack(held);',
      ),
  },
  {
    id: "MU-463",
    title:
      "R28 (revision 14): a reservation that never settles is renewed for ever (a leak holds the space as long as the page lives)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-settlement.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    // Re-anchored in revision 16: only a reservation whose writer has not begun is revoked by its age.
    expect: /never began is a leak/,
    patch: (t) =>
      sub(
        t,
        "    if (!held.started && time() - held.born >= maxAgeMs) {",
        "    if (false) {",
      ),
  },
  {
    id: "MU-464",
    title:
      "R28 (revision 14): the renewal timer is not cleared with the last settlement",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the timer is the guard's alone|goes with the settlement)/,
    patch: (t) =>
      sub(t, "      clearTimeout(renewTimer);\n", "      // (not cleared)\n"),
  },
  {
    id: "MU-465",
    title:
      "R28 (revision 14): a settlement does not stop the renewal of its hold",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the timer is the guard's alone|goes with the settlement)/,
    patch: (t) =>
      sub(
        t,
        "          held.settled = true;\n          untrack(held);\n",
        "          held.settled = true;\n",
      ),
  },
  {
    id: "MU-466",
    title:
      "R28 (revision 14): a call the origin's ledger rejects is not asked again (one transient failure costs the origin-wide guarantee)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /one rejection costs nothing/,
    patch: (t) =>
      sub(
        t,
        "  const attempts = Math.max(\n    1,\n    config.quotaLedgerAttempts ?? DATA_CONFIG.quotaLedgerAttempts,\n  );",
        "  const attempts = 1;",
      ),
  },
  {
    id: "MU-469",
    title:
      "R28 (revision 14): a degraded `check` forgets what the origin last showed of the other pages",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /still counted by `check` while it cannot be read/,
    patch: (t) =>
      sub(
        t,
        "          known.view,\n          taken,",
        "          EMPTY_LEDGER,\n          taken,",
      ),
  },
  {
    id: "MU-470",
    title:
      "R28 (revision 14): a page's own change does not update what it last knew of the origin (a promise it settled is counted again, and its own earlier hold is not)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /counts a promise this page made while the origin answered/,
    patch: (t) => sub(t, "      if (shared.shared) remember(left);\n", ""),
  },
  {
    id: "MU-471",
    title:
      "R28 (revision 14): a settlement the ledger rejects is not asked again",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /rejected once: the hold is removed/,
    patch: (t) =>
      sub(
        t,
        "          if (!shared.shared || generation !== closes) break;",
        "          break;",
      ),
  },
  {
    id: "MU-473",
    title:
      "R28 (revision 14): the draft plans do not read the lease of the reservation (a write begins on a hold that ended)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(lease_lapsed|the lease ran out)/,
    patch: (t) =>
      sub(
        t,
        '  if (admission.leaseLive !== undefined && !admission.leaseLive())\n    return { kind: "lease_lapsed" };\n',
        "",
      ),
  },
  {
    id: "MU-474",
    title:
      "R28 (revision 14): the facade does not admit a save again when its hold ended (the lapsed answer is returned as the save's result)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /admitted again at the same size/,
    patch: (t) =>
      sub(
        t,
        '      if (result.kind !== "too_large" && result.kind !== "lease_lapsed")',
        '      if (result.kind !== "too_large")',
      ),
  },
  {
    id: "MU-475",
    title:
      "R28 (revision 14): the facade does not hand the reservation's lease to the plans",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the lease ran out|admitted again at the same size)/,
    patch: (t) => t.replaceAll("leaseLive: () => reservation.live(),", ""),
  },
  {
    id: "MU-476",
    title:
      "R28 (revision 14): the facade's re-admission bound is one round too many (a hold that ends on every admission is admitted a fourth time)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /after the bounded rounds/,
    patch: (t) =>
      sub(
        t,
        '      if (round >= SIZE_ROUNDS) return { kind: "refused", reason: "quota" };',
        '      if (round >= SIZE_ROUNDS + 1)\n        return { kind: "refused", reason: "quota" };',
      ),
  },
  {
    id: "MU-477",
    title:
      "R28 (revision 14): the recovery plan does not read the lease of the reservation",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-overlap.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended once/,
    patch: (t) =>
      sub(
        t,
        '    if (input.leaseLive !== undefined && !input.leaseLive())\n      return { result: { kind: "lease_lapsed" } };\n',
        "",
      ),
  },
  {
    id: "MU-478",
    title:
      "R28 (revision 14): the recovery port treats a lapsed hold as a saved copy",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-overlap.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended once/,
    patch: (t) =>
      sub(
        t,
        '            if (result.kind === "lease_lapsed") lapsed = true;',
        "            if (false) lapsed = true;",
      ),
  },
  {
    id: "MU-479",
    title:
      "R28 (revision 14): the recovery port does not hand the reservation's lease to the plan",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-overlap.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended once/,
    patch: (t) =>
      sub(
        t,
        "                capture_seq: seq,\n                writer_gen: claimed.gen,\n              },\n              held === undefined ? {} : { leaseLive: () => held.live() },",
        "                capture_seq: seq,\n                writer_gen: claimed.gen,\n              },\n              {},",
      ),
  },
  {
    id: "MU-480",
    title:
      "R28 (revision 14): the page commit plan does not read the lease of the reservation",
    file: "src/data/plans/commit-page.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended once: the page is admitted again/,
    patch: (t) =>
      sub(
        t,
        '    if (input.leaseLive !== undefined && !input.leaseLive())\n      return { result: { kind: "lease_lapsed" } };\n',
        "",
      ),
  },
  {
    id: "MU-481",
    title:
      "R28 (revision 14): the engine does not hand the reservation's lease to the page commit",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended once: the page is admitted again/,
    patch: (t) =>
      sub(t, "          leaseLive: () => reservation.live(),\n", ""),
  },
  {
    id: "MU-482",
    title:
      "R28 (revision 14): the engine reserves nothing for the page it commits (the response is committed on the early check, which holds no bytes)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the PAGE is the one refused|refuses at the commit)/,
    patch: (t) =>
      sub(
        t,
        '      const reservation = await deps.quota.reserve("cache", bytes.length);',
        '      const reservation = await deps.quota.reserve("cache", 0);',
      ),
  },
  {
    id: "MU-483",
    title: "R28 (revision 14): the engine commits a page its admission refused",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the PAGE is the one refused|refuses at the commit)/,
    patch: (t) =>
      sub(
        t,
        '        return reservation.unestablished === true ? "unestablished" : "refused";\n      }\n      let written = false;',
        "      }\n      let written = false;",
      ),
  },
  {
    id: "MU-484",
    title:
      "R28 (revision 14): the engine never records a committed page as landed (the next judgement does not see its bytes until the estimate shows them)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /landed bytes are recorded/,
    patch: (t) =>
      sub(
        t,
        '        reservation.settle(written ? "written" : "not_written");',
        '        reservation.settle("not_written");',
      ),
  },
  {
    id: "MU-485",
    title:
      "R28 (revision 14): the engine releases the reservation only for a page that was applied (a failed commit leaves its hold to lapse)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(a commit that FAILS releases the hold|genuine `quota` failure)/,
    patch: (t) =>
      sub(
        t,
        '        reservation.settle(written ? "written" : "not_written");',
        '        if (written) reservation.settle("written");',
      ),
  },
  {
    id: "MU-486",
    title:
      "R28 (revision 14): the engine re-admits a page whose hold keeps ending a thousand times (the pacing never applies)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /holds that end on all three admissions/,
    patch: (t) =>
      sub(
        t,
        "        if (!lapsed || round >= ADMISSION_ROUNDS)",
        "        if (!lapsed || round >= 1000)",
      ),
  },
  {
    id: "MU-487",
    title:
      "R28 (revision 14): the engine writes the crash-loop marker BEFORE the admission (a refused page leaves a marker the next start reads as a tab that did not survive)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /leaves no sizing marker/,
    patch: (t) =>
      sub(
        t,
        "    const admitted = await admitAndCommit(",
        "    await service.store.run(recordSizingAttempt, {\n      incarnationId: service.incarnationId,\n      id: deps.ids.uuid(),\n      limit,\n      startedAt: deps.clock.now(),\n    });\n    const admitted = await admitAndCommit(",
      ),
  },
  {
    id: "MU-488",
    title:
      "R30 (revision 14): a detach function acts on whichever leader stands now (an obsolete one cuts the replacement's engine, invalidation, outbox and recovery subscriptions)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(obsolete disposer|replaced leader's detach)/,
    patch: (t) => sub(t, "        if (attachment !== mine) return;\n", ""),
  },
  {
    id: "MU-489",
    title:
      "R30 (revision 14): a detach function is not spent by its first call (a repeated one carries what the detached engine admitted since)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a repeated disposer carries nothing new/,
    patch: (t) => sub(t, "        attachment = null;\n", ""),
  },
  {
    id: "MU-490",
    title:
      "R30 (revision 14): a detach function does not leave the attachment it made (a repeated disposer of the same leader attached twice detaches the later attachment)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the same leader attached again/,
    patch: (t) =>
      sub(
        t,
        "      const mine = {};\n      attachment = mine;",
        "      const mine = attachment ?? {};\n      attachment = mine;",
      ),
  },
  {
    id: "MU-492",
    title:
      "R28 (revision 14, re-expressed in revision 23 for R42): a page whose hold ended after its crash-loop marker was written and whose admission is then refused leaves the marker (the next start reads a refusal for want of space as a tab that did not survive): the lapsed round's marker is not retired",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hold that ended after the crash-loop marker was written/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (attempt !== null && !written && !lapsed)\n          await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-493",
    title:
      "R31 (revision 15): a stop of the controller forgets the invalidation a detached leader admitted (`dispose(); start()` reopens the cache the server called invalid)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /stopped and started|restart\(s\)|stop that is repeated/,
    patch: (t) =>
      sub(
        t,
        "    // `carried` is NOT forgotten (R31): a stop is reversible, and what a detached leader admitted may be recorded nowhere else.\n",
        "    carried = [];\n",
      ),
  },
  {
    id: "MU-494",
    title:
      "R31 (revision 15): a read of the facts that landed never ends a carried invalidation (a recovered cache at the old position, and a position that moved on, stay held)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/ui-env.test.ts",
      "tests/data/controller-invalidation-hold.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the durable state speaking ends it|dropped for good/,
    patch: (t) => sub(t, "          settleCarried(service, read.value);\n", ""),
  },
  {
    id: "MU-495",
    title:
      "R31 (revision 15): a carried invalidation outlives the cache's own status (once the invalidation is recorded and the cache replaced, the hold still hides a valid cache named by the same position)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the durable state speaking ends it/,
    patch: (t) => sub(t, '          value.cacheStatus === "valid" &&\n', ""),
  },
  {
    id: "MU-496",
    title:
      "R31 (revision 15): a carried invalidation is kept whatever position the facts name (a hold for a position that has moved on is never dropped)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dropped for good/,
    patch: (t) =>
      sub(
        t,
        '          value.cacheStatus === "valid" &&\n          hold.operation === value.invalidateOperation),',
        '          value.cacheStatus === "valid"),',
      ),
  },
  {
    id: "MU-497",
    title:
      "R31 (revision 15): a read of one account's facts decides the carried holds of every account (a visit to another account forgets this account's invalidation)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /another account's facts do not decide it/,
    patch: (t) => sub(t, "        hold.account !== service.account ||\n", ""),
  },
  {
    id: "MU-498",
    title:
      "R28 (revision 15): a refusal made because the accounting could not be established does not say so (the engine and the facade cannot tell it from a storage-full refusal)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/quota-cache-admission.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /unestablished|could not be established/,
    patch: (t) => sub(t, "          unestablished: true,\n", ""),
  },
  {
    id: "MU-499",
    title:
      "R28 (revision 15): a reservation whose ledger could not answer is ADMITTED (a judgement on a guess, invisible to every other page)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/production-quota.test.ts",
      "tests/data/outbox-quota-origin.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /unestablished|REJECTS every try|ledger persistent|cannot reach the ledger/,
    patch: (t) =>
      sub(
        t,
        "        forget(token);\n        return unestablishedFor(taken.free);",
        '        forget(token);\n        return { verdict: "ok", live: () => true, settle: () => undefined };',
      ),
  },
  {
    id: "MU-500",
    title:
      "R28 (revision 15): a ledger that does not ANSWER is asked again like one that rejects (a hung ledger costs every save the whole wait times the tries)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /does not ANSWER within the wait/,
    patch: (t) =>
      sub(
        t,
        "if (error === silent || attempt >= tries) throw",
        "if (attempt >= tries) throw",
      ),
  },
  {
    id: "MU-501",
    title:
      "R28 (revision 15): the wait between two tries of the ledger does not grow",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the tries are bounded/,
    patch: (t) =>
      sub(
        t,
        "await sleep(retryMs * 2 ** (attempt - 1));",
        "await sleep(retryMs);",
      ),
  },
  {
    id: "MU-502",
    title:
      "R28 (revision 15): a hold that a lost answer may have left is not taken out again when the reservation is refused for want of an answer",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a refusal because the answer never came/,
    patch: (t) => sub(t, "        forget(token);\n", ""),
  },
  {
    id: "MU-503",
    title:
      "R28 (revision 15): a call that is asked again counts the hold its own earlier try made (a lost answer refuses a write that fits)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /answer was LOST/,
    patch: (t) =>
      sub(
        t,
        "const { [token]: _earlier, ...others } = live.state.holds;",
        "const others = live.state.holds;",
      ),
  },
  {
    id: "MU-504",
    title:
      "R28 (revision 15): the sync engine stops with the storage-full notice for a page whose admission could not be established",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/quota-cache-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /not a storage stop|paced, and committed once/,
    patch: (t) =>
      sub(
        t,
        '        return reservation.unestablished === true ? "unestablished" : "refused";',
        '        return "refused";',
      ),
  },
  {
    id: "MU-505",
    title:
      "R28 (revision 15): an unavailable ESTIMATE is refused when the accounting could not be established (the approved `unknown` is lost)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /unavailable ESTIMATE|unavailable estimate/,
    patch: (t) =>
      sub(
        t,
        "    free === null\n      ? // No estimate",
        "    false\n      ? // No estimate",
      ),
  },
  {
    id: "MU-506",
    title:
      "R28 (revision 15): the advisory `check` refuses on a guess when the ledger cannot be read",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`check` stays advisory|falls back the same way/,
    patch: (t) =>
      sub(
        t,
        /judged = judge\(\s*known\.view,[\s\S]*?known\.state\.landed,\s*\);/,
        'judged = { effective: taken.free, verdict: "refuse" };',
      ),
  },
  {
    id: "MU-507",
    title:
      "R28 (revision 15): a hold is not flagged as owned (every hold lapses with its lease, however alive its writer)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/quota-lease.test.ts",
      "tests/data/outbox-quota-origin.test.ts",
      "tests/data/quota-cache-admission.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ownership|owner|lease ran out|DELAYED|suspended|destroyed/,
    patch: (t) =>
      sub(
        t,
        "                    ...(claim === null ? {} : { owned: true }),\n",
        "",
      ),
  },
  {
    id: "MU-508",
    title:
      "R28 (revision 15): an owned hold is judged by the clock like any other (a suspended writer loses its hold when the lease ends)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/outbox-quota-origin.test.ts",
      "tests/data/quota-cache-admission.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(pre-transaction delay|in-progress commit|DELAYED|suspended|lease is long over)/,
    patch: (t) =>
      sub(
        t,
        "      hold.owned === true\n        ? proven?.has(token) === true\n        : !(",
        "      false\n        ? proven?.has(token) === true\n        : !(",
      ),
  },
  {
    id: "MU-509",
    title:
      "R28 (revision 15): the owners of the holds a refusal counted are never asked (a destroyed page's hold is never reclaimed before its lease ends)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(destroyed|dead owner|freed at once|reclaimed on proof)/,
    patch: (t) =>
      sub(
        t,
        "          admission.candidates.length > 0 &&\n          owners !== undefined",
        "          false &&\n          owners !== undefined",
      ),
  },
  {
    id: "MU-510",
    title:
      "R28 (revision 15): a hold is reclaimed on proof only once its lease is over",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /reclaimed on proof even before its lease ends/,
    patch: (t) =>
      sub(
        t,
        "        ? proven?.has(token) === true\n",
        "        ? proven?.has(token) === true && now >= hold.until\n",
      ),
  },
  {
    id: "MU-511",
    title:
      "R28 (revision 15): the ownership is given up BEFORE the settlement is asked of the ledger (the hold has no owner while it is still in the record)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
      "tests/data/outbox-quota-origin.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /AFTER|given up only|completion notification is delayed/,
    patch: (t) =>
      sub(
        t,
        "          held.settled = true;\n          untrack(held);",
        "          held.settled = true;\n          untrack(held);\n          held.claim?.release();",
      ),
  },
  {
    id: "MU-512",
    title:
      "R28 (revision 15): the ownership is never given up after a settlement (the lock outlives the write for the life of the page)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
      "tests/data/quota-lease.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ownership|given up|owner has let go|AFTER/,
    patch: (t) =>
      sub(t, "      held.claim?.release();\n    })();", "    })();"),
  },
  {
    id: "MU-513",
    title:
      "R28 (revision 15): a refused reservation keeps the ownership it claimed",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /refused one holds none|holds no lock/,
    patch: (t) =>
      sub(
        t,
        '      if (admission.verdict === "refuse") {\n        claim?.release();',
        '      if (admission.verdict === "refuse") {',
      ),
  },
  {
    id: "MU-514",
    title:
      "R28 (revision 15): a reservation whose ledger could not answer keeps the ownership it claimed",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /refused as unestablished, nothing held|could not be written is let go|REJECTS every try/,
    patch: (t) =>
      sub(
        t,
        "      } catch {\n        claim?.release();\n        // The change may have been applied",
        "      } catch {\n        // The change may have been applied",
      ),
  },
  {
    id: "MU-515",
    title:
      "R28 (revision 15): a claim that cannot be made admits the write all the same (a hold that could be reclaimed under a suspended writer)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /cannot be claimed|lock manager that fails/,
    patch: (t) =>
      sub(
        t,
        "        if (claim === null) return unestablishedFor(taken.free);\n",
        "",
      ),
  },
  {
    id: "MU-516",
    title:
      "R28 (revision 15, re-expressed in revision 16): a leaked reservation is revoked at `quotaHoldMaxAgeMs` but its end is never published (its hold and its ownership outlive it for the life of the page)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /older than `quotaHoldMaxAgeMs` is a leak/,
    patch: (t) =>
      sub(
        t,
        '      untrack(held);\n      conclude(held, "not_written");\n      return;',
        "      untrack(held);\n      return;",
      ),
  },
  {
    id: "MU-517",
    title:
      "R28 (revision 15): a lock manager that throws on a probe is taken as proof that the owner let go",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /throws gives no ownership and proves nothing/,
    patch: (t) =>
      sub(
        t,
        "      } catch {\n        return false;\n      }\n    },\n  };",
        "      } catch {\n        return true;\n      }\n    },\n  };",
      ),
  },
  {
    id: "MU-518",
    title:
      "R28 (revision 15): the production guard builds the origin's ledger without the page's locks (every hold is reclaimed by its lease alone)",
    file: "src/data/ui/production-quota.ts",
    tests: ["tests/data/production-quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(lock that owns a hold|review's schedule through the real adapter)/,
    patch: (t) =>
      sub(
        t,
        "      ? createIdbLedger(options?.factory, locks)",
        "      ? createIdbLedger(options?.factory)",
      ),
  },
  {
    id: "MU-519",
    title:
      "R28 (revision 15): the number of owners one judgement asks about is not bounded",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the work of a judgement is bounded/,
    patch: (t) =>
      sub(
        t,
        "                      .map(([other]) => other)\n                      .slice(0, PROOF_LIMIT),",
        "                      .map(([other]) => other),",
      ),
  },
  {
    id: "MU-520",
    title:
      "R28 (revision 15): the stored record forgets which holds are owned (every hold read back lapses with its lease)",
    file: "src/data/store/quota-ledger.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(keeps the `owned` flag|alive|lock that owns a hold|review's schedule through the real adapter)/,
    patch: (t) =>
      sub(
        t,
        "          ...(entry.owned === true ? { owned: true } : {}),\n",
        "",
      ),
  },
  {
    id: "MU-521",
    title:
      "R28 (revision 15): the proof of one owner is taken as the proof of every owner a refusal counted",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dead owner, then the control/,
    patch: (t) =>
      sub(
        t,
        "          const over = answers\n            .filter(([, released]) => released)\n            .map(([other]) => other);",
        "          const over = answers.some(([, released]) => released)\n            ? answers.map(([other]) => other)\n            : [];",
      ),
  },
  {
    id: "MU-522",
    title:
      "R28 (revision 15): a refusal that has proven some owners over is not judged again (the room they held stays unused)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-owners.test.ts",
      "tests/data/outbox-quota-origin.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(reclaimed on proof|destroyed|dead owner)/,
    patch: (t) =>
      sub(
        t,
        "          if (over.length > 0) admission = await admit(new Set(over));",
        "          if (over.length > 0) void over;",
      ),
  },
  {
    id: "MU-527",
    title:
      "R28 (revision 16): a hold reclaimed on proof (its owner destroyed or released) is deleted instead of landed (the bytes of a write that may have committed vanish from the account: the review's schedule)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-owners.test.ts",
      "tests/data/production-quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(destroyed|reclaimed on proof|release that is not published|unpublished settlement)/,
    patch: (t) =>
      sub(
        t,
        "      landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
        "      if (hold.owned !== true)\n        landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
      ),
  },
  {
    id: "MU-528",
    title:
      "R28 (revision 16): a hold whose lease lapsed is deleted instead of landed (a suspended writer's bytes vanish from the account when the lease ends)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
      "tests/data/quota-owners.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(stops renewing|lease ran out|without the flag lapses|lease ends|hold stands while the lease runs|lapsed lease|rejected for good)/,
    patch: (t) =>
      sub(
        t,
        "      landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
        "      if (hold.owned === true)\n        landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
      ),
  },
  {
    id: "MU-529",
    title:
      "R28 (revision 16): a landing is not once per hold (a settlement repeated because its answer was lost counts its bytes twice)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(ONCE PER HOLD|answer lost|answers lost|counted once)/,
    patch: (t) =>
      sub(
        t,
        "  if (landed?.settled?.includes(token) === true) return landed;\n",
        "",
      ),
  },
  {
    id: "MU-530",
    title:
      "R28 (revision 16): a landing does not record the token of the hold it counted (nothing can tell that it was counted)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(ONCE PER HOLD|answer lost|answers lost|counted once)/,
    patch: (t) =>
      sub(
        t,
        "[...(landed?.settled ?? []), token].slice(-SETTLED_KEPT);",
        "[...(landed?.settled ?? [])].slice(-SETTLED_KEPT);",
      ),
  },
  {
    id: "MU-531",
    title:
      "R28 (revision 16): the landed entry remembers every token it has counted (its record grows without a bound under a steady stream of writes)",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /SETTLED_KEPT/,
    patch: (t) =>
      sub(
        t,
        "[...(landed?.settled ?? []), token].slice(-SETTLED_KEPT);",
        "[...(landed?.settled ?? []), token];",
      ),
  },
  {
    id: "MU-532",
    title:
      "R28 (revision 16): a settlement the ledger rejects twice is not offered again (the ownership is given up after two tries and the hold is left to whoever reclaims it)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-owners.test.ts",
      "tests/data/quota-lease.test.ts",
      "tests/data/outbox-quota-lease.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(rejected twice|rejected until healed|THIRD try|KEEPS the ownership)/,
    patch: (t) =>
      sub(
        t,
        "          if (attempt >= 2) {\n            if (waited >= leaseMs) break;\n",
        "          if (attempt >= 2) {\n            break;\n",
      ),
  },
  {
    id: "MU-533",
    title:
      "R28 (revision 16): a settlement is offered for ever (no bound after a lease of waiting)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /stop after a lease/,
    patch: (t) => sub(t, "            if (waited >= leaseMs) break;\n", ""),
  },
  {
    id: "MU-534",
    title:
      "R28 (revision 16): closing the guard does not stop the offers of an unpublished settlement (or let go of the ownership)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /closing the guard stops the offers/,
    patch: (t) => sub(t, "      closes += 1;\n", ""),
  },
  {
    id: "MU-535",
    title:
      "R28 (revision 16): reading `live()` as true is not the writer beginning (an unfinished commit is treated as a reservation that never began)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-lease.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /BEGAN/,
    patch: (t) => sub(t, "          held.started = true;\n", ""),
  },
  {
    id: "MU-536",
    title:
      "R28 (revision 16): the maximum age revokes a reservation whose writer BEGAN (the review's second schedule: an unfinished commit loses its accounting)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-lease.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /BEGAN/,
    patch: (t) =>
      sub(
        t,
        "    if (!held.started && time() - held.born >= maxAgeMs) {",
        "    if (time() - held.born >= maxAgeMs) {",
      ),
  },
  {
    id: "MU-537",
    title:
      "R28 (revision 16): a reservation revoked at its age is published as a write that landed (the room it held is lost to a debit for a write that could not begin)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-settlement.test.ts",
      "tests/data/quota-lease.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /never began is a leak/,
    patch: (t) =>
      sub(
        t,
        '      conclude(held, "not_written");\n      return;',
        '      conclude(held, "written");\n      return;',
      ),
  },
  {
    id: "MU-538",
    title:
      "R28 (revision 16): a revoked reservation whose writer nevertheless says `written` is dropped (the bytes of a write that landed are never counted)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nevertheless says `written`/,
    patch: (t) =>
      sub(
        t,
        '          if (held.revoked && outcome === "not_written") return;\n',
        "          if (held.revoked) return;\n",
      ),
  },
  {
    id: "MU-539",
    title:
      "R28 (revision 16): a revoked reservation whose writer says `not_written` publishes its end a second time (an extra change of the ledger for a settlement that has been published)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nevertheless says `written`/,
    patch: (t) =>
      sub(
        t,
        '          if (held.revoked && outcome === "not_written") return;\n',
        "",
      ),
  },
  {
    id: "MU-540",
    title:
      "R28 (revision 16): a writer's own hold is judged by its lease before its settlement takes effect (`not_written` after a lapsed lease leaves a debit for a write that did not happen)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /writer's own word decides its own hold/,
    patch: (t) =>
      sub(
        t,
        "      const live = aged(\n        { holds: others, landed: state.landed },\n        now,\n        undefined,\n        held.base,\n      );",
        "      const live = aged(state, now, undefined, held.base);",
      ),
  },
  {
    id: "MU-541",
    title:
      "R28 (revision 16): a hold does not record the figure it was judged against (a reclaiming page lands its bytes against its own)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /figure the hold was judged on/,
    patch: (t) => sub(t, "base: judged.effective,", ""),
  },
  {
    id: "MU-542",
    title: "R28 (revision 16): the stored record forgets the figure of a hold",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`base` is a figure or `null`/,
    patch: (t) =>
      sub(
        t,
        "          ...(entry.base === null || finite(entry.base)\n            ? { base: entry.base }\n            : {}),\n",
        "",
      ),
  },
  {
    id: "MU-543",
    title:
      "R28 (revision 16): the stored record forgets which holds the landed entry has counted",
    file: "src/data/store/quota-ledger.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`settled` is a list of strings/,
    patch: (t) =>
      sub(t, "      ...(settled.length === 0 ? {} : { settled }),\n", ""),
  },
  {
    id: "MU-544",
    title:
      "R28 (revision 16): the advisory fallback reads what the ledger last showed without ageing it (a lapsed hold is landed again from every later call and never lapses)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-lease.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /what the origin last showed of the other pages/,
    patch: (t) =>
      sub(
        t,
        "    remember(live.state);\n    return live;\n",
        "    return live;\n",
      ),
  },
  {
    id: "MU-545",
    title:
      "R28 (revision 16): a judgement does not pass its own figure to the reclaim (a hold of an older build that recorded none lands nothing)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-owners.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(without the flag lapses|older build|recorded no figure)/,
    patch: (t) =>
      sub(
        t,
        "const live = aged(state, now, proven, reading.free);",
        "const live = aged(state, now, proven);",
      ),
  },
  {
    id: "MU-549",
    title:
      "R28 (revision 16): a settlement lands the lapsed holds of other pages without the figure of its own reservation (a hold of an older build that recorded none is dropped)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /lapses while this page SETTLES/,
    patch: (t) =>
      sub(
        t,
        "        undefined,\n        held.base,\n      );\n      const left: LedgerState",
        "        undefined,\n        null,\n      );\n      const left: LedgerState",
      ),
  },
  {
    id: "MU-550",
    title:
      "R28 (revision 16): a renewal lands the lapsed holds of other pages without the figure of its own reservation (a hold of an older build that recorded none is dropped)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-settlement.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /lapses while this page RENEWS/,
    patch: (t) =>
      sub(
        t,
        "const live = aged(state, now, undefined, held.base);",
        "const live = aged(state, now, undefined, null);",
      ),
  },
  {
    id: "MU-551",
    title:
      "R28 (revision 17): a reading is stamped with the instant it was DELIVERED, not the instant its request began (an answer that arrives after the debit's end looks as fresh as one requested after it)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-estimate-age.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(answered after it is not used either|answer crosses debit expiry)/,
    patch: (t) =>
      sub(
        t,
        "      const reading: Sample = { start, free };",
        "      const reading: Sample = { start: time(), free };",
      ),
  },
  {
    id: "MU-552",
    title:
      "R28 (revision 17): the cap does not apply to a reading that began before the entry's `until` (a lagging reading spends the bytes of a write that may not be shown yet)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(answered while the debit still stands|advisory check, when the ledger cannot be read at the boundary|taken inside the debit's lifetime)/,
    patch: (t) =>
      sub(
        t,
        "  ): boolean => !fresh(reading, now) || reading.start < landed.until;",
        "  ): boolean => !fresh(reading, now);",
      ),
  },
  {
    id: "MU-553",
    title:
      "R28 (revision 17): the landed entry is retired at its `until`, not one lifetime after it (a reading that began before it is judged against entries that have gone: the review's first schedule)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-estimate-age.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(taken inside the debit's lifetime|kept one further lifetime|cached-before-expiry)/,
    patch: (t) =>
      sub(
        t,
        "    } else if (now >= reaches(landed) + limits.ttlMs) {",
        "    } else if (now >= landed.until) {",
      ),
  },
  {
    id: "MU-554",
    title:
      "R28 (revision 17): a reading is judged however old it is when the ledger applies the change (a reading that waited for the ledger longer than a lifetime is judged against entries that have been retired)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /waited for the ledger longer than a lifetime/,
    patch: (t) =>
      sub(
        t,
        "    !usable(reading, now) ||\n    (reading.free !== null &&",
        "    (reading.free !== null &&",
      ),
  },
  {
    id: "MU-555",
    title:
      "R28 (revision 17): no new reading is asked for at the boundary (a reading that predates a debit that has run out is used, capped, instead of replaced)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(asks again at the boundary|taken inside the debit's lifetime|began inside the lifetime and was answered after it)/,
    patch: (t) => sub(t, "      now >= state.landed.until);", "      false);"),
  },
  {
    id: "MU-556",
    title:
      "R28 (revision 17): a reservation asks again for a fresh reading without a bound that is its tries (a reading that is always too old is asked for a thousand times)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /cannot be judged on a fresh reading within its tries/,
    patch: (t) =>
      sub(
        t,
        "          if (round >= attempts) throw new LedgerUnavailable();",
        "          if (round >= 1000) throw new LedgerUnavailable();",
      ),
  },
  {
    id: "MU-557",
    title:
      "R28 (revision 17): an invalidation does not drop the request on its way (the next judgement joins a request that began before the write it was told of)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /invalidate drops the request on its way/,
    patch: (t) =>
      sub(
        t,
        "    cached = null;\n    pending = null;\n    epoch += 1;\n  };",
        "    cached = null;\n    epoch += 1;\n  };",
      ),
  },
  {
    id: "MU-558",
    title:
      "R28 (revision 17): the answer of a request that began before an invalidation is cached when it arrives (a reading from before the write becomes the reading in use)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /never cached/,
    patch: (t) =>
      sub(
        t,
        "      if (epoch === asked && (cached === null || cached.start <= start))",
        "      if (cached === null || cached.start <= start)",
      ),
  },
  {
    id: "MU-559",
    title:
      "R28 (revision 17): a step of the clock found by the guard does not drop its readings (they are stamped in the scale before it)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(no age at all|drops its readings, the request on its way included)/,
    patch: (t) => sub(t, "    onStep: dropReadings,", "    onStep: undefined,"),
  },
  {
    id: "MU-560",
    title:
      "R28 (revision 17): a look that clamps an entry, or takes it to have just landed, does not write it back (the next look adjusts it afresh, to a later end, for as long as nothing else writes)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(writes it back, once|has written it back)/,
    patch: (t) =>
      sub(
        t,
        "          if (looked.adjusted) repair(reading.free);",
        "          void looked.adjusted;",
      ),
  },
  {
    id: "MU-561",
    title:
      "R28 (revision 17): a reading stamped after the clock went back is fresh (a negative age is no age, and the reading is used for as long as the clock is behind)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /no age at all/,
    patch: (t) =>
      sub(
        t,
        "    return age >= 0 && age < config.quotaEstimateTtlMs;",
        "    return age < config.quotaEstimateTtlMs;",
      ),
  },
  {
    id: "MU-562",
    title:
      "R28 (revision 17): the guard has no monotonic clock whatever the page supplies (a step forwards is time passing)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(FORWARDS, found by a page that lived through it|drops its readings, the request on its way included|written it back)/,
    patch: (t) =>
      sub(t, "    monotonic: options.monotonic,", "    monotonic: undefined,"),
  },
  {
    id: "MU-563",
    title:
      "R28 (revision 17): an entry that ends further ahead than its lifetime allows is DROPPED (revision 16: a step of the clock is read as proof that the write is reflected in the estimate)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-estimate-age.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(BACKWARDS|ends further ahead than its own lifetime allows|rollback=true)/,
    patch: (t) =>
      sub(
        t,
        "    } else if (landed.until - now > limits.ttlMs) {\n      landed = { ...landed, until: now + limits.ttlMs };\n      changed = true;\n      adjusted = true;\n    }",
        "    } else if (landed.until - now > limits.ttlMs) {\n      landed = null;\n      changed = true;\n    }",
      ),
  },
  {
    id: "MU-564",
    title:
      "R28 (revision 17): a page that has found a step forwards does not take the landed entry to have just landed (a step of the wall clock is read as the end of the debit)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-estimate-age.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(FORWARDS, found by a page that lived through it|an hour forwards)/,
    patch: (t) =>
      sub(
        t,
        "    if (distrust && landed.until < now + limits.ttlMs) {",
        "    if (false) {",
      ),
  },
  {
    id: "MU-565",
    title:
      "R28 (revision 17): the wall clock is distrusted for ever after a step forwards, not for one lifetime of real time (every landed entry is extended at every look: a debit that is never retired)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(one lifetime of REAL time|lasts one lifetime of REAL time and no longer)/,
    patch: (t) =>
      sub(
        t,
        "      return Number.isFinite(steady) && steady < distrustedUntil;",
        "      return Number.isFinite(steady);",
      ),
  },
  {
    id: "MU-566",
    title:
      "R28 (revision 17): a step BACKWARDS also distrusts the wall clock (a stamp that is further ahead than its lifetime is clamped by the ledger; distrust would extend every entry as well)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /BACKWARDS is announced/,
    patch: (t) =>
      sub(
        t,
        "          if (moved > 0) distrustedUntil = steady + windowMs;",
        "          distrustedUntil = steady + windowMs;",
      ),
  },
  {
    id: "MU-567",
    title:
      "R28 (revision 17): any difference between the two clocks is a step (jitter and drift are read as steps)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(exactly the slack is jitter|drift below the slack)/,
    patch: (t) =>
      sub(
        t,
        "        if (Math.abs(moved) > slackMs) {",
        "        if (moved !== 0) {",
      ),
  },
  {
    id: "MU-568",
    title:
      "R28 (revision 17): a step found is not announced (the guard keeps readings stamped before it)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(announced once|each announced|announced as they are found|drops its readings)/,
    patch: (t) => sub(t, "          onStep?.(moved);\n", ""),
  },
  {
    id: "MU-569",
    title:
      "R28 (revision 17): a reading does not move the anchors it compares the next one with (the same step is found again at every reading)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(announced once|each announced|announced as they are found|drift below the slack)/,
    patch: (t) =>
      sub(
        t,
        "        lastWall = reading;\n        lastMonotonic = steady;\n",
        "",
      ),
  },
  {
    id: "MU-570",
    title:
      "R28 (revision 17): a clock that answers something that is not a number is followed (its anchors become not-a-number and no step is found again)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /not a number/,
    patch: (t) =>
      sub(
        t,
        "      if (Number.isFinite(reading) && Number.isFinite(steady)) {",
        "      if (true) {",
      ),
  },
  {
    id: "MU-571",
    title:
      "R28 (revision 17): the production composition supplies no monotonic clock whatever the page has (a step forwards is time passing in the application)",
    file: "src/data/ui/production-quota.ts",
    tests: ["tests/data/production-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /follows the wall clock by the page's monotonic clock/,
    patch: (t) => sub(t, "    ...(monotonic ? { monotonic } : {}),\n", ""),
  },
  {
    id: "MU-572",
    title:
      "R28 (revision 17): a reading that began exactly AT the debit's end is taken to predate it (an estimate asked for twice at the boundary)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /boundaries are exact/,
    patch: (t) =>
      sub(
        t,
        "      reading.start < state.landed.until &&",
        "      reading.start <= state.landed.until &&",
      ),
  },
  {
    id: "MU-573",
    title:
      "R28 (revision 17): at the instant the debit ends a reading that began before it is not yet replaced (it is capped for one more instant)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /boundaries are exact/,
    patch: (t) =>
      sub(
        t,
        "      now >= state.landed.until);",
        "      now > state.landed.until);",
      ),
  },
  {
    id: "MU-574",
    title:
      "R28 (revision 17): a reading is used for a lifetime and one millisecond more",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /not a millisecond more/,
    patch: (t) =>
      sub(
        t,
        "    return age >= 0 && age < config.quotaEstimateTtlMs;",
        "    return age >= 0 && age <= config.quotaEstimateTtlMs;",
      ),
  },
  {
    id: "MU-575",
    title:
      "R28 (revision 17): a reading that began exactly AT the debit's end is capped (the boundary of `mayLack` is exclusive of the end)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /boundaries are exact/,
    patch: (t) =>
      sub(
        t,
        "  ): boolean => !fresh(reading, now) || reading.start < landed.until;",
        "  ): boolean => !fresh(reading, now) || reading.start <= landed.until;",
      ),
  },
  {
    id: "MU-576",
    title:
      "R28 (revision 17): the write-back of a look changes nothing (the repair asks the ledger for a change and gives it none)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-estimate-age.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(writes it back, once|has written it back)/,
    patch: (t) =>
      sub(
        t,
        "        return { state: live.changed ? live.state : null, result: undefined };\n      });\n    if (!shared.shared) {",
        "        return { state: null, result: undefined };\n      });\n    if (!shared.shared) {",
      ),
  },
  {
    id: "MU-581",
    title:
      "R28b (revision 18): every stamp is believed whatever this page's anchor says (an entry stamped before the page's clocks began to be checked is judged by the age its stamp gives it: the review's schedule, a debit deleted by a page that opened after a step)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ms forwards|ms backwards|the public outbox: |the new page first|every original page closed)/,
    patch: (t) =>
      sub(t, "    entry.until - limits.ttlMs < anchor;", "    false;"),
  },
  {
    id: "MU-582",
    title:
      "R28b (revision 18): an entry the page did not see land is taken to have landed AT the anchor, with no lifetime of cap after it (it caps nothing a reading that began after the anchor can see)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ms forwards|the public outbox: |the new page first|every original page closed|a reading begun before one lifetime)/,
    patch: (t) =>
      sub(
        t,
        "Math.max(entry.until, Math.min(anchor, now) + limits.ttlMs)",
        "Math.max(entry.until, Math.min(anchor, now))",
      ),
  },
  {
    id: "MU-583",
    title:
      "R28b (revision 18): the page's extension slides with the clock (an entry it did not see land is taken to have landed just now, at every look: it caps for ever and is never retired)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-new-page.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a reading begun before one lifetime|the entry stays in the ledger for one more lifetime|has long passed both lifetimes|a page that was open when the write landed)/,
    patch: (t) =>
      sub(
        t,
        "Math.max(entry.until, Math.min(anchor, now) + limits.ttlMs)",
        "Math.max(entry.until, now + limits.ttlMs)",
      ),
  },
  {
    id: "MU-584",
    title:
      "R28b (revision 18): the page's view of an entry it did not see land is WRITTEN BACK (a look of one page extends the entry for the others, and two pages looking at each other's extensions would extend it for ever)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the entry stays in the ledger for one more lifetime|adds nothing of its own|keeps the debit: the room is held)/,
    patch: (t) =>
      sub(
        t,
        "  const next = changed ? { holds, landed } : state;",
        "  if (landed !== null && unwitnessed(landed)) {\n    landed = { ...landed, until: reaches(landed) };\n    changed = true;\n  }\n  const next = changed ? { holds, landed } : state;",
      ),
  },
  {
    id: "MU-585",
    title:
      "R28b (revision 18): the guard ignores its clock's anchor (the production composition judges every stamp by its own age, as revision 17 did)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/production-quota.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ms forwards|ms backwards|opens after a step of the wall clock keeps the debit|the writing page)/,
    patch: (t) =>
      sub(t, "      clock.anchor(),", "      Number.NEGATIVE_INFINITY,"),
  },
  {
    id: "MU-586",
    title:
      "R28b (revision 18): a refusal that only the page's view of an entry it did not see land makes is not flagged `unestablished` (the engine stops with a storage notice for the page's own lack of knowledge)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-cache-admission.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(user input is the last thing refused|only the page's extension makes is|asks again, paced)/,
    patch: (t) =>
      sub(
        t,
        /\.\.\.\(verdict === "refuse" && believed !== "refuse"\s*\? \{ unestablished: true \}\s*: \{\}\),/,
        "",
      ),
  },
  {
    id: "MU-587",
    title:
      "R28b (revision 18): EVERY refusal of a judgement is flagged `unestablished` (a storage-full refusal is mistaken for the page's lack of knowledge, and the engine never stops for want of space)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-lease.test.ts",
      "tests/data/quota-origin-ledger.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(only the page's extension makes is|`unestablished`|unestablished)/,
    patch: (t) =>
      sub(
        t,
        'verdict === "refuse" && believed !== "refuse"',
        'verdict === "refuse"',
      ),
  },
  {
    id: "MU-588",
    title:
      "R28b (revision 18): the advisory `check` refuses on the page's lack of knowledge (it stops the engine with a storage notice on an entry the page cannot date)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-cache-admission.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(advisory `check` refuses nothing|early check does not stop the engine|what the ledger last showed is kept)/,
    patch: (t) =>
      sub(
        t,
        '      return judged.unestablished === true ? "unknown" : judged.verdict;',
        "      return judged.verdict;",
      ),
  },
  {
    id: "MU-589",
    title:
      "R28b (revision 18): a reservation refused for the page's lack of knowledge does not say so (the engine stops with a storage notice instead of asking again, paced)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-cache-admission.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(user input is the last thing refused|only the page's extension makes is|asks again, paced)/,
    patch: (t) =>
      sub(
        t,
        "          ...(admission.unestablished === true ? { unestablished: true } : {}),\n",
        "",
      ),
  },
  {
    id: "MU-590",
    title:
      "R28b (revision 18): the advisory `check` judges on the entry as its stamps say it is, not on the page's view of it",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-new-page.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(advisory `check` refuses nothing|what the ledger last showed is kept|the advisory check across the boundary)/,
    patch: (t) =>
      sub(
        t,
        "                  judged: judge(\n                    live.view,",
        "                  judged: judge(\n                    live.state,",
      ),
  },
  {
    id: "MU-591",
    title:
      "R28b (revision 18): a reservation is judged on the entry as its stamps say it is, not on the page's view of it (the review's schedule: the second save is admitted)",
    file: "src/data/engine/quota-guard.ts",
    tests: [
      "tests/data/quota-new-page.test.ts",
      "tests/data/outbox-quota-estimate.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ms forwards|the public outbox: |the new page first|every original page closed)/,
    patch: (t) =>
      sub(
        t,
        "                { holds: others, landed: live.view.landed },",
        "                { holds: others, landed: live.state.landed },",
      ),
  },
  {
    id: "MU-592",
    title:
      "R28b (revision 18): a reservation does not ask for a new reading at the end of the page's extension (it is judged, and capped, on a reading that began inside the lifetime)",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-new-page.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a request begun inside the lifetime and answered after it is not used|replaced at the boundary)/,
    patch: (t) =>
      sub(
        t,
        "              if (needsNewer(live.view, reading, now)) {",
        "              if (needsNewer(live.state, reading, now)) {",
      ),
  },
  {
    id: "MU-593",
    title:
      "R28b (revision 18): the advisory `check` does not ask for a new reading at the end of the page's extension",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-new-page.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the advisory check across the boundary asks again too/,
    patch: (t) =>
      sub(
        t,
        "                  newer: needsNewer(live.view, reading, now),",
        "                  newer: needsNewer(live.state, reading, now),",
      ),
  },
  {
    id: "MU-594",
    title:
      "R28b (revision 18): the advisory fallback, when the ledger cannot be read, counts what the ledger last showed as its stamps say it is, not as the page took it to be",
    file: "src/data/engine/quota-guard.ts",
    tests: ["tests/data/quota-new-page.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /what the ledger last showed is kept as the PAGE saw it/,
    patch: (t) =>
      sub(
        t,
        "          known.view,\n          taken,",
        "          known.state,\n          taken,",
      ),
  },
  {
    id: "MU-595",
    title:
      "R28b (revision 18): a step the clock finds does not move the anchor (the stretch a page has checked does not start again at it, and a stamp made before the step is believed after it)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-new-page.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a step found, forwards or backwards, moves the anchor|a clock that opens after a step is anchored after it)/,
    patch: (t) =>
      sub(
        t,
        "          anchored = reading;\n          onStep?.(moved);",
        "          onStep?.(moved);",
      ),
  },
  {
    id: "MU-596",
    title:
      "R28b (revision 18): a wall clock that reads less than the anchor is not re-anchored (a clock set back leaves the anchor ahead of it, and the page's extension of an entry never ends)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-new-page.test.ts",
      "tests/data/quota-estimate-age.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(re-anchors there|reading LESS than it did|jitter that is not a step|ms backwards|a step an hour BACKWARDS)/,
    patch: (t) =>
      sub(
        t,
        "if (Number.isFinite(reading) && reading < anchored) anchored = reading;",
        "void reading;",
      ),
  },
  {
    id: "MU-597",
    title:
      "R28b (revision 18): a page with no monotonic clock has no anchor (every stamp it reads is believed, as revision 17 did: the review's schedule for a page that has only the wall clock)",
    file: "src/data/engine/quota-clock.ts",
    tests: [
      "tests/data/quota-clock.test.ts",
      "tests/data/quota-new-page.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the new page has the wall clock only|with and without a monotonic clock|the wall clock only)/,
    patch: (t) =>
      sub(
        t,
        "      distrusted: () => false,\n      anchor: () => anchored,",
        "      distrusted: () => false,\n      anchor: () => Number.NEGATIVE_INFINITY,",
      ),
  },
  {
    id: "MU-598",
    title:
      "R33 (revision 18): the claim of a writer generation CREATES a terminal row for a form that has none (the key of any length is written before the quota guard is asked, and a refused save leaves it behind)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-quota.test.ts",
      "tests/data/form-recovery-overlap.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(creates NOTHING|no row is left|creates no record|nothing is created|leave no row)/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  decide: ({ sync, reads: stored }) => {",
          "  decide: ({ sync, reads: stored, input }) => {",
        ),
        "      ...(stored === undefined\n        ? {}\n        : {",
        '      ...(stored === undefined\n        ? {\n            writes: [\n              w.put("form_recovery", {\n                form_context: input.formContext,\n                tab_instance_id: input.tabInstanceId,\n                fields: {},\n                redacted: [],\n                saved_at: input.now,\n                capture_seq: 0,\n                writer_gen: gen,\n                terminal: true,\n                content_digest: "",\n              }),\n            ],\n          }\n        : {',
      ),
  },
  {
    id: "MU-599",
    title:
      "R33 (revision 18): a claim of a form with no row does not move the database's counter (two contexts that claim one after the other get the same generation, and the older one's capture is not refused)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-quota.test.ts",
      "tests/data/form-recovery-overlap.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(counter|one counter orders them all|NOTHING|different generations|later generation)/,
    patch: (t) =>
      sub(
        t,
        "      sync: { ...sync, form_writer_gen: gen },",
        "      sync: stored === undefined ? sync : { ...sync, form_writer_gen: gen },",
      ),
  },
  {
    id: "MU-600",
    title:
      "R33 (revision 18): a write that was not to create a row creates it (a discard of a form that has no row writes its terminal row before the guard has been asked)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-quota.test.ts",
      "tests/data/form-recovery-overlap.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(discard of a form that has no row|below the floor nothing is created|reserved at the size of the terminal row)/,
    patch: (t) =>
      sub(t, "    if (!stored && input.mayCreate === false)", "    if (false)"),
  },
  {
    id: "MU-601",
    title:
      "R33 (revision 18): the recovery estimate counts the values alone (the row's context, tab id, timestamp, digest and keys are stored and never admitted: the review's 900,000-character context saved in 500,000 bytes of room)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(whole row is sized|900,000-character|boundary is the figure|old estimate stood)/,
    patch: (t) =>
      sub(
        t,
        "  return RECOVERY_ALLOWANCE_BYTES + UNIT_BYTES * (measured.length + keyed);",
        '  return RECOVERY_ALLOWANCE_BYTES + UNIT_BYTES * Object.values(row.fields).join("").length;',
      ),
  },
  {
    id: "MU-602",
    title:
      "R33 (revision 18): the copies of a row's key (its primary key and the entries of the index on `form_context`) are not counted",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(at two bytes a unit|old estimate stood|boundary is the figure|900,000-character)/,
    patch: (t) =>
      sub(
        t,
        "3 * row.form_context.length + 2 * row.tab_instance_id.length;",
        "0;",
      ),
  },
  {
    id: "MU-603",
    title:
      "R33 (revision 18): the order record is sized as it is, not at its widest (the figure depends on the numbers the claim and the call will give the row)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the order record is sized at its widest/,
    patch: (t) =>
      sub(
        t,
        "    capture_seq: WIDEST_ORDER,\n    writer_gen: WIDEST_ORDER,\n",
        "",
      ),
  },
  {
    id: "MU-604",
    title:
      "R33 (revision 18): the capture is the caller's own object, not a copy made when `save` is called (a snapshot edited while the guard is asked, or while an earlier save of the port runs, is what is written)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(while the guard is asked|QUEUED behind an earlier one|the saved row is the capture that was admitted)/,
    patch: (t) =>
      sub(
        t,
        "      const captured = capture(snapshot);",
        "      const captured = snapshot as Captured | null;",
      ),
  },
  {
    id: "MU-605",
    title:
      "R33 (revision 18): a discard of a form that has no row is written without asking the guard (a new row is growth, and is not admitted)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(discard of a form that has no row|below the floor nothing is created|reserved at the size of the terminal row)/,
    patch: (t) =>
      sub(
        t,
        /reservation = await deps\.quota\?\.reserve\(\s*"input",\s*recoveryWriteBytes\(row\),\s*\);/,
        "reservation = undefined;",
      ),
  },
  {
    id: "MU-606",
    title:
      "R33 (revision 18): a discard of a form that HAS a row is admitted like a creation (it asks for room it does not need, and below the floor the saved copy is left to be shown again after the person discarded it)",
    file: "src/data/ports/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-quota.test.ts",
      "tests/data/form-recovery-overlap.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(has a row|HAS a row)/,
    patch: (t) =>
      sub(
        t,
        "          let result = await write(service, row, { mayCreate: false });",
        '          let result: FormWriteResult = { kind: "absent" };',
      ),
  },
  {
    id: "MU-607",
    title:
      "R33 (revision 18): the writer does not remember a discard that could write no row (an older capture asked for before it is written afterwards, and the text the person discarded comes back)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /asked for BEFORE a discard that could write no row/,
    patch: (t) =>
      sub(
        t,
        /if \(created && !written\)\s*writer\.cleared = Math\.max\(writer\.cleared, seq\);/,
        "void created;",
      ),
  },
  {
    id: "MU-608",
    title:
      "R33 (revision 18): a capture does not look at what the writer remembers of a discard before it writes",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /asked for BEFORE a discard that could write no row/,
    patch: (t) =>
      sub(
        t,
        '            if (writer.cleared > seq) return "failed";',
        "            void writer.cleared;",
      ),
  },
  {
    id: "MU-609",
    title:
      "R33 (revision 18): the hold a discard of a form with no row was admitted under is not handed to the write (a row is written under a hold that has ended)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-quota.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a discard whose hold ended before its row was written/,
    patch: (t) =>
      sub(
        t,
        '              row,\n              held === undefined ? {} : { leaseLive: () => held.live() },\n            );\n          }\n          written = result.kind === "saved";',
        '              row,\n              {},\n            );\n          }\n          written = result.kind === "saved";',
      ),
  },
  {
    id: "MU-614",
    title:
      "R1 (revision 19): a claim of an EXISTING row takes the stored generation + 1 and ignores the database's counter (revision 18's formula: a later context is given the generation that an earlier claim, whose save has not landed, already holds, and the earlier one's second capture overwrites it)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the review's schedule|claims made while the row is absent|variant \d of the second captures|a counter above the row)/,
    patch: (t) =>
      sub(
        t,
        "    const gen = Math.max(counter, held) + 1;",
        "    const gen = (stored === undefined ? counter : held) + 1;",
      ),
  },
  {
    id: "MU-615",
    title:
      "R1 (revision 19): a claim goes above the database's counter only and not above the generation stored in the row (a row written before the counter existed, or seeded above it, is claimed at a generation at or below its own)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(moves the counter to its generation|a stored generation at the limit)/,
    patch: (t) =>
      sub(
        t,
        "    const gen = Math.max(counter, held) + 1;",
        "    const gen = counter + 1;",
      ),
  },
  {
    id: "MU-616",
    title:
      "R1 (revision 19): the claim of an EXISTING row does not move the database's counter (a number that the claim of a row was given can be issued again if the row that carried it is ever gone)",
    file: "src/data/plans/form-recovery.ts",
    tests: [
      "tests/data/form-recovery-generation.test.ts",
      "tests/data/form-recovery-quota.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(moves the counter to its generation|never issued twice|the review's schedule)/,
    patch: (t) =>
      sub(
        t,
        "      sync: { ...sync, form_writer_gen: gen },",
        "      sync: stored === undefined ? { ...sync, form_writer_gen: gen } : sync,",
      ),
  },
  {
    id: "MU-617",
    title:
      "R1 (revision 19): the last generation is not enforced (the claim after the last safe integer is issued, and from there two claims can be given the same number)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the last generation is issued once|a counter at the limit|a stored generation at the limit)/,
    patch: (t) =>
      sub(
        t,
        '    if (gen > MAX_WRITER_GEN) return { result: { kind: "no_generation" } };\n',
        "",
      ),
  },
  {
    id: "MU-618",
    title:
      "R1 (revision 19): a counter that is not a non-negative safe integer is trusted (a negative, fractional, infinite or past-the-limit counter is gone above, and a generation is issued from it)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(a counter that is .* is not trusted|a stored generation that is)/,
    patch: (t) =>
      sub(
        t,
        '  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;',
        '  typeof value === "number";',
      ),
  },
  {
    id: "MU-619",
    title:
      "R1 (revision 19): the generation stored in the row is not checked (a negative, fractional or text generation in the row is gone above, and a claim is issued from it)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a stored generation that is .* is not trusted/,
    patch: (t) =>
      sub(
        t,
        "    if (!isGeneration(counter) || !isGeneration(held))",
        "    if (!isGeneration(counter))",
      ),
  },
  {
    id: "MU-620",
    title:
      "R1 (revision 19): a claim made without the row that holds the counter is answered with a guessed generation (1, which another claim may already have)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /without the singleton that holds the counter/,
    patch: (t) =>
      sub(
        t,
        '    if (sync === undefined) return { result: { kind: "no_generation" } };',
        '    if (sync === undefined) return { result: { kind: "claimed", gen: 1 } };',
      ),
  },
  {
    id: "MU-621",
    title:
      "R1 (revision 19): a claim of a form with no row is given the counter's own value instead of the next (two claims that follow one another share a generation)",
    file: "src/data/plans/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(claims made while the row is absent|different forms and tabs|variant \d of the second captures|the review's schedule)/,
    patch: (t) =>
      sub(
        t,
        "    const gen = Math.max(counter, held) + 1;",
        "    const gen = Math.max(counter, held) + (stored === undefined ? 0 : 1);",
      ),
  },
  {
    id: "MU-622",
    title:
      "R1 (revision 19): the recovery port reads a claim that could not be given a generation as a saved capture (nothing was written, and the capture is reported durable)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /through the port: (a save is `failed`|the refusal is not remembered)/,
    patch: (t) =>
      sub(
        t,
        '              return claimed.kind === "refused" ? "refused" : "failed";',
        '              return claimed.kind === "refused" ? "refused" : "saved";',
      ),
  },
  {
    id: "MU-623",
    title:
      "R1 (revision 19): the recovery port remembers a claim that could not be given a generation (the writer never claims afresh, so the page cannot save again once a generation can be issued)",
    file: "src/data/ports/form-recovery.ts",
    tests: ["tests/data/form-recovery-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the refusal is not remembered/,
    patch: (t) =>
      sub(
        t,
        '            if (result.kind !== "claimed" && writer.claim === started)\n              writer.claim = null;',
        '            if (result.kind === "refused" && writer.claim === started)\n              writer.claim = null;',
      ),
  },
  {
    id: "MU-625",
    title:
      "R35 (revision 20): a disposed runtime accepts a new open (its own refusal is gone; over an opener that ignores `abandoned` it lists the databases and opens the account again)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the same over an opener that ignores `abandoned`/,
    patch: (t) =>
      sub(
        t,
        '    if (this.disposed) return { kind: "refused", reason: "abandoned" };\n    const existing = this.services.get(account);',
        "    const existing = this.services.get(account);",
      ),
  },
  {
    id: "MU-626",
    title:
      "R35 (revision 20): the runtime never tells its opener it is abandoned (a held listing is let go into a native open for a runtime that has gone)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the runtime tells its opener when it is abandoned|the discovery of the databases is pending \(an opener that honours)/,
    patch: (t) =>
      sub(
        t,
        "      abandoned: () => this.disposed,",
        "      abandoned: () => false,",
      ),
  },
  {
    id: "MU-627",
    title:
      "R35 (revision 20): a completion that arrives after the runtime's disposal installs a service in it (the runtime does not look; over an opener that ignores `abandoned`, the disposed runtime keeps two connections and a live service and publishes the epoch)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an opener that ignores `abandoned`/,
    patch: (t) =>
      sub(
        t,
        '    if (this.disposed) {\n      outcome.store.close();\n      return { kind: "refused", reason: "abandoned" };\n    }\n',
        "",
      ),
  },
  {
    id: "MU-628",
    title:
      "R35 (revision 20): a completion that arrives after disposal is refused but its store is left open (the late open's two connections are kept with no service to close them)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an opener that ignores `abandoned`/,
    patch: (t) =>
      sub(
        t,
        '    if (this.disposed) {\n      outcome.store.close();\n      return { kind: "refused", reason: "abandoned" };\n    }\n',
        '    if (this.disposed) {\n      return { kind: "refused", reason: "abandoned" };\n    }\n',
      ),
  },
  {
    id: "MU-629",
    title:
      "R35 (revision 20): a completion that arrives after disposal is released with `registry.closeAll` instead of its own handles (it closes a healthy replacement runtime's connections and latches the account through the shared page registry)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a healthy replacement runtime opens the same account meanwhile/,
    patch: (t) =>
      sub(
        t,
        '    if (this.disposed) {\n      outcome.store.close();\n      return { kind: "refused", reason: "abandoned" };\n    }\n',
        '    if (this.disposed) {\n      this.deps.registry.closeAll(account, { latch: "closed_for_identity" });\n      return { kind: "refused", reason: "abandoned" };\n    }\n',
      ),
  },
  {
    id: "MU-630",
    title:
      "R35 (revision 20): two opens of one account in one runtime each install a service (the second replaces the first in the map and four connections stand for one account)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /two opens of one account in ONE runtime/,
    patch: (t) =>
      sub(
        t,
        '    const standing = this.services.get(account);\n    if (standing?.live) {\n      outcome.store.close();\n      return { kind: "opened", service: standing, created: outcome.created };\n    }\n',
        "",
      ),
  },
  {
    id: "MU-631",
    title:
      "R35 (revision 20): the second of two opens of one account hands out the standing service but keeps its own duplicate store open (four connections for one service)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /two opens of one account in ONE runtime/,
    patch: (t) =>
      sub(
        t,
        '      outcome.store.close();\n      return { kind: "opened", service: standing, created: outcome.created };',
        '      return { kind: "opened", service: standing, created: outcome.created };',
      ),
  },
  {
    id: "MU-632",
    title:
      "R35 (revision 20): disposal is not terminal (the runtime is never marked disposed: pending opens install services in it and a new open is accepted)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(opens nothing, ever|keeps nothing that open produces)/,
    patch: (t) =>
      sub(
        t,
        "    this.disposed = true;\n    this.unsubscribe();",
        "    this.unsubscribe();",
      ),
  },
  {
    id: "MU-633",
    title:
      "R35 (revision 20): `openAccountData` starts the listing for a caller that is already gone",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a caller that is already gone starts nothing/,
    patch: (t) =>
      sub(
        t,
        '  // A caller that is already gone starts nothing.\n  if (abandoned()) return refuse("abandoned");\n',
        "  // A caller that is already gone starts nothing.\n",
      ),
  },
  {
    id: "MU-634",
    title:
      "R35 (revision 20): a native open is begun for a caller that went while the databases were listed (the held listing is let go into an open the runtime must then close)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the discovery of the databases is pending \(an opener that honours/,
    patch: (t) =>
      sub(
        t,
        "    const early = lapsed(false);\n",
        '    const early = closedSince() ? refuse("closed") : null;\n',
      ),
  },
  {
    id: "MU-635",
    title:
      "R35 (revision 20): a native open that finishes for a caller that has gone is handed back as opened and lifts the account's latch (the runtime must release it, and a latch a wipe set meanwhile is gone)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a late completion lifts no latch|gone while the native open is under way: its own two connections are closed)/,
    patch: (t) =>
      sub(
        t,
        "    const over = lapsed(false);\n",
        '    const over = closedSince() ? refuse("closed") : null;\n',
      ),
  },
  {
    id: "MU-636",
    title:
      "R35 (revision 20): an abandoned native open is released with `registry.closeAll` instead of its own two connections (it closes every connection of the account on the page, a healthy replacement runtime's included)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ANOTHER runtime holds the account's connections|a healthy replacement runtime opens the same account meanwhile)/,
    patch: (t) =>
      sub(
        t,
        "      opened.store.close();\n      return over;\n",
        '      deps.registry.closeAll(account, { latch: "closed_for_identity" });\n      return over;\n',
      ),
  },
  {
    id: "MU-637",
    title:
      "R35 (revision 20): the account's latch is lifted BEFORE the caller's absence is looked at (a latch a wipe set while the open was pending is lifted by an open nobody wants)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a late completion lifts no latch|the latch stays as it was|a latch set meanwhile stays)/,
    patch: (t) =>
      sub(
        t,
        '    if (opened.kind !== "opened") return opened;\n    const over = lapsed(false);\n    if (over !== null) {\n      opened.store.close();\n      return over;\n    }\n    deps.registry.setLatch(account, "open");\n    return opened;',
        '    if (opened.kind !== "opened") return opened;\n    deps.registry.setLatch(account, "open");\n    const over = lapsed(false);\n    if (over !== null) {\n      opened.store.close();\n      return over;\n    }\n    return opened;',
      ),
  },
  {
    id: "MU-638",
    title:
      "R35 (revision 20): a creation that was waiting for the wipe's lock lists the databases again under it for a caller that went",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /disposed while the creation waits behind a wipe's lock/,
    patch: (t) =>
      sub(
        t,
        "    const underLock = lapsed(true);\n    if (underLock !== null) return underLock;\n",
        "",
      ),
  },
  {
    id: "MU-639",
    title:
      "R35 (revision 20): a creating upgrade is begun for a caller that went while the listing under the wipe's lock was pending (the database is created for a runtime that has gone)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(disposed while the listing made under the lock is pending|the listing made under the lock is pending \(an opener that ignores `permit`\))/,
    patch: (t) =>
      sub(
        t,
        "    const beforeCreating = lapsed(true);\n    if (beforeCreating !== null) return beforeCreating;\n",
        "",
      ),
  },
  {
    id: "MU-640",
    title:
      "R35 (revision 20): a creating upgrade that finishes for a caller that has gone is handed back as opened and lifts the account's latch",
    file: "src/data/store/open.ts",
    tests: ["tests/data/runtime-disposal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /disposed while the creating upgrade has finished in the engine/,
    patch: (t) =>
      sub(
        t,
        "    const outcome = await native(() =>\n      deps.opener.open(account, {\n        create: true,\n        incarnation: deps.newIncarnation(),\n        permit,\n      }),\n    );\n",
        '    const outcome: OpenOutcome = await deps.opener.open(account, {\n      create: true,\n      incarnation: deps.newIncarnation(),\n      permit,\n    });\n    if (outcome.kind === "opened") deps.registry.setLatch(account, "open");\n',
      ),
  },
  {
    id: "MU-641",
    title:
      "R35 (revision 20): disposal leaves the runtime subscribed to the page's identity (a disposed runtime still follows every change of it)",
    file: "src/data/engine/account-service.ts",
    tests: [
      "tests/data/runtime-disposal.test.ts",
      "tests/data/provider-pending-open.test.tsx",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the late completion installs no service|the unmount disposes the runtime|disposal is idempotent)/,
    patch: (t) =>
      sub(
        t,
        "    this.disposed = true;\n    this.unsubscribe();\n    this.unlatch();",
        "    this.disposed = true;\n    this.unlatch();",
      ),
  },
  {
    id: "MU-642",
    title:
      "R35 (revision 20): unmounting the production provider does not dispose the runtime it loaded (the wiring between the provider's cleanup and the runtime's disposal)",
    file: "src/data/ui/react.tsx",
    tests: ["tests/data/provider-pending-open.test.tsx"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the unmount disposes the runtime/,
    patch: (t) =>
      sub(
        t,
        "      dispose();\n      browser?.dispose();\n      browser = null;",
        "      dispose();\n      browser = null;",
      ),
  },
  {
    id: "MU-646",
    title:
      "R35 (revision 20): the controller takes a runtime's `abandoned` answer for an ordinary refusal, which is an ANSWER about the database (the look finishes with no database bound: a false absence, so the readers ask on a fresh in-memory budget over what may be a durable pause)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-look.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a runtime disposed UNDER a live controller/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "refused" && outcome.reason === "abandoned") {\n      if (runtime === loading) runtime = null;\n      failed();\n      return;\n    }\n',
        "",
      ),
  },
  {
    id: "MU-647",
    title:
      "R35 (revision 20): the controller fails the look on `abandoned` but keeps asking the same disposed runtime (it is never dropped, so no paced look ever loads one that can open)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-look.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a runtime disposed UNDER a live controller/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "refused" && outcome.reason === "abandoned") {\n      if (runtime === loading) runtime = null;\n',
        '    if (outcome.kind === "refused" && outcome.reason === "abandoned") {\n',
      ),
  },
  {
    id: "MU-648",
    title:
      "R37 (revision 21): `closeAll` does not count as a closure (a closeAll that names the latch `open`, or any path that closes connections without latching them, leaves an open that began before it alive)",
    file: "src/data/store/registry.ts",
    tests: ["tests/data/registry-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /closeAll is a closure even when it names the latch/,
    patch: (t) =>
      sub(
        t,
        "      close(account);\n      // Latch FIRST:",
        "      // Latch FIRST:",
      ),
  },
  {
    id: "MU-649",
    title:
      "R37 (revision 21): a latch set to anything but `open` is not counted (a wipe that only latches the account, with no closeAll, does not end an open that began before it)",
    file: "src/data/store/registry.ts",
    tests: [
      "tests/data/registry-generation.test.ts",
      "tests/data/open-lifetime.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a latch to anything but|a latch set to deletion with no closeAll)/,
    patch: (t) => sub(t, '    if (latch !== "open") close(account);\n', ""),
  },
  {
    id: "MU-650",
    title:
      "R37 (revision 21): lifting a latch (`open`) counts as a closure (an open that finishes and lifts the latch ends every other open of the account that was still pending)",
    file: "src/data/store/registry.ts",
    tests: ["tests/data/registry-generation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /lifting a latch is not/,
    patch: (t) =>
      sub(
        t,
        '    if (latch !== "open") close(account);\n',
        "    close(account);\n",
      ),
  },
  {
    id: "MU-651",
    title:
      "R37 (revision 21): the closure count is the page's, not the account's (a closure of ANOTHER account ends this open)",
    file: "src/data/store/registry.ts",
    tests: [
      "tests/data/registry-generation.test.ts",
      "tests/data/open-lifetime.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(it is per account|a closure of ANOTHER account)/,
    patch: (t) =>
      sub(
        t,
        "    generation: (account) => generations.get(account) ?? 0,\n",
        "    generation: () => [...generations.values()].reduce((a, b) => a + b, 0),\n",
      ),
  },
  {
    id: "MU-652",
    title:
      "R37 (revision 21): `openAccountData` never notices a closure (every check of the lifetime answers 'no closure')",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the answer is `closed`/,
    patch: (t) =>
      sub(
        t,
        "  const closedSince = (): boolean => deps.registry.generation(account) !== born;\n",
        "  const closedSince = (): boolean => false;\n",
      ),
  },
  {
    id: "MU-653",
    title:
      "R37 (revision 21): a native open that finishes after a closure is handed back as opened and lifts the latch (the result's own lifetime check looks at the caller only)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the native open has finished and its result has not reached the runtime, then/,
    patch: (t) =>
      sub(
        t,
        "    const over = lapsed(false);\n",
        '    const over = abandoned() ? refuse("abandoned") : null;\n',
      ),
  },
  {
    id: "MU-654",
    title:
      "R37 (revision 21): a native open is begun although a closure ended the open while the databases were being listed",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the discovery of the databases is pending, then/,
    patch: (t) =>
      sub(
        t,
        "    const early = lapsed(false);\n",
        '    const early = abandoned() ? refuse("abandoned") : null;\n',
      ),
  },
  {
    id: "MU-655",
    title:
      "R37 (revision 21): an opener's failure after a closure is rethrown as an ordinary failure (the closure's consequence is not named: the answer is not `closed`)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the failure is the closure's consequence/,
    patch: (t) =>
      sub(
        t,
        '      if (closedSince()) return refuse("closed");\n      throw error;',
        "      throw error;",
      ),
  },
  {
    id: "MU-656",
    title:
      "R36 (revision 21): the creating open is not given `permit` (the creating upgrade is never asked, so a fact that changed while the request was queued creates the database)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the creating upgrade is pending \(an opener that honours `permit`\)/,
    patch: (t) =>
      sub(
        t,
        "        incarnation: deps.newIncarnation(),\n        permit,\n",
        "        incarnation: deps.newIncarnation(),\n",
      ),
  },
  {
    id: "MU-657",
    title: "R36 (revision 21): `permit` always allows (it reads no fact)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the creating upgrade is pending \(an opener that honours `permit`\)/,
    patch: (t) =>
      sub(
        t,
        "      refusal.outcome = lapsed(true);\n      return refusal.outcome === null;\n",
        "      return true;\n",
      ),
  },
  {
    id: "MU-658",
    title:
      "R36 (revision 21): a creation refused inside the upgrade is answered `absent` (the reason is lost: a caller reads 'there is no database' for a refusal)",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the creating upgrade is pending \(an opener that honours `permit`\)/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "absent" && refusal.outcome !== null)\n      return refusal.outcome;\n',
        "",
      ),
  },
  {
    id: "MU-659",
    title:
      "R36 (revision 21): the may-create predicate does not read the page's identity",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(then the page's identity moves to another account|then the page signs out)/,
    patch: (t) =>
      sub(
        t,
        '      if (deps.identityAccount() !== account) return refuse("identity");\n      if (deps.operationPending(account)) return refuse("operation_pending");\n',
        '      if (deps.operationPending(account)) return refuse("operation_pending");\n',
      ),
  },
  {
    id: "MU-660",
    title:
      "R36 (revision 21): the may-create predicate does not read a pending logout or retirement",
    file: "src/data/store/open.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /then a logout or retirement becomes pending/,
    patch: (t) =>
      sub(
        t,
        '      if (deps.identityAccount() !== account) return refuse("identity");\n      if (deps.operationPending(account)) return refuse("operation_pending");\n',
        '      if (deps.identityAccount() !== account) return refuse("identity");\n',
      ),
  },
  {
    id: "MU-661",
    title:
      "R37 (revision 21): the runtime does not look for a closure of its own (an opener that knows nothing of closures can undo one: a service over a closed store, the latch lifted)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the runtime refuses `closed`/,
    patch: (t) =>
      sub(
        t,
        '    if (this.deps.registry.generation(account) !== born) {\n      outcome.store.close();\n      return { kind: "refused", reason: "closed" };\n    }\n',
        "",
      ),
  },
  {
    id: "MU-662",
    title:
      "R37 (revision 21): the runtime reads the closure count AFTER the open, so no closure can differ from it",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the runtime refuses `closed`/,
    patch: (t) =>
      sub(
        t,
        "    const born = this.deps.registry.generation(account);\n    const outcome = await this.deps.open(account, {\n      create: options.create === true,\n      abandoned: () => this.disposed,\n    });\n",
        "    const outcome = await this.deps.open(account, {\n      create: options.create === true,\n      abandoned: () => this.disposed,\n    });\n    const born = this.deps.registry.generation(account);\n",
      ),
  },
  {
    id: "MU-663",
    title:
      "R37 (revision 21): the runtime judges the identity BEFORE the closure (a wipe's latch is replaced by the identity's, and the answer names the identity)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/open-lifetime.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a wipe's closure and the identity leaving together/,
    patch: (t) =>
      sub(
        sub(
          t,
          '    if (this.deps.registry.generation(account) !== born) {\n      outcome.store.close();\n      return { kind: "refused", reason: "closed" };\n    }\n',
          "",
        ),
        '      return { kind: "refused", reason: "identity" };\n    }\n',
        '      return { kind: "refused", reason: "identity" };\n    }\n    if (this.deps.registry.generation(account) !== born) {\n      outcome.store.close();\n      return { kind: "refused", reason: "closed" };\n    }\n',
      ),
  },
  {
    id: "MU-664",
    title:
      "R37 (revision 21): the controller takes a runtime's `closed` answer for an ordinary refusal, which is an ANSWER about the database (the look finishes with no database bound: a false absence)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-look.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an open that a CLOSURE of the account ended/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "refused" && outcome.reason === "closed") {\n      failed();\n      return;\n    }\n',
        "",
      ),
  },
  {
    id: "MU-665",
    title:
      "R37 (revision 21): the controller drops a healthy runtime when one open of it is ended by a closure (every paced look loads the runtime chunk again)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/ui-env-look.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an open that a CLOSURE of the account ended/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "refused" && outcome.reason === "closed") {\n      failed();',
        '    if (outcome.kind === "refused" && outcome.reason === "closed") {\n      if (runtime === loading) runtime = null;\n      failed();',
      ),
  },
  {
    id: "MU-671",
    title:
      'R38 (revision 21): the code-point counter takes ANY high surrogate for the start of a pair (an unpaired one swallows the unit after it: `"\\ud800a"` repeated 151 times counts 151 and passes the 300-code-point label bound)',
    file: "src/data/scan/code-points.ts",
    tests: ["tests/data/code-points.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(an unpaired high before an ordinary unit|the review's reproduction|a fixed table of strings)/,
    patch: (t) =>
      sub(
        t,
        "      const next = text.charCodeAt(i + 1);\n      if (next >= 0xdc00 && next <= 0xdfff) i += 1;\n",
        "      i += 1;\n",
      ),
  },
  {
    id: "MU-672",
    title:
      "R38 (revision 21): the projection's label is bounded in UTF-16 units, not code points (a label of 300 valid astral characters is refused)",
    file: "src/data/scan/validate.ts",
    tests: ["tests/data/code-points.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /valid pair: exactly 300 code points is accepted/,
    patch: (t) =>
      sub(
        t,
        "  const labelLength = codePointCount(p.label);\n",
        "  const labelLength = p.label.length;\n",
      ),
  },
  {
    id: "MU-673",
    title:
      "R38 (revision 21): the `/sync` cursor is bounded in UTF-16 units, not code points (a cursor of 512 valid astral characters is refused)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/code-points.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /valid pair: exactly 512 code points is accepted/,
    patch: (t) =>
      sub(
        t,
        "          if (codePointCount(text) > config.maxCursorLength)\n",
        "          if (text.length > config.maxCursorLength)\n",
      ),
  },
  {
    id: "MU-674",
    title:
      "R39 (revision 22): `planEnqueue` digests, measures and stores the object `build` returned, not a private copy (a caller's later edit reaches the body; every enqueue and supersession)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(planEnqueue: the command, the display patch and the defaults context are copies|R39: (enqueue|supersede), build returns)/,
    patch: (t) =>
      sub(
        t,
        "    built = buildSnapshot(request, resolved.bases);",
        "    built = request.build(resolved.bases);",
      ),
  },
  {
    id: "MU-675",
    title:
      "R39 (revision 22): `planEdit` digests, measures and stores the object `build` returned, not a private copy",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(planEdit: the same, from the bases the draft already holds|R39: edit, build returns)/,
    patch: (t) =>
      sub(
        t,
        "    built = buildSnapshot(request, draft.bases);",
        "    built = request.build(draft.bases);",
      ),
  },
  {
    id: "MU-676",
    title:
      "R39 (revision 22): the builder is handed the plan's own `bases` (a builder that keeps or alters its argument changes what the header stores)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a builder that keeps or alters the .bases. it was given/,
    patch: (t) =>
      sub(t, "    request.build({ ...bases });", "    request.build(bases);"),
  },
  {
    id: "MU-677",
    title:
      "R39 (revision 22): the display patch a build returns is stored by reference (the command is copied, the patch is not)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /planEnqueue: the command, the display patch and the defaults context are copies/,
    patch: (t) =>
      sub(
        t,
        "displayPatch: snapshotPlain(displayPatch) as Record<",
        "displayPatch: displayPatch as Record<",
      ),
  },
  {
    id: "MU-678",
    title:
      "R39 (revision 22): the defaults context a build returns is stored by reference (the command is copied, the context is not)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /planEnqueue: the command, the display patch and the defaults context are copies/,
    patch: (t) =>
      sub(
        t,
        "{ defaultsContext: snapshotPlain(defaultsContext) }",
        "{ defaultsContext: defaultsContext }",
      ),
  },
  {
    id: "MU-679",
    title:
      "R39 (revision 22): `snapshotRequest` shares the caller's `targets` (a target edited while the reservation is awaited is the one read and stored)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(snapshotRequest copies the endpoint, the target id, the targets|enqueue: a request edited while the quota reservation is awaited stores what was validated)/,
    patch: (t) =>
      sub(
        t,
        / {4}targets: request\.targets\.map\(\(target\) => \(\{[\s\S]*?\}\)\),\n/,
        "    targets: request.targets,\n",
      ),
  },
  {
    id: "MU-680",
    title:
      "R39 (revision 22): `enqueue` validates and stores the caller's own request, not a copy taken at the boundary",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /enqueue: a request edited while the quota reservation is awaited stores what was validated/,
    patch: (t) =>
      sub(
        t,
        "    const request = snapshotRequest(given);\n    validateRequest(request);",
        "    const request = given;\n    validateRequest(request);",
      ),
  },
  {
    id: "MU-681",
    title:
      "R39 (revision 22): `editQueued` validates and stores the caller's own request, not a copy taken at the boundary",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /edit: a request edited while the quota reservation is awaited stores what was validated/,
    patch: (t) =>
      sub(
        t,
        "  ): Promise<EditOutcome> {\n    const next = snapshotRequest(given);",
        "  ): Promise<EditOutcome> {\n    const next = given;",
      ),
  },
  {
    id: "MU-682",
    title:
      "R39 (revision 22): `supersede` validates and stores the caller's own request, not a copy taken at the boundary",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /supersede: a request edited while the quota reservation is awaited stores what was validated/,
    patch: (t) =>
      sub(
        t,
        "  ): Promise<SupersedeOutcome> {\n    const next = snapshotRequest(given);",
        "  ): Promise<SupersedeOutcome> {\n    const next = given;",
      ),
  },
  {
    id: "MU-683",
    title:
      "R39 (revision 22): the snapshot runs an accessor and copies what it answered (a getter can answer differently when the write is measured and when it is stored)",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an accessor is not data/,
    patch: (t) =>
      sub(
        t,
        '  if (!("value" in descriptor)) throw new NotPlainData("an accessor");\n',
        "",
      ),
  },
  {
    id: "MU-684",
    title:
      "R40 (revision 22): the snapshot turns a hole into an `undefined` member instead of refusing it",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R40: a hole is refused, in every position, by one policy/,
    patch: (t) =>
      sub(
        t,
        "  if (descriptor === undefined) throw new NotPlainData(absent);",
        "  if (descriptor === undefined) return undefined;",
      ),
  },
  {
    id: "MU-685",
    title:
      "R39 (revision 22): the snapshot is SHALLOW (the root is copied, every nested value is the caller's own)",
    file: "src/data/model/snapshot.ts",
    tests: [
      "tests/data/snapshot.test.ts",
      "tests/data/outbox-snapshot.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(nothing the caller does to its graph afterwards reaches the copy|a graph comes back equal, deep and sharing no object|R39: .*build returns)/,
    patch: (t) =>
      sub(
        t,
        "    if (item === null || item === undefined) return item;\n",
        "    if (item === null || item === undefined || depth > 0) return item;\n",
      ),
  },
  {
    id: "MU-686",
    title:
      "R39 (revision 22): the snapshot has no depth limit (a value nested deeper than the size measure follows is copied)",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nested one container deeper than MAX_DEPTH/,
    patch: (t) =>
      sub(
        t,
        '    if (depth >= MAX_DEPTH) throw new NotPlainData("nested too deeply");\n',
        "",
      ),
  },
  {
    id: "MU-687",
    title:
      "R39 (revision 22): the snapshot accepts an object that is not plain (a Map, a Date or a class instance is copied as `{}`)",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /what is refused: anything that is not plain JSON data/,
    patch: (t) =>
      sub(
        t,
        '    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null)\n      throw new NotPlainData("an object that is not plain");\n',
        "",
      ),
  },
  {
    id: "MU-688",
    title: "R39 (revision 22): the snapshot accepts a non-finite number",
    file: "src/data/model/snapshot.ts",
    tests: ["tests/data/snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(NaN|Infinity)/,
    patch: (t) =>
      sub(
        t,
        '        if (!Number.isFinite(item))\n          throw new NotPlainData("a non-finite number");\n',
        "",
      ),
  },
  {
    id: "MU-689",
    title:
      "R39 (revision 22): the snapshot drops the named properties of an array (a clone keeps them, and the size measure counts them)",
    file: "src/data/model/snapshot.ts",
    tests: [
      "tests/data/snapshot.test.ts",
      "tests/data/outbox-quota-context.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the named properties of an array are kept as a clone keeps them|a named property is part of the write|NAMED property|named property)/,
    patch: (t) =>
      sub(
        t,
        "        if (!isArrayIndex(key))\n          Object.defineProperty(members, key, {",
        "        if (false)\n          Object.defineProperty(members, key, {",
      ),
  },
  {
    id: "MU-690",
    title:
      "R40 (revision 22): the canonical form of an array skips its holes again (`map`: `new Array(1)` has the digest of `[]`, two holes make `[,]`)",
    file: "src/data/model/canonical.ts",
    tests: ["tests/data/canonical.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R40: a hole in an array is refused, not skipped/,
    patch: (t) =>
      sub(
        t,
        / {6}if \(Array\.isArray\(value\)\) \{[\s\S]*?\n {6}\}\n/,
        "      if (Array.isArray(value))\n        return `[$" +
          '{value.map((item) => canonicalJson(item)).join(",")}]`;\n',
      ),
  },
  {
    id: "MU-691",
    title:
      "R40 (revision 22): the canonical form has no explicit check for a hole (it reads as an `undefined`: refused, but not as the hole it is)",
    file: "src/data/model/canonical.ts",
    tests: ["tests/data/canonical.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /canonicalJson and digestOf refuse, and say it is a hole/,
    patch: (t) =>
      sub(
        t,
        '          if (!(i in value))\n            throw new TypeError("a hole in an array has no canonical form");\n',
        "",
      ),
  },
  {
    id: "MU-692",
    title:
      "R41 (revision 22): the preliminary bound on a cursor token assumes six encoded bytes a code point again (a valid cursor of 257 escaped astral characters is refused as too long)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/cursor-escapes.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R41: the cursor's length is its decoded code points/,
    patch: (t) =>
      sub(
        t,
        "const MAX_BYTES_PER_CODE_POINT = 12;",
        "const MAX_BYTES_PER_CODE_POINT = 6;",
      ),
  },
  {
    id: "MU-693",
    title:
      "R41 (revision 22): the bound on a key is smaller than the widest representation of the longest name (a fully escaped `next_cursor` is refused by size)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/cursor-escapes.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(every top-level key and the phase may be written fully escaped|a batch's keys may be written fully escaped)/,
    patch: (t) =>
      sub(
        t,
        "const MAX_KEY_CODE_POINTS = 64;",
        "const MAX_KEY_CODE_POINTS = 5;",
      ),
  },
  {
    id: "MU-694",
    title:
      "R41 (revision 22): the bound on `phase` is smaller than the widest representation of `snapshot` (a fully escaped phase is refused by size)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/cursor-escapes.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /every top-level key and the phase may be written fully escaped/,
    patch: (t) =>
      sub(
        t,
        "const MAX_PHASE_CODE_POINTS = 32;",
        "const MAX_PHASE_CODE_POINTS = 3;",
      ),
  },
  {
    id: "MU-695",
    title:
      "R41 (revision 22): the cursor's length is not checked once the token fits (only the bound on the token stands: 513 escaped BMP characters are accepted)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/cursor-escapes.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /R41: the cursor's length is its decoded code points/,
    patch: (t) =>
      sub(
        t,
        '          if (codePointCount(text) > config.maxCursorLength)\n            fail("limit", "cursor too long");\n',
        "",
      ),
  },
  {
    id: "MU-700",
    title:
      "R39 (revision 22): the recognition of a retried supersession reads the object `build` returned (a `Date` or a `Map` canonicalises to `{}` and is mistaken for a stored empty command)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-snapshot.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(a Date|a Map|a class instance) is not the stored empty command/,
    patch: (t) =>
      sub(
        t,
        "      digestOf(buildSnapshot(request, draft.bases).command) ===\n      draft.command_digest",
        "      digestOf(request.build(draft.bases).command) === draft.command_digest",
      ),
  },
  {
    id: "MU-701",
    title:
      "R42 (revision 23): the crash-loop marker of an attempt that landed nothing is never retired (a safe drop is read as a tab that did not survive: three at the lowest rung are the floor)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /no marker, no count, no step/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (attempt !== null && !written && (false as boolean))\n          await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-702",
    title:
      "R42 (revision 23): the marker is retired only for a commit the guards DROPPED (a `not_ready`, a lapsed hold and a failed commit leave it)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(not_ready \(the cache stopped being valid|a commit that FAILS)/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        '        if (attempt !== null && outcome.kind === "dropped")\n          await retireAttempt(service, attempt);',
      ),
  },
  {
    id: "MU-703",
    title:
      "R42 (revision 23): the marker is retired only while the run stands (a stopped run's attempt ended too, and leaves its marker)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a run stopped while its commit waited|a run that ended while the commit was stalled|a lost ownership signal)/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (attempt !== null && !written && alive(id))\n          await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-704",
    title:
      "R42 (revision 23): the marker of a lapsed round is retired only when the LAST round ends (it stands while the page waits to be admitted again)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /retired BEFORE the page is admitted again/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (\n          attempt !== null &&\n          !written &&\n          (!lapsed || round >= ADMISSION_ROUNDS)\n        )\n          await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-705",
    title:
      "R42 (revision 23): an attempt is named only once its marker's write has succeeded (a write that reports failure but landed leaves a marker nobody retires)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a write that reported failure but landed is still retired/,
    patch: (t) =>
      sub(
        sub(
          t,
          "          attempt = deps.ids.uuid();\n          try {",
          "          const chosen = deps.ids.uuid();\n          try {",
        ),
        "              id: attempt,\n              limit,\n              startedAt: deps.clock.now(),\n            });\n          } catch {",
        "              id: chosen,\n              limit,\n              startedAt: deps.clock.now(),\n            });\n            attempt = chosen;\n          } catch {",
      ),
  },
  {
    id: "MU-706",
    title:
      "R42 (revision 23): `retireSizingAttempt` clears whatever marker stands (an overtaken attempt erases the marker of a newer one that is genuinely under way)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(an overtaken attempt cannot erase|it leaves another attempt's marker)/,
    patch: (t) =>
      sub(
        t,
        "sync === undefined || sync.sizing.attempt?.id !== input.id",
        "sync === undefined || sync.sizing.attempt === null",
      ),
  },
  {
    id: "MU-707",
    title:
      "R42 (revision 23): an OUTCOME record clears the marker, as it did (a continuation that was overtaken erases the marker of a newer attempt)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(OUTCOME record does not erase|decides the ladder and leaves the marker)/,
    patch: (t) =>
      sub(
        t,
        "const sizing: SizingState = { ...out.state, attempt: sync.sizing.attempt };",
        "const sizing: SizingState = out.state;",
      ),
  },
  {
    id: "MU-708",
    title:
      "R42 (revision 23): an attempt whose retirement could not be written is forgotten (the next capture reads its marker as a tab that did not survive)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the page's own memory carries it/,
    patch: (t) =>
      sub(
        t,
        "      endedAttempts.set(service.account, attempt);",
        "      void attempt;",
      ),
  },
  {
    id: "MU-709",
    title:
      "R42 (revision 23): the capture is never told of the attempt the page saw end (its marker is counted as a crash)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the page's own memory carries it/,
    patch: (t) =>
      sub(
        t,
        "      endedAttempt: endedAttempts.get(service.account) ?? null,",
        "      endedAttempt: null,",
      ),
  },
  {
    id: "MU-710",
    title:
      "R42 (revision 23): `captureRequest` ignores the attempt it is told ended (the marker is counted as a crash)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(captureRequest counts a marker as a crash|the page's own memory carries it|clears a named marker even when the gate refuses)/,
    patch: (t) =>
      sub(
        t,
        "      if (sizing.attempt.id === input.endedAttempt) {",
        "      if (sizing.attempt.id === input.endedAttempt && (false as boolean)) {",
      ),
  },
  {
    id: "MU-711",
    title:
      "R42 (revision 23): `captureRequest` clears ANY marker once an attempt is named (a genuine crash is not counted)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /captureRequest counts a marker as a crash/,
    patch: (t) =>
      sub(
        t,
        "      if (sizing.attempt.id === input.endedAttempt) {",
        "      if (input.endedAttempt != null) {",
      ),
  },
  {
    id: "MU-712",
    title:
      "R42 (revision 23): a marker cleared because its attempt ended is reported as a step-down",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /captureRequest counts a marker as a crash/,
    patch: (t) =>
      sub(
        t,
        "        sizing = { ...sizing, attempt: null };\n      } else {",
        "        sizing = { ...sizing, attempt: null };\n        steppedDown = true;\n      } else {",
      ),
  },
  {
    id: "MU-713",
    title:
      "R42 (revision 23): `retireSizingAttempt` also resets the count of failures at the lowest rung (it changes more than the marker)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /retireSizingAttempt clears the marker of that attempt/,
    patch: (t) =>
      sub(
        t,
        "      sync: { ...sync, sizing: { ...sync.sizing, attempt: null } },\n      result: { retired: true },",
        "      sync: {\n        ...sync,\n        sizing: { ...sync.sizing, attempt: null, floor_hits: 0 },\n      },\n      result: { retired: true },",
      ),
  },
  {
    id: "MU-714",
    title:
      "R42 (revision 23): the marker is retired after a page that LANDED too (a write nobody needs: the commit already cleared it)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nothing retires it/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (attempt !== null) await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-715",
    title:
      "R42 (revision 23): a retirement that cannot be written stops the engine (a marker's bookkeeping removes the bound it exists to keep)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-marker.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the engine is not stopped or slowed/,
    patch: (t) =>
      sub(
        t,
        "      endedAttempts.set(service.account, attempt);",
        '      endedAttempts.set(service.account, attempt);\n      throw new Error("bookkeeping");',
      ),
  },
  {
    id: "MU-718",
    title:
      "R44 (revision 24): the scan reads an allocation failure while decoding a key or the cursor as invalid text (the page is malformed), not as the device's signal",
    file: "src/data/scan/scan.ts",
    tests: [
      "tests/data/scan-allocation.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a small token's allocation failure|the decoding of a small token)/,
    patch: (t) =>
      sub(
        t,
        '      if (isAllocationError(error)) throw error;\n      return fail("syntax", "invalid text");',
        '      return fail("syntax", "invalid text");',
      ),
  },
  {
    id: "MU-719",
    title:
      "R44 (revision 24): the scan lets EVERY exception of a token's decoding leave it (a malformed key or cursor is a crash of the step, not a malformed page)",
    file: "src/data/scan/scan.ts",
    tests: ["tests/data/scan-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /control: a (syntax|utf8) fault at|a REAL invalid byte in a key/,
    patch: (t) =>
      sub(
        t,
        '      if (isAllocationError(error)) throw error;\n      return fail("syntax", "invalid text");',
        "      throw error;",
      ),
  },
  {
    id: "MU-720",
    title:
      "R44 (revision 24): an allocation failure while decoding or parsing an element is reported as `not_decodable` (invalid data), so the valid page is asked for again at the same size",
    file: "src/data/scan/validate.ts",
    tests: [
      "tests/data/scan-allocation.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(throws the RangeError itself, not a PageInvalid|valid page is NOT asked for again|the same signal)/,
    patch: (t) =>
      sub(
        t,
        "    if (isAllocationError(error)) throw error;\n    // Invalid UTF-8 inside a string",
        "    // Invalid UTF-8 inside a string",
      ),
  },
  {
    id: "MU-721",
    title:
      "R44 (revision 24): every exception of an element's decoding leaves `decodeChange` as itself (a malformed element is no longer `not_decodable`)",
    file: "src/data/scan/validate.ts",
    tests: [
      "tests/data/scan-allocation.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(control: a (syntax|utf8) fault at change|REAL invalid UTF-8 and REAL truncated JSON|is a fault of the DATA)/,
    patch: (t) =>
      sub(
        t,
        '    if (isAllocationError(error)) throw error;\n    // Invalid UTF-8 inside a string, or a syntax fault the scan did not see: either way the page is not what the contract says.\n    throw new PageInvalid("element", "not_decodable");',
        "    throw error;",
      ),
  },
  {
    id: "MU-722",
    title:
      "R44 (revision 24): a kind validator's allocation failure is `validator_failed` (invalid data), not the device's signal",
    file: "src/data/scan/validate.ts",
    tests: [
      "tests/data/scan-allocation.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(kind validator that runs out of memory|a validator's allocation failure is the RangeError)/,
    patch: (t) =>
      sub(
        t,
        '    if (isAllocationError(error)) throw error;\n    throw new PageInvalid("value", "validator_failed");',
        '    throw new PageInvalid("value", "validator_failed");',
      ),
  },
  {
    id: "MU-723",
    title:
      "R44 (revision 24): every exception of a validator leaves `decodeChange` as itself (a registrant's ordinary defect is no longer `validator_failed`)",
    file: "src/data/scan/validate.ts",
    tests: [
      "tests/data/scan-allocation.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ORDINARY defect/,
    patch: (t) =>
      sub(
        t,
        '    if (isAllocationError(error)) throw error;\n    throw new PageInvalid("value", "validator_failed");',
        "    throw error;",
      ),
  },
  {
    id: "MU-724",
    title:
      "R44 (revision 24): the engine does not handle the scan's allocation failure (it reaches the loop's own stop as `local_storage`, with the size unchanged and no floor count)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(anywhere in the scan steps the ladder down|at the lowest rung \(no device-memory signal\)|from the device's first rung|run that ended while its response was read)/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        "      // in a step, and reaches the loop's stop.\n      throw error;",
      ),
  },
  {
    id: "MU-725",
    title:
      "R44 (revision 24): the scan's allocation failure is read as an invalid page (the unrecognised-response budget), not as the device's signal",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(anywhere in the scan steps the ladder down|at the lowest rung \(no device-memory signal\)|from the device's first rung)/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return invalidPage(id, service, captured, "invalid");\n      throw error;',
      ),
  },
  {
    id: "MU-726",
    title:
      "R44 (revision 24): the scan's allocation failure is a counted network failure of the read (a back-off), not the device's signal",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(anywhere in the scan steps the ladder down|at the lowest rung \(no device-memory signal\)|from the device's first rung)/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return failRead(id, service, captured, "failure");\n      throw error;',
      ),
  },
  {
    id: "MU-727",
    title:
      "R44 (revision 24): the scan's allocation failure is caught but recorded nowhere (the same size is asked for again, paced, for ever)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(anywhere in the scan steps the ladder down|at the lowest rung \(no device-memory signal\)|from the device's first rung)/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error)) return { when: "after", ms: 1_000 };\n      throw error;',
      ),
  },
  {
    id: "MU-728",
    title:
      "R44 (revision 24): EVERY thrown Error is an allocation failure (a malformed token, invalid UTF-8 and a defect of a step all step the ladder down)",
    file: "src/data/model/sizing.ts",
    tests: [
      "tests/data/sizing.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a fault of the data, a defect and a storage failure are not|is a fault of the DATA|defect that is neither an allocation failure)/,
    patch: (t) =>
      sub(t, "  error instanceof RangeError;", "  error instanceof Error;"),
  },
  {
    id: "MU-729",
    title:
      "R44 (revision 24): nothing is an allocation failure (not the scan's, not the decoder's, not even the body's)",
    file: "src/data/model/sizing.ts",
    tests: [
      "tests/data/sizing.test.ts",
      "tests/data/engine-sizing.test.ts",
      "tests/data/engine-sizing-allocation.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a RangeError \(and anything built on one\)|response body that cannot be allocated|anywhere in the scan steps the ladder down)/,
    patch: (t) =>
      sub(
        t,
        "  error instanceof RangeError;",
        "  (false as boolean) && error instanceof RangeError;",
      ),
  },
  {
    id: "MU-730",
    title:
      "R44 (revision 24): a RangeError thrown inside the commit is not classified as an allocation failure (the decoding's failures become ordinary commit failures, which never count toward the floor)",
    file: "src/data/store/failure.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(change\.decode at the lowest rung|change\.parse at the lowest rung|change\.decode from the device's first rung|the lowest rung: three failed attempts)/,
    patch: (t) =>
      sub(
        t,
        "  if (error instanceof RangeError)\n    return new StoreFailure",
        "  if (error instanceof RangeError && (false as boolean))\n    return new StoreFailure",
      ),
  },
  {
    id: "MU-731",
    title:
      "R44 (revision 24): the scan's allocation failure is recorded as a local commit failure (it never counts toward the floor, so a device that cannot scan even one change never reaches the specified resource-exhaustion state)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-sizing-allocation.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(at the lowest rung \(no device-memory signal\)|from the device's first rung|Try again)/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, {\n          kind: "commit_failed",\n          cause: "error",\n        });\n      throw error;',
      ),
  },
  {
    id: "MU-736",
    title:
      "R45 (revision 25): the replacement always keeps the old draft's place, whatever it waits for (a draft newer than that place is then both its prerequisite and ahead-of-it in the queue: neither can ever be sent)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(takes the END of the queue|the same for a side effect the replacement adds|explicit dependency on a newer draft is placed|retarget-occupied after|add-side-effect after)/,
    patch: (t) =>
      sub(
        t,
        "    created_seq: newerDependency ? planned.draft.created_seq : old.created_seq,",
        "    created_seq: old.created_seq,",
      ),
  },
  {
    id: "MU-737",
    title:
      "R45 (revision 25): a newer dependency with a dependant of the old draft behind the replacement is admitted (the dependant waits for the replacement, which waits for a newer draft)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a newer draft but a DEPENDANT of the old draft|a newer draft and a dependant behind the replacement|explicit dependency on a newer draft is placed)/,
    patch: (t) =>
      sub(
        t,
        '  if (newerDependency && standing.length > 0)\n    return { kind: "refused", reason: "order_conflict" };',
        '  if (newerDependency && standing.length > 0 && (false as boolean))\n    return { kind: "refused", reason: "order_conflict" };',
      ),
  },
  {
    id: "MU-738",
    title:
      "R45 (revision 25): an explicit dependency on a dependant of the old draft is not refused (a cycle: the replacement waits for its own dependant)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(is a CYCLE: refused|is a cycle and is refused)/,
    patch: (t) =>
      sub(
        t,
        '  if (dependsOn.some((id) => standingIds.has(id)))\n    return { kind: "refused", reason: "order_conflict" };',
        '  if ((false as boolean) && dependsOn.some((id) => standingIds.has(id)))\n    return { kind: "refused", reason: "order_conflict" };',
      ),
  },
  {
    id: "MU-739",
    title:
      "R45 (revision 25): a settled draft newer than the old draft's place moves the replacement to the end for nothing",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a newer draft that is itself terminal is nothing to wait for|an explicit dependency on an older, a missing or a settled draft keeps the place)/,
    patch: (t) =>
      sub(
        t,
        "      row !== undefined && !isTerminal(row) && row.created_seq > old.created_seq",
        "      row !== undefined && row.created_seq > old.created_seq",
      ),
  },
  {
    id: "MU-740",
    title:
      "R45 (revision 25): the drafts named by the request's explicit dependencies are not looked at when the place is decided",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /an explicit dependency on a newer draft is placed like a derived one/,
    patch: (t) =>
      sub(
        t,
        "  for (const row of [...facts.others, ...(facts.extras ?? [])])",
        "  for (const row of [...facts.others])",
      ),
  },
  {
    id: "MU-741",
    title:
      "R45 (revision 25): a target the replacement raises where the old draft did not, and a dependant touches, is admitted (the replacement's base holds the dependant's own contribution)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a target the replacement RAISES where the old draft did not|raises where the old draft did not, which)/,
    patch: (t) =>
      sub(
        t,
        "    standing.some((member) =>\n      [...member.index_targets, ...member.bumped].some(raisedAhead),",
        "    (false as boolean) &&\n    standing.some((member) =>\n      [...member.index_targets, ...member.bumped].some(raisedAhead),",
      ),
  },
  {
    id: "MU-742",
    title:
      "R45 (revision 25): a dependant is paused only when a base the replacement shares with the old draft differs (a dropped target or side effect pauses nothing: the dependant is sent on a version that will never exist)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(drops a side effect the old draft raised|stops raising the version of a target|a dropped side effect pauses)/,
    patch: (t) =>
      sub(
        t,
        "  const changed = old.bumped.some(\n    (id) => leaves(old, id) !== leaves(replacement, id),\n  );",
        "  const changed = old.bumped.some(\n    (id) =>\n      old.bases[id] !== undefined &&\n      replacement.bases[id] !== undefined &&\n      old.bases[id] !== replacement.bases[id],\n  );",
      ),
  },
  {
    id: "MU-743",
    title:
      "R45 (revision 25): a dependant that stays queued is not counted in the version record after a supersession (the next save is based on a version the dependant is about to raise)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a dependant that stays queued keeps the record|a dependant that stays queued: the record keeps)/,
    patch: (t) =>
      sub(
        t,
        "  if (!pause)\n    for (const member of standing)",
        "  if (false as boolean)\n    for (const member of standing)",
      ),
  },
  {
    id: "MU-744",
    title:
      "R45 (revision 25): the version record is raised to what a dependant stands on even when the supersession paused it",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a dependant that is paused leaves the record at the replacement's result/,
    patch: (t) =>
      sub(
        t,
        "  if (!pause)\n    for (const member of standing)",
        "  if (true as boolean)\n    for (const member of standing)",
      ),
  },
  {
    id: "MU-745",
    title:
      "R45 (revision 25): the decision of a replacement that took the end of the queue carries no counter (the model: it consumed a sequence number nobody records)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(takes the END of the queue, behind it, and writes the counter|the same for a side effect the replacement adds|explicit dependency on a newer draft is placed)/,
    patch: (t) =>
      sub(
        t,
        "    ...(newerDependency ? { sync: planned.sync } : {}),",
        "    ...(newerDependency ? {} : {}),",
      ),
  },
  {
    id: "MU-746",
    title:
      "R45 (revision 25): the plan does not write the counter of a replacement that took the end of the queue (the next save is given the same sequence number: two drafts at one place)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a moved replacement consumes exactly ONE sequence number|retarget-occupied after|add-side-effect after|a restart BEFORE anything is sent)/,
    patch: (t) =>
      sub(
        t,
        "    const written = cleared ?? (decision.sync === undefined ? undefined : base);",
        "    const written = cleared;",
      ),
  },
  {
    id: "MU-747",
    title:
      "R45 (revision 25): the plan does not read the drafts named by the request's explicit dependencies",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /an explicit dependency on a dependant of the old draft is a cycle and is refused; on a newer unrelated draft/,
    patch: (t) =>
      sub(
        t,
        'bulkGetWindowed(reader, "drafts", named)',
        'bulkGetWindowed(reader, "drafts", [])',
      ),
  },
  {
    id: "MU-748",
    title:
      "R45 (revision 25): a dependant that is already settled stands behind the replacement (it blocks moving to the end, and counts as a cycle)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a dependant that is already terminal does not stand behind anything|an explicit dependency on a TERMINAL dependant is no cycle)/,
    patch: (t) =>
      sub(
        t,
        "    (member) => member.local_id !== old.local_id && !isTerminal(member),",
        "    (member) => member.local_id !== old.local_id,",
      ),
  },
  {
    id: "MU-749",
    title:
      "R45 (revision 25): only the DIRECT dependants of the old draft stand behind the replacement (a dependant further down the chain is neither refused as a cycle nor counted in the record)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(is a CYCLE: refused|and transitive ones count)/,
    patch: (t) =>
      sub(
        t,
        "  const standing = facts.cascade.filter(",
        "  const standing = facts.direct.filter(",
      ),
  },
  {
    id: "MU-750",
    title:
      "R45 (revision 25): a dependency is newer than the old draft's place when it is OLDER (the comparison is inverted)",
    file: "src/data/model/outbox.ts",
    tests: ["tests/data/outbox-supersede-order.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(takes the END of the queue|nothing it waits for is newer|retarget-occupied after)/,
    patch: (t) =>
      sub(
        t,
        "      row !== undefined && !isTerminal(row) && row.created_seq > old.created_seq",
        "      row !== undefined && !isTerminal(row) && row.created_seq < old.created_seq",
      ),
  },
  {
    id: "MU-759",
    title:
      "R46 (revision 26): a save that lands does not end its own failure streak (a reload loses the page's memory of the failure, and the count stands: the draft is not sent)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /enqueue, (below_bound|streak)/,
    patch: (t) =>
      sub(
        t,
        "      sync: withoutStreaks(planned.sync, ended) ?? planned.sync,",
        "      sync: planned.sync,",
      ),
  },
  {
    id: "MU-760",
    title:
      "R46 (revision 26): the repeat of a save that had already landed (a duplicate) does not end the failures of the repeat",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(enqueue: two failures then a success|a marker that will not be removed)/,
    patch: (t) =>
      sub(
        t,
        '    if (planned.kind === "duplicate") {\n      const cleared = withoutStreaks(sync, ended);',
        '    if (planned.kind === "duplicate") {\n      const cleared = (false as boolean) ? withoutStreaks(sync, ended) : undefined;',
      ),
  },
  {
    id: "MU-761",
    title:
      "R46 (revision 26): an edit that lands does not end its own failure streak",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /editQueued, (below_bound|streak)/,
    patch: (t) =>
      sub(
        t,
        `    const cleared = withoutStreaks(sync, [\`draft:\${input.localId}\`]);\n    return {\n      writes: [\n        w.put("drafts", planned.draft),`,
        `    const cleared = (false as boolean) ? withoutStreaks(sync, [\`draft:\${input.localId}\`]) : undefined;\n    return {\n      writes: [\n        w.put("drafts", planned.draft),`,
      ),
  },
  {
    id: "MU-762",
    title:
      "R46 (revision 26): a discard that lands does not end the failure streaks of the draft it removed",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /discard, (below_bound|streak)/,
    patch: (t) =>
      sub(
        t,
        "      sync === undefined\n        ? undefined\n        : withoutStreaks(sync, draftOperations(input.localId));",
        "      undefined as SyncStateRow | undefined;",
      ),
  },
  {
    id: "MU-763",
    title:
      "R46 (revision 26): a discard ends only the draft's saves' streak, not its receipts' (the draft's two operations are both its own)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /abandons BOTH of the draft's operations in the record/,
    patch: (t) =>
      sub(
        t,
        "        : withoutStreaks(sync, draftOperations(input.localId));",
        `        : withoutStreaks(sync, [\`draft:\${input.localId}\`]);`,
      ),
  },
  {
    id: "MU-764",
    title:
      "R46 (revision 26): a discard of a draft that is already gone does not end the streaks it left behind",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /already gone \(it was removed meanwhile\)/,
    patch: (t) =>
      sub(
        t,
        '      if (decision.reason !== "not_found" || ended === undefined)\n        return { result: decision };',
        '      if ((true as boolean) || decision.reason !== "not_found" || ended === undefined)\n        return { result: decision };',
      ),
  },
  {
    id: "MU-765",
    title:
      "R46 (revision 26): every refused discard ends the draft's streaks (a refusal for another reason abandons nothing)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /already gone \(it was removed meanwhile\)/,
    patch: (t) =>
      sub(
        t,
        '      if (decision.reason !== "not_found" || ended === undefined)\n        return { result: decision };',
        "      if (ended === undefined)\n        return { result: decision };",
      ),
  },
  {
    id: "MU-766",
    title:
      "R46 (revision 26): a supersession that lands does not end the replacement's own failure streak",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /supersede, (below_bound|streak)/,
    patch: (t) =>
      sub(
        t,
        `    const ended = [\n      \`draft:\${input.localId}\`,\n      ...draftOperations(input.oldLocalId),\n    ];`,
        "    const ended = [...draftOperations(input.oldLocalId)];",
      ),
  },
  {
    id: "MU-767",
    title:
      "R46 (revision 26): a supersession does not end the failure streaks of the draft it abandons",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the counter, the replacement and the cleared streaks are one write|abandoned draft)/,
    patch: (t) =>
      sub(
        t,
        `    const ended = [\n      \`draft:\${input.localId}\`,\n      ...draftOperations(input.oldLocalId),\n    ];`,
        `    const ended = [\`draft:\${input.localId}\`];`,
      ),
  },
  {
    id: "MU-768",
    title:
      "R46 (revision 26): the counter a moved replacement consumed is lost when its transaction also ends streaks (the sequence number is reused)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the counter, the replacement and the cleared streaks are one write/,
    patch: (t) =>
      sub(
        t,
        "    const base = decision.sync ?? sync;",
        "    const base = sync;",
      ),
  },
  {
    id: "MU-769",
    title:
      "R46 (revision 26): the repeat of a supersession that had already been made does not end the failures of the repeat",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /supersede: two failures then a success/,
    patch: (t) =>
      sub(
        t,
        '    if (decision.kind === "duplicate") {\n      const cleared = withoutStreaks(sync, ended);',
        '    if (decision.kind === "duplicate") {\n      const cleared = (false as boolean) ? withoutStreaks(sync, ended) : undefined;',
      ),
  },
  {
    id: "MU-770",
    title:
      "R46 (revision 26): a claim that lands does not end the failure streak of the claim (a count left by an earlier page stands)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a claim that lands ends the failures of the claim/,
    patch: (t) =>
      sub(
        t,
        `    const cleared = withoutStreaks(sync, [\`draft:\${draft.local_id}\`]);`,
        `    const cleared = (false as boolean) ? withoutStreaks(sync, [\`draft:\${draft.local_id}\`]) : undefined;`,
      ),
  },
  {
    id: "MU-771",
    title:
      "R46 (revision 26): a request that got no answer, recorded successfully, does not end the receipt streak",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a request that got no answer, recorded successfully/,
    patch: (t) =>
      sub(
        t,
        `        : withoutStreaks(sync, [\`receipt:\${input.localId}\`]);\n    return {\n      writes: [w.bulkPut("drafts", decision.draftPuts)],`,
        '        : undefined;\n    return {\n      writes: [w.bulkPut("drafts", decision.draftPuts)],',
      ),
  },
  {
    id: "MU-772",
    title:
      "R46 (revision 26): the record of a request that got no answer ends the draft's SAVE streak instead of its receipt streak",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a request that got no answer, recorded successfully/,
    patch: (t) =>
      sub(
        t,
        `        : withoutStreaks(sync, [\`receipt:\${input.localId}\`]);\n    return {\n      writes: [w.bulkPut("drafts", decision.draftPuts)],`,
        `        : withoutStreaks(sync, [\`draft:\${input.localId}\`]);\n    return {\n      writes: [w.bulkPut("drafts", decision.draftPuts)],`,
      ),
  },
  {
    id: "MU-773",
    title:
      "R46 (revision 26): a success ends EVERY operation's failure streak, not only its own",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(nothing else does|another operation's success does NOT end)/,
    patch: (t) =>
      sub(
        t,
        "    streaks = onLocalWriteSuccess(streaks, operation);\n  return streaks === sync.local_write_streaks",
        "    streaks = {};\n  return streaks === sync.local_write_streaks",
      ),
  },
  {
    id: "MU-774",
    title:
      "R46 (revision 26): the dispatch window does not report the failures of the queue read",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(three isolated aborts of the queue read|a count left by an earlier page|a clearing of the queue count)/,
    patch: (t) =>
      sub(
        t,
        "      queueFailures: sync?.local_write_streaks[QUEUE_OPERATION] ?? 0,",
        "      queueFailures: 0,",
      ),
  },
  {
    id: "MU-775",
    title:
      "R46 (revision 26): a read of the queue that lands ends the failure count only (a queue stop that only a marker or the memory holds stands)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a queue stop that only a marker or the memory holds ends/,
    patch: (t) =>
      sub(
        t,
        "      failedOperations.has(QUEUE_OPERATION) ||\n      queueStopped(service)\n    )",
        "      (false as boolean)\n    )",
      ),
  },
  {
    id: "MU-776",
    title:
      "R46 (revision 26): a read of the queue that lands does not end the failure count (three isolated aborts are three in a row)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(three isolated aborts of the queue read|a count left by an earlier page|a clearing of the queue count)/,
    patch: (t) =>
      sub(
        t,
        "      window.queueFailures > 0 ||\n",
        "      (window.queueFailures > 0 && (false as boolean)) ||\n",
      ),
  },
  {
    id: "MU-777",
    title:
      "R46 (revision 26): the dispatcher only ADDS to the drafts it holds stopped; a stop that has ended in the record is never released",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a stop that ended in the record is released|discarding a stopped draft ends)/,
    patch: (t) =>
      sub(
        t,
        '    if (reconcileStalled(window.stopped)) return { when: "now" };',
        "    for (const draft of window.stopped) stalled.add(draft);",
      ),
  },
  {
    id: "MU-778",
    title:
      "R46 (revision 26): the stop only this tab's memory holds is released by the next step (it is not in the record)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/outbox-local-stop.test.ts",
      "tests/data/outbox-local-recovery.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a wake, coming online and a long wait do not resend it|a stop and a start of the dispatcher|another draft is still sent, and its success)/,
    patch: (t) =>
      sub(
        t,
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...stops.operations(service),\n  ];",
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...([] as string[]),\n  ];",
      ),
  },
  {
    id: "MU-779",
    title:
      "R46 (revision 26): a draft whose stop has ended is released but keeps the infinite wait stalling gave it (it is never selected)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a draft the dispatcher itself stalled/,
    patch: (t) =>
      sub(
        t,
        "        if (blockedUntil.get(draft) === Number.POSITIVE_INFINITY)\n          blockedUntil.delete(draft);\n",
        "",
      ),
  },
  {
    id: "MU-780",
    title:
      "R46 (revision 26): a receipt (or a record of an answer) that lands leaves the draft's fallback marker standing",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a marker that appeared for the draft while its request was in flight/,
    patch: (t) =>
      sub(
        t,
        "    const ended = retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n    });",
        "    const ended = retireStops(undefined, stops, issued.seen, {\n      operations: [operation],\n    });",
      ),
  },
  {
    id: "MU-781",
    title:
      "R46 (revision 26): the dispatcher forgets an operation whose clearing could not be written (the next retry has nothing to end)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a clearing that cannot be written keeps the operation in the dispatcher's bookkeeping/,
    patch: (t) =>
      sub(
        t,
        "    } catch {\n      // Still recorded: the operation stays in `failedOperations`, and the next retry or successful read ends it.\n    }",
        "    } catch {\n      // x\n    }\n    failedOperations.delete(operation);",
      ),
  },
  {
    id: "MU-782",
    title:
      "R47 (revision 26): the dispatcher's retry for one draft matches the END of the operation's name (`a` also ends the stop of `ba`)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the dispatcher's retry for one draft is matched by the exact id/,
    patch: (t) =>
      sub(
        t,
        "        ...[...failedOperations].filter(covers),",
        "        ...[...failedOperations].filter(\n          (operation) => localId === undefined || operation.endsWith(localId),\n        ),",
      ),
  },
  {
    id: "MU-783",
    title:
      "R46 (revision 26): a record of an answer that lands (a rejection, a conflict) does not end the draft's receipt marker",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a marker that appeared for the draft while its request was in flight \(a rejection\)/,
    patch: (t) =>
      sub(
        t,
        '    if (out.value.kind === "recorded")\n      succeeded(service, draftOperations(draft.local_id)[1], issued);\n    deps.channel?.post({',
        "    deps.channel?.post({",
      ),
  },
  {
    id: "MU-784",
    title:
      "R46 (revision 26): a request that got no answer, recorded successfully, does not end the draft's receipt marker",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a marker that appeared for the draft while its request was in flight \(no answer\)/,
    patch: (t) =>
      sub(
        t,
        "          stopsChanged(service);\n        succeeded(service, draftOperations(draft.local_id)[1], issued);\n      }\n    } catch (caught) {",
        "          stopsChanged(service);\n      }\n    } catch (caught) {",
      ),
  },
  {
    id: "MU-785",
    title:
      "R46 (revision 26): a receipt that is admitted does not end the draft's receipt marker",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a marker that appeared for the draft while its request was in flight \(a receipt\)/,
    patch: (t) =>
      sub(
        t,
        '      if (out.value.kind === "admitted")\n        succeeded(service, draftOperations(draft.local_id)[1], issued);\n',
        "",
      ),
  },
  {
    id: "MU-808",
    title:
      "R46 (revision 26): a draft released from its stop is not given the queue again at once (the window that was read still held it back, and nothing looks again until some other wake)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/outbox-local-recovery.test.ts",
      "tests/data/outbox-cross-writer.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(a draft the dispatcher itself stalled|a LONE wake)/,
    patch: (t) =>
      sub(
        t,
        '    if (reconcileStalled(window.stopped)) return { when: "now" };',
        "    reconcileStalled(window.stopped);",
      ),
  },
  {
    id: "MU-786",
    title:
      "R46 (revision 26): a success does not remove the operation's fallback marker",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(save|, marker|a marker that will not be removed|abandoned draft)/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(undefined, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-787",
    title:
      "R46 (revision 26): a success does not drop this tab's memory of the operation's stop",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /, memory:/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(deps.markers, createLocalStops(), issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-788",
    title:
      "R47 (revision 26): after a success the warning is not looked at again from the records (it stays up, or goes down on the page's own count)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(, (streak|marker|memory)|the success of one draft's own save|the controller's save that succeeds)/,
    patch: (t) =>
      sub(
        t,
        "    if (warned || unsure) await look();",
        "    if ((false as boolean) && (warned || unsure)) await look();",
      ),
  },
  {
    id: "MU-789",
    title:
      "R47 (revision 26): a success made before the page's first look is answered does not look again (the older look then decides, and leaves a stale warning)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a save made right after a reload, which ends the very stop/,
    patch: (t) =>
      sub(
        t,
        "    if (warned || unsure) await look();",
        "    if (warned) await look();",
      ),
  },
  {
    id: "MU-790",
    title:
      "R47 (revision 26): when the record cannot be read the warning is taken down (a guess that nothing stands)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/outbox-local-recovery.test.ts",
      "tests/data/outbox-cross-writer.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(when the record cannot be read the warning is not taken down on a guess|a stop this page's own successful save ended is not shown as gone)/,
    patch: (t) =>
      sub(
        t,
        "    else if (known) storage.set(false);",
        "    else storage.set(false);",
      ),
  },
  {
    id: "MU-791",
    title:
      "R47 (revision 26): the warning does not count the stops this tab holds in memory alone",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(A is stopped by (memory|streak|marker|receipt), B by memory|B by memory|the unscoped retry lifts every stop)/,
    patch: (t) =>
      sub(
        t,
        "    const found = new Set<string>([...markers.operations, ...memoryDrafts()]);",
        "    const found = new Set<string>([...markers.operations]);",
      ),
  },
  {
    id: "MU-792",
    title:
      'R47 (revision 26): "Try again" for one draft takes the shared warning down at once, whatever else is stopped',
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /A is stopped by/,
    patch: (t) =>
      sub(
        t,
        "      if (everKnown && [...standing].every(covers)) {",
        "      if (everKnown) {",
      ),
  },
  {
    id: "MU-793",
    title:
      "R47 (revision 26): the facade's retry matches the END of the operation's name (`a` also lifts the stop of `ba`)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /leaves .* alone/,
    patch: (t) =>
      sub(
        t,
        "      const covers = (operation: string): boolean =>\n        localId === undefined || operationDraft(operation) === localId;",
        "      const covers = (operation: string): boolean =>\n        localId === undefined || operation.endsWith(localId);",
      ),
  },
  {
    id: "MU-794",
    title:
      "R47 (revision 26): after the stops are lifted the warning is not derived again from what remains (a clearing that failed is shown as recovered)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a retry whose clearing cannot be written does not claim the recovery/,
    patch: (t) =>
      sub(
        t,
        "        showMemoryOnly();\n        stops.announce(service, self, { ended: lifted });\n        await look();\n      })();",
        "        showMemoryOnly();\n        stops.announce(service, self, { ended: lifted });\n      })();",
      ),
  },
  {
    id: "MU-795",
    title:
      "R46 (revision 26): the facade forgets a stop whose clearing could not be written (the next retry has nothing to end below the bound)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /keeps a failure BELOW the bound in the bookkeeping too/,
    patch: (t) =>
      sub(
        t,
        "    } catch {\n      // Still recorded: it stays in `failed`, and in `standing` while a read cannot say it ended.\n    }\n  }",
        "    } catch {\n      // x\n    }\n    failed.delete(operation);\n  }",
      ),
  },
  {
    id: "MU-796",
    title:
      "R47 (revision 26): a stop this page recorded itself is not remembered as standing (a retry of another draft sees nothing else stopped)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /A is stopped by/,
    patch: (t) =>
      sub(
        t,
        "    looks += 1;\n    standing.add(operation);\n    storage.set(true);",
        "    looks += 1;\n    storage.set(true);",
      ),
  },
  {
    id: "MU-797",
    title:
      "R47 (revision 26): a stop recorded now does not outrank the older look still to be answered (the stale look takes the warning down)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/outbox-local-recovery.test.ts",
      "tests/data/outbox-cross-writer.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a stop recorded while the page's first look is still to be answered|never taken down by that look's older answer)/,
    patch: (t) =>
      sub(
        t,
        "    looks += 1;\n    standing.add(operation);\n    storage.set(true);",
        "    standing.add(operation);\n    storage.set(true);",
      ),
  },
  {
    id: "MU-798",
    title:
      "R46 (revision 26): a discard of a draft that is already gone does not end its operations in this page (its marker and warning stand)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /already gone \(it was removed meanwhile\)/,
    patch: (t) =>
      sub(
        t,
        "        await ended(draftOperations(localId), issued, draftOperations(localId));\n        return refusal;",
        "        return refusal;",
      ),
  },
  {
    id: "MU-799",
    title:
      "R46 (revision 26): a supersession does not end the draft it replaces in this page (its marker and warning stand)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /abandoned draft/,
    patch: (t) =>
      sub(
        t,
        `          await ended(\n            [\`draft:\${localId}\`, ...draftOperations(oldLocalId)],\n            issued,\n            draftOperations(oldLocalId),\n          );`,
        `          await ended([\`draft:\${localId}\`], issued);`,
      ),
  },
  {
    id: "MU-800",
    title:
      "R46 (revision 26, re-expressed in revision 27): an edit that lands does not tell the dispatcher, neither by waking it directly nor by the page's announcement that a stop ended (a draft whose stop it ended waits for some other trigger)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/outbox-local-recovery.test.ts",
      "tests/data/outbox-cross-writer.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a stop that ended in the record is released|a draft the dispatcher itself stalled)/,
    patch: (t) =>
      sub(
        sub(
          t,
          "          await ended([operation], issued);\n          changed();\n          // A draft whose own stop this ended (the dispatcher's, which this page's warning does not show) may be sent again now.\n          deps.dispatcher?.wake();",
          "          await ended([operation], issued);\n          changed();",
        ),
        "    stops.announce(service, self, { ended: operations });\n    // The act's own look",
        "    // The act's own look",
      ),
  },
  {
    id: "MU-801",
    title:
      "R47 (revision 26): a page that starts does not look at the records for a stop recorded before it (no warning after a reload)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/outbox-local-recovery.test.ts",
      "tests/data/outbox-local-stop.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(, (streak|marker|below_bound), after a reload|restores it from the durable streak|a marker keeps it across a reload|after a reload)/,
    patch: (t) =>
      sub(
        t,
        "  void reconcile();\n\n  const identityChanged",
        "  const identityChanged",
      ),
  },
  {
    id: "MU-802",
    title:
      "R46 (revision 26): a save that lands ends no operation of the page (nothing is retired by it)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(save|enqueue|, marker|, memory)/,
    patch: (t) =>
      sub(
        t,
        "          await ended([operation], issued);\n          changed();\n          deps.dispatcher?.wake();",
        "          await ended([], issued);\n          changed();\n          deps.dispatcher?.wake();",
      ),
  },
  {
    id: "MU-803",
    title:
      "R46 (revision 26): a discard that lands ends only the draft's saves' operation, not its receipts' (an abandoned draft's marker of either kind goes)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an abandoned draft's own markers end with it/,
    patch: (t) =>
      sub(
        t,
        "      await ended(draftOperations(localId), issued, draftOperations(localId));\n      changed();\n      deps.dispatcher?.wake();\n      return result;",
        `      await ended([\`draft:\${localId}\`], issued, [\`draft:\${localId}\`]);\n      changed();\n      deps.dispatcher?.wake();\n      return result;`,
      ),
  },
  {
    id: "MU-804",
    title:
      "R47 (revision 26): the dispatcher's own queue stop (its marker) is counted as a storage stop of the outbox's facade",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the dispatcher's own queue stop is not the outbox's storage warning/,
    patch: (t) =>
      sub(
        t,
        "        .filter((operation) => operationDraft(operation) !== null)\n        .sort(),",
        "        .filter(() => true)\n        .sort(),",
      ),
  },
  {
    id: "MU-805",
    title:
      "R47 (revision 26): an operation names a draft when the prefix is anywhere in it (`xdraft:a` is a draft's)",
    file: "src/data/model/retry.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`draft:<id>` and `receipt:<id>` name their id/,
    patch: (t) =>
      sub(
        t,
        "    if (operation.startsWith(prefix) && operation.length > prefix.length)",
        "    if (operation.includes(prefix) && operation.length > prefix.length)",
      ),
  },
  {
    id: "MU-806",
    title: "R47 (revision 26): an operation with an empty id names a draft",
    file: "src/data/model/retry.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`draft:<id>` and `receipt:<id>` name their id/,
    patch: (t) =>
      sub(
        t,
        "    if (operation.startsWith(prefix) && operation.length > prefix.length)",
        "    if (operation.startsWith(prefix))",
      ),
  },
  {
    id: "MU-807",
    title: "R47 (revision 26): a draft's two operations are both its save's",
    file: "src/data/model/retry.ts",
    tests: ["tests/data/outbox-local-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a draft's two operations are exactly its own/,
    patch: (t) =>
      sub(
        t,
        `  \`\${RECEIPT_OPERATION_PREFIX}\${localId}\`,\n];`,
        `  \`\${DRAFT_OPERATION_PREFIX}\${localId}\`,\n];`,
      ),
  },
  {
    id: "MU-818",
    title:
      "R46 (revision 27): the page's memory of a stop ignores the incarnation (a database deleted and created again inherits a stop of the one before)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /exactly the operation it is given, in exactly its scope/,
    patch: (t) =>
      sub(
        t,
        "    JSON.stringify([scope.account, scope.incarnationId]);",
        "    JSON.stringify([scope.account]);",
      ),
  },
  {
    id: "MU-819",
    title:
      "R46 (revision 27): ending the tab's hold on an operation says it held one whether or not it did",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /exactly the operation it is given, in exactly its scope/,
    patch: (t) =>
      sub(
        t,
        "      if (!operations.delete(operation)) return false;\n      if (operations.size === 0) held.delete(key);\n      return true;",
        "      operations.delete(operation);\n      if (operations.size === 0) held.delete(key);\n      return true;",
      ),
  },
  {
    id: "MU-820",
    title:
      "R46 (revision 27): an account's markers are removed with its database but the page's memory of its stops is not",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /markers and its memory of stops are removed together/,
    patch: (t) =>
      sub(t, "      stops.clearAccount(account);\n    },", "    },"),
  },
  {
    id: "MU-821",
    title:
      "R46 (revision 27): removing an account's memory of stops removes every account's",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /markers and its memory of stops are removed together/,
    patch: (t) =>
      sub(
        t,
        "        if ((JSON.parse(key) as [string, string])[0] === account)\n          held.delete(key);",
        "        held.delete(key);",
      ),
  },
  {
    id: "MU-822",
    title:
      "R46 (revision 27): one writer's defect in hearing an announcement stops the others from hearing it",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /one listener's defect stops no other/,
    patch: (t) =>
      sub(
        t,
        "        try {\n          listener(scope, from, news);\n        } catch {\n          // One writer's defect must not stop another from hearing.\n        }",
        "        listener(scope, from, news);",
      ),
  },
  {
    id: "MU-823",
    title:
      "R46 (revision 27): the markers hand every writer a record of its own (the page's memory of a stop is not shared)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(R46|R47|dispatcher|facade|memory)/,
    patch: (t) =>
      sub(
        t,
        "  return {\n    stops,\n    set(scope, operation, live) {",
        "  return {\n    get stops() {\n      return createLocalStops();\n    },\n    set(scope, operation, live) {",
      ),
  },
  {
    id: "MU-824",
    title:
      "R46 (revision 27): the dispatcher records the stop it could not store nowhere (it is not held in the page's memory)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(dispatcher|memory)/,
    patch: (t) =>
      sub(
        t,
        "          hold: () => {\n            stops.hold(service, operation);\n          },",
        "          hold: () => () => undefined,",
      ),
  },
  {
    id: "MU-825",
    title:
      "R47 (revision 27): the dispatcher does not tell the page's facades that a stop reached its bound in the record",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /shown by the facade at once/,
    patch: (t) =>
      sub(
        t,
        "      if (result.stop) {\n        stops.announce(service, self, { recorded: [operation] });\n        stopsChanged(service);\n        return stall(id, service, operation);\n      }",
        "      if (result.stop) {\n        stopsChanged(service);\n        return stall(id, service, operation);\n      }",
      ),
  },
  {
    id: "MU-826",
    title:
      "R47 (revision 27): the dispatcher does not tell the page's facades about a stop it recorded in a marker or its memory",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /shown by the facade at once/,
    patch: (t) =>
      sub(
        t,
        "      stops.announce(service, self, { recorded: [operation] });\n      return stall(id, service, operation);\n    }\n    if (!alive(id))",
        "      return stall(id, service, operation);\n    }\n    if (!alive(id))",
      ),
  },
  {
    id: "MU-827",
    title:
      "R46 (revision 27): a receipt that lands does not end the page's memory of the draft's stop",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ends with the receipt that landed/,
    patch: (t) =>
      sub(
        t,
        "    const ended = retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n    });",
        "    const ended = retireStops(deps.markers, createLocalStops(), issued.seen, {\n      operations: [operation],\n    });",
      ),
  },
  {
    id: "MU-828",
    title:
      "R47 (revision 27): a success of the dispatcher's does not tell the facades that a stop ended",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ends with the receipt that landed/,
    patch: (t) =>
      sub(
        t,
        "    if (knew || ended.length > 0)\n      stops.announce(service, self, { ended: [operation] });",
        "    void knew;",
      ),
  },
  {
    id: "MU-829",
    title:
      "R46 (revision 27): the dispatcher's own clearing of an operation does not end the page's memory of its stop",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dispatcher's retry lifts a stop the page holds in memory/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
        "    retireStops(deps.markers, createLocalStops(), issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
      ),
  },
  {
    id: "MU-830",
    title:
      "R46 (revision 27): the dispatcher's retry does not reach a stop the page holds in memory that the dispatcher has not looked at",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dispatcher's retry lifts a stop the page holds in memory/,
    patch: (t) =>
      sub(t, "        ...stops.operations(service).filter(covers),\n", ""),
  },
  {
    id: "MU-831",
    title:
      "R47 (revision 27): the dispatcher's retry for one draft lifts every stop the page holds in memory",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /dispatcher's retry lifts a stop the page holds in memory/,
    patch: (t) =>
      sub(
        t,
        "        ...stops.operations(service).filter(covers),",
        "        ...stops.operations(service),",
      ),
  },
  {
    id: "MU-832",
    title:
      "R46 (revision 27): the dispatcher's state does not say that a stop is held in this tab alone",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(honours a stop the facade holds|a memory stop of the facade|memory stop)/,
    patch: (t) =>
      sub(
        t,
        "          ...(stops.operations(service).length > 0\n            ? { memoryOnly: true as const }\n            : {}),",
        "          ...{},",
      ),
  },
  {
    id: "MU-833",
    title:
      "R46 (revision 27): the dispatcher does not look again when another writer of the page ends a stop (a facade it was not composed with ends the stop of a draft it holds back)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /ends on the (editQueued|discard) of a facade that has no dispatcher/,
    patch: (t) =>
      sub(
        t,
        '          if (stalled.size > 0 || store.get().kind === "stopped") wake();',
        "          void wake;",
      ),
  },
  {
    id: "MU-834",
    title:
      "R46 (revision 27): the dispatcher steps for every announcement of the page, whether or not it holds anything back",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /does not make the dispatcher look at the queue/,
    patch: (t) =>
      sub(
        t,
        '          if (stalled.size > 0 || store.get().kind === "stopped") wake();',
        "          wake();",
      ),
  },
  {
    id: "MU-835",
    title:
      "R46 (revision 27): the dispatcher steps for an announcement about another account or another lifetime of the database",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(news of another account, or of another lifetime|a healthy save by a facade the dispatcher was not composed with)/,
    patch: (t) =>
      sub(
        t,
        "            service === null ||\n            scope.account !== service.account ||\n            scope.incarnationId !== service.incarnationId\n          )\n            return;",
        "            service === null\n          )\n            return;",
      ),
  },
  {
    id: "MU-836",
    title:
      "R46 (revision 27): a facade has a record of its own stops, whatever markers and dispatcher it was given",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(R46|R47|dispatcher|facade|memory)/,
    patch: (t) =>
      sub(
        t,
        "    deps.markers?.stops ?? deps.dispatcher?.stops ?? createLocalStops();",
        "    createLocalStops();",
      ),
  },
  {
    id: "MU-837",
    title:
      "R46 (revision 27): a facade composed with a dispatcher and given no markers does not share the dispatcher's record",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(shares the dispatcher's record|no markers)/,
    patch: (t) =>
      sub(
        t,
        "    deps.markers?.stops ?? deps.dispatcher?.stops ?? createLocalStops();",
        "    deps.markers?.stops ?? createLocalStops();",
      ),
  },
  {
    id: "MU-838",
    title:
      "R47 (revision 27): a look that could not read the record forgets the stops this page knew of",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(unreadable|UNKNOWN|unknown)/,
    patch: (t) =>
      sub(
        t,
        "    standing = known\n      ? new Set(operations)\n      : new Set([...standing, ...operations]);",
        "    standing = new Set(operations);",
      ),
  },
  {
    id: "MU-839",
    title:
      "R47 (revision 27): a look that could not read the record says the stops have ended",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(own successful save|retained rule|record is unreadable)/,
    patch: (t) =>
      sub(
        t,
        "    else if (known) storage.set(false);",
        "    else storage.set(false);",
      ),
  },
  {
    id: "MU-840",
    title:
      "R47 (revision 27): messages that arrive while a look is outstanding start a look each (the reads pile up)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(a burst|hint)/,
    patch: (t) =>
      sub(
        t,
        "    if (pass !== null) {\n      again = true;\n      return pass;\n    }",
        "",
      ),
  },
  {
    id: "MU-841",
    title:
      "R47 (revision 27): a message that arrives while a look is outstanding is not looked at after it (the last word is not the record's)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a message that arrives while a look is outstanding|a look that a newer stop made out of date)/,
    patch: (t) =>
      sub(
        t,
        "      } while (again && observing);",
        "      } while ((false as boolean) && observing);",
      ),
  },
  {
    id: "MU-842",
    title:
      "R47 (revision 27): a database change another tab announced is read whether or not anything is shown or unsure",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(not read|quiet|a hint)/,
    patch: (t) =>
      sub(
        t,
        "      if (storage.get() || unsure || standing.size > 0) void reconcile();\n      else if (message.stores.includes(LOCAL_WRITE_STOPS_STORE))\n        void reconcile();",
        "      void reconcile();",
      ),
  },
  {
    id: "MU-843",
    title:
      "R47 (revision 27): a database change announced for another account is read",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a hint for another account is not read/,
    patch: (t) =>
      sub(
        t,
        '      if (\n        message.type !== "data_changed" ||\n        message.account !== service.account\n      )\n        return;',
        '      if (message.type !== "data_changed") return;',
      ),
  },
  {
    id: "MU-844",
    title:
      "R47 (revision 27): a marker another tab sets or removes is not heard by the facade",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a marker another tab removes is heard/,
    patch: (t) =>
      sub(
        t,
        "      if (signatureOf(markedDrafts()) === expected) return;\n      void reconcile(true);",
        "      if (signatureOf(markedDrafts()) === expected) return;",
      ),
  },
  {
    id: "MU-845",
    title:
      "R47 (revision 27): a facade hears its own announcements (a second look for every success while a stop is shown)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a facade does not hear itself/,
    patch: (t) =>
      sub(
        t,
        "          from === self ||\n          scope.account !== service.account ||",
        "          scope.account !== service.account ||",
      ),
  },
  {
    id: "MU-846",
    title:
      "R47 (revision 27): a facade looks at the record for every announcement of the page, whatever operation it names",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /news of an operation it does not show is not read/,
    patch: (t) =>
      sub(
        t,
        "          (news.recorded?.length ?? 0) > 0 ||\n          (news.ended ?? []).some((operation) => standing.has(operation))\n        )",
        "          true\n        )",
      ),
  },
  {
    id: "MU-847",
    title:
      "R47 (revision 27): a facade looks at the record for news about another account or another lifetime of the database",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /news of another account, or of another lifetime/,
    patch: (t) =>
      sub(
        t,
        "          from === self ||\n          scope.account !== service.account ||\n          scope.incarnationId !== service.incarnationId\n        )\n          return;",
        "          from === self\n        )\n          return;",
      ),
  },
  {
    id: "MU-848",
    title:
      "R47 (revision 27): a facade does not tell the others that it recorded a stop (another facade does not show it)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(shows it|a stop recorded by one facade)/,
    patch: (t) =>
      sub(
        t,
        "    stops.announce(service, self, { recorded: [operation] });\n    // A look that was outstanding",
        "    // A look that was outstanding",
      ),
  },
  {
    id: "MU-849",
    title:
      "R47 (revision 27): a stop that makes an outstanding look out of date is not followed by a look of its own",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a look that a newer stop made out of date/,
    patch: (t) =>
      sub(
        t,
        "    // meanwhile is read again.\n    void reconcile();",
        "    // meanwhile is read again.",
      ),
  },
  {
    id: "MU-850",
    title:
      "R46 (revision 27): a facade does not hold in the page's memory a stop it could record nowhere else",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(R46|R47|dispatcher|facade|memory)/,
    patch: (t) =>
      sub(
        t,
        "          hold: () => {\n            stops.hold(service, operation);\n          },",
        "          hold: () => () => undefined,",
      ),
  },
  {
    id: "MU-851",
    title:
      "R47 (revision 27): a facade does not tell the others that a stop ended by its success",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(stop recorded by one facade|dispatcher's \w+ stop ends on the)/,
    patch: (t) =>
      sub(
        t,
        "    stops.announce(service, self, { ended: operations });\n    // The act's own look",
        "    // The act's own look",
      ),
  },
  {
    id: "MU-852",
    title:
      "R47 (revision 27): a facade tells the others of a success that it ended nothing",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(stop recorded by one facade|dispatcher's \w+ stop ends on the)/,
    patch: (t) =>
      sub(
        t,
        "    stops.announce(service, self, { ended: operations });",
        "    stops.announce(service, self, { ended: [] });",
      ),
  },
  {
    id: "MU-853",
    title:
      "R47 (revision 27): a lifted stop stays in what this page knows of until a read says it ended",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(unscoped retry lifts what the page knew|unreadable)/,
    patch: (t) =>
      sub(
        t,
        "      if (!unnamed && (failedAt.get(operation) ?? 0) <= issued.failures) {\n        failed.delete(operation);\n        standing.delete(operation);\n      }",
        "      if (!unnamed && (failedAt.get(operation) ?? 0) <= issued.failures) {\n        failed.delete(operation);\n      }",
      ),
  },
  {
    id: "MU-854",
    title:
      "R47 (revision 27): a retry does not lift the stops the last look found (only the page's own failures)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /after a reload, with the record unreadable, the retry lifts the stop the last look found/,
    patch: (t) =>
      sub(
        t,
        "      const knew = [...failed, ...standing].filter(covers);",
        "      const knew = [...failed].filter(covers);",
      ),
  },
  {
    id: "MU-855",
    title:
      "R46 (revision 27): a facade's lifting of an operation does not end the page's memory of its stop (the dispatcher's, or another facade's)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(R46|R47|dispatcher|facade|memory)/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: true,\n    });",
        "    retireStops(deps.markers, createLocalStops(), issued.seen, {\n      operations: [operation],\n      explicit: true,\n    });",
      ),
  },
  {
    id: "MU-856",
    title:
      "R47 (revision 27): a facade's retry does not tell the others that it lifted a stop",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(takes the first one's warning down|stop recorded by one facade)/,
    patch: (t) =>
      sub(
        t,
        "        stops.announce(service, self, { ended: lifted });\n        await look();",
        "        await look();",
      ),
  },
  {
    id: "MU-857",
    title:
      "R47 (revision 27): the dispatcher's own queue stop in the page's memory is counted as a draft's by the facade",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the dispatcher's own queue stop is not a draft's/,
    patch: (t) =>
      sub(
        t,
        "      .filter((operation) => operationDraft(operation) !== null);\n  const showMemoryOnly",
        "  ;\n  const showMemoryOnly",
      ),
  },
  {
    id: "MU-858",
    title:
      "R15 (revision 27): a marker another tab sets or removes makes the facade look at the record whatever operation it names (a page's or a capture's marker costs a read)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /is not the outbox's: the facade does not look/,
    patch: (t) =>
      sub(
        t,
        "      if (signatureOf(markedDrafts()) === expected) return;\n",
        "",
      ),
  },
  {
    id: "MU-859",
    title:
      "R15 (revision 27): the facade hears a marker another tab SETS and not one it removes (a stop another tab ended stays shown)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /is not the outbox's: the facade does not look/,
    patch: (t) =>
      sub(
        t,
        "    if (signatureOf(markedDrafts()) === expected) return;\n",
        '    if (signatureOf(markedDrafts()).length <= (expected ?? "").length) return;\n',
      ),
  },
  {
    id: "MU-869",
    title:
      "R46 (revision 28): the claim does not consult the durable record (a draft whose count reached the bound is claimed, and the claim ends the count)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(recorded while (the queue read|the claim) is held|refuses the claim and is NOT cleared)/,
    patch: (t) =>
      sub(
        t,
        "      draftStopped(sync.local_write_streaks, draft.local_id) ||\n      input.heldOutside?.(draft.local_id) === true\n",
        "      input.heldOutside?.(draft.local_id) === true\n",
      ),
  },
  {
    id: "MU-870",
    title:
      "R46 (revision 28): the claim does not consult the stops the database does not hold (the page's memory and the marker): it claims, and the step that issues the request gives the claim back",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(WRITES NOTHING|through `heldOutside`)/,
    patch: (t) =>
      sub(
        t,
        "      draftStopped(sync.local_write_streaks, draft.local_id) ||\n      input.heldOutside?.(draft.local_id) === true\n",
        "      draftStopped(sync.local_write_streaks, draft.local_id)\n",
      ),
  },
  {
    id: "MU-871",
    title:
      "R46 (revision 28): the durable bound is exclusive (a count AT the bound does not stop the draft)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /at the bound refuses the claim/,
    patch: (t) =>
      sub(
        t,
        "    (operation) => (streaks[operation] ?? 0) >= after,",
        "    (operation) => (streaks[operation] ?? 0) > after,",
      ),
  },
  {
    id: "MU-872",
    title:
      "R46 (revision 28): the claim reads the draft's own operation and not its receipt's (a durable stop of `receipt:<id>` does not hold the draft)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /receipt:a at the bound refuses the claim/,
    patch: (t) =>
      sub(
        t,
        "  return draftOperations(localId).some(\n    (operation) => (streaks[operation] ?? 0) >= after,\n  );",
        `  return (streaks[\`draft:\${localId}\`] ?? 0) >= after;`,
      ),
  },
  {
    id: "MU-873",
    title:
      "R46 (revision 28): the claim that refuses a stopped draft also ends its count (a refusal is a recovery)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /NOT cleared/,
    patch: (t) =>
      sub(
        t,
        '      return { result: { kind: "stopped" } };\n    const flipped',
        `      return {\n        sync: withoutStreaks(sync, [\`draft:\${draft.local_id}\`]) ?? sync,\n        result: { kind: "stopped" },\n      };\n    const flipped`,
      ),
  },
  {
    id: "MU-874",
    title:
      "R46 (revision 28): the claim asks the page about another draft than the one it claims",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /through `heldOutside`/,
    patch: (t) =>
      sub(
        t,
        "      input.heldOutside?.(draft.local_id) === true\n",
        '      input.heldOutside?.("") === true\n',
      ),
  },
  {
    id: "MU-875",
    title:
      "R46 (revision 28): the dispatcher hands the claim no page-level stops (the claim reads the durable record only)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /WRITES NOTHING/,
    patch: (t) =>
      sub(t, "      heldOutside: () => heldOutside(service, pick),\n", ""),
  },
  {
    id: "MU-876",
    title:
      "R46 (revision 28): the step that issues the request does not ask the marker or the page's memory (a marker another tab wrote since the claim is sent through)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nothing announces it/,
    patch: (t) =>
      sub(
        t,
        "    if (heldOutside(service, pick) || announcedSince(pick.local_id)) {",
        "    if (announcedSince(pick.local_id)) {",
      ),
  },
  {
    id: "MU-877",
    title:
      "R46 (revision 28): the step that issues the request does not honour a stop another writer announced since the attempt began (a durable stop recorded after the claim landed is sent through)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(streak: recorded while the claim is held|the step that issues the request is where it is refused)/,
    patch: (t) =>
      sub(
        t,
        "    if (heldOutside(service, pick) || announcedSince(pick.local_id)) {",
        "    if (heldOutside(service, pick)) {",
      ),
  },
  {
    id: "MU-878",
    title:
      "R46 (revision 28): the dispatcher does not collect the stops other writers announce while an attempt is under way",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(streak: recorded while the claim is held|the step that issues the request is where it is refused)/,
    patch: (t) =>
      sub(
        t,
        "          for (const operation of news.recorded ?? [])\n            announced?.add(operation);\n",
        "",
      ),
  },
  {
    id: "MU-879",
    title:
      "R46 (revision 28): the announced stops outlive their attempt (a stop recorded and lifted while one claim was outstanding gives back every later claim of the draft)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /recorded and lifted while the claim was outstanding/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    announced = new Set();\n    try {",
          "    announced ??= new Set();\n    try {",
        ),
        "    } finally {\n      announced = null;\n    }",
        "    } finally {\n    }",
      ),
  },
  {
    id: "MU-880",
    title:
      "R46 (revision 28): a claim that landed leaves the dispatcher's count of its own failures standing (an explicit retry then writes a clearing it does not need)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /leaves the dispatcher nothing to clear/,
    patch: (t) =>
      sub(
        t,
        "    failedOperations.delete(draftOperations(pick.local_id)[0] as string);",
        "",
      ),
  },
  {
    id: "MU-881",
    title:
      "R46 (revision 28): a claim that landed counts as the operation's own success: it releases the page's memory stop and removes the marker that were recorded since its decision",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(memory|marker): recorded while the claim is held/,
    patch: (t) =>
      sub(
        t,
        "    failedOperations.delete(draftOperations(pick.local_id)[0] as string);",
        "    succeeded(service, draftOperations(pick.local_id)[0] as string);",
      ),
  },
  {
    id: "MU-882",
    title:
      "R46 (revision 28): a refusal because a stop stands is asked again at once however often (the queue read and the claim, if they ever disagree, spin against each other)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-claim-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(attempts are paced|queue read that cannot see the stop)/,
    patch: (t) =>
      sub(
        t,
        '    return next.when === "now" && refusedRun > 2\n      ? { when: "after", ms: 1_000 }\n      : next;',
        "    return next;",
      ),
  },
  {
    id: "MU-883",
    title:
      "R47 (revision 28): a failed enumeration reports no marker at all (the stops this page established are forgotten)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(marked while it cannot be read|BOTH reads failing|the warning stands|established while the queue read is held)/,
    patch: (t) =>
      sub(
        t,
        /(for \(const instance of instances\)\n\s+established\.add\(id, operation, instance\);\n\s+return \{\n\s+)operations: established\s*\.operations\(id\)[\s\S]*?known: false,/,
        "$1operations: [],\n        known: false,",
      ),
  },
  {
    id: "MU-884",
    title:
      "R47 (revision 28): a failed enumeration reports itself complete (the facade replaces what it knew)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(WROTE stays marked|BOTH reads failing|the warning stands)/,
    patch: (t) =>
      sub(
        t,
        /(for \(const instance of instances\)\n\s+established\.add\(id, operation, instance\);\n\s+return \{\n\s+operations: established\s*\.operations\(id\)[\s\S]*?)known: false,/,
        "$1known: true,",
      ),
  },
  {
    id: "MU-885",
    title:
      "R47 (revision 28): a failed read of one marker is an absent marker (`unmarked`)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
      "tests/data/controller-marker-unreadable.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(WROTE stays marked|BOTH reads failing|a read of this one found|keeps the cache hidden|the gate is not open)/,
    patch: (t) =>
      sub(
        t,
        "    if (!observed.complete) {\n      for (const instance of instances)",
        '    if (!observed.complete) {\n      return { kind: "none" };\n      for (const instance of instances)',
      ),
  },
  {
    id: "MU-886",
    title:
      "R47 (revision 28): a failed read of one marker is unknown even for a marker this page established",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
      "tests/data/controller-marker-unreadable.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(WROTE stays marked|BOTH reads failing|a read of this one found|keeps the cache hidden|the gate is not open)/,
    patch: (t) =>
      sub(
        t,
        '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : { kind: "unread" };\n    }\n    learn(',
        '      void known;\n      return { kind: "unread" };\n    }\n    learn(',
      ),
  },
  {
    id: "MU-887",
    title: "R47 (revision 28): a marker this page writes is not established",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(WROTE stays marked|BOTH reads failing)/,
    patch: (t) =>
      sub(
        t,
        "    const id = scopeId(scope);\n    established.add(id, operation, instance);\n",
        "    const id = scopeId(scope);\n",
      ),
  },
  {
    id: "MU-888",
    title:
      "R47 (revision 28): the page forgets a marker even when its removal threw (the marker may still be there)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a removal that THROWS ends nothing/,
    patch: (t) =>
      sub(
        t,
        "    } catch {\n      if (owe)\n        owed.set(",
        "    } catch {\n      gone(scope, operation, instance);\n      if (owe)\n        owed.set(",
      ),
  },
  {
    id: "MU-889",
    title:
      "R47 (revision 28): the page never forgets a marker it removed itself",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /own removal of it ends it/,
    patch: (t) =>
      sub(
        t,
        "      storage.removeItem(markerKey(scope, operation, instance));\n      gone(scope, operation, instance);\n      return true;",
        "      storage.removeItem(markerKey(scope, operation, instance));\n      return true;",
      ),
  },
  {
    id: "MU-890",
    title:
      "R47 (revision 28): a read that lands and finds the marker gone does not end what the page established",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a read that LANDS and finds it gone ends it/,
    patch: (t) =>
      sub(
        t,
        "    established.replace(id, operation, instances);",
        "    if (instances.length > 0)\n      established.replace(id, operation, instances);",
      ),
  },
  {
    id: "MU-891",
    title:
      "R47 (revision 28): a read that lands and finds a marker another page wrote does not establish it (a follower forgets it)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /ANOTHER page wrote and a read of this one found/,
    patch: (t) =>
      sub(
        t,
        "    established.replace(id, operation, instances);",
        "    if (established.get(id, operation) !== undefined)\n      established.replace(id, operation, instances);",
      ),
  },
  {
    id: "MU-892",
    title:
      "R47 (revision 28): an enumeration that lands does not replace what the page established for the account",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /an enumeration that lands REPLACES/,
    patch: (t) =>
      sub(
        t,
        "    for (const operation of established.operations(id))\n      if (!byOperation.has(operation) && !observed.unreadable.has(operation))\n        learn(scope, operation, []);\n    for (const [operation, instances] of byOperation)\n      if (!observed.unreadable.has(operation))\n        learn(scope, operation, instances.sort());\n",
        "",
      ),
  },
  {
    id: "MU-893",
    title:
      "R47 (revision 28): clearing an account's markers leaves what the page established for it",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /`clearAccount` removes the markers and what the page established/,
    patch: (t) => sub(t, "      established.clearAccount(account);\n", ""),
  },
  {
    id: "MU-894",
    title:
      "R47 (revision 28): what the page established is not kept by account (another account's marker answers for this one)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /establishment is by account/,
    patch: (t) =>
      sub(
        t,
        "    return this.byScope.get(scope)?.get(operation);",
        "    for (const operations of this.byScope.values()) {\n      const known = operations.get(operation);\n      if (known !== undefined) return known;\n    }\n    return undefined;",
      ),
  },
  {
    id: "MU-895",
    title: "R47 (revision 28): `has` counts an unknown marker as a marker",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(BOTH reads failing|never established)/,
    patch: (t) =>
      sub(
        t,
        '    has: (scope, operation) => probe(scope, operation) === "marked",',
        '    has: (scope, operation) => probe(scope, operation) !== "unmarked",',
      ),
  },
  {
    id: "MU-896",
    title:
      "R47 (revision 28): a page with no `localStorage` at all reports its markers as unknown",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-unknown.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /no `localStorage` at all/,
    patch: (t) =>
      sub(
        t,
        '    if (found.kind === "none") return { kind: "none" };\n    if (found.kind === "blocked") return believed(scope, operation);',
        '    if (found.kind === "none") return { kind: "unread" };\n    if (found.kind === "blocked") return believed(scope, operation);',
      ),
  },
  {
    id: "MU-897",
    title:
      "R47 (revision 28): the facade's look is complete whenever the database could be read (an unreadable marker enumeration replaces the warning)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-unreadable-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the warning stands|OWN successful edit ends the marker even while the markers cannot be read)/,
    patch: (t) =>
      sub(t, "    let known = markers.known;", "    let known = true;"),
  },
  {
    id: "MU-898",
    title:
      "R47 (revision 28): a look that could not read every record ends the facade's unsureness (a cold start that found the markers unreadable is blind for good)",
    file: "src/data/outbox/outbox.ts",
    // Retargeted in revision 36: the original test advances 10 s before its prompt, and the paced look of R55 (revision 36) now restores
    // the warning by itself in that time, so the prompt it relies on is no longer what shows the stop. What the mutant still breaks is
    // that a cold start which could not read the records hears a prompt: the new case delivers one before the paced look is due.
    tests: [
      "tests/data/outbox-unreadable-markers.test.ts",
      "tests/data/outbox-public-recovery.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(never read the marker \(a reload\)|a cold start that could not read the records stays unsure)/,
    patch: (t) => sub(t, "    unsure = !known;", "    unsure = false;"),
  },
  {
    id: "MU-900",
    title:
      "R47 (revision 28): the gate opens for a cache whose invalidation marker it never managed to read (an unknown marker is an absent one)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-marker-unreadable.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /never been able to read/,
    patch: (t) =>
      sub(
        t,
        '        markerUnread = true;\n        return "unverified";\n',
        "        markerUnread = true;\n",
      ),
  },
  {
    id: "MU-906",
    title:
      "R47 (revision 29): a store whose access threw is taken for an empty one (the module kept `undefined` for good)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/engine-cold-markers.test.ts",
      "tests/data/controller-storage-access.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(getter throws|getter threw)/,
    patch: (t) =>
      sub(
        t,
        '    return { kind: "blocked" };\n  }\n}',
        '    return { kind: "none" };\n  }\n}',
      ),
  },
  {
    id: "MU-907",
    title:
      "R47 (revision 29): a refusal is kept for good (access restored later is never found by the object that was built under it)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/engine-cold-markers.test.ts",
      "tests/data/controller-storage-access.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(access restored|access is restored|stops throwing)/,
    patch: (t) =>
      sub(
        t,
        '    if (kept !== undefined) return { kind: "store", storage: kept };\n    const found = obtainStorage();',
        '    if (kept !== undefined) return { kind: "store", storage: kept };\n    if (refused) return { kind: "blocked" };\n    const found = obtainStorage();',
      ),
  },
  {
    id: "MU-908",
    title:
      "R47 (revision 29): a refused access that then disappears is taken for an absent one",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/controller-storage-access.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(never becomes an ABSENT one|access was restored at once)/,
    patch: (t) =>
      sub(
        t,
        '    return found.kind === "none" && refused ? { kind: "blocked" } : found;',
        "    return found;",
      ),
  },
  {
    id: "MU-909",
    title:
      "R47 (revision 29): a store obtained once is not kept (the next use asks the global again)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/controller-storage-access.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a store obtained once is kept|the marker read through a store that is there)/,
    patch: (t) =>
      sub(
        t,
        '    if (found.kind === "store") kept = found.storage;',
        '    if (found.kind === "store") void found.storage;',
      ),
  },
  {
    id: "MU-910",
    title:
      "R47 (revision 29): the first attempt to obtain the store is not made when the markers are built",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/controller-storage-access.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a store obtained once is kept|never becomes an ABSENT one|the marker read through a store that is there)/,
    patch: (t) =>
      sub(
        t,
        "  // later `none` is measured against.\n  access();\n",
        "  // later `none` is measured against.\n",
      ),
  },
  {
    id: "MU-919",
    title:
      "R47 (revision 29): admission takes a marker it could not read for no marker (the draft is sent)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(both unreadable|getter threw)/,
    patch: (t) =>
      sub(
        t,
        '      if (state === "unknown" && (inFlight || operation === operations[0]))\n        unknown = true;',
        "      if (false as boolean) unknown = true;",
      ),
  },
  {
    id: "MU-920",
    title:
      "R47 (revision 29): a draft that is still `queued` is asked about its receipt's marker too (the success of its own edit does not send it)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a QUEUED draft is asked about its own operation alone/,
    patch: (t) =>
      sub(
        t,
        '      if (state === "unknown" && (inFlight || operation === operations[0]))\n        unknown = true;',
        '      if (state === "unknown") unknown = true;',
      ),
  },
  {
    id: "MU-921",
    title:
      "R47 (revision 29): a resend of an `in_flight` draft is not asked about its receipt's marker",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a resend of an `in_flight` draft is asked about its receipt's marker as well/,
    patch: (t) =>
      sub(
        t,
        '      if (state === "unknown" && (inFlight || operation === operations[0]))\n        unknown = true;',
        '      if (state === "unknown" && operation === operations[0])\n        unknown = true;',
      ),
  },
  {
    id: "MU-922",
    title:
      "R47 (revision 29): a draft held for an unreadable marker is stalled like a stopped one (released by the next read of the queue, refused again, paced)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(asked on a pace and not in a loop|a wake after the store is readable|NO marker anywhere)/,
    patch: (t) =>
      sub(
        t,
        '    if (admission(service, localId, inFlight) !== "unknown")\n',
        "    if (true as boolean)\n",
      ),
  },
  {
    id: "MU-923",
    title:
      "R47 (revision 29): a draft held for an unreadable marker is never released (the store can be read and the draft stays out)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /releases it/,
    patch: (t) =>
      sub(
        t,
        '      if (admission(service, draft, inFlight) === "unknown") continue;',
        "      continue;",
      ),
  },
  {
    id: "MU-924",
    title:
      "R47 (revision 29): the drafts held for an unreadable marker are not asked about again on the rescan",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /without anyone's act/,
    patch: (t) =>
      sub(
        t,
        "      if (window.blocked > 0 || unreadable.size > 0) {",
        "      if (window.blocked > 0) {",
      ),
  },
  {
    id: "MU-925",
    title:
      "R47 (revision 29): the dispatcher does not say local storage is not responding while it holds a draft for an unreadable marker",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nothing is sent when the page comes online/,
    patch: (t) =>
      sub(
        t,
        "      if (stalled.size > 0 || unreadable.size > 0 || queueStopped(service))",
        "      if (stalled.size > 0 || queueStopped(service))",
      ),
  },
  {
    id: "MU-929",
    title:
      "R47 (revision 29): a connectivity change releases the drafts held for an unreadable marker from the candidates (a new claim each time)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /asks for no new claim/,
    patch: (t) =>
      sub(
        t,
        "        if (explicit || (!stalled.has(draft) && !unreadable.has(draft)))\n",
        "        if (explicit || !stalled.has(draft))\n",
      ),
  },
  {
    id: "MU-931",
    title:
      "R47 (revision 29): the capture gate ignores the fallback marker of the operations it names (only memory stops and the durable counter stop)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a marker that stands is honoured whichever way/,
    patch: (t) =>
      sub(
        t,
        '      input.stoppedOperations?.includes(operation) === true ||\n      markerOf(operation) === "marked";',
        "      input.stoppedOperations?.includes(operation) === true;",
      ),
  },
  {
    id: "MU-932",
    title:
      "R47 (revision 29): the capture gate does not stop for a record it cannot read (an unknown marker is an absent one)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(both unreadable|getter threw|cannot be read at all)/,
    patch: (t) =>
      sub(
        t,
        '      if (unreadableOperations.length > 0) return "unreadable";\n',
        "",
      ),
  },
  {
    id: "MU-933",
    title:
      "R47 (revision 29): the unreadable gate names only the first unreadable operation (the retry removes one of five records)",
    file: "src/data/plans/sync-writers.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a retry made after a listing lands again, before the engine has asked again, ends the markers that stand for EVERY operation/,
    patch: (t) =>
      sub(
        t,
        "                  operations: unreadableOperations,",
        "                  operations: unreadableOperations.slice(0, 1),",
      ),
  },
  {
    id: "MU-934",
    title:
      "R47 (revision 29): the retry removes the unreadable record of an admitted invalidation too (a retry is not evidence that the cache is valid)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a retry made after a listing lands again never ends the marker of an admitted invalidation/,
    patch: (t) =>
      sub(
        t,
        "                if (!operation.startsWith(INVALIDATE_PREFIX))\n                  lift(service, operation);",
        "                lift(service, operation);",
      ),
  },
  {
    id: "MU-935",
    title:
      "R47 (revision 29): the unreadable gate waits for an event, not for a pace (the sync does not resume when the store can be read)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(asked again on a pace|resumes by itself|a store that cannot be read at all)/,
    patch: (t) =>
      sub(
        t,
        '        unreadableRun += 1;\n        return { when: "after", ms: wait };',
        '        unreadableRun += 1;\n        void wait;\n        return { when: "event" };',
      ),
  },
  {
    id: "MU-936",
    title:
      "R47 (revision 29): the unreadable gate asks again every second for ever (no growth of the pace)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the asking is paced and not a loop/,
    patch: (t) =>
      sub(
        t,
        "        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(unreadableRun, 6));",
        "        const wait = 1_000;",
      ),
  },
  {
    id: "MU-937",
    title:
      "R47 (revision 29): the engine asks the markers whether one is KNOWN and takes an unreadable one for none",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(both unreadable|getter threw|cannot be read at all)/,
    patch: (t) =>
      sub(
        t,
        '        const seen = deps.markers?.witness(service, operation);\n        if (seen === undefined) return "unmarked";\n        saw.set(operation, seen);\n        return markerStateOf(seen);',
        '        const seen = deps.markers?.witness(service, operation);\n        if (seen === undefined) return "unmarked";\n        saw.set(operation, seen);\n        return seen.kind === "instance" ? "marked" : "unmarked";',
      ),
  },
  {
    id: "MU-938",
    title:
      "R47 (revision 29): the retry of the engine does not remove the records of the operations the step found unreadable",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/engine-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a retry made after a listing lands again, before the engine has asked again, ends the markers that stand for EVERY operation/,
    patch: (t) =>
      sub(
        t,
        '            if (state.kind === "stopped" && unreadableOperations.length > 0) {',
        "            if (false as boolean) {",
      ),
  },
  {
    id: "MU-939",
    title:
      "R47 (revision 29): the controller does not look again at an unreadable marker (the cache stays hidden when the store can be read)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-storage-access.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(access restored later|a read that lands opens it)/,
    patch: (t) => sub(t, "    lookAtMarker();\n  };", "  };"),
  },
  {
    id: "MU-940",
    title:
      "R47 (revision 29): the controller's look at an unreadable marker is not cancelled when the marker can be read or the controller ends",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-storage-access.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /nothing is left pending after it is disposed/,
    patch: (t) =>
      sub(
        t,
        "    if (!markerUnread) {\n      cancelMarkerLook();\n      markerLooks = 0;\n      return;\n    }",
        "    if (!markerUnread) {\n      markerLooks = 0;\n      return;\n    }",
      ),
  },
  {
    id: "MU-941",
    title:
      "R47 (revision 29): the controller's look at an unreadable marker does not slow down (a read every 250 ms for ever)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-storage-access.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a bounded number of reads over five minutes/,
    patch: (t) =>
      sub(
        t,
        "      DATA_CONFIG.factsReadRetryMs * 2 ** markerLooks,",
        "      DATA_CONFIG.factsReadRetryMs,",
      ),
  },
  {
    id: "MU-952",
    title:
      "R47 (revision 30, re-anchored in revision 34 on the incomplete-read branch of `see`): a removal that returned is kept as evidence that the key is gone (an older recovery becomes proof about a newer stop)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/marker-older-removal.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(an older removal, then another page's NEW marker|what the page can observe is the SAME|an older recovery, then another page's NEW stop|the page removed it and can no longer read|the consumer removed the marker itself|an ordinary page success retires the marker)/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const stops = createLocalStops();\n  // A name for each failure this page records",
            "  const removedOnce = new Set<string>();\n  const stops = createLocalStops();\n  // A name for each failure this page records",
          ),
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : { kind: "unread" };\n    }\n    learn(',
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : removedOnce.has(scopeId(scope) + "\\u0000" + operation)\n          ? { kind: "none" }\n          : { kind: "unread" };\n    }\n    learn(',
        ),
        "    written.remove(scopeId(scope), operation, instance);\n  };",
        '    written.remove(scopeId(scope), operation, instance);\n    removedOnce.add(scopeId(scope) + "\\u0000" + operation);\n  };',
      ),
  },
  {
    id: "MU-953",
    title:
      "R47 (revision 30): the dispatcher keeps a memory of the person's retry and treats an unreadable marker as free for it",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the dispatcher keeps no memory of the person's retry/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const unreadable = new Map<LocalId, boolean>();",
            "  const unreadable = new Map<LocalId, boolean>();\n  const recovered = new Set<string>();",
          ),
          "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
          "    recovered.add(operation);\n    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
        ),
        '      const state = deps.markers?.probe(service, operation);\n      if (state === "marked") return "held";',
        '      const probed = deps.markers?.probe(service, operation);\n      const state =\n        probed === "unknown" && recovered.has(operation) ? "unmarked" : probed;\n      if (state === "marked") return "held";',
      ),
  },
  {
    id: "MU-954",
    title:
      "R47 (revision 30): the dispatcher takes another writer's announcement that a stop ENDED as proof that its marker is absent",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-cold-markers.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the draft's own successful edit, then a NEW stop.*the dispatcher is already running/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const unreadable = new Map<LocalId, boolean>();",
            "  const unreadable = new Map<LocalId, boolean>();\n  const endedElsewhere = new Set<string>();",
          ),
          "          if ((news.ended?.length ?? 0) === 0) return;",
          "          for (const operation of news.ended ?? [])\n            endedElsewhere.add(operation);\n          if ((news.ended?.length ?? 0) === 0) return;",
        ),
        '      const state = deps.markers?.probe(service, operation);\n      if (state === "marked") return "held";',
        '      const probed = deps.markers?.probe(service, operation);\n      const state =\n        probed === "unknown" && endedElsewhere.has(operation)\n          ? "unmarked"\n          : probed;\n      if (state === "marked") return "held";',
      ),
  },
  {
    id: "MU-955",
    title:
      "R47 (revision 30): ordinary sync takes the retirement of a marker after its own page success as proof that the marker is absent",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/marker-older-removal.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /only the invalidation's own marker cannot be read/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  function clearInvalidationRecord(\n    service: AccountService,\n    operation: string,\n    saw: GateSaw,\n  ): void {\n    retireMarker(service, operation, saw);",
          "  const retiredOnce = new Set<string>();\n  function clearInvalidationRecord(\n    service: AccountService,\n    operation: string,\n    saw: GateSaw,\n  ): void {\n    retireMarker(service, operation, saw);\n    retiredOnce.add(operation);",
        ),
        '        const seen = deps.markers?.witness(service, operation);\n        if (seen === undefined) return "unmarked";\n        saw.set(operation, seen);\n        return markerStateOf(seen);',
        '        const seen = deps.markers?.witness(service, operation);\n        if (seen === undefined) return "unmarked";\n        saw.set(operation, seen);\n        const probed = markerStateOf(seen);\n        return probed === "unknown" && retiredOnce.has(operation)\n          ? "unmarked"\n          : probed;',
      ),
  },
  {
    id: "MU-959",
    title:
      "R50 (revision 31): the facade's success takes its witness when its result is DELIVERED, not when the write was issued (a newer stop recorded meanwhile is ended)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /delivered late: the stop stands/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(deps.markers, stops, witnessStops(deps.markers, stops, service, operations), {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-960",
    title:
      "R50 (revision 31): every failure writes the same marker value (a newer failure of the same operation cannot be told from the one a success saw)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(writes a NEW name|delivered late: the stop stands|newer failure)/,
    patch: (t) =>
      sub(
        t,
        `    failures += 1;\n    return \`\${pageName}.\${failures}\`;`,
        `    failures += 1;\n    return \`\${pageName}.1\`;`,
      ),
  },
  {
    id: "MU-961",
    title:
      "R52 (revision 32): a marker's retirement removes every failure of the operation that a listing finds, whatever instance the write saw (the operation-wide removal that revision 31 made by comparing first)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(never reaches a failure the other page records|newer|NEW instance|delivered late: the stop stands)/,
    patch: (t) =>
      sub(
        t,
        "      for (const instance of seen.instances) {",
        '      const everything =\n        found.kind === "store"\n          ? (standing(found.storage, scope)?.found ?? [])\n              .filter((entry) => entry.operation === operation)\n              .map((entry) => entry.instance)\n          : seen.instances;\n      for (const instance of [...new Set([...seen.instances, ...everything])]) {',
      ),
  },
  {
    id: "MU-962",
    title:
      "R50 (revision 31): a hold recorded again in the page's memory keeps the instance of the hold before it (a newer memory stop is not told from the older)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a hold recorded again is a new instance|newer memory stop|delivered late: the stop stands)/,
    patch: (t) =>
      sub(
        t,
        `      operations.set(operation, instance);\n      held.set(key, operations);\n      return instance;`,
        `      operations.set(operation, operations.get(operation) ?? instance);\n      held.set(key, operations);\n      return operations.get(operation) as string;`,
      ),
  },
  {
    id: "MU-963",
    title:
      "R50 (revision 31): the release of a hold in the page's memory ignores the instance it is asked to end",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(a release with an instance ends only that one|newer memory stop|delivered late: the stop stands)/,
    patch: (t) =>
      sub(
        t,
        "      if (instance !== undefined && operations.get(operation) !== instance)\n        return false;\n",
        "",
      ),
  },
  {
    id: "MU-964",
    title:
      "R50 (revision 31): a witness takes no instance of the page's memory (a success never ends a hold that stood when it was issued)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(ends the hold and the marker that stood|memory stop recorded BEFORE the write|with nothing newer, both end)/,
    patch: (t) =>
      sub(
        t,
        "        memory: stops.instance(scope, operation),",
        "        memory: null,",
      ),
  },
  {
    id: "MU-965",
    title:
      "R50 (revision 31, re-expressed in revision 33): a success is an explicit act (a removal it cannot make is forgotten instead of owed to the next read)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(OWED the removal|is OWED|owed)/,
    patch: (t) =>
      sub(
        t,
        "        explicit: options.explicit === true,\n",
        "        explicit: true,\n",
      ),
  },
  {
    id: "MU-967",
    title:
      "R50 (revision 31): a success whose removal the store refuses owes nothing (the instance it ended is never retired)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(OWED|owed|own successful edit|the first read that lands)/,
    patch: (t) =>
      sub(
        t,
        "      if (owe)\n        owed.set(",
        "      if (owe && (false as boolean))\n        owed.set(",
      ),
  },
  {
    id: "MU-968",
    title:
      "R50 (revision 31): a listing that lands never makes the removal a success was owed",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(OWED|owed|own successful edit|the first read that lands)/,
    patch: (t) =>
      sub(
        t,
        "      if (scopeId(due.scope) !== id) continue;",
        "      continue;",
      ),
  },
  {
    id: "MU-969",
    title:
      "R52 (revision 32): a removal that is owed reaches every failure of the operation that a listing finds, a newer one included",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(never reaches a failure the other page records|OWED|owed|a failure this page records after)/,
    patch: (t) =>
      sub(
        t,
        "      if (remove(storage, scope, due.operation, due.instance)) {",
        "      for (const entry of listed.filter((e) => e.operation === due.operation))\n        remove(storage, scope, due.operation, entry.instance);\n      listed.splice(0, listed.length, ...listed.filter((e) => e.operation !== due.operation));\n      if (false as boolean) {",
      ),
  },
  {
    id: "MU-970",
    title:
      "R50 (revision 31): an instance whose removal is owed is still reported as a stop this page knows of",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(an ended marker is not a stop the page knows of|cannot be REMOVED while the store is unreadable|OWED|owed)/,
    patch: (t) =>
      sub(
        t,
        "      .filter((instance) => !isOwed(scope, operation, instance))\n      .sort();\n    return instances.length === 0",
        "      .sort();\n    return instances.length === 0",
      ),
  },
  {
    id: "MU-974",
    title:
      "R50 (revision 31): clearing an account keeps what its successes were owed",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /clearing an account forgets what it was owed/,
    patch: (t) =>
      sub(
        t,
        "      for (const [key, due] of [...owed])\n        if (due.scope.account === account) owed.delete(key);\n",
        "",
      ),
  },
  {
    id: "MU-977",
    title:
      "R50 (revision 31): a late success drops the facade's note of a newer counted failure (a retry then misses its count below the bound)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the facade's notes of its own failures/,
    patch: (t) =>
      sub(
        t,
        "    failures: failureCount,\n    durable: new Map(),\n  });",
        "    failures: Number.MAX_SAFE_INTEGER,\n    durable: new Map(),\n  });",
      ),
  },
  {
    id: "MU-978",
    title:
      "R50 (revision 31): the person's retry takes its witness when it reaches an operation, not when the person asked (a stop recorded meanwhile is lifted)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /does not lift a newer (marker|memory) stop of the draft it reaches last/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: true,\n    });",
        "    retireStops(deps.markers, stops, witnessStops(deps.markers, stops, service, [operation]), {\n      operations: [operation],\n      explicit: true,\n    });",
      ),
  },
  {
    id: "MU-979",
    title:
      "R50 (revision 31): the dispatcher's success takes its witness when its result is delivered (a newer stop of the receipt's operation is ended)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /recorded late: a newer (marker|memory|another page) stop of the receipt's operation/,
    patch: (t) =>
      sub(
        t,
        "    const ended = retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n    });",
        "    const ended = retireStops(deps.markers, stops, witnessStops(deps.markers, stops, service, [operation]), {\n      operations: [operation],\n    });",
      ),
  },
  {
    id: "MU-980",
    title:
      "R50 (revision 31): the success of the queue read takes its witness when its answer is delivered (a newer stop of reading the queue is ended)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the queue read: a stop of reading the queue/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
        "    retireStops(deps.markers, stops, witnessStops(deps.markers, stops, service, [operation]), {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
      ),
  },
  {
    id: "MU-981",
    title:
      "R50 (revision 31): the dispatcher's retry takes its witness when it reaches an operation (a stop recorded meanwhile is lifted)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /with the DISPATCHER running, every write of the retry held/,
    patch: (t) =>
      sub(
        t,
        "            await clearStreak(service, operation, entitled, {\n              explicit: true,\n              expect: entitled.durable.get(operation) ?? null,\n            });",
        "            await clearStreak(service, operation, issue(service, [operation]), {\n              explicit: true,\n              expect: entitled.durable.get(operation) ?? null,\n            });",
      ),
  },
  {
    id: "MU-983",
    title:
      "R51 (revision 31): the engine's page success removes whatever marker stands at the position (the old unconditional retirement)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(R51: an older page completion|the same, with the older request still IN FLIGHT|a newer commit failure of the same page)/,
    patch: (t) =>
      sub(
        t,
        '    deps.markers?.retire(\n      service,\n      operation,\n      saw.get(operation) ?? { kind: "none" },\n    );',
        "    deps.markers?.clear(service, operation);",
      ),
  },
  {
    id: "MU-984",
    title:
      "R51 (revision 31): the engine's page success takes its witness when its completion is delivered, not when the gate admitted the request",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(R51: an older page completion|the same, with the older request still IN FLIGHT|a newer commit failure of the same page)/,
    patch: (t) =>
      sub(
        t,
        '    deps.markers?.retire(\n      service,\n      operation,\n      saw.get(operation) ?? { kind: "none" },\n    );',
        "    deps.markers?.retire(\n      service,\n      operation,\n      deps.markers.witness(service, operation),\n    );",
      ),
  },
  {
    id: "MU-985",
    title:
      "R51 (revision 31): the gate's reading is not kept as the request's witness (a success retires nothing it was admitted over)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/marker-instances.test.ts",
      "tests/data/outbox-late-success.test.ts",
      "tests/data/engine-late-completion.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /R51 controls: a page that succeeds still retires what the request was admitted over/,
    patch: (t) => sub(t, "        saw.set(operation, seen);\n", ""),
  },
  {
    id: "MU-994",
    title:
      "R52 (revision 32): a failure recorded by this page replaces every instance it knows of, another page's included (two pages that each replace the other's after storing their own leave none)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-exact-keys.test.ts",
      "tests/data/marker-instances.test.ts",
    ],
    expect:
      /(replaces only this page's own earlier one|never leave the operation unmarked|another page's key is left alone|NEW instance over the one that was witnessed stays)/,
    patch: (t) =>
      sub(
        t,
        "    for (const older of [...(written.get(id, operation) ?? [])])",
        "    for (const older of [\n      ...(established.get(id, operation) ?? []),\n    ].filter((name) => name !== instance))",
      ),
  },

  {
    id: "MU-995",
    title:
      "R53 (revision 32): a reset of the durable failure state does not compare the version it was decided on (it ends whatever failure stands)",
    file: "src/data/model/retry.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(another version|ABA|newer|left|durable)/,
    patch: (t) =>
      sub(
        t,
        "  if (version !== expect) return { patch: null, cleared: false, version };\n",
        "",
      ),
  },

  {
    id: "MU-996",
    title:
      "R53 (revision 32): a failure's version is its count (three failures, a reset and three more are the same failure)",
    file: "src/data/model/retry.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(ABA|a count that comes back|each failure takes a version)/,
    patch: (t) =>
      sub(
        t,
        "  versions[operation] = seq;",
        "  versions[operation] = failed.streaks[operation] ?? 0;",
      ),
  },

  {
    id: "MU-997",
    title:
      "R53 (revision 32): the facade's retry resets a streak on the version it sees when the reset runs, not the one it saw when the person asked",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(the review's schedule|reversed order|not yet admitted|ABA)/,
    patch: (t) =>
      sub(
        t,
        "          expect: issued.durable.get(operation) ?? null,",
        "          expect: observed.get(operation) ?? null,",
      ),
  },

  {
    id: "MU-998",
    title:
      "R53 (revision 32): the dispatcher's retry resets a streak on the version it has seen when it reaches the operation, not the one it saw when the person asked",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(the dispatcher's own retry|every reset held)/,
    patch: (t) =>
      sub(
        t,
        "              expect: entitled.durable.get(operation) ?? null,",
        "              expect: observed.get(operation) ?? null,",
      ),
  },

  {
    id: "MU-999",
    title:
      "R53 (revision 32): the success of the queue read resets on the observation made when it was issued, not on its own snapshot",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(queue read)/,
    patch: (t) =>
      sub(
        t,
        "        expect: window.failureVersions[QUEUE_OPERATION] ?? null,",
        "        expect: queueRead.durable.get(QUEUE_OPERATION) ?? null,",
      ),
  },

  {
    id: "MU-1000",
    title:
      "R53 (revision 32): the engine records no version for the stop its gate read (a stop restored after a reload is not ended by the retry)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(a stop restored after a reload is ended by the retry too)/,
    patch: (t) =>
      sub(
        t,
        "        if (operation !== undefined) {\n          if (version === null) stoppedVersions.delete(operation);\n          else stoppedVersions.set(operation, version);\n        }\n",
        "",
      ),
  },

  {
    id: "MU-1001",
    title:
      "R53 (revision 32): the engine records no version for its own durable failure (its retry ends nothing it counted)",
    file: "src/data/engine/sync-engine.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect:
      /(control: nothing recorded meanwhile, the retry ends the stop it saw)/,
    patch: (t) =>
      sub(
        t,
        "      if (result.version !== null)\n        stoppedVersions.set(operation, result.version);\n",
        "",
      ),
  },

  {
    id: "MU-1002",
    title:
      "R53 (revision 32): the facade's look does not refresh what it has seen of the durable failures (a retry after a look resets on a stale version)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/outbox-cross-writer.test.ts",
    ],
    expect:
      /(LOOKED at|the retry made after a look does|after a reload, with the record unreadable)/,
    patch: (t) =>
      sub(
        t,
        "      for (const operation of [...observed.keys()])\n        if (operationDraft(operation) !== null) observed.delete(operation);\n      for (const record of records)\n        observed.set(record.operation, record.version);",
        "      void records;",
      ),
  },

  {
    id: "MU-1003",
    title:
      "R53 (revision 32): the facade records no version for its own durable failure (a retry of a count below the bound ends nothing)",
    file: "src/data/outbox/outbox.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(below-bound count the facade saw fail)/,
    patch: (t) =>
      sub(
        t,
        "      if (result.version !== null) observed.set(operation, result.version);\n      if (result.stop) {\n        stopped(operation);",
        "      if (result.stop) {\n        stopped(operation);",
      ),
  },

  {
    id: "MU-1004",
    title:
      "R53 (revision 32): the dispatcher records no version from the window it read (its retry of a stop it read resets nothing)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: [
      "tests/data/local-write-versions.test.ts",
      "tests/data/outbox-retry-entitlement.test.ts",
      "tests/data/engine-retry-entitlement.test.ts",
      "tests/data/outbox-late-success.test.ts",
    ],
    expect: /(the dispatcher's own retry|every reset held)/,
    patch: (t) =>
      sub(
        t,
        "    for (const [operation, version] of Object.entries(window.failureVersions))\n      observed.set(operation, version);\n",
        "",
      ),
  },

  {
    id: "MU-1006",
    title:
      "R52 (revision 32): an operation-wide removal by the library (`clear`) removes the keys it was shown plus every instance this page knows",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-exact-keys.test.ts",
      "tests/data/marker-unknown.test.ts",
      "tests/data/marker-access.test.ts",
      "tests/data/marker-instances.test.ts",
    ],
    expect:
      /(another operation's marker is not touched|ends whatever a listing finds|REPLACES what the page established|operation that is a prefix)/,
    patch: (t) =>
      sub(
        t,
        "      for (const entry of observed.found)\n        if (entry.operation === operation)\n          remove(found.storage, scope, operation, entry.instance, false);",
        "      for (const entry of observed.found)\n        remove(found.storage, scope, entry.operation, entry.instance, false);",
      ),
  },
  {
    id: "MU-1013",
    title:
      "R55 (revision 33): a failure's key is written before the directory that lists it (a page that stops between the two leaves a standing key that no read can find)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect: /directory is written FIRST/,
    patch: (t) =>
      sub(
        t,
        '    const listed =\n      slot === null\n        ? "not-listed"\n        : writeDirectory(storage, scope, slot, [[operation, instance]]);\n    try {\n      storage.setItem(key, MARKED);\n    } catch {',
        '    let listed: "listed" | "not-listed" = "not-listed";\n    try {\n      storage.setItem(key, MARKED);\n      listed =\n        slot === null\n          ? "not-listed"\n          : writeDirectory(storage, scope, slot, [[operation, instance]]);\n    } catch {',
      ),
  },
  {
    id: "MU-1014",
    title:
      "R55 (revision 33): a listed failure whose own key cannot be read makes the whole scope unknown (one unreadable key hides every other operation's answer: no isolation)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-directories.test.ts",
      "tests/data/marker-access.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
      "tests/data/engine-cold-markers.test.ts",
      "tests/data/outbox-unreadable-markers.test.ts",
    ],
    expect:
      /(THAT operation is `unknown`|exact-operation isolation|only its own marker key unreadable)/,
    patch: (t) =>
      sub(
        t,
        "        // A failure whose key cannot be read may stand: its operation, and no other, is unknown.\n        unreadable.add(operation);\n      }\n      return true;",
        "        // A failure whose key cannot be read may stand: its operation, and no other, is unknown.\n        unreadable.add(operation);\n        return false;\n      }\n      return true;",
      ),
  },
  {
    id: "MU-1015",
    title:
      "R55 (revision 33): a directory that is not one is read as an empty directory (a corrupt record becomes absence instead of unknown)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect: /a directory that is not one/,
    patch: (t) =>
      sub(
        t,
        "          complete = false;\n          continue;",
        "          continue;",
      ),
  },
  {
    id: "MU-1016",
    title:
      "R55 (revision 33): an observation that passes its work bound answers with what it has checked so far (a partial answer is taken for the whole)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect: /(work bound|more failures than its work bound)/,
    patch: (t) =>
      sub(
        t,
        "      if (checked > OBSERVATION_MAX_ENTRIES) return false;",
        "      if (checked > OBSERVATION_MAX_ENTRIES) return true;",
      ),
  },
  {
    id: "MU-1017",
    title:
      "R55 (revision 33): a page takes a directory slot without holding its lock (two pages can write one directory: its single-writer guarantee is gone)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect:
      /(first free slot|crashes frees|every slot is held|refused lock request)/,
    patch: (t) =>
      sub(
        t,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the anchor is source text.
        "          handle = await locks.tryAcquire(`${SLOT_LOCK_PREFIX}${slot}`);",
        "          handle = { release: () => undefined };",
      ),
  },
  {
    id: "MU-1018",
    title:
      "R55 (revision 33): a full directory drops its oldest listed failure to make room (a bound evicts protection instead of refusing the new failure)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect: /(more failures than its bound|too long in text)/,
    patch: (t) =>
      sub(
        t,
        "  const text = serializeDirectory(kept);\n  // A bound refuses the listing; it never drops one that stands.",
        "  while (kept.length > DIRECTORY_MAX_ENTRIES) kept.shift();\n  const text = serializeDirectory(kept);\n  // A bound refuses the listing; it never drops one that stands.",
      ),
  },
  {
    id: "MU-1019",
    title:
      "R56 (revision 33): the markers record a failure although the caller's lifetime has ended (neither `set` nor the write asks `live`)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /(writes neither a directory nor a key|same step as the write)/,
    patch: (t) =>
      sub(
        sub(
          t,
          '      if (live !== undefined && !live()) return finished("obsolete");',
          '      if (false as boolean) return finished("obsolete");',
        ),
        '    if (live !== undefined && !live()) return "obsolete";',
        '    if (false as boolean) return "obsolete";',
      ),
  },
  {
    id: "MU-1020",
    title:
      "R56 (revision 33): `recordStop` holds a stop in the page's memory for a failure whose lifetime has ended (it does not ask `live` before anything else)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /`recordStop` takes no hold for an obsolete failure/,
    patch: (t) =>
      sub(
        t,
        '  if (!live()) return "obsolete";\n  const published = markers?.set(scope, operation, live);',
        "  const published = markers?.set(scope, operation, () => true);",
      ),
  },
  {
    id: "MU-1021",
    title:
      "R56 (revision 33): the facade records the stop of a failed counter although its service has ended (the last look at the lifetime is removed from the fallback)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect:
      /(service ended, the database deleted and its markers cleaned|cleanup never ran)/,
    patch: (t) =>
      sub(
        t,
        "        () => service.live,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
        "        () => true,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
      ),
  },
  {
    id: "MU-1022",
    title:
      "R56 (revision 33): the facade shows a stop that its counter reached after its service ended (the look at the lifetime after the awaited counter is removed)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /facade: two earlier failures/,
    patch: (t) =>
      sub(
        t,
        '      if (!service.live) {\n        if (result.stop) stopsChanged();\n        return "identity_changed";\n      }\n      if (result.version !== null) observed.set(operation, result.version);',
        "      if (result.version !== null) observed.set(operation, result.version);",
      ),
  },
  {
    id: "MU-1023",
    title:
      "R56 (revision 33): the dispatcher records a stop under `queue`, `draft:<id>` or `receipt:<id>` although its service has ended",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect:
      /(nothing is recorded under `queue`|nothing is recorded under `draft:<id>`)/,
    patch: (t) =>
      sub(
        t,
        "        () => service.live,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
        "        () => true,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
      ),
  },
  {
    id: "MU-1024",
    title:
      "R56 (revision 33): the dispatcher is stopped by a counter that reached its bound after its service ended (the look at the lifetime after the awaited counter is removed)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /dispatcher: two earlier failures/,
    patch: (t) =>
      sub(
        t,
        '      if (!service.live) {\n        if (result.stop) stopsChanged(service);\n        return { when: "event" };\n      }\n      if (result.version !== null) observed.set(operation, result.version);',
        "      if (result.version !== null) observed.set(operation, result.version);",
      ),
  },
  {
    id: "MU-1025",
    title:
      "R56 (revision 33): the sync engine records a stop under `capture`, `page:<cursor>` or `invalidate:<cursor>` although its service has ended (both looks at the lifetime are removed)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /nothing is recorded under `capture`/,
    patch: (t) =>
      sub(
        t,
        "      if (!service.live) return lifetimeOver(id);\n      stop = true;\n      lifted.delete(key);\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => service.live,",
        "      stop = true;\n      lifted.delete(key);\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => true,",
      ),
  },
  {
    id: "MU-1026",
    title:
      "R56 (revision 33): the sync engine is stopped by a counter that reached its bound after its service ended (the look at the lifetime after the awaited counter is removed)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /engine: two earlier failures/,
    patch: (t) =>
      sub(
        t,
        "      if (!service.live) return lifetimeOver(id);\n      stop = result.stop;",
        "      stop = result.stop;",
      ),
  },
  {
    id: "MU-1027",
    title:
      "R56 (revision 33): the engine's immediate stop of a counter it cannot write (the retry record, the sizing record) is recorded although its service has ended",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /retry record failed, the service ended/,
    patch: (t) =>
      sub(
        t,
        "      () => service.live,\n      { hold: () => holdMemory(memoryStopKey(service, operation)) },\n    );",
        "      () => true,\n      { hold: () => holdMemory(memoryStopKey(service, operation)) },\n    );",
      ),
  },
  {
    id: "MU-1028",
    title:
      "R56 (revision 33): the quota stop of an admitted invalidation is recorded although its service has ended (it hides the replacement's cache)",
    file: "src/data/engine/sync-engine.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect:
      /invalidation's quota failure was delivered after the service ended/,
    patch: (t) =>
      sub(
        t,
        "        () => service.live,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
        "        () => true,\n        { hold: () => holdMemory(memoryStopKey(service, operation)) },\n      );",
      ),
  },
  {
    id: "MU-1029",
    title:
      "R56 (revision 33): the lifetime is not part of a marker's key (an obsolete writer, or a cleanup that never ran, is read as the replacement's)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-lifetime.test.ts",
      "tests/data/marker-instances.test.ts",
      "tests/data/marker-directories.test.ts",
    ],
    expect: /(another lifetime|housekeeping|two lifetimes|its own address)/,
    patch: (t) =>
      sub(
        t,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the anchor is source text.
        "const scopePart = (scope: StopScope): string =>\n  `${enc(scope.account)}:${enc(scope.incarnationId)}`;",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the replacement is source text.
        "const scopePart = (scope: StopScope): string =>\n  `${enc(scope.account)}:shared`;",
      ),
  },
  {
    id: "MU-1030",
    title:
      "R55 (revision 33): a page that takes over a directory slot drops the failures the previous owner listed (what a closed page published is lost to every reader)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-directories.test.ts"],
    expect:
      /(crashes frees its slot|reload and cold discovery|finds every failure its predecessor published)/,
    patch: (t) =>
      sub(
        sub(t, "      kept = parsed;", "      kept = [];"),
        "    for (const entry of unlistedStanding(storage, scope, slot))\n      if (!kept.some((have) => have[0] === entry[0] && have[1] === entry[1]))\n        kept.push(entry);\n",
        "",
      ),
  },
  {
    id: "MU-1042",
    title:
      "R55 (revision 34): the heal is removed (a failure whose directory entry a stale hand-over dropped is never listed again by the page that writes the directory)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-witnesses.test.ts"],
    expect:
      /(stays protected after the next owner publishes|listed again by the next page)/,
    patch: (t) =>
      sub(
        t,
        "    for (const entry of unlistedStanding(storage, scope, slot))\n      if (!kept.some((have) => have[0] === entry[0] && have[1] === entry[1]))\n        kept.push(entry);\n",
        "",
      ),
  },
  {
    id: "MU-1043",
    title:
      "R55 (revision 34): the listing of the origin's keys is ignored (the second witness is gone: a failure that no directory lists is not found)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-witnesses.test.ts",
      "tests/data/marker-directories.test.ts",
    ],
    expect:
      /(found by the listing|a key with no directory entry is found|listed in no directory)/,
    patch: (t) =>
      sub(
        t,
        "    const listing = listScope(storage, scope);\n    if (listing === null) complete = false;",
        "    const listing: Standing[] | null = [];\n    if (listing === null) complete = false;",
      ),
  },
  {
    id: "MU-1044",
    title:
      "R55 (revision 34): the directories are ignored (the first witness is gone: a failure the listing omits is not found)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-witnesses.test.ts",
      "tests/data/marker-directories.test.ts",
    ],
    // Retargeted, revision 35 (premise P11): the churn cases no longer need a directory (one snapshot cannot be shifted), so the
    // directories' role is the read whose snapshot cannot be made (refused, or over its bound): there they are the only discovery, and
    // the defect is caught there (the driver run `driver-r35b` caught it by those assertions and not by the old pattern).
    expect:
      /(a listing that is refused, that loses a key under its walk|what a directory names is still found)/,
    patch: (t) =>
      sub(
        t,
        "        const entries = parseDirectory(raw);\n",
        "        const entries = parseDirectory(raw) === null ? null : [];\n",
      ),
  },
  {
    id: "MU-1046",
    title:
      "R55 (revision 34): a listing that could not be completed is taken for a complete one (absence is claimed on the directories alone)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-access.test.ts",
      "tests/data/marker-witnesses.test.ts",
      "tests/data/outbox-cold-markers.test.ts",
    ],
    expect:
      /(origin's keys cannot be listed|listing that is refused|waits, instead of being sent)/,
    patch: (t) =>
      sub(
        t,
        "    if (listing === null) complete = false;",
        "    if (listing === null) complete = true;",
      ),
  },
  {
    id: "MU-1047",
    title:
      "R55 (revisions 34 and 35): the size bound is removed (an origin with more keys than the work bound is materialised: revision 35 reads the size first, so a snapshot is never taken past the bound)",
    file: "src/data/engine/write-failure-marker.ts",
    // Retargeted, revision 35: the list's own length is still bounded after the snapshot, so the read stays `unknown` without the size
    // bound and the revision-34 case cannot tell; the defect is that the origin is materialised, which `marker-snapshot` counts.
    tests: [
      "tests/data/marker-snapshot.test.ts",
      "tests/data/marker-witnesses.test.ts",
    ],
    expect: /bounded work: a size or a list over/,
    patch: (t) =>
      sub(
        t,
        "    if (!Number.isSafeInteger(count) || count < 0 || count > LISTING_MAX_KEYS)\n      return null;",
        "    if (!Number.isSafeInteger(count) || count < 0) return null;",
      ),
  },
  {
    id: "MU-1048",
    title:
      "R58 (revision 34): a failure is recorded only while the page holds a slot (a page without one keeps it in memory: a durable record depends on a lock arriving)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-durable-at-once.test.ts",
      "tests/data/marker-lifetime.test.ts",
      "tests/data/marker-directories.test.ts",
    ],
    expect:
      /(durable AT ONCE|is not published when the lock is delivered|whether or not the page holds a slot|without a directory)/,
    patch: (t) =>
      sub(
        t,
        '    if (live !== undefined && !live()) return "obsolete";\n    const key = markerKey(scope, operation, instance);',
        '    if (live !== undefined && !live()) return "obsolete";\n    if (slot === null) return "unavailable";\n    const key = markerKey(scope, operation, instance);',
      ),
  },
  {
    id: "MU-1049",
    title:
      "R58 (revision 34): the listing made when a slot arrives is made for a key that no longer stands (a recovered failure is listed after its recovery)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-durable-at-once.test.ts"],
    expect:
      /(never reaches the pending listing of another|ANOTHER page ended before the slot arrived)/,
    patch: (t) =>
      sub(
        t,
        "        stands = found.storage.getItem(key) !== null;",
        "        stands = true;",
      ),
  },
  {
    id: "MU-1050",
    title:
      "R58 (revision 34): `recordStop` holds the stop in the page's memory although the marker was recorded (two representations of one failure, the memory one never released)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-lifetime.test.ts"],
    expect: /takes none when the marker is recorded/,
    patch: (t) =>
      sub(
        t,
        '  if (published?.state === "recorded") return "marker";\n  memory.hold();',
        '  if (published?.state === "recorded") {\n    memory.hold();\n    return "marker";\n  }\n  memory.hold();',
      ),
  },
  {
    id: "MU-1051",
    title:
      "R55 (revision 34): an observation that could not be completed makes the removals this page owes (a removal is made by a read that did not land)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/outbox-unreadable-markers.test.ts"],
    expect:
      /(a marker that cannot be REMOVED while the store is unreadable|the next retry removes it)/,
    patch: (t) =>
      sub(
        t,
        "    if (observed.complete) settle(found.storage, scope, observed.found);\n    const instances = observed.found",
        "    settle(found.storage, scope, observed.found);\n    const instances = observed.found",
      ),
  },
  {
    id: "MU-1052",
    title:
      "R55 (revision 34): an observation that could not be completed does not report what the witness that could be read found (the failure is invisible to the page that read it)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-access.test.ts"],
    expect:
      /the directories cannot be read: the listing still names what stands/,
    patch: (t) =>
      sub(
        t,
        "      for (const instance of instances)\n        established.add(scopeId(scope), operation, instance);\n      const known = believed(scope, operation);",
        "      const known = believed(scope, operation);",
      ),
  },
  {
    id: "MU-1053",
    title:
      "R55 (revision 34): the heal counts the directory it is rewriting as listing the failures (an entry a stale view dropped looks listed, and is dropped for good)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-witnesses.test.ts"],
    expect:
      /(stays protected after the next owner publishes|listed again by the next page)/,
    patch: (t) => sub(t, "    if (slot === rewriting) continue;\n", ""),
  },
  {
    id: "MU-1062",
    title:
      "R55 (revision 35): the listing walks the origin's keys by index again (one `key(i)` per index: an interleaving between two of them can shift a standing failure out of sight, the review of revision 34's counterexample)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: [
      "tests/data/marker-snapshot.test.ts",
      "tests/data/marker-witnesses.test.ts",
      "tests/data/marker-snapshot-dom.test.ts",
    ],
    expect:
      /(the failure is found and the read is whole|skipped by BOTH walks|never called)/,
    patch: (t) =>
      sub(
        t,
        "  const keys = snapshotKeys(storage);",
        "  const keys = ((): string[] | null => {\n    try {\n      const walked: string[] = [];\n      for (let at = 0; at < storage.length; at += 1) {\n        const key = storage.key(at);\n        if (key === null) return null;\n        walked.push(key);\n      }\n      return walked;\n    } catch {\n      return null;\n    }\n  })();",
      ),
  },
  {
    id: "MU-1063",
    title:
      "R55 (revision 35): a store with no single-operation listing is read as an EMPTY one (its absence of keys is taken for a complete snapshot)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-snapshot.test.ts"],
    expect: /a store with no single-operation listing/,
    patch: (t) =>
      sub(
        t,
        '    else if (typeof storage.keys === "function") keys = storage.keys();\n    else return null;',
        '    else if (typeof storage.keys === "function") keys = storage.keys();\n    else keys = [];',
      ),
  },
  {
    id: "MU-1064",
    title:
      "R55 (revision 35): the keys this page established are not read again by name (an informed page forgets a failure whose key a snapshot left out)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-snapshot.test.ts"],
    expect: /snapshot leaves out a key it established/,
    patch: (t) =>
      sub(
        t,
        "    const id = scopeId(scope);\n    for (const operation of established.operations(id))\n      for (const instance of established.get(id, operation) ?? []) {\n        const key = markerKey(scope, operation, instance);\n        if (listed.has(key)) continue;",
        "    const id = scopeId(scope);\n    for (const operation of [] as string[])\n      for (const instance of established.get(id, operation) ?? []) {\n        const key = markerKey(scope, operation, instance);\n        if (listed.has(key)) continue;",
      ),
  },
  {
    id: "MU-1065",
    title:
      "R55 (revision 35): a snapshot that an established key contradicts is still taken for complete (the read says it is whole while it left a standing failure out)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-snapshot.test.ts"],
    expect: /snapshot leaves out a key it established/,
    patch: (t) =>
      sub(t, "        if (listing !== null) complete = false;\n", ""),
  },
  {
    id: "MU-1066",
    title:
      "R55 (revision 35): the length of the snapshot itself is not bounded (a list longer than the size said is read whole)",
    file: "src/data/engine/write-failure-marker.ts",
    tests: ["tests/data/marker-snapshot.test.ts"],
    expect: /bounded work: a size or a list over/,
    patch: (t) =>
      sub(
        t,
        "    if (!Array.isArray(keys) || keys.length > LISTING_MAX_KEYS) return null;",
        "    if (!Array.isArray(keys)) return null;",
      ),
  },
  {
    id: "MU-1069",
    title:
      "R55 (revision 36): a look that could not read every record schedules no paced look (the public warning recovers only on some other trigger)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(Q1|Q2|Q3): /,
    patch: (t) =>
      sub(
        t,
        "    else if (known) storage.set(false);\n    pace(known);\n",
        "    else if (known) storage.set(false);\n",
      ),
  },
  {
    id: "MU-1070",
    title:
      "R55 (revision 36): the facade compares only the marked operations, not whether their read was complete (an outage that changes no operation is not heard)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /Q4: a warm facade that finds the markers unreadable/,
    patch: (t) =>
      sub(
        t,
        "  }): string => JSON.stringify([read.operations, read.known]);",
        "  }): string => JSON.stringify([read.operations]);",
      ),
  },
  {
    id: "MU-1071",
    title:
      "R55 (revision 36): unsureness is one-way again (a facade that once read everything is never unsure after a later outage)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /Q4: a later outage makes a warm facade unsure again/,
    patch: (t) =>
      sub(t, "    unsure = !known;\n", "    if (known) unsure = false;\n"),
  },
  {
    id: "MU-1072",
    title:
      "R55 (revision 36): a look that a newer signal made obsolete still publishes when it is answered (a stale absence flickers the warning)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a newer marker heard while the look that read none is held/,
    patch: (t) =>
      sub(
        t,
        "    if (mine !== looks || !observing || !service.live) return;",
        "    if (!observing || !service.live) return;",
      ),
  },
  {
    id: "MU-1073",
    title:
      "R55 (revision 36): the end of the observation leaves the paced look scheduled",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the timer is cancelled|disposeObservation while the pace is pending)/,
    patch: (t) =>
      sub(t, "    again = false;\n    cancelPace();\n", "    again = false;\n"),
  },
  {
    id: "MU-1074",
    title:
      "R55 (revision 36): the end of the observation leaves its subscriptions (the markers' feed, the channel, the page's stops)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/controller-marker-follower.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a disposed controller no longer listens/,
    patch: (t) =>
      sub(t, "    for (const off of hearing.splice(0)) off();\n", ""),
  },
  {
    id: "MU-1075",
    title:
      "R55 (revision 36): the controller does not end the observation of the facade its binding made (it keeps reading after a stop or an unbind)",
    file: "src/data/ui/env.ts",
    tests: [
      "tests/data/outbox-public-recovery.test.ts",
      "tests/data/controller-marker-follower.test.ts",
    ],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(the controller is stopped with its service still live|a disposed controller no longer listens)/,
    patch: (t) => sub(t, "      () => facade.disposeObservation(),\n", ""),
  },
  {
    id: "MU-1076",
    title:
      "R55 (revision 36): the paced look has no cap (it falls further and further behind a recovery)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a permanent refusal: the gaps/,
    patch: (t) =>
      sub(
        t,
        "      config.factsReadRetryMaxMs,\n      config.factsReadRetryMs * 2 ** Math.min(paced, 16),\n",
        "      Number.POSITIVE_INFINITY,\n      config.factsReadRetryMs * 2 ** Math.min(paced, 16),\n",
      ),
  },
  {
    id: "MU-1077",
    title:
      "R55 (revision 36): the paced look does not back off (a permanent refusal is read at the first wait, for ever)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a permanent refusal: the gaps/,
    patch: (t) =>
      sub(
        t,
        "      config.factsReadRetryMs * 2 ** Math.min(paced, 16),\n",
        "      config.factsReadRetryMs,\n",
      ),
  },
  {
    id: "MU-1078",
    title:
      "R55 (revision 36): every incomplete look schedules a paced look of its own (timers pile up under a burst of hints)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /bursts of hints/,
    patch: (t) =>
      sub(
        t,
        "    if (paceTimer !== null) return;\n    const wait",
        "    const wait",
      ),
  },
  {
    id: "MU-1079",
    title:
      "R55 (revision 36): a marker change does not make the look under way obsolete (its older answer is published first)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a newer marker heard while the look that read none is held/,
    patch: (t) =>
      sub(
        t,
        "      if (signatureOf(markedDrafts()) === expected) return;\n      void reconcile(true);",
        "      if (signatureOf(markedDrafts()) === expected) return;\n      void reconcile();",
      ),
  },
  {
    id: "MU-1080",
    title:
      "R55 (revision 36): a success waits for the look under way instead of making its own (a save is not answered while a read is held)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a save that succeeds while the paced look is held/,
    patch: (t) =>
      sub(
        t,
        "    if (warned || unsure) await look();",
        "    if (warned || unsure) await reconcile();",
      ),
  },
  {
    id: "MU-1081",
    title:
      'R55 (revision 36): "Try again" takes the warning down at once only when the LAST look was complete (a warm outage keeps a retried stop shown)',
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(stops of the markers and of the page's memory are known without the record|the notice a person reads keeps the stop through every unreadable reconciliation)/,
    patch: (t) =>
      sub(
        t,
        "      if (everKnown && [...standing].every(covers)) {",
        "      if (!unsure && [...standing].every(covers)) {",
      ),
  },
  {
    id: "MU-1082",
    title:
      "R55 (revision 36): a marker event is compared with the last PUBLISHED look only (a change made after the look under way read the markers is missed)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-cross-writer.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a marker another tab removes is heard/,
    patch: (t) =>
      sub(
        t,
        "      reading !== null && reading.look === looks ? reading.signature : marked;",
        "      marked;",
      ),
  },
  {
    id: "MU-1083",
    title:
      "R55 (revision 36): a look answered after the service ended publishes (no lifetime check after the await, and the end does not make it obsolete)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-public-recovery.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the service ends while the paced look is held/,
    patch: (t) =>
      sub(
        sub(
          t,
          "    if (mine !== looks || !observing || !service.live) return;",
          "    if (mine !== looks) return;",
        ),
        "    // A look under way publishes nothing, and nothing is asked again.\n    looks += 1;\n",
        "    // A look under way publishes nothing, and nothing is asked again.\n",
      ),
  },
  {
    id: "MU-1085",
    title:
      "R59 (revision 37): the controller admits an opened result whose service has already ended (a dead binding, and the readers take the no-database path over a durable pause)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-late-binding.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(is never bound|while every result arrives dead)/,
    patch: (t) =>
      sub(
        t,
        '    if (outcome.kind === "opened" && !outcome.service.live) {',
        '    if (outcome.kind === "opened" && (false as boolean)) {',
      ),
  },
  {
    id: "MU-1086",
    title:
      "R59 (revision 37): a binding whose service is no longer live counts as a finished look (the readers take the no-database path)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-late-binding.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the readers wait \(no request over the pause\), and a hint looks again/,
    patch: (t) =>
      sub(
        t,
        "      (lookedFor !== account || current !== null),",
        "      lookedFor !== account,",
      ),
  },
  {
    id: "MU-1087",
    title:
      "R59 (revision 37): a hint does not look again while a binding that is no longer live stands",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/controller-late-binding.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the readers wait \(no request over the pause\), and a hint looks again/,
    patch: (t) =>
      sub(
        t,
        "    if (identity !== null && (current === null || !current.service.live))",
        "    if (identity !== null && current === null)",
      ),
  },
  {
    id: "MU-1088",
    title:
      "R59 (revision 37): a facade made over a service that has already ended observes (it subscribes, and its end is never heard)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /over an ended service/,
    patch: (t) =>
      sub(t, "  let observing = !service.ended;", "  let observing = true;"),
  },
  {
    id: "MU-1089",
    title:
      "R59 (revision 37): a look reads the records over a service that is not live (no liveness check before the read)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /checks liveness BEFORE it reads/,
    patch: (t) =>
      sub(
        t,
        "    if (!observing || !service.live) return;\n    looks += 1;",
        "    if (!observing) return;\n    looks += 1;",
      ),
  },
  {
    id: "MU-1090",
    title:
      "R60 (revision 37): a healthy facade ignores a hint naming the stop records (another page's new durable stop is never shown)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(the ignored-hint path|a durable stop\)|bounded: a burst)/,
    patch: (t) =>
      sub(
        t,
        "      else if (message.stores.includes(LOCAL_WRITE_STOPS_STORE))\n        void reconcile();\n",
        "",
      ),
  },
  {
    id: "MU-1091",
    title:
      "R60 (revision 37): the facade's durable stop is announced to its own page only (no hint for the other pages)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(third failed save|a follower page's controller shows the existing notice)/,
    patch: (t) =>
      sub(
        t,
        "        stopped(operation);\n        stopsChanged();\n",
        "        stopped(operation);\n",
      ),
  },
  {
    id: "MU-1092",
    title:
      "R60 (revision 37): the facade's Try again ends a durable stop without telling the other pages",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the facade's Try again ends the durable stop it saw/,
    patch: (t) =>
      sub(t, "      if (issued.durable.has(operation)) stopsChanged();\n", ""),
  },
  {
    id: "MU-1093",
    title:
      "R60 (revision 37): the dispatcher's durable stop (a claim or a receipt) is announced to its own page only",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(receipt write fails three times|claim fails three times)/,
    patch: (t) =>
      sub(
        t,
        "        stopsChanged(service);\n        return stall(id, service, operation);",
        "        return stall(id, service, operation);",
      ),
  },
  {
    id: "MU-1094",
    title:
      "R60 (revision 37): the dispatcher's Try again ends a durable stop without telling the other pages",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the dispatcher's Try again ends the durable stop it saw/,
    patch: (t) =>
      sub(
        t,
        "        if (options.expect !== null) stopsChanged(service);\n",
        "",
      ),
  },
  {
    id: "MU-1095",
    title:
      "R59 (revision 37): a service never says it has ended (a consumer handed it late waits for an end already announced)",
    file: "src/data/engine/account-service.ts",
    tests: ["tests/data/outbox-stop-publication.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /over an ended service/,
    patch: (t) =>
      sub(
        t,
        "  get ended(): boolean {\n    return this.finished;\n  }",
        "  get ended(): boolean {\n    return false;\n  }",
      ),
  },
  {
    id: "MU-1099",
    title:
      "R59 (revision 38): the attempt asks on its adoption's answer, without reading the binding again in the turn that asks (a binding that ended across the adoption still admits the request)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /(ends ACROSS the retry's adoption|the binding ENDS)/,
    patch: (t) => sub(t, "      if (!bound(w)) return;\n", ""),
  },
  {
    id: "MU-1100",
    title:
      "R59 (revision 38, progress): a replacement the turn that asks finds is never taken in (the work waits for an event instead of reading the replacement's budget and asking)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /no pause \(control\): the replacement's budget is read first, then the retry asks over it/,
    patch: (t) =>
      sub(
        t,
        "      w.again = true;\n      return false;\n    }\n    if (deps.databasePending",
        "      return false;\n    }\n    if (deps.databasePending",
      ),
  },
  {
    id: "MU-1101",
    title:
      "R59 (revision 38): an open database whose budget the work has not read admits the request (a replacement's pause is not read first)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /replaced ACROSS a retry's cached adoption, and the reader is not told yet; the database holds a pause/,
    patch: (t) =>
      sub(
        t,
        "      if (w.adopted === service) return true;\n      w.again = true;\n      return false;\n",
        "      return true;\n",
      ),
  },
  {
    id: "MU-1102",
    title:
      "R59 (revision 38, over-correction): a genuinely absent database refuses the memory path (the profile's memory-only verification never asks)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /found ABSENT/,
    patch: (t) =>
      sub(
        t,
        "      return false;\n    }\n    return true;\n  };\n\n  const attempt",
        "      return false;\n    }\n    return false;\n  };\n\n  const attempt",
      ),
  },
  {
    id: "MU-1103",
    title:
      "R59 (revision 38): connectivity is not read again in the turn that asks (a page that went offline while the retry awaited its adoption still asks)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /connectivity is read in the turn that asks/,
    patch: (t) =>
      sub(
        t,
        "      if (!deps.online()) return;\n      const identity = deps.identity.get();\n",
        "      const identity = deps.identity.get();\n",
      ),
  },
  {
    id: "MU-1104",
    title:
      "R59 (revision 38): `online`'s reset is applied after an awaited write whatever happened meanwhile (a newer counted outcome's back-off is cut short)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a retry fails meanwhile/,
    patch: (t) =>
      sub(
        t,
        "      if (resetStands(w, outcomes, adopted)) {\n        w.failures = 0;\n",
        "      if (true) {\n        w.failures = 0;\n",
      ),
  },
  {
    id: "MU-1105",
    title:
      "R59 (revision 38): an outcome is not counted for the reset's check (a reset decided before it undoes it)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a retry fails meanwhile/,
    patch: (t) => sub(t, "    w.outcomes += 1;\n", ""),
  },
  {
    id: "MU-1106",
    title:
      "R60 (revision 38, DA-R60-C): the discard of a draft that never existed ends its stop without telling the other pages (a warm follower keeps the warning)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(discard answers not_found, posts ONE stop hint|another draft's stop stands)/,
    patch: (t) =>
      sub(
        t,
        "        if (endedStreak >= config.localWritePauseAfter) stopsChanged();\n",
        "",
      ),
  },
  {
    id: "MU-1107",
    title:
      "R60 (revision 38): a discard that ended failures BELOW the bound announces a stop change (a healthy follower reads for nothing)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /control: two failures/,
    patch: (t) =>
      sub(
        t,
        "if (endedStreak >= config.localWritePauseAfter) stopsChanged();",
        "if (endedStreak > 0) stopsChanged();",
      ),
  },
  {
    id: "MU-1108",
    title:
      "R60 (revision 38, DA-R60-C): the not_found discard plan does not report the streaks it ended (the facade cannot tell a stop ended)",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /(discard answers not_found, posts ONE stop hint|another draft's stop stands)/,
    patch: (t) =>
      sub(
        t,
        "          endedStreak: endedStreak(sync, draftOperations(input.localId)),\n",
        "",
      ),
  },
  {
    id: "MU-1109",
    title:
      "R60 (revision 38): the record of a request that got no answer ends a receipt stop without telling the other pages",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /receipt STOP recorded while the request was in flight/,
    patch: (t) =>
      sub(
        t,
        "        if ((result.endedStreak ?? 0) >= config.localWritePauseAfter)\n          stopsChanged(service);\n",
        "",
      ),
  },
  {
    id: "MU-1110",
    title:
      "R60 (revision 38): the no-answer record plan does not report the receipt streak it ended",
    file: "src/data/plans/outbox.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /receipt STOP recorded while the request was in flight/,
    patch: (t) =>
      sub(
        t,
        "        ...(cleared === undefined\n          ? {}\n          : {\n              endedStreak: endedStreak(sync, [`receipt:$" +
          "{input.localId}`]),\n            }),\n",
        "",
      ),
  },
  {
    id: "MU-1111",
    title:
      "R60 (revision 38): the facade's stop counter that COMMITTED while its service ended is not announced (the follower never shows the stop)",
    file: "src/data/outbox/outbox.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /its counter committed while the writer's service ended/,
    patch: (t) =>
      sub(
        t,
        '        if (result.stop) stopsChanged();\n        return "identity_changed";\n',
        '        return "identity_changed";\n',
      ),
  },
  {
    id: "MU-1112",
    title:
      "R60 (revision 38): the dispatcher's stop counter that COMMITTED while its service ended is not announced",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /the dispatcher's third failed claim, its counter committed while the service ended/,
    patch: (t) =>
      sub(
        t,
        '        if (result.stop) stopsChanged(service);\n        return { when: "event" };\n',
        '        return { when: "event" };\n',
      ),
  },
  {
    id: "MU-1113",
    title:
      "R60 (revision 38): a receipt admitted after the dispatcher's run ended is not announced (a follower showing the receipt's stop keeps it)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /a receipt admitted while the dispatcher's run ENDED/,
    patch: (t) =>
      sub(
        t,
        '        if (out.kind === "applied") answered(service);\n        return { when: "event" };\n',
        '        return { when: "event" };\n',
      ),
  },
  {
    id: "MU-1114",
    title:
      "R60 (revision 38): an outcome recorded after the dispatcher's run ended is not announced (a follower showing the receipt's stop keeps it)",
    file: "src/data/engine/outbox-dispatcher.ts",
    tests: ["tests/data/outbox-stop-clearance.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect:
      /a 503 recorded \(a counted retry\) while the dispatcher's run ENDED/,
    patch: (t) =>
      sub(
        t,
        '    if (!alive(id)) {\n      if (out.kind === "applied") answered(service);\n      return { when: "event" };\n    }\n',
        '    if (!alive(id)) return { when: "event" };\n',
      ),
  },
  {
    id: "MU-1116",
    title:
      "R59 (revision 38): a reset decided before an awaited write is dropped when the binding merely ENDED meanwhile (an explicit retry whose write landed is lost)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /the binding merely ENDS meanwhile/,
    patch: (t) =>
      sub(
        t,
        "w.outcomes === outcomes && w.adopted === adopted;",
        "w.outcomes === outcomes && w.adopted === adopted && openService(w) !== null;",
      ),
  },
  {
    id: "MU-1117",
    title:
      "R59 (revision 38): a reset decided before an awaited write is applied over a budget the work took in meanwhile (another page's newer pause is undone)",
    file: "src/data/engine/identity-task.ts",
    tests: ["tests/data/identity-admission.test.ts"],
    // The failing tests must include one of these (an unrelated crash or timeout is no evidence): see scripts/run-data-mutants.mjs.
    expect: /takes in ANOTHER budget meanwhile/,
    patch: (t) =>
      sub(
        t,
        "w.outcomes === outcomes && w.adopted === adopted;",
        "w.outcomes === outcomes;",
      ),
  },

  // ---- WEB-09b (10 October 2026): the production leader, the staged snapshot, the recovery job and its budgets ---------------------------
  {
    id: "MU-1201",
    title:
      "WEB-09b: a staged snapshot page is not admitted by the staging compare-and-set (W22 lists no STG)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-2 to S-7|S-8 the same page requested again/,
    patch: (t) =>
      sub(
        t,
        '    guards: ["INC", "CLS", "STG", "GEN", "OWN", "EPO"],\n    quota: "cache",\n  },\n  scope: ["cache_staging"],',
        '    guards: ["INC", "CLS", "GEN", "OWN", "EPO"],\n    quota: "cache",\n  },\n  scope: ["cache_staging"],',
      ),
  },
  {
    id: "MU-1202",
    title:
      "WEB-09b: the STG guard itself compares nothing (a page at another staged position is applied)",
    file: "src/data/model/guards.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-2 to S-7|S-8 the same page requested again/,
    patch: (t) =>
      sub(
        t,
        '    if (sync.staging_position !== (captured.expectedPosition ?? null))\n      return "position";',
        '    if (sync.staging_position !== (captured.expectedPosition ?? null) && (false as boolean))\n      return "position";',
      ),
  },
  {
    id: "MU-1203",
    title:
      "WEB-09b: the activation swaps in the staged rows of ANOTHER generation, not those of the attempt it activates",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-9 the final page and the swap|S-11 adopted rows/,
    patch: (t) =>
      sub(
        t,
        '        "recovery_generation",\n        generation,\n',
        '        "recovery_generation",\n        generation - 1,\n',
      ),
  },
  {
    id: "MU-1204",
    title:
      "WEB-09b: the activation does not clear the old cache before the swap",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-9 the final page and the swap/,
    patch: (t) => sub(t, 'writes: [w.clear("cache")],', "writes: [],"),
  },
  {
    id: "MU-1205",
    title:
      "WEB-09b: the activation releases receipts NEWER than the snapshot's boundary (content that predates the change)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-12 unsent work is byte-identical/,
    patch: (t) =>
      sub(t, "row.receipt_revision <= boundary,", "row.receipt_revision >= 0,"),
  },
  {
    id: "MU-1206",
    title:
      "WEB-09b (P-7): the activation's receipt bookkeeping writes the effect rows of UNSENT work too",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /S-12 unsent work is byte-identical/,
    // Re-anchored in review cycle 1 (R8): the selection is the same; the `deletes` option it sat beside is gone (the receipt bookkeeping
    // is no longer made in recovery mode at all). Its tests are the ordinary activation and W26 (S-12), where it now applies.
    patch: (t) =>
      sub(t, "        select: acknowledgedOnly,\n      });", "      });"),
  },
  {
    id: "MU-1208",
    title:
      "WEB-09b (Q7): an attempt is adopted up to the whole lifetime, without the margin",
    file: "src/data/model/recovery.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /O-2 at \(and after\) the lifetime/,
    patch: (t) =>
      sub(
        t,
        "config.snapshotCursorLifetimeMs - config.snapshotAdoptMarginMs",
        "config.snapshotCursorLifetimeMs",
      ),
  },
  {
    id: "MU-1209",
    title:
      "WEB-09b (case (c)): a restart under a new generation leaves the old generation's staged rows",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /O-2 at \(and after\) the lifetime/,
    patch: (t) =>
      sub(
        t,
        '        writes: [w.clear("cache_staging")],\n        sync: {\n          ...sync,\n          ...withoutAttemptStreaks(sync),\n          owner,',
        "        writes: [],\n        sync: {\n          ...sync,\n          ...withoutAttemptStreaks(sync),\n          owner,",
      ),
  },
  {
    id: "MU-1210",
    title:
      "WEB-09b (trace 5): a page's success resets the whole-attempt counter (a healthy page one keeps the loop going for ever)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /trace 5/,
    patch: (t) =>
      sub(
        t,
        "    delta_error_streak: 0,\n    ...(cursorless ? { sync_error_streak: 0 } : {}),\n  };",
        "    delta_error_streak: 0,\n    recovery_attempt_streak: 0,\n    ...(cursorless ? { sync_error_streak: 0 } : {}),\n  };",
      ),
  },
  {
    id: "MU-1211",
    title:
      "WEB-09b (trace 6): a blocked budget still captures an automatic request",
    file: "src/data/plans/recovery-writers.ts",
    tests: [
      "tests/data/recovery-job.test.ts",
      "tests/data/snapshot-plans.test.ts",
    ],
    expect: /trace 6|a blocked budget sends nothing|permits ONE attempt/,
    patch: (t) =>
      sub(
        t,
        "if (blocked !== null && input.allowBlocked !== true)",
        "if (blocked !== null && input.allowBlocked !== true && (false as boolean))",
      ),
  },
  {
    id: "MU-1212",
    title:
      "WEB-09b: three unrecognised answers on a cursor count the attempt but do not abandon the cursor",
    file: "src/data/model/recovery.ts",
    tests: [
      "tests/data/snapshot-plans.test.ts",
      "tests/data/recovery-job.test.ts",
    ],
    expect: /R-1 the reducer|trace 5/,
    patch: (t) =>
      sub(
        t,
        "      return {\n        ...base,\n        delta_error_streak: 0,\n        recovery_attempt_streak: base.recovery_attempt_streak + 1,\n        attemptCounted: true,\n        abandon: true,\n      };\n    }",
        "      return {\n        ...base,\n        delta_error_streak: 0,\n        recovery_attempt_streak: base.recovery_attempt_streak + 1,\n        attemptCounted: true,\n        abandon: false,\n      };\n    }",
      ),
  },
  {
    id: "MU-1213",
    title:
      "WEB-09b: a server-instructed restart (410, 409 access_changed) is counted against the whole-attempt budget",
    file: "src/data/model/recovery.ts",
    tests: [
      "tests/data/snapshot-plans.test.ts",
      "tests/data/recovery-job.test.ts",
    ],
    expect: /R-1 the reducer|restarts cursor-less, counting nothing/,
    patch: (t) =>
      sub(
        t,
        '    case "server_restart":\n      return {\n        ...base,\n        delta_error_streak: 0,',
        '    case "server_restart":\n      return {\n        ...base,\n        recovery_attempt_streak: base.recovery_attempt_streak + 1,\n        delta_error_streak: 0,',
      ),
  },
  {
    id: "MU-1214",
    title:
      "WEB-09b (matrix 3.7.3): a recovery that has made its data commit never asks `finish` (the fence never clears)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /T24 A|T24 F/,
    patch: (t) =>
      sub(
        t,
        'if (issued.mode === "ordinary") return idle();\n    return finish(b, issued.handle);',
        'if (issued.mode === "ordinary") return idle();\n    return idle();',
      ),
  },
  {
    id: "MU-1215",
    title:
      "WEB-09b (T24 H): an ineligible `begin` is ignored and the recovery reads anyway",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /T24 H/,
    patch: (t) =>
      sub(
        t,
        // Re-anchored in review cycle 2 (R3): `ineligible` now also takes the binding and the epoch of its admission wait.
        'if (begun.kind === "ineligible")\n          return ineligible(',
        'if (begun.kind === "ineligible" && (false as boolean))\n          return ineligible(',
      ),
  },
  {
    id: "MU-1216",
    title:
      "WEB-09b (matrix 3.7.3): recovery reads use the ORDINARY request class",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /T24 A|T24 B/,
    patch: (t) =>
      sub(t, 'mode === "recovery" ? "recovery" : "ordinary",', '"ordinary",'),
  },
  {
    id: "MU-1217",
    title:
      "WEB-09b (row 6 case 5): the leader gives the lock up on an account transition",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-3 the lock is never released/,
    patch: (t) =>
      sub(
        t,
        "    b.controller.abort();",
        "    b.controller.abort();\n    deps.election.dispose();",
      ),
  },
  {
    id: "MU-1218",
    title: "WEB-09b: a follower page binds and runs the writers as if it led",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-1\/L-2|F-1 variant 1|F-2 variant 2/,
    patch: (t) =>
      sub(
        t,
        "const leading = (): boolean =>",
        "const leading = (): boolean => true || ",
      ),
  },
  {
    id: "MU-1219",
    title:
      "WEB-09b (P-8): the engine keeps running while the recovery job has the cache to itself",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-6 the engine is stopped while the job has the cache/,
    patch: (t) =>
      sub(
        t,
        "const wanted = live && !job.exclusive.get();",
        "const wanted = live;",
      ),
  },
  {
    id: "MU-1220",
    title:
      "WEB-09b: the engine and the dispatcher run while the account is fenced (a loop of refused requests)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-10/,
    patch: (t) =>
      sub(
        t,
        "displayed(b.account);",
        "(displayed(b.account) || (true as boolean));",
      ),
  },
  {
    id: "MU-1221",
    title:
      "WEB-09b: the leader reopens the account by itself when its service ends (a wipe's latch is lifted)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-9b/,
    patch: (t) =>
      sub(
        t,
        "if (bound === b) unbind();",
        "if (bound === b) {\n          unbind();\n          follow();\n        }",
      ),
  },
  {
    id: "MU-1222",
    title:
      "WEB-09b (row 3): the leader opens the account while a logout or retirement is pending",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-9/,
    patch: (t) =>
      sub(
        t,
        "if (deps.operationPending(identity.account_id)) return;",
        "if (deps.operationPending(identity.account_id) && (false as boolean)) return;",
      ),
  },
  {
    id: "MU-1223",
    title:
      "WEB-09b (E-B14): a staged page's local-write identity carries the generation (a reload forgets three failures)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /survives a reload/,
    patch: (t) =>
      sub(
        t,
        "? snapshotPageOperation(position)",
        // A template literal is the patched TEXT here, so its placeholders are built, not interpolated.
        [
          "? `",
          "$",
          "{snapshotPageOperation(position)}#",
          "$",
          "{sync.recovery_generation}`",
        ].join(""),
      ),
  },
  {
    id: "MU-1224",
    title:
      "WEB-09b (P-7): a catch-up page in recovery mode is reconciled like an ordinary page (unsent work written, receipts deleted)",
    file: "src/data/plans/commit-page.ts",
    tests: ["tests/data/commit-page-recovery.test.ts"],
    // Review cycle 1 (R8): the case was renamed when the recovery stopped writing acknowledged work too.
    expect: /NOTHING of the queue is written/,
    patch: (t) =>
      sub(t, '...(input.mode === "recovery" ? { recovery: true } : {}),', ""),
  },
  {
    id: "MU-1225",
    title:
      "WEB-09b: an abandoned catch-up cursor leaves the cache shown as valid",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /R-2 an abandonment/,
    patch: (t) =>
      sub(
        t,
        '        ...(sync.cache_status === "valid"\n          ? { cache_status: "invalid" as const, cursor: null }\n          : {}),',
        "",
      ),
  },
  {
    id: "MU-1226",
    title:
      "WEB-09b: Try again resets a whole-attempt failure it did not see (the reset is not versioned)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /R-4 Try again/,
    patch: (t) =>
      sub(
        t,
        "if (fields.recovery_budget_version !== input.expect)",
        "if (fields.recovery_budget_version !== input.expect && (false as boolean))",
      ),
  },
  {
    id: "MU-1227",
    title:
      "WEB-09b (P-3): with a production leader on the page the provider still builds and disposes a runtime of its own",
    file: "src/data/ui/react.tsx",
    tests: ["tests/data/follower-status.test.tsx"],
    expect: /waits for and uses the PAGE's runtime/,
    patch: (t) =>
      sub(
        t,
        "if (leaderStarted() || host.runtime.get() !== null) {",
        "if ((leaderStarted() || host.runtime.get() !== null) && (false as boolean)) {",
      ),
  },
  {
    id: "MU-1228",
    title:
      "WEB-09b (P-11): a follower page reads 'Updates stopped' merely because another page leads",
    file: "src/data/model/status.ts",
    tests: ["tests/data/follower-status.test.tsx"],
    expect: /FS-1|FS-2/,
    patch: (t) =>
      sub(
        t,
        "if (inputs.follower === true) {",
        "if (inputs.follower === true && (false as boolean)) {",
      ),
  },
  {
    id: "MU-1229",
    title:
      "WEB-09b: a page of another boundary revision is staged into the attempt",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /a delta page, a revision mismatch and a lapsed hold/,
    patch: (t) =>
      sub(
        t,
        "revision !== staged",
        "revision !== staged && (false as boolean)",
      ),
  },
  {
    id: "MU-1230",
    title:
      "WEB-09b (R28): a staged page is written after the hold it was admitted under ended",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /a delta page, a revision mismatch and a lapsed hold/,
    patch: (t) =>
      sub(
        t,
        '  if (input.leaseLive !== undefined && !input.leaseLive())\n    return { kind: "lease_lapsed" };',
        "",
      ),
  },
  {
    id: "MU-1231",
    title:
      "WEB-09b (OWN): the recovery job's capture is admitted for a binding that no longer owns the database",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /another binding's token/,
    patch: (t) =>
      sub(
        t,
        '    if (!owns(sync, input.token))\n      return { result: { kind: "gated", reason: "owner" } };',
        "",
      ),
  },
  {
    id: "MU-1232",
    title:
      "WEB-09b: a draft saved through another facade (this page's screens, a follower page) does not wake the leader's dispatcher",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/leader.test.ts"],
    expect: /L-11/,
    patch: (t) =>
      sub(
        t,
        '            message.stores.includes("drafts")\n          )\n            dispatcher.wake();',
        '            message.stores.includes("drafts") &&\n            (false as boolean)\n          )\n            dispatcher.wake();',
      ),
  },
  {
    id: "MU-1233",
    title:
      "WEB-09b (trace 6, E-B13): the one attempt a page load permits while blocked is spent at the capture, so a request withheld at the issue check leaves the load with none",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /spent only by a request that is ISSUED/,
    patch: (t) =>
      sub(
        t,
        '    trigger ??= capture.position === null ? "first_snapshot" : "adopted";\n',
        '    trigger ??= capture.position === null ? "first_snapshot" : "adopted";\n    permitBlocked = false;\n',
      ),
  },
  {
    id: "MU-1234",
    title:
      "WEB-09b (trace 6, E-B13 in WebKit): a request the session refuses before sending it (not_sent, not_covered) keeps the load's one permitted attempt, so the load sends nothing",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect:
      /the permitted attempt is RETURNED when the session refuses its request/,
    patch: (t) =>
      sub(
        t,
        '        issued.permit &&\n        (error.kind === "not_sent" || error.kind === "not_covered")\n      )\n        permitBlocked = true;\n',
        '        issued.permit &&\n        (error.kind === "not_sent" || error.kind === "not_covered")\n      )\n        void 0;\n',
      ),
  },
  // ---- WEB-09b review cycle 1 (10 October 2026): R1 to R8 ------------------------------------------------------------------------------
  {
    id: "MU-1235",
    title:
      "WEB-09b R8: an activation in RECOVERY mode does the queue's receipt bookkeeping itself (the recovery writes acknowledged drafts and their effects)",
    file: "src/data/plans/recovery-writers.ts",
    tests: [
      "tests/data/snapshot-plans.test.ts",
      "tests/data/recovery-job.test.ts",
    ],
    expect:
      /S-12 unsent work is byte-identical|the whole queue is byte-identical/,
    patch: (t) =>
      sub(
        t,
        '    const stats =\n      input.mode === "recovery"',
        "    const stats =\n      (false as boolean)",
      ),
  },
  {
    id: "MU-1236",
    title:
      "WEB-09b R8: a catch-up page in recovery mode reconciles the queue's effects (acknowledged drafts written by the recovery)",
    file: "src/data/plans/reconcile-windows.ts",
    tests: [
      "tests/data/commit-page-recovery.test.ts",
      "tests/data/recovery-job.test.ts",
    ],
    expect: /NOTHING of the queue is written|the whole queue is byte-identical/,
    patch: (t) =>
      sub(
        t,
        "  if (input.recovery === true) {",
        "  if (input.recovery === true && (false as boolean)) {",
      ),
  },
  {
    id: "MU-1237",
    title:
      "WEB-09b R8: the receipt bookkeeping a recovery owed is never done after the display (W26 never runs)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /W26 releases the acknowledged receipt/,
    patch: (t) =>
      sub(
        t,
        "if (capture.reconcilePending === true)\n",
        "if (capture.reconcilePending === true && (false as boolean))\n",
      ),
  },
  {
    id: "MU-1238",
    title:
      "WEB-09b R1: a recovery is finished on ANY handle once some data commit was made (a second re-authentication finishes without its own catch-up)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R1 \(lock_timeout\)|R1 \(failed\)/,
    // TWO layers protect R1 (the proof is cleared by a new `begin`, and it is bound to the exact handle): either alone is an equivalent
    // mutant (the first run of review cycle 1 found the handle comparison alone survives). Removing both is the defect the review found.
    patch: (t) =>
      sub(
        sub(
          t,
          "        commitProof.handle === handle\n",
          "        (true as boolean)\n",
        ),
        "        handle = null;\n        commitProof = null;\n        const begun",
        "        handle = null;\n        const begun",
      ),
  },
  {
    id: "MU-1239",
    title:
      "WEB-09b R3: a refusal that only the durable record ends is never asked again on the record's notification (a resolved gate leaves recovery waiting)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R3 \(/,
    // Redefined in review cycle 2 (R3): `awaitsRecord` is gone; the same defect in the new mechanism is a `begin` refusal on the record
    // that is left as a bare event wait (no admission wait, so a resolution in the same epoch is never noticed).
    patch: (t) =>
      sub(
        t,
        'return awaitAdmission(b, "recovery", epoch, "begin");',
        'return { when: "event" };',
      ),
  },
  {
    id: "MU-1240",
    title:
      "WEB-09b R4: when an obsolete step ends, the replacement binding is not scheduled (it waits for an unrelated notification)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts", "tests/data/leader.test.ts"],
    expect: /R4: with NO further notification|L-13/,
    patch: (t) =>
      sub(
        t,
        '      woken = false;\n      const current = binding;\n      if (current !== null && alive(current))\n        schedule(current, { when: "now" });\n      else resolveWaiters();',
        "      woken = false;\n      resolveWaiters();",
      ),
  },
  {
    id: "MU-1241",
    title:
      "WEB-09b R4: the recovery request does not carry its binding's ownership signal (an obsolete call stays outstanding)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R4: the obsolete request is aborted/,
    patch: (t) =>
      sub(
        t,
        '{ method: "GET", signal: b.ownership.signal }',
        '{ method: "GET" }',
      ),
  },
  {
    id: "MU-1242",
    title:
      "WEB-09b R5: the response-derived budget write (W24) bypasses the stamp's admission (G1, G2, the persistence hold)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R5/,
    patch: (t) =>
      sub(
        t,
        "const out = await service.commit(recordRecoveryOutcome, {",
        "const out = await service.store.run(recordRecoveryOutcome, {",
      ),
  },
  {
    id: "MU-1243",
    title:
      "WEB-09b R5: W24 lists no epoch mirror (an earlier epoch's answer, admitted before the mirror moved, counts)",
    file: "src/data/plans/recovery-writers.ts",
    tests: ["tests/data/snapshot-plans.test.ts"],
    expect: /R-3b an answer of an EARLIER epoch/,
    patch: (t) =>
      sub(
        t,
        '    guards: ["INC", "CLS", "GEN", "OWN", "EPO"],\n    quota: null,',
        '    guards: ["INC", "CLS", "GEN", "OWN"],\n    quota: null,',
      ),
  },
  {
    id: "MU-1244",
    title:
      "WEB-09b R6: a follower ignores the leader's durable stops and says 'Up to date'",
    file: "src/data/model/status.ts",
    tests: ["tests/data/follower-status.test.tsx"],
    expect: /R6:/,
    patch: (t) =>
      sub(
        t,
        "        (stops.paused || stops.pageStopped || stops.floor)",
        "        (false as boolean)",
      ),
  },
  {
    id: "MU-1245",
    title:
      "WEB-09b R6: the follower's facts do not read a durably paused `sync` read caller",
    file: "src/data/plans/facts.ts",
    tests: ["tests/data/follower-status.test.tsx"],
    expect: /R6: a durably PAUSED/,
    patch: (t) =>
      sub(
        t,
        "    paused: sync.read_retry_states.sync?.paused === true,",
        "    paused: false,",
      ),
  },
  {
    id: "MU-1246",
    title:
      "WEB-09b R2: the leading page ignores a follower's request to retry updates",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/retry-routing.test.ts"],
    expect: /a FOLLOWER's retry is applied by the leading page/,
    patch: (t) =>
      sub(
        t,
        "            retryHere({ account: message.account, epoch: message.epoch });",
        "            void message;",
      ),
  },
  {
    id: "MU-1247",
    title:
      "WEB-09b R2: the leader applies a retry made against another epoch's view",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/retry-routing.test.ts"],
    expect: /a retry made against another epoch/,
    patch: (t) =>
      sub(
        t,
        "      identity.epoch !== target.epoch\n",
        "      (false as boolean)\n",
      ),
  },
  {
    id: "MU-1248",
    title:
      "WEB-09b R2: a follower's 'Retry now' / 'Try again' for updates asks nobody (it has no engine or job)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/retry-routing.test.ts"],
    expect: /posts `retry_requested`/,
    patch: (t) =>
      sub(
        t,
        "      if (follower !== null && leader.engine === undefined) {\n        const identity = deps.identity.get();",
        "      if (follower !== null && leader.engine === undefined && (false as boolean)) {\n        const identity = deps.identity.get();",
      ),
  },
  {
    id: "MU-1249",
    title:
      "WEB-09b R2: the neutral state's 'Try again' does not reach the recovery owner (the session's retry tells no listener)",
    file: "src/session/session.ts",
    tests: ["tests/session/recovery-api.test.ts"],
    expect: /the neutral state's Try again is the recovery owner's act too/,
    patch: (t) => sub(t, "      recovery.retried();", "      void 0;"),
  },
  {
    id: "MU-1250",
    title:
      "WEB-09b R7: 'save as new' is rebuilt on nothing although the authorised current read loaded",
    file: "src/features/sync/ItemDetailDialog.tsx",
    tests: ["tests/features/sync/recovery-screens.test.tsx"],
    expect: /U-6/,
    patch: (t) =>
      sub(
        t,
        ".saveAsNew(draft.local_id, base)",
        ".saveAsNew(draft.local_id, null)",
      ),
  },
  {
    id: "MU-1251",
    title:
      "WEB-09b R7: the new attempt is enabled while the authorised current read is still loading or has failed",
    file: "src/features/sync/ItemDetailDialog.tsx",
    tests: ["tests/features/sync/recovery-screens.test.tsx"],
    expect: /U-7/,
    patch: (t) =>
      sub(t, '    read === "loaded" ||\n', "    (true as boolean) ||\n"),
  },
  // ---- WEB-09b review cycle 2 (R3, R7) ----------------------------------------------------------------------------------------------
  {
    id: "MU-1262",
    title:
      "WEB-09b R3 (cycle 2): a cover that closes after `begin` (closed, closed_unresolved) leaves the job running with nothing to wake it",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R3 \(closed/,
    patch: (t) =>
      sub(
        t,
        '          return awaitAdmission(\n            issued.binding,\n            issued.mode,\n            issued.epoch,\n            "closed",\n          );',
        '          return { when: "event" };',
      ),
  },
  {
    id: "MU-1263",
    title:
      "WEB-09b R3 (cycle 2): a not_sent that outlasts the immediate retries ends in a bare event wait (a released hold is never noticed)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R3 \(not_sent|R3 \(lost hint/,
    patch: (t) =>
      sub(
        t,
        '          return awaitAdmission(\n            issued.binding,\n            issued.mode,\n            issued.epoch,\n            "not_sent",\n          );',
        '          return { when: "event" };',
      ),
  },
  {
    id: "MU-1264",
    title:
      "WEB-09b R3 (cycle 2): a recovery request refused by the cover keeps its handle, so the resumed run is finished under the old `s`",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R3 \(closed/,
    patch: (t) =>
      sub(
        t,
        '          if (issued.mode === "recovery") {\n            handle = null;\n            commitProof = null;\n          }\n',
        "",
      ),
  },
  {
    id: "MU-1265",
    title:
      "WEB-09b R3 (cycle 2): an open, unchanged admission revision always permits another attempt (a refusal the probe cannot see loops)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /tried ONCE more/,
    patch: (t) =>
      sub(t, "(changed || !episode.consumed || due)", "(changed || true)"),
  },
  {
    id: "MU-1266",
    title:
      "WEB-09b R3 (cycle 2): a standing admission wait has no paced reconciliation (a lost notification strands it)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /lost hint/,
    patch: (t) =>
      sub(
        t,
        "    let ms = Math.min(\n      config.recoveryBeginRetryMaxMs,",
        '    return { when: "event" } as Next;\n    let ms = Math.min(\n      config.recoveryBeginRetryMaxMs,',
      ),
  },
  {
    id: "MU-1267",
    title:
      "WEB-09b R3 (cycle 2): the first probe after a refusal permits no attempt unless the revision moved since an earlier probe (a gate resolved before the wait was installed is never tried)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /came and went/,
    patch: (t) =>
      sub(
        t,
        "(changed || !episode.consumed || due)",
        "((changed && seen) || due)",
      ),
  },
  {
    id: "MU-1268",
    title:
      "WEB-09b R3 (cycle 2): a notification is dropped while the job stands in an admission wait (only the paced timer is left)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /R3 \(closed after/,
    patch: (t) =>
      sub(
        t,
        "if (eligibility() === lastEligibility && !waiting) return;",
        "if (eligibility() === lastEligibility) return;",
      ),
  },
  {
    id: "MU-1269",
    title:
      "WEB-09b R7 (cycle 2): the authorised current read hands back the command's result without sealing it against the durable record",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/current-read.test.ts"],
    expect: /refused|durable record|fails closed|sealed once/,
    patch: (t) =>
      sub(
        t,
        "result = await seal(account, epoch, interpreted);",
        "result = await interpreted;",
      ),
  },
  {
    id: "MU-1270",
    title:
      "WEB-09b R7 (cycle 2): the current read is validated against the page's identity mirror instead of the durable record",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/current-read.test.ts"],
    expect: /notice never arrives|LATER interpretation/,
    patch: (t) =>
      sub(
        t,
        "result = await seal(account, epoch, interpreted);",
        "result = await interpreted;\n          const mirror = deps.identity.get();\n          if (mirror?.account_id !== account || mirror.epoch !== epoch) return unavailable;",
      ),
  },
  {
    id: "MU-1271",
    title:
      "WEB-09b R7 (cycle 2): the current read's own scope (lifetime, binding, service, caller's signal) is not checked at release",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/current-read.test.ts"],
    expect: /stops during the decode|service ends|cancels/,
    patch: (t) =>
      sub(t, "return live() ? result : unavailable;", "return result;"),
  },
  {
    id: "MU-1272",
    title:
      "WEB-09b R7 (cycle 2): the caller's cancellation does not end the current read's scope (a command that ignores its signal is handed back)",
    file: "src/data/ui/env.ts",
    tests: ["tests/data/current-read.test.ts"],
    expect: /cancels/,
    patch: (t) =>
      sub(
        t,
        'signal?.addEventListener("abort", onCaller, { once: true });',
        "void onCaller;",
      ),
  },
  {
    id: "MU-1273",
    title:
      "WEB-09b R3 (cycle 2): the session's admission probe ignores this page's hold",
    file: "src/session/kernel/admission.ts",
    tests: ["tests/session/admission-probe.test.ts"],
    expect: /hold and closing write block it/,
    patch: (t) =>
      sub(
        t,
        "blocked: !stamp || !open || hold || closing,",
        "blocked: !stamp || !open || closing,",
      ),
  },
  {
    id: "MU-1274",
    title:
      "WEB-09b R3 (cycle 2): the admission revision does not include the account's fences (an O11 removal in the same epoch changes nothing it reads)",
    file: "src/session/kernel/admission.ts",
    tests: ["tests/session/admission-probe.test.ts"],
    expect: /added and removed IN THE SAME EPOCH/,
    patch: (t) =>
      sub(
        t,
        "        state.fence_seq,\n        fences,\n",
        "        state.fence_seq,\n",
      ),
  },
  {
    id: "MU-1275",
    title:
      "WEB-09b R3 (cycle 2): the admission revision counts this page's OWN leases (its own requests would wake its own wait)",
    file: "src/session/kernel/admission.ts",
    tests: ["tests/session/admission-probe.test.ts"],
    expect: /another page's request lease/,
    patch: (t) =>
      sub(
        t,
        "leasesOfOthers(state, account, k.bootId)",
        'leasesOfOthers(state, account, "not-a-page")',
      ),
  },
  {
    id: "MU-1277",
    title:
      "WEB-09b R3 (cycle 2): an open admission revision whose attempt was refused is never tried again (a CSRF token only a new verification can fetch strands the job)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /open but refused/,
    patch: (t) =>
      sub(
        t,
        "      now >= episode.retryAt;",
        "      now >= episode.retryAt &&\n      (false as boolean);",
      ),
  },
  {
    id: "MU-1276",
    title:
      "WEB-09b R7 (cycle 2): `session.api.seal` hands a result back after the session was disposed",
    file: "src/session/session.ts",
    tests: ["tests/session/admission-probe.test.ts"],
    expect: /disposed session/,
    patch: (t) =>
      sub(
        t,
        'if (k.disposed) throw new StampedRequestError("stale");',
        "void k.disposed;",
      ),
  },
];

/**
 * RETIRED in revision 15 (R28): seven mutants of code that was removed on purpose, kept here so the audit trail is whole. Revision 14 let a
 * page whose ledger could not answer judge on its own accounting (the guard's own ledger, what the origin last showed, and the write
 * counted twice, called `degraded`). The review showed that stand-in bounds neither another page's outstanding write nor the number of
 * pages, so a reservation is now admitted only on an answer of the origin's ledger and refused (`unestablished`) when none comes. A mutant
 * of a fallback that no longer exists has nothing to patch; what each of them stood for is covered by the mutant named beside it.
 */
export const RETIRED = [
  {
    id: "MU-1207",
    why: '(WEB-09b review cycle 1, R8) an activation in recovery mode deletes the finished receipts it released: the recovery-mode activation no longer does any receipt bookkeeping (the approved brief: the recovery touches no draft, `pending_effects` or outbox entry), so there is no deletion of it to switch on and the anchor (`deletes: input.mode !== "recovery"` of `reconcileReceipts`) does not exist',
    replacedBy:
      "MU-1235 (a recovery-mode activation does the bookkeeping itself), MU-1237 (the owed bookkeeping is never done after the display) and S-12's recovery branch",
  },
  {
    id: "MU-444",
    why: "(REAL ENGINE) a hold in the origin's ledger lapses at once, so a page that dies mid-save frees its bytes immediately: with the ownership of revision 15 a hold of a page that has gone is reclaimed AT ONCE on proof whatever its lease, and a hold of a page that lives is never judged by its lease, so the lease no longer decides the outcome of that spec: the mutant is equivalent there",
    replacedBy:
      "MU-523 to MU-526 (real engine): the ownership itself, with real Web Locks and real IndexedDB",
  },
  {
    id: "MU-404",
    why: "a reservation made while the origin could not answer is forgotten by the next reservation: no reservation is made without the origin now",
    replacedBy: "MU-499 (an unanswered ledger admits the write)",
  },
  {
    id: "MU-405",
    why: "the same for `check`",
    replacedBy: "MU-470 (`check` remembers a page's own promises) and MU-506",
  },
  {
    id: "MU-413",
    why: "after a silent ledger every later save waits the whole wait again: there is no skip window any more (every save asks the origin)",
    replacedBy: "MU-500 (a silence is asked again like a rejection)",
  },
  {
    id: "MU-414",
    why: "a ledger that rejects fails the save instead of falling back: the refusal is now the specified outcome",
    replacedBy: "MU-499 and MU-498",
  },
  {
    id: "MU-467",
    why: "a judgement without the origin counts the write once: there is no judgement without the origin",
    replacedBy: "MU-499",
  },
  {
    id: "MU-468",
    why: "a degraded reservation forgets what the origin last showed: a reservation is never degraded",
    replacedBy:
      "MU-469 (the same for the advisory `check`, which still falls back to it)",
  },
  {
    id: "MU-472",
    why: "a judgement without the origin is not told from one with it: replaced by a refusal that says so",
    replacedBy: "MU-498",
  },
  {
    id: "MU-911",
    why: "(revision 32, R52) a read of the individual key that fails is tried again as a read of the enumeration: a marker is now read by listing the account's keys and by nothing else (its failure is named by its KEY), so there is no individual read to fall back from",
    replacedBy:
      "MU-885 and MU-886 (a failed listing is neither absent nor forgotten) and the reads of tests/data/marker-access.test.ts",
  },
  {
    id: "MU-943",
    why: "(REAL ENGINE, revision 32, R53) the person's retry does not remove the record of a draft held for an unreadable marker: a retry made while nothing can be listed names no marker, so it removes nothing whether or not the draft is among the operations it lifts; the mutant (a smaller set of operations to lift) is equivalent",
    replacedBy:
      "the E-O10 cold retry cases (revision 32): the retry cannot name the record and removes nothing, the retry made when a listing lands removes it (MU-958 keeps a memory of the retry and sends through it)",
  },
  {
    id: "MU-945",
    why: "(REAL ENGINE, revision 32, R52) a read of the individual key that fails is not tried again as a read of the enumeration: no individual key is read any more",
    replacedBy:
      "MU-903 and MU-905 (a failed listing reports no marker, or forgets what the page established), and the E-O10 (revision 32) cold cases for a listing that cannot be made",
  },
  {
    id: "MU-926",
    why: "(revision 32, R52) the person's retry does not remove the record of a draft held for an unreadable marker: a retry made while nothing can be listed names no marker, so there is no record for it to remove, and the lifting of the draft's unread operations (a removal by name, then a reset of the durable counter on the version the dispatcher had seen) lifted nothing the act could name. The construct was removed from the dispatcher; the retry's lifting is `named` alone.",
    replacedBy:
      "the cold retry cases of tests/data/outbox-cold-markers.test.ts (the retry made while the store cannot be listed removes nothing; the retry made when a listing lands sends the draft once)",
  },
  {
    id: "MU-927",
    why: "(revision 32, R52) the retry of all drafts does not cover the drafts held for an unreadable marker: see MU-926, the same construct (the held drafts' operations, passed to the witness and lifted when unread)",
    replacedBy:
      "the retry-of-all cold case of tests/data/outbox-cold-markers.test.ts",
  },
  {
    id: "MU-928",
    why: "(revision 32, R52) the retry of one draft lifts every draft held for an unreadable marker: see MU-926, the same construct",
    replacedBy:
      "the retry-of-another-draft cold case of tests/data/outbox-cold-markers.test.ts",
  },
  {
    id: "MU-930",
    why: "(revision 32, R52) the facade's retry does not remove the record of a draft whose marker it cannot read: see MU-926. The facade's loop over the operations it lifts no longer adds the draft's unread operations, because an unread witness names nothing to end",
    replacedBy:
      "the facade-before-the-dispatcher cold case of tests/data/outbox-cold-markers.test.ts",
  },
  {
    id: "MU-971",
    why: "(revision 32, R52) a listing does not read the names of the markers it finds: the name of a failure is its key, so a listing names every marker it finds and reads no value",
    replacedBy:
      "MU-891 and MU-892 (a listing that lands establishes what it finds) and MU-1005 (a listing that moved is not trusted)",
  },
  {
    id: "MU-966",
    why: "(revision 33, R55 and R56) a success removes a marker that names no instance: no key names no instance any more. A key written before keys named their failure and their database's lifetime is read by nothing (the card is new and no earlier format has shipped), so there is no marker a success could wrongly remove",
    replacedBy:
      "MU-1029 (the lifetime is not part of a key: a marker of another lifetime is read as this one's) and the 'another lifetime' cases of tests/data/marker-instances.test.ts and tests/data/marker-lifetime.test.ts",
  },
  {
    id: "MU-1005",
    why: "(revision 33, R55) a listing is not repeated when the store changed under it: nothing is read by listing the origin's keys any more, so there is no listing to repeat or to trust. A repeated or length-checked listing was never a proof of completeness (the review of revision 32, R55)",
    replacedBy:
      "MU-1012 (a read depends on a listing of the origin's keys again) and the churn cases of tests/data/marker-directories.test.ts, with the origin's listing forbidden",
  },
  {
    id: "MU-987",
    why: "(revision 33, R55) the operations of an abandoned draft end only when their marker can be read: the person's abandonment was 'blind' so that it also removed a marker that names no instance (an earlier build's key). No such key is read any more, and an unread witness names nothing to end, so the explicit flag now changes only whether a removal that cannot be made is owed; the mutant (explicit false) is equivalent for an abandonment",
    replacedBy:
      "MU-978 (the retry takes its witness at the act), MU-965 (a success owes nothing it cannot make) and the 'abandoning the draft ends its operations' cases of tests/data/outbox-cold-markers.test.ts",
  },
  {
    id: "MU-1012",
    why: "(revision 34, R55) a read of the markers depends on the length of the origin's storage: since revision 34 the listing of the origin's keys IS the second witness of a failure (header of the marker module, obligation 2), so a read that uses `length` is the design, not a defect",
    replacedBy:
      "MU-1043 (the listing is ignored: a key no directory lists is not found), MU-1044 (the directories are ignored), MU-1046 (a listing that failed is taken for complete) and MU-1047 (the walk's bound is removed)",
  },
  {
    id: "MU-1031",
    why: "(revision 34, R58) a hold that waited for its marker is kept when the marker could not be recorded either way: no hold waits for a marker any more (a failure is recorded in the step that records it, so `recordStop` takes a hold only when nothing could be written, and never releases it for a marker that arrives)",
    replacedBy:
      "MU-1048 (a failure waits for a slot), MU-1050 (a hold is taken although the marker was recorded) and the 'recordStop takes no hold' case of tests/data/marker-lifetime.test.ts",
  },
  {
    id: "MU-1035",
    why: "(revision 34, R55) (REAL ENGINE) a read of the markers depends on the length of the origin's storage again: see MU-1012, the same construct. E-O13 D1 now asserts the opposite premise (the walk is made, and no walk is disturbed by a second page that churns the keys)",
    replacedBy:
      "MU-1058 (the listing is ignored, in a real engine) and MU-1060 (the directories are ignored, in a real engine)",
  },
  {
    id: "MU-1038",
    why: "(revision 34, R55) (REAL ENGINE) a failure's directory is never written, selected by D3 (a cold page finds a failure another page published): the listing is the second witness since revision 34, so D3 passes without the directory by design. The defect (the first witness is gone) is MU-1060, selected by D8, which refuses the listing in the reading page",
    replacedBy: "MU-1060",
  },
  {
    id: "MU-1041",
    why: "(revision 34, R56 and R58) a failure is written although the lifetime ended while the page was taking its directory slot: a failure no longer waits for its slot, so there is no window between the call and the write in which the lifetime can end. The look in `publish` repeats the one in `set` in the same synchronous step (nothing awaits between them), so removing it alone is an equivalent mutant (it survived the affected run of revision 34 with no failing test); the look itself is MU-1019, which removes both",
    replacedBy:
      "MU-1019 (neither `set` nor the write asks `live`) and the 'SAME step as the write' case of tests/data/marker-lifetime.test.ts",
  },
  {
    id: "MU-1045",
    why: "(revision 35, R55) the second walk is not compared with the first: there is no walk any more. The listing is ONE snapshot of the origin's keys (`Object.keys` of the store, the HTML standard's single \"get the keys\"), which no interleaving can enter, so there are no two walks to compare and the anchor does not exist",
    replacedBy:
      "MU-1062 (the listing walks by index again: the review's churn then hides a standing failure), MU-1064 and MU-1065 (an established key the snapshot left out is read again and contradicts it)",
  },
];

/**
 * The mutants that only a REAL ENGINE can catch: a defect of the raw-IndexedDB host or of the Dexie adapter, which the double
 * of IndexedDB does not exercise (the double is test support, not source). They are built into a mutant FIXTURE bundle and the
 * named real-engine specs must fail (scripts/run-data-mutants.mjs --engine).
 */
export const ENGINE = [
  {
    id: "MU-40",
    title:
      "delete resolves on `blocked`: a delete that another tab still holds open is reported as done",
    file: "src/data/store/idb-host.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "E-W3",
    patch: (t) =>
      sub(
        t,
        /request\.onblocked = \(\) => \{\n {10}blocked = true;\n {8}\};/,
        'request.onblocked = () => {\n          blocked = true;\n          resolve("deleted");\n        };',
      ),
  },
  {
    id: "MU-48",
    title:
      "plan reads and writes use the implicit Dexie zone instead of the explicit transaction: a native await between requests ends the transaction",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-store.spec.ts",
    grep: "E-A3",
    patch: (t) => {
      let out = t;
      for (const call of ["makeReader", "makeSink", "applyWrite"]) {
        const from = `${call}(trans`;
        if (!out.includes(from))
          throw new PatchError(`anchor not found: ${from}`);
        out = out.split(from).join(`${call}(db`);
      }
      return out;
    },
  },
  {
    id: "MU-47",
    title:
      "the adapter's closed-database defences are all removed (no latch or isOpen check, autoOpen on): the first query after a wipe re-creates the database",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "E-W5",
    patch: (t) => {
      const noGuard = sub(
        t,
        /private assertOpen\(db: Dexie\): void \{[\s\S]*?\n {2}\}\n\n {2}async run/,
        "private assertOpen(_db: Dexie): void {}\n\n  async run",
      );
      const open = sub(
        noGuard,
        /\n\s+autoOpen: false,/,
        "\n          autoOpen: true,",
      );
      // Dexie's own versionchange handler closes with `disableAutoOpen: false` (decision D-01): the next query re-opens, and so
      // re-creates.
      if (!open.includes("disableAutoOpen: true"))
        throw new PatchError("anchor not found: disableAutoOpen: true");
      return open.split("disableAutoOpen: true").join("disableAutoOpen: false");
    },
  },
  {
    id: "MU-99",
    title:
      "R5 (revision 7): the capture gate does not enforce the capture write's stop (the revision-6 gate named only the page's operation): in a real engine a wake and a reload then send a request nobody consented to",
    file: "src/data/plans/sync-writers.ts",
    spec: "tests/e2e/fixture.data-sync.spec.ts",
    grep: "E-C4",
    patch: (t) =>
      sub(
        t,
        "      stopped(CAPTURE_OPERATION)\n        ? CAPTURE_OPERATION\n",
        "      (false as boolean)\n        ? CAPTURE_OPERATION\n",
      ),
  },
  {
    id: "MU-100",
    title:
      "R6 (revision 7): the initial lookup reads every pending effect of its ids in one unbounded read: the real adapter's conformance case C-16 (no read above the window) fails in every engine",
    file: "src/data/plans/reconcile-windows.ts",
    spec: "tests/e2e/fixture.data-store.spec.ts",
    grep: "E-A3",
    patch: (t) =>
      sub(t, "      remaining,\n      allowed,\n", "      remaining,\n"),
  },
  {
    id: "MU-124",
    title:
      "R11 (revision 8): the overlay clear of the ordinary invalidation reads every pending effect in ONE unbounded read: the real adapter's conformance case C-17 (no read above the window) fails in every engine",
    file: "src/data/plans/reconcile-windows.ts",
    spec: "tests/e2e/fixture.data-store.spec.ts",
    grep: "E-A3",
    patch: (t) =>
      sub(
        t,
        "      size,\n    );\n    if (rows.length === 0) break;",
        "      undefined,\n    );\n    if (rows.length === 0) break;",
      ),
  },
  {
    id: "MU-125",
    title:
      "R12 (revision 8): the wipe goes on without the durable closing flag: in a real engine a failed closing write (AbortError, UnknownError, QuotaExceededError) still reads the digest and deletes, and the late writer is answered `saved`",
    file: "src/session/kernel/wipe.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    // Narrowed in revision 18 (the adopted runner qualifies a catch only when EVERY failure of the selection is an assertion): the three
    // "every time" cases wait for a state the mutant never reaches and fail by a 30 s TIMEOUT, which is no evidence; the three "once" cases
    // and the control fail by assertion in every engine, and are the ones this mutant is for.
    grep: "E-W7.*(, once: |the control: )",
    patch: (t) =>
      sub(t, "if (!(await this.confirmClosing(account))) {", "if (false) {"),
  },
  {
    id: "MU-126",
    title:
      "R10 (revision 8): a failed write of an admitted invalidation is swallowed (`{when: event}`): in a real engine the cache stays open, nothing is retried, and the engine is silent",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-sync.spec.ts",
    grep: "E-C5",
    // Revision 13: caught by an ASSERTION (E-C5 asserts the state the engine reaches), no longer by a timeout of the spec's own wait.
    expect: /E-C5/,
    patch: (t) =>
      sub(
        t,
        "      return invalidationFailure(id, service, captured, reason, out.failure);",
        '      return { when: "event" };',
      ),
  },

  {
    id: "MU-152",
    title:
      "R10 (revision 9): an explicit retry ERASES the streak, marker and memory stop of an admitted invalidation before the write has landed: in a real engine, connectivity lost after the retry leaves the cache displayable (the revision-8 behaviour), and the real localStorage marker and IndexedDB streak are gone",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-sync.spec.ts",
    grep: "E-C6",
    patch: (t) =>
      sub(
        t,
        "if (operation?.startsWith(INVALIDATE_PREFIX) === true) {",
        "if (false) {",
      ),
  },
  {
    id: "MU-153",
    title:
      "R10 (revision 9): the first failed write of an admitted invalidation records no hold: in a real engine an offline wake with nothing durable leaves the engine's state silent and the cache displayable",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-sync.spec.ts",
    grep: "E-C6",
    patch: (t) =>
      sub(
        t,
        '    addHold(service, operation);\n    if (failure.cause === "quota") {',
        '    if (failure.cause === "quota") {',
      ),
  },
  {
    id: "MU-178",
    title:
      "R13 (revision 10): in a real engine an open database whose facts are not established reads as `unknown`: a failed or delayed first read of the facts opens the gate over a cache the database says is invalid, in the real IndexedDB and the real live query",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "E-C7",
    patch: (t) =>
      sub(
        t,
        'if (value === null) return "unverified";',
        'if (value === null) return "unknown";',
      ),
  },
  {
    id: "MU-179",
    title:
      "R13 (revision 10): in a real engine a failed read of the facts erases what the last good read said, so a hidden cache is hidden by accident and a valid one is hidden by a transient fault",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "E-C7",
    patch: (t) =>
      sub(
        t,
        '} else if (read.status === "unavailable" && read.reason === "error") {\n          scheduleReread(service);',
        '} else if (read.status === "unavailable" && read.reason === "error") {\n          established = null;\n          scheduleReread(service);',
      ),
  },
  {
    id: "MU-180",
    title:
      "R14 (revision 10): the real adapter's keyset page ignores its cursor: the conformance cases C-18 and C-19 fail in every engine (every page is the first)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-store.spec.ts",
    grep: "E-A3",
    patch: (t) =>
      sub(
        t,
        "          if (after !== undefined && !((fields[keyPath] as string) > after))\n            return false;\n",
        "",
      ),
  },
  {
    id: "MU-181",
    title:
      "R14 (revision 10): the real adapter's keyset page is not bounded by its limit: the conformance cases C-18 and C-19 fail in every engine (the whole index key is returned)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-store.spec.ts",
    grep: "E-A3",
    patch: (t) =>
      sub(
        t,
        "return (await collection.limit(limit).toArray()) as never;",
        "return (await collection.toArray()) as never;",
      ),
  },
  {
    id: "MU-193",
    title:
      "R15 (revision 11): in a real engine the controller does not listen to the marker feed: an already-open follower stays `open` after another page records an invalidation only in the fallback marker, in the real `storage` event, IndexedDB and `localStorage`",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "E-C8",
    patch: (t) =>
      sub(
        t,
        "    deps.markers?.subscribe(onMarkerChange) ?? (() => undefined),\n",
        "",
      ),
  },
  {
    id: "MU-194",
    title:
      "R15 (revision 11): in a real engine the window feed never listens for the browser's `storage` event (the marker is written and the event is delivered, and nothing hears it)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "E-C8",
    patch: (t) =>
      sub(t, '      window.addEventListener("storage", hear);\n', ""),
  },
  {
    id: "MU-195",
    title:
      "R15 (revision 11): in a real engine the notification is trusted: a marker that goes opens the cache on the facts read before it, with no read begun after the change",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "E-C8",
    patch: (t) =>
      sub(
        t,
        "      established = null;\n      rereadFailures = 0;\n      cancelReread();\n      watchFacts();\n      recompute();\n    };",
        "      recompute();\n    };",
      ),
  },
  {
    id: "MU-221",
    title:
      "R16 (revision 12): in a real engine a notification of the identity already being worked on starts the work again (the identity is an event, not a key): two real tabs feed each other through the session's lease hints, and the reads are repeated without bound",
    file: "src/data/engine/identity-task.ts",
    spec: "tests/e2e/fixture.data-identity-reads.spec.ts",
    grep: "E-C9",
    patch: (t) =>
      sub(
        t,
        "    if (key === (work?.key ?? null)) return;\n",
        "    if (key === null) {\n      work = null;\n      return;\n    }\n",
      ),
  },
  {
    id: "MU-222",
    title:
      "R16 (revision 12): in a real engine the durable budget is never read (a reload, a second tab and a database that says paused are all invisible to a page that starts): the pause does not survive a reload",
    file: "src/data/engine/identity-task.ts",
    spec: "tests/e2e/fixture.data-identity-reads.spec.ts",
    grep: "E-C9",
    patch: (t) =>
      sub(
        t,
        '    if (w.adopted === service) return "adopted";\n    try {',
        '    return "adopted";\n    try {',
      ),
  },
  {
    id: "MU-223",
    title:
      "R17 (revision 12): in a real engine the profile source reads its persisted name when it starts and not when the database opens (an offline start, whose database opens a moment later, never shows the name verified for this epoch)",
    file: "src/data/engine/profile-source.ts",
    spec: "tests/e2e/fixture.data-identity-reads.spec.ts",
    grep: "E-C10",
    patch: (t) =>
      sub(
        t,
        "        deps.onService?.(show) ?? (() => undefined),\n",
        "        () => undefined,\n",
      ),
  },
  {
    id: "MU-280",
    title:
      "R16 (revision 9): in a real engine the controller never says the look for the database is pending: a page that reloads asks `GET /me` before it can read the budget of an earlier page (the request the stored pause forbids)",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-identity-binding.spec.ts",
    grep: "E-C11: the database binds late",
    patch: (t) =>
      sub(
        t,
        "      openServiceOf(account) === null &&\n      (lookedFor !== account || current !== null),",
        "      false,",
      ),
  },
  {
    id: "MU-281",
    title:
      "R18 (revision 9): in a real engine the device id of the current row is not checked (a null, numeric or truthy-flagged row verifies the device, and the entry is never counted)",
    file: "src/data/model/identity-bodies.ts",
    spec: "tests/e2e/fixture.data-identity-binding.spec.ts",
    grep: "E-C11: a body that is not the contract's",
    patch: (t) =>
      sub(
        t,
        'typeof deviceId === "string" && deviceId.trim().length > 0',
        "deviceId !== undefined",
      ),
  },
  {
    id: "MU-282",
    title:
      "R18 (revision 9): in a real engine the profile check does not look at the type of `username` (a number reaches the label code: the read is counted as a failure of the network and asked again, not as an unrecognised answer)",
    file: "src/data/model/identity-bodies.ts",
    spec: "tests/e2e/fixture.data-identity-binding.spec.ts",
    grep: "E-C11: a body that is not the contract's",
    patch: (t) =>
      sub(
        t,
        '  if (typeof username !== "string") return null;',
        "  if (username === undefined) return null;",
      ),
  },
  {
    id: "MU-330",
    title:
      "R16 (revision 10): in a real engine a look that fails (indexedDB.databases() rejects) is taken for an answer: the readers are released and every remount asks /me over a database that holds a durable pause",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-identity-binding.spec.ts",
    // Narrowed in revision 14 (the validation tooling qualifies a catch only when EVERY failure of the selection is an assertion): the
    // `E-C11: a look that FAILS` group also holds an OFFLINE-start case that waits for a name which this defect keeps from ever appearing,
    // so under the mutant it fails by the 30 s test timeout, not by an assertion (assertion 18, timeout 3 in three engines, preserved in
    // `native-final-2.log`). The six cases of a listing that fails are what this mutant is meant to be caught by, and are.
    grep: "a listing that fails for (ever|4 s and then)",
    expect: /a listing that fails/,
    patch: (t) =>
      sub(
        t,
        "attaching = null;\n      lookAgain(account);",
        "attaching = null;\n      finishedLooking(account);",
      ),
  },
  {
    id: "MU-331",
    title:
      "R22 (revision 10): in a real engine the sync engine remembers no wake that arrives while a step runs (a sign-in that moved during a request is never read: one request, then nothing)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-wake.spec.ts",
    grep: "E-C13",
    patch: (t) =>
      sub(
        t,
        '      if (why === "wake") wakes.notify(eligibility());\n      else if (why !== "timer" && why !== "now" && why !== "start") {\n        wakes.signal();\n        if (why === "retry") retried = true;\n      }\n',
        "\n",
      ),
  },
  {
    id: "MU-347",
    title:
      "R12 (revision 11): in a real engine the first connection reports ABSENT for any AbortError (an aborted open request of an existing database: the ports read it as no work, and setClosing answers closing with no flag written)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-failure.spec.ts",
    grep: "E-C14",
    patch: (t) =>
      sub(
        t,
        '        release();\n        if (refused(error)) return { kind: "absent" };\n        throw toStoreFailure(error);\n      }\n      adopt(strict);',
        '        release();\n        if (refused(error) || NAMES(error).includes("AbortError"))\n          return { kind: "absent" };\n        throw toStoreFailure(error);\n      }\n      adopt(strict);',
      ),
  },
  {
    id: "MU-348",
    title:
      "R12 (revision 11): in a real engine the SECOND connection reports ABSENT for any AbortError (the page's open of an existing database fails on its second connection and is taken for a missing database)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-failure.spec.ts",
    grep: "E-C14",
    patch: (t) =>
      sub(
        t,
        '        // The second connection refuses the same way when the database was deleted between the two opens.\n        if (refused(error)) return { kind: "absent" };',
        '        // The second connection refuses the same way when the database was deleted between the two opens.\n        if (refused(error) || NAMES(error).includes("AbortError"))\n          return { kind: "absent" };',
      ),
  },
  {
    id: "MU-349",
    title:
      'R12 (revision 11): in a real engine an aborted open REQUEST of an existing database is taken for "there is no database" by the page\'s own look (the controller treats it as an answer and every remount asks /me on a fresh in-memory budget over a durable pause)',
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-identity-binding.spec.ts",
    // Narrowed in revision 18 to its own case, and WIDENED again in revision 19 (R34): the narrowing was made because a control of this
    // describe (a WebKit case whose injected fault was not in force, or whose look fell outside it) failed in a loaded run and stopped the whole
    // run. The faults are now installed in the live page and checked, and the failed interval is observed, so the whole describe is the
    // selection again: the controls (the same paused database with opens that work, and the late-by-9-s control) pass, and the cases the
    // mutant breaks fail by assertion.
    grep: "E-C11: an aborted OPEN REQUEST",
    patch: (t) =>
      sub(
        t,
        '        release();\n        if (refused(error)) return { kind: "absent" };\n        throw toStoreFailure(error);\n      }\n      adopt(strict);',
        '        release();\n        if (refused(error) || NAMES(error).includes("AbortError"))\n          return { kind: "absent" };\n        throw toStoreFailure(error);\n      }\n      adopt(strict);',
      ),
  },
  {
    id: "MU-386",
    title:
      "R24 (revision 12): in a real engine the replacement's key is not checked against the drafts that exist (a supersession under the key of a draft that was sent, or of the old draft itself, is `superseded` and overwrites or deletes it)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R24:",
    expect: /R24: an old draft in conflict/,
    patch: (t) =>
      sub(
        t,
        '  if (existing !== undefined) return { kind: "refused", reason: "key_in_use" };\n',
        "",
      ),
  },
  {
    id: "MU-387",
    title:
      "R25 (revision 12): in a real engine the plan's size guard never refuses (a base-dependent 900 KB command is admitted at the allowance on every growth path)",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R25:",
    expect: /R25: a base-dependent 900 KB command/,
    // Re-anchored in revision 14 (`overBound` takes the admission): the mutated meaning is unchanged.
    patch: (t) =>
      sub(
        t,
        'return bytes > admission.maxBytes ? { kind: "too_large", bytes } : null;',
        "return null;",
      ),
  },
  {
    id: "MU-388",
    title:
      "R26 (revision 12): in a real engine the ownership listener closes over the shared timer and is never removed (the replaced signal's late abort ends the new run's 3 s Retry-After deadline)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-ownership.spec.ts",
    grep: "R26",
    expect: /a restart, then the replaced signal aborts/,
    patch: (t) =>
      sub(
        t,
        '      bindAbort(generation, next.signal);\n      setState({ kind: "waiting", reason: "cache_not_valid" });',
        '      next.signal.addEventListener("abort", () => {\n        clearTimer();\n        resolveWaiters();\n      });\n      setState({ kind: "waiting", reason: "cache_not_valid" });',
      ),
  },
  {
    id: "MU-389",
    title:
      "R27 (revision 12): in a real engine the step issues its request without judging its eligibility again after the quota read (a stop() or a lost ownership during the read still sends)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-ownership.spec.ts",
    grep: "R27",
    expect: /during the quota read: no request when it resolves/,
    patch: (t) =>
      sub(
        t,
        '    if (eligible !== "yes")\n      return { when: eligible === "ended" ? "event" : "now" };\n',
        "",
      ),
  },
  {
    id: "MU-441",
    title:
      "R28 (revision 13): in a real engine the origin ledger's change is not one transaction (two real pages each read the empty ledger and both are admitted)",
    file: "src/data/store/quota-ledger.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28 with page A's ledger SLOW",
    expect: /R28 with page A's ledger SLOW/,
    patch: (t) =>
      sub(
        t,
        '    update: (change) => run("readwrite", change),',
        '    update: (change) =>\n      run("readonly", (state) => ({ state: null, result: state })).then(\n        (stale) => run("readwrite", () => change(stale)),\n      ),',
      ),
  },
  {
    id: "MU-442",
    title:
      "R28 (revision 13): in a real engine the production guard is not wired to the origin's IndexedDB ledger (each real page keeps its own accounting)",
    file: "src/data/ui/production-quota.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    // Narrowed in revision 14 (the validation tooling qualifies a catch only when EVERY failure is an assertion): the broad `R28`
    // selection also ran the cases that read the ledger record themselves, which fail by an error and a timeout (not by an assertion)
    // when the mutated page never creates the ledger. The race of two real pages is what this mutant is meant to be caught by.
    grep: "R28: two real pages",
    expect: /R28: two real pages/,
    patch: (t) =>
      sub(
        t,
        '  const ledger =\n    typeof storage?.estimate === "function"\n      ? createIdbLedger(options?.factory, locks)\n      : undefined;',
        "  const ledger = undefined as ReturnType<typeof createIdbLedger>;",
      ),
  },
  {
    id: "MU-443",
    title:
      "R25 (revision 13): in a real engine the header (its defaults context) is not part of the write's measure",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R25: a 900000-byte DEFAULTS CONTEXT",
    expect: /DEFAULTS CONTEXT/,
    patch: (t) =>
      sub(
        t,
        "  const header = plainJsonBytes({ ...write.draft, display_patch: null });",
        "  const header: number | null = 0;",
      ),
  },
  {
    id: "MU-445",
    title:
      "R22 (revision 13): in a real engine the healthy engine never goes quiet (its idle poll is 200 ms, a request every 200 ms for ever, as a loop that feeds itself would)",
    file: "src/data/model/config.ts",
    spec: "tests/e2e/fixture.data-wake.spec.ts",
    grep: "E-C13: the real session",
    expect: /a healthy engine beside a second real tab/,
    patch: (t) => sub(t, "  syncIdleMs: 60_000,", "  syncIdleMs: 200,"),
  },
  {
    id: "MU-491",
    title:
      "R28 (revision 14): in a real engine a page that is still open never renews its outstanding hold (the lease runs out under a live save, and the other page counts the space as free)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "RENEWS its outstanding hold",
    expect: /RENEWS its outstanding hold/,
    patch: (t) =>
      sub(
        t,
        "    if (renewTimer !== undefined || tracked.size === 0) return;",
        "    return;",
      ),
  },
  {
    id: "MU-523",
    title:
      "R28 (revision 15): in a real engine the production guard builds the origin's ledger without the page's Web Locks (a page that is still open loses its hold when the lease looks over from another page)",
    file: "src/data/ui/production-quota.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28 \\(revision 15\\): a page that is still open keeps its hold",
    expect: /a page that is still open keeps its hold/,
    patch: (t) =>
      sub(
        t,
        "      ? createIdbLedger(options?.factory, locks)",
        "      ? createIdbLedger(options?.factory)",
      ),
  },
  {
    id: "MU-524",
    title:
      "R28 (revision 15): in a real engine an owned hold is judged by the clock like any other (the other page reclaims a hold whose owner is alive when its lease looks over)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28 \\(revision 15\\): a page that is still open keeps its hold",
    expect: /a page that is still open keeps its hold/,
    patch: (t) =>
      sub(
        t,
        "      hold.owned === true\n        ? proven?.has(token) === true\n        : !(",
        "      false\n        ? proven?.has(token) === true\n        : !(",
      ),
  },
  {
    id: "MU-525",
    title:
      "R28 (revision 15): in a real engine the proof of release is believed without asking the lock (a hold whose owner is alive is reclaimed)",
    file: "src/data/store/quota-ledger.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28 \\(revision 15\\): a page that is still open keeps its hold",
    expect: /a page that is still open keeps its hold/,
    patch: (t) =>
      sub(
        t,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the anchor is source text.
        "        return (await locks.probe(`${HOLD_LOCK_PREFIX}${token}`)) === true;",
        "        return true;",
      ),
  },
  {
    id: "MU-526",
    title:
      "R28 (revision 15): in a real engine a save that settles never gives up its Web Lock (the lock outlives the write for the life of the page)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28 \\(revision 15\\): a save that settles gives up its Web Lock",
    expect: /a save that settles gives up its Web Lock/,
    patch: (t) =>
      sub(t, "      held.claim?.release();\n    })();", "    })();"),
  },
  {
    id: "MU-546",
    title:
      "R28 (revision 16): in a real engine the maximum age revokes a reservation whose writer BEGAN (the unfinished commit loses its hold, its real Web Lock and its renewals at the production age)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "at the production maximum age a reservation whose writer BEGAN",
    expect: /whose writer BEGAN keeps its hold/,
    patch: (t) =>
      sub(
        t,
        "    if (!held.started && time() - held.born >= maxAgeMs) {",
        "    if (time() - held.born >= maxAgeMs) {",
      ),
  },
  {
    id: "MU-547",
    title:
      "R28 (revision 16): in a real engine a settlement the real ledger rejects twice is not offered again (the page lets go of its Web Lock after two tries, so the unpublished settlement is no longer the writer's to finish)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "settlement the REAL ledger rejects stays counted",
    expect: /settlement the REAL ledger rejects stays counted/,
    patch: (t) =>
      sub(
        t,
        "          if (attempt >= 2) {\n            if (waited >= leaseMs) break;\n",
        "          if (attempt >= 2) {\n            break;\n",
      ),
  },
  {
    id: "MU-548",
    title:
      "R28 (revision 16): in a real engine a hold reclaimed on proof (its owner's page destroyed) is deleted instead of landed (the bytes of a write that may have committed vanish from the account)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "the review's schedule in a real engine",
    expect: /the review's schedule in a real engine/,
    patch: (t) =>
      sub(
        t,
        "      landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
        "      if (hold.owned !== true)\n        landed = landHold(landed, token, hold, now, limits.ttlMs, figure);\n",
      ),
  },
  {
    id: "MU-577",
    title:
      "R28 (revision 17): in a real engine the landed entry is retired at its `until`, not one lifetime after it (the other page's cached reading from inside the debit's lifetime is spent after it: the review's first schedule)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "a reading taken inside page A's debit is not spent after it",
    expect: /a reading taken inside page A's debit is not spent after it/,
    patch: (t) =>
      sub(
        t,
        "    } else if (now >= reaches(landed) + limits.ttlMs) {",
        "    } else if (now >= landed.until) {",
      ),
  },
  {
    id: "MU-578",
    title:
      "R28 (revision 17): in a real engine no new reading of the estimate is asked for at the boundary (the other page judges on the reading that predates the debit that has run out)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "a reading taken inside page A's debit is not spent after it",
    expect: /a reading taken inside page A's debit is not spent after it/,
    patch: (t) => sub(t, "      now >= state.landed.until);", "      false);"),
  },
  {
    id: "MU-579",
    title:
      "R28 (revision 17): in a real engine an entry that ends further ahead than its lifetime allows is dropped (a step of the wall clock backwards deletes a fresh debit: the review's second schedule)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "a step of the wall clock BACKWARDS does not delete page A's fresh debit",
    expect:
      /a step of the wall clock BACKWARDS does not delete page A's fresh debit/,
    patch: (t) =>
      sub(
        t,
        "    } else if (landed.until - now > limits.ttlMs) {\n      landed = { ...landed, until: now + limits.ttlMs };\n      changed = true;\n      adjusted = true;\n    }",
        "    } else if (landed.until - now > limits.ttlMs) {\n      landed = null;\n      changed = true;\n    }",
      ),
  },
  {
    id: "MU-580",
    title:
      "R28 (revision 17): in a real engine the guard ignores the page's monotonic clock (a step of the wall clock forwards ends the debit)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "a step of the wall clock FORWARDS, found by a page that lived through it",
    expect:
      /a step of the wall clock FORWARDS, found by a page that lived through it/,
    patch: (t) =>
      sub(t, "    monotonic: options.monotonic,", "    monotonic: undefined,"),
  },
  {
    id: "MU-610",
    title:
      "R28b (revision 18): in a real engine every stamp is believed whatever the page's anchor says (a page whose guard is built after a step of the wall clock judges page A's debit by the age its stamp gives it: the review's schedule, the second save is admitted)",
    file: "src/data/engine/quota-guard.ts",
    spec: "tests/e2e/fixture.data-outbox.spec.ts",
    grep: "R28b \\(revision 18\\)",
    expect: /a step, (the new page first|every original page closed)/,
    patch: (t) =>
      sub(t, "    entry.until - limits.ttlMs < anchor;", "    false;"),
  },
  {
    id: "MU-611",
    title:
      "R33 (revision 18): in a real engine the claim of a writer generation CREATES a terminal row for a form that has none (a refused save leaves it behind, below the floor)",
    file: "src/data/plans/form-recovery.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "E-R3",
    expect:
      /(first save refused below the floor creates NO row|whole row is sized)/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  decide: ({ sync, reads: stored }) => {",
          "  decide: ({ sync, reads: stored, input }) => {",
        ),
        "      ...(stored === undefined\n        ? {}\n        : {",
        '      ...(stored === undefined\n        ? {\n            writes: [\n              w.put("form_recovery", {\n                form_context: input.formContext,\n                tab_instance_id: input.tabInstanceId,\n                fields: {},\n                redacted: [],\n                saved_at: input.now,\n                capture_seq: 0,\n                writer_gen: gen,\n                terminal: true,\n                content_digest: "",\n              }),\n            ],\n          }\n        : {',
      ),
  },
  {
    id: "MU-612",
    title:
      "R33 (revision 18): in a real engine the recovery estimate counts the values alone (a 900,000-character form context is saved in 500,000 bytes of room above the floor: the review's schedule)",
    file: "src/data/ports/form-recovery.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "E-R3",
    expect: /whole row is sized/,
    patch: (t) =>
      sub(
        t,
        "  return RECOVERY_ALLOWANCE_BYTES + UNIT_BYTES * (measured.length + keyed);",
        '  return RECOVERY_ALLOWANCE_BYTES + UNIT_BYTES * Object.values(row.fields).join("").length;',
      ),
  },
  {
    id: "MU-613",
    title:
      "R33 (revision 18): in a real engine a claim of a form with no row does not move the database's counter (two real page contexts get the same generation, and the earlier context's late save overwrites the later one's text)",
    file: "src/data/plans/form-recovery.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "E-R3",
    expect:
      /(first save refused below the floor creates NO row|two real page contexts claim)/,
    patch: (t) =>
      sub(
        t,
        "      sync: { ...sync, form_writer_gen: gen },",
        "      sync: stored === undefined ? sync : { ...sync, form_writer_gen: gen },",
      ),
  },
  {
    id: "MU-624",
    title:
      "R1 (revision 19): in a real engine a claim of an EXISTING row takes the stored generation + 1 and ignores the database's counter (revision 18's formula: three real page contexts, two of which claimed while the row was absent, give the later claimant the generation the earlier one holds, and the earlier one's late captures overwrite, erase or restore text)",
    file: "src/data/plans/form-recovery.ts",
    spec: "tests/e2e/fixture.data-wipe.spec.ts",
    grep: "mixed claims",
    expect:
      /(mixed claims \(the review's schedule, (save|discard)\)|mixed claims \(an older claimant's pending DISCARD\))/,
    patch: (t) =>
      sub(
        t,
        "    const gen = Math.max(counter, held) + 1;",
        "    const gen = (stored === undefined ? counter : held) + 1;",
      ),
  },
  {
    id: "MU-643",
    title:
      "R35 (revision 20): in a real engine disposal is not terminal (the runtime is never marked disposed: the open a provider's unmount left pending finishes into a live service, two connections and an epoch publication, the review's reproduction)",
    file: "src/data/engine/account-service.ts",
    spec: "tests/e2e/fixture.data-runtime-lifetime.spec.ts",
    grep: "E-L1",
    expect: /R35: .*(provider is unmounted)/,
    patch: (t) =>
      sub(
        t,
        "    this.disposed = true;\n    this.unsubscribe();",
        "    this.unsubscribe();",
      ),
  },
  {
    id: "MU-644",
    title:
      "R35 (revision 20): in a real engine a listing that was held while the provider was unmounted is let go into a native open (the page makes two open requests of the account's database for a runtime that has gone, and the runtime must close them)",
    file: "src/data/store/open.ts",
    spec: "tests/e2e/fixture.data-runtime-lifetime.spec.ts",
    grep: "E-L1",
    expect:
      /R35: the discovery of the databases is held, the provider is unmounted, then/,
    patch: (t) =>
      sub(
        t,
        "    const early = lapsed(false);\n",
        '    const early = closedSince() ? refuse("closed") : null;\n',
      ),
  },
  {
    id: "MU-645",
    title:
      "R35 (revision 20): in a real engine an abandoned native open is released with `registry.closeAll` (it closes the replacement provider's two connections through the page's shared registry and latches the account)",
    file: "src/data/store/open.ts",
    spec: "tests/e2e/fixture.data-runtime-lifetime.spec.ts",
    grep: "E-L1",
    expect:
      /R35: .*(a replacement is mounted before the hold is let go|provider is unmounted, then)/,
    patch: (t) =>
      sub(
        t,
        "      opened.store.close();\n      return over;\n",
        '      deps.registry.closeAll(account, { latch: "closed_for_identity" });\n      return over;\n',
      ),
  },
  {
    id: "MU-666",
    title:
      "R36 (revision 21): in a real engine the creating upgrade does not ask `permit` (a fact that changed in the turn the creating native request was made creates the database)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-closure.spec.ts",
    grep: "E-L2",
    expect:
      /R36: the page's facts change \(.*\) in the turn the creating native request is made/,
    patch: (t) =>
      sub(
        t,
        "          if (!mayCreate || (!finished && options.permit?.() === false)) {\n",
        "          if (!mayCreate) {\n",
      ),
  },
  {
    id: "MU-667",
    title:
      "R37 (revision 21): in a real engine a connection joins the page's registry only when the whole open is over (the old timing): a deletion queued after the first native request waits for ever, and a closure leaves the first connection open",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-closure.spec.ts",
    grep: "E-L3",
    expect:
      /R37: (the database is deleted in the turn the FIRST native open request is made|the account is closed on the page \(a latch from a wipe\) while the SECOND)/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "      adopt(strict);\n      if (lifetimeEnded()) throw endedByClosure();\n      const fast",
            "      if (lifetimeEnded()) throw endedByClosure();\n      const fast",
          ),
          "      if (fast !== strict) adopt(fast);\n      if (lifetimeEnded()) throw endedByClosure();\n",
          "      if (lifetimeEnded()) throw endedByClosure();\n",
        ),
        "      const store = new DexieAccountStore(",
        "      adopt(strict);\n      if (fast !== strict) adopt(fast);\n      const store = new DexieAccountStore(",
      ),
  },
  {
    id: "MU-668",
    title:
      "R37 (revision 21): in a real engine the opener never notices a closure (the second request, queued behind a deletion, is read as 'the database is absent' and the open answers absent)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-closure.spec.ts",
    grep: "E-L3",
    expect:
      /R37: the database is deleted in the turn the FIRST native open request is made/,
    patch: (t) =>
      sub(
        t,
        "      const lifetimeEnded = (): boolean =>\n        deps.registry.generation(account) !== born;\n",
        "      const lifetimeEnded = (): boolean => false;\n",
      ),
  },
  {
    id: "MU-669",
    title:
      "R37 (revision 21): in a real engine an open that a closure ended fails without letting go of its connections (the deletion stays blocked)",
    file: "src/data/store/dexie-adapter.ts",
    spec: "tests/e2e/fixture.data-open-closure.spec.ts",
    grep: "E-L3",
    expect:
      /R37: (the SECOND native open's completion is held|a newer build upgrades)/,
    patch: (t) =>
      sub(
        t,
        "      const endedByClosure = (): StoreFailure => {\n        release();\n",
        "      const endedByClosure = (): StoreFailure => {\n",
      ),
  },
  {
    id: "MU-670",
    title:
      "R36 (revision 21): in a real engine the predicate is not read again after the listing made under the wipe's lock (a native creating request is made for a page that has already changed; only the upgrade stops it)",
    file: "src/data/store/open.ts",
    spec: "tests/e2e/fixture.data-open-closure.spec.ts",
    grep: "E-L2",
    expect:
      /R36: the listing made under the wipe's lock is held, then the page's facts change/,
    patch: (t) =>
      sub(
        t,
        "    const beforeCreating = lapsed(true);\n    if (beforeCreating !== null) return beforeCreating;\n",
        "",
      ),
  },
  {
    id: "MU-696",
    title:
      "R39 (revision 22): (REAL ENGINE) `planEnqueue` stores the object `build` returned: a caller's edit between the header's native put and the body's reaches the body (enqueue and supersede)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-write-snapshot.spec.ts",
    grep: "E-S1",
    expect: /R39: (enqueue|supersede), build returns/,
    patch: (t) =>
      sub(
        t,
        "    built = buildSnapshot(request, resolved.bases);",
        "    built = request.build(resolved.bases);",
      ),
  },
  {
    id: "MU-697",
    title:
      "R39 (revision 22): (REAL ENGINE) `planEdit` stores the object `build` returned: the same edit reaches the body of an edit",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-write-snapshot.spec.ts",
    grep: "E-S1",
    expect: /R39: edit, build returns/,
    patch: (t) =>
      sub(
        t,
        "    built = buildSnapshot(request, draft.bases);",
        "    built = request.build(draft.bases);",
      ),
  },
  {
    id: "MU-698",
    title:
      "R39 (revision 22): (REAL ENGINE) `snapshotRequest` hands the caller's own request on: an endpoint edited while the reservation is awaited is the one stored",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-write-snapshot.spec.ts",
    grep: "E-S1",
    expect:
      /R39: (enqueue|edit|supersede), the request is edited while the quota reservation is awaited/,
    patch: (t) =>
      sub(
        t,
        "  const build = request.build;\n  return {\n    endpoint: request.endpoint,",
        "  const build = request.build;\n  if (build) return request;\n  return {\n    endpoint: request.endpoint,",
      ),
  },
  {
    id: "MU-699",
    title:
      "R39 (revision 22): (REAL ENGINE) the snapshot is shallow: the root is copied and a nested value stays the caller's, so a later edit of it reaches the stored body",
    file: "src/data/model/snapshot.ts",
    spec: "tests/e2e/fixture.data-write-snapshot.spec.ts",
    grep: "E-S1",
    expect: /R39: (enqueue|edit|supersede), build returns/,
    patch: (t) =>
      sub(
        t,
        "    if (item === null || item === undefined) return item;\n",
        "    if (item === null || item === undefined || depth > 0) return item;\n",
      ),
  },
  {
    id: "MU-716",
    title:
      "R42 (revision 23): (REAL ENGINE) the crash-loop marker of an attempt that landed nothing is never retired: a safely dropped large page is read by the next capture as a tab that did not survive",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-marker.spec.ts",
    grep: "E-M1",
    expect:
      /(safe drops count nothing|a later page of the origin, after the drops|an ownership mismatch drops a large page)/,
    patch: (t) =>
      sub(
        t,
        "        if (attempt !== null && !written) await retireAttempt(service, attempt);",
        "        if (attempt !== null && !written && (false as boolean))\n          await retireAttempt(service, attempt);",
      ),
  },
  {
    id: "MU-717",
    title:
      "R42 (revision 23): (REAL ENGINE) a marker found at the next capture is not counted (the control: a genuine crash, a page closed with its commit in flight, goes undetected)",
    file: "src/data/plans/sync-writers.ts",
    spec: "tests/e2e/fixture.data-marker.spec.ts",
    grep: "E-M1",
    expect:
      /(the next page of the origin finds the marker in the real database|a crash at the lowest rung counts toward the floor)/,
    patch: (t) =>
      sub(
        t,
        "    if (sizing.attempt !== null) {\n      if (sizing.attempt.id === input.endedAttempt) {",
        "    if (sizing.attempt !== null && (false as boolean)) {\n      if (sizing.attempt.id === input.endedAttempt) {",
      ),
  },
  {
    id: "MU-732",
    title:
      "R44 (revision 24): (REAL ENGINE) the engine does not handle the scan's allocation failure: it reaches the loop's own stop as `local_storage`, with no smaller request and no floor count",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-allocation.spec.ts",
    grep: "offsets\\.initial \\(3 changes\\): 4 -> 2|offsets\\.growth \\(520 changes\\): 4 -> 2",
    expect: /(offsets\.initial \(3 changes\)|offsets\.growth \(520 changes\))/,
    patch: (t) =>
      sub(
        t,
        '      // in a step, and reaches the loop\'s stop.\n      if (isAllocationError(error))\n        return sizingFailure(id, service, { kind: "allocation_failed" });\n      throw error;',
        "      // in a step, and reaches the loop's stop.\n      throw error;",
      ),
  },
  {
    id: "MU-733",
    title:
      "R44 (revision 24): (REAL ENGINE) an allocation failure while decoding or parsing an element inside the commit is reported as `not_decodable` (invalid data), so the valid page is asked for again at the same size",
    file: "src/data/scan/validate.ts",
    spec: "tests/e2e/fixture.data-allocation.spec.ts",
    grep: "change\\.decode \\(3 changes\\): 4 -> 2|change\\.parse \\(40 changes",
    expect: /change\.(decode|parse) \((3|40) changes/,
    patch: (t) =>
      sub(
        t,
        "    if (isAllocationError(error)) throw error;\n    // Invalid UTF-8 inside a string",
        "    // Invalid UTF-8 inside a string",
      ),
  },
  {
    id: "MU-734",
    title:
      "R44 (revision 24): (REAL ENGINE) the scan reads an allocation failure while decoding a key or the cursor as invalid text (the page is malformed), not as the device's signal",
    file: "src/data/scan/scan.ts",
    spec: "tests/e2e/fixture.data-allocation.spec.ts",
    grep: "key\\.decode \\(3 changes\\): 4 -> 2|cursor\\.parse \\(3 changes\\): 4 -> 2",
    expect: /(key\.decode|cursor\.parse) \(3 changes\)/,
    patch: (t) =>
      sub(
        t,
        '      if (isAllocationError(error)) throw error;\n      return fail("syntax", "invalid text");',
        '      return fail("syntax", "invalid text");',
      ),
  },
  {
    id: "MU-735",
    title:
      "R44 (revision 24): (REAL ENGINE) EVERY thrown Error is an allocation failure (a fault of the data steps the ladder down, instead of counting as an unrecognised answer)",
    file: "src/data/model/sizing.ts",
    spec: "tests/e2e/fixture.data-allocation.spec.ts",
    grep: "control: a (syntax fault at change\\.parse|utf8 fault at key\\.decode)",
    expect:
      /control: a (syntax fault at change\.parse|utf8 fault at key\.decode)/,
    patch: (t) =>
      sub(t, "  error instanceof RangeError;", "  error instanceof Error;"),
  },
  {
    id: "MU-751",
    title:
      "R45 (revision 25): (REAL ENGINE) the replacement always keeps the old draft's place, whatever it waits for",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: (retarget-occupied|add-side-effect) after (conflict|operation_conflict|defaults_changed)",
    expect: /(retarget-occupied|add-side-effect) after/,
    patch: (t) =>
      sub(
        t,
        "    created_seq: newerDependency ? planned.draft.created_seq : old.created_seq,",
        "    created_seq: old.created_seq,",
      ),
  },
  {
    id: "MU-752",
    title:
      "R45 (revision 25): (REAL ENGINE) a newer dependency with a dependant of the old draft behind the replacement is admitted",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: (conflict|operation_conflict|defaults_changed): a newer draft and a dependant behind the replacement",
    expect: /a newer draft and a dependant behind the replacement/,
    patch: (t) =>
      sub(
        t,
        '  if (newerDependency && standing.length > 0)\n    return { kind: "refused", reason: "order_conflict" };',
        '  if (newerDependency && standing.length > 0 && (false as boolean))\n    return { kind: "refused", reason: "order_conflict" };',
      ),
  },
  {
    id: "MU-753",
    title:
      "R45 (revision 25): (REAL ENGINE) the plan does not write the counter of a replacement that took the end of the queue",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: (retarget-occupied|add-side-effect) after operation_conflict",
    expect: /(retarget-occupied|add-side-effect) after operation_conflict/,
    patch: (t) =>
      sub(
        t,
        "    const written = cleared ?? (decision.sync === undefined ? undefined : base);",
        "    const written = cleared;",
      ),
  },
  {
    id: "MU-754",
    title:
      "R45 (revision 25): (REAL ENGINE) the plan does not read the drafts named by the request's explicit dependencies",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: an explicit dependency on a dependant of the old draft is a cycle",
    expect: /an explicit dependency on a dependant of the old draft is a cycle/,
    patch: (t) =>
      sub(
        t,
        'bulkGetWindowed(reader, "drafts", named)',
        'bulkGetWindowed(reader, "drafts", [])',
      ),
  },
  {
    id: "MU-755",
    title:
      "R45 (revision 25): (REAL ENGINE) a dependant that stays queued is not counted in the version record after a supersession",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: a dependant that stays queued keeps the record",
    expect: /a dependant that stays queued keeps the record/,
    patch: (t) =>
      sub(
        t,
        "  if (!pause)\n    for (const member of standing)",
        "  if (false as boolean)\n    for (const member of standing)",
      ),
  },
  {
    id: "MU-756",
    title:
      "R45 (revision 25): (REAL ENGINE) a dropped side effect pauses nothing (the dependant is sent on a version that will never exist)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: a dropped side effect pauses the dependant",
    expect: /a dropped side effect pauses the dependant/,
    patch: (t) =>
      sub(
        t,
        "  const changed = old.bumped.some(\n    (id) => leaves(old, id) !== leaves(replacement, id),\n  );",
        "  const changed = old.bumped.some(\n    (id) =>\n      old.bases[id] !== undefined &&\n      replacement.bases[id] !== undefined &&\n      old.bases[id] !== replacement.bases[id],\n  );",
      ),
  },
  {
    id: "MU-757",
    title:
      "R45 (revision 25): (REAL ENGINE) a target the replacement raises where the old draft did not, and a dependant touches, is admitted",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: a target the replacement raises where the old draft did not",
    expect: /a target the replacement raises where the old draft did not/,
    patch: (t) =>
      sub(
        t,
        "    standing.some((member) =>\n      [...member.index_targets, ...member.bumped].some(raisedAhead),",
        "    (false as boolean) &&\n    standing.some((member) =>\n      [...member.index_targets, ...member.bumped].some(raisedAhead),",
      ),
  },
  {
    id: "MU-758",
    title:
      "R45 (revision 25): (REAL ENGINE) a cycle through an explicit dependency is detected by neither layer: the named dependency's row is not looked at, and the old draft's dependants are not checked (each alone is covered by the other: a dependant of the old draft is always a newer dependency with a dependant behind it, so MU-738 and MU-740 are each invisible to the real plans; the pure tests defeat the other layer)",
    file: "src/data/model/outbox.ts",
    spec: "tests/e2e/fixture.data-supersede.spec.ts",
    grep: "R45: an explicit dependency on a dependant of the old draft is a cycle",
    expect: /an explicit dependency on a dependant of the old draft is a cycle/,
    patch: (t) =>
      sub(
        sub(
          t,
          '  if (dependsOn.some((id) => standingIds.has(id)))\n    return { kind: "refused", reason: "order_conflict" };',
          '  if ((false as boolean) && dependsOn.some((id) => standingIds.has(id)))\n    return { kind: "refused", reason: "order_conflict" };',
        ),
        "  for (const row of [...facts.others, ...(facts.extras ?? [])])",
        "  for (const row of [...facts.others])",
      ),
  },
  {
    id: "MU-809",
    title:
      "R46 (revision 26): (REAL ENGINE) a save that lands does not end its own failure streak in the transaction that writes it (a reload loses the page's memory of the failure, and the count stands: the draft is not sent)",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: enqueue, streak",
    expect: /R46: enqueue, streak/,
    patch: (t) =>
      sub(
        t,
        "      sync: withoutStreaks(planned.sync, ended) ?? planned.sync,",
        "      sync: planned.sync,",
      ),
  },
  {
    id: "MU-810",
    title:
      "R46 (revision 26): (REAL ENGINE) a discard that lands does not end the failure streaks of the draft it removed",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: discard, streak",
    expect: /R46: discard, streak/,
    patch: (t) =>
      sub(
        t,
        "      sync === undefined\n        ? undefined\n        : withoutStreaks(sync, draftOperations(input.localId));",
        "      undefined as SyncStateRow | undefined;",
      ),
  },
  {
    id: "MU-811",
    title:
      "R46 (revision 26): (REAL ENGINE) a supersession that lands does not end the replacement's own failure streak",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: supersede, streak",
    expect: /R46: supersede, streak/,
    patch: (t) =>
      sub(
        t,
        `    const ended = [\n      \`draft:\${input.localId}\`,\n      ...draftOperations(input.oldLocalId),\n    ];`,
        "    const ended = [...draftOperations(input.oldLocalId)];",
      ),
  },
  {
    id: "MU-812",
    title:
      "R46 (revision 26): (REAL ENGINE) a success does not remove the operation's fallback marker from the page's localStorage",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: (enqueue|editQueued|supersede|discard), marker",
    expect: /R46: (enqueue|editQueued|supersede|discard), marker/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(undefined, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-813",
    title:
      'R47 (revision 26): (REAL ENGINE) "Try again" for one draft takes the shared warning down at once, whatever else is stopped',
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R47: A is stopped by",
    expect: /R47: A is stopped by/,
    patch: (t) =>
      sub(
        t,
        "      if (everKnown && [...standing].every(covers)) {",
        "      if (everKnown) {",
      ),
  },
  {
    id: "MU-814",
    title:
      "R46 (revision 26): (REAL ENGINE) a read of the queue that lands does not end the failure count (three isolated aborts are three in a row)",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: three isolated aborts of the queue read",
    expect: /three isolated aborts of the queue read/,
    patch: (t) =>
      sub(
        t,
        "      window.queueFailures > 0 ||\n      failedOperations.has(QUEUE_OPERATION) ||\n      queueStopped(service)\n    )",
        "      (false as boolean)\n    )",
      ),
  },
  {
    id: "MU-815",
    title:
      "R46 (revision 26): (REAL ENGINE) a claim that lands does not end the failure streak of the claim (a count left by an earlier page stands)",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: a claim that lands ends the failures of the claim",
    expect: /a claim that lands ends the failures of the claim/,
    patch: (t) =>
      sub(
        t,
        `    const cleared = withoutStreaks(sync, [\`draft:\${draft.local_id}\`]);`,
        `    const cleared = (false as boolean) ? withoutStreaks(sync, [\`draft:\${draft.local_id}\`]) : undefined;`,
      ),
  },
  {
    id: "MU-816",
    title:
      "R47 (revision 26): (REAL ENGINE) after a success the warning is not looked at again from the records (it stays up)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "R46: (enqueue|editQueued), (streak|marker)",
    expect: /R46: (enqueue|editQueued), (streak|marker)/,
    patch: (t) =>
      sub(
        t,
        "    if (warned || unsure) await look();",
        "    if ((false as boolean) && (warned || unsure)) await look();",
      ),
  },
  {
    id: "MU-817",
    title:
      "R47 (revision 26): (REAL ENGINE) a page that starts does not read the account's fallback markers when it looks at what is stopped (a marker-only stop is not shown again after a reload)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-local-recovery.spec.ts",
    grep: "after a reload",
    expect: /after a reload/,
    patch: (t) =>
      sub(
        t,
        "    const markers = markedDrafts();",
        "    const markers: string[] = [];",
      ),
  },
  {
    id: "MU-860",
    title:
      "R46 (revision 27): (REAL ENGINE) an ordinary wake of the dispatcher does not honour a stop the facade holds in the page's memory (it sends the saved draft)",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "a memory stop of the facade's",
    expect: /a memory stop of the facade's/,
    patch: (t) =>
      sub(
        t,
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...stops.operations(service),\n  ];",
        "    ...(deps.markers?.inspect(service).operations ?? []),\n    ...([] as string[]),\n  ];",
      ),
  },
  {
    id: "MU-861",
    title:
      "R46 (revision 27): (REAL ENGINE) the facade's success does not end the page's memory of the dispatcher's stop (the dispatcher stays stopped)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "the dispatcher's memory stop of a draft ends on the facade's",
    expect: /the dispatcher's memory stop of a draft ends on the facade's/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(deps.markers, createLocalStops(), issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-862",
    title:
      "R47 (revision 27): (REAL ENGINE) a look that could not read the record forgets the stops this page knew of",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "R47: B's durable stop outlasts unreadable",
    expect: /R47: B's durable stop outlasts unreadable/,
    patch: (t) =>
      sub(
        t,
        "    standing = known\n      ? new Set(operations)\n      : new Set([...standing, ...operations]);",
        "    standing = new Set(operations);",
      ),
  },
  {
    id: "MU-863",
    title:
      "R47 (revision 27): (REAL ENGINE) a look does not count the stops the page holds in memory (the facade does not show the dispatcher's memory-only stop)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "the dispatcher's memory stop of a draft ends on the facade's",
    expect: /the dispatcher's memory stop of a draft ends on the facade's/,
    patch: (t) =>
      sub(
        t,
        "    const found = new Set<string>([...markers.operations, ...memoryDrafts()]);",
        "    const found = new Set<string>([...markers.operations]);",
      ),
  },
  {
    id: "MU-864",
    title:
      "R47 (revision 27): (REAL ENGINE) the dispatcher does not tell the facade that a stop reached its bound in the record (the warning is not raised)",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "the dispatcher's streak stop of a draft ends on the facade's",
    expect: /the dispatcher's streak stop of a draft ends on the facade's/,
    patch: (t) =>
      sub(
        t,
        "      if (result.stop) {\n        stops.announce(service, self, { recorded: [operation] });\n        stopsChanged(service);\n        return stall(id, service, operation);\n      }",
        "      if (result.stop) {\n        stopsChanged(service);\n        return stall(id, service, operation);\n      }",
      ),
  },
  {
    id: "MU-865",
    title:
      "R47 (revision 27): (REAL ENGINE) the dispatcher does not tell the facade about a stop it recorded in a marker or its memory",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "the dispatcher's (marker|memory) stop of a draft ends on the facade's",
    expect:
      /the dispatcher's (marker|memory) stop of a draft ends on the facade's/,
    patch: (t) =>
      sub(
        t,
        "      stops.announce(service, self, { recorded: [operation] });\n      return stall(id, service, operation);\n    }\n    if (!alive(id))",
        "      return stall(id, service, operation);\n    }\n    if (!alive(id))",
      ),
  },
  {
    id: "MU-866",
    title:
      "R46 (revision 27): (REAL ENGINE) a facade does not hold in the page's memory a stop it could record nowhere else",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "a memory stop of the facade's",
    expect: /a memory stop of the facade's/,
    patch: (t) =>
      sub(
        t,
        "          hold: () => {\n            stops.hold(service, operation);\n          },",
        "          hold: () => () => undefined,",
      ),
  },
  {
    id: "MU-867",
    title:
      "R46 (revision 27): (REAL ENGINE) the markers hand every writer a record of its own (the page's memory of a stop is not shared)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-cross-writer.spec.ts",
    grep: "memory stop of",
    expect: /memory stop of/,
    patch: (t) =>
      sub(
        t,
        "  return {\n    stops,\n    set(scope, operation, live) {",
        "  return {\n    get stops() {\n      return createLocalStops();\n    },\n    set(scope, operation, live) {",
      ),
  },
  {
    id: "MU-868",
    title:
      "R15 (revision 27): (REAL ENGINE) a marker another page sets or removes makes the facade look at the record whatever operation it names (a page's or an unrelated operation's marker costs a read of the facts)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "this account's marker for (another position|an unrelated operation)",
    expect:
      /this account's marker for (another position|an unrelated operation)/,
    patch: (t) =>
      sub(
        t,
        "      if (signatureOf(markedDrafts()) === expected) return;\n",
        "",
      ),
  },
  {
    id: "MU-901",
    title:
      "R46 (revision 28): (REAL ENGINE) the claim does not consult the durable record (the count is cleared by the claim that the stop should have refused)",
    file: "src/data/plans/outbox.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R46: streak: recorded while the queue read is held",
    expect: /R46: streak: recorded while the queue read is held/,
    patch: (t) =>
      sub(
        t,
        "      draftStopped(sync.local_write_streaks, draft.local_id) ||\n      input.heldOutside?.(draft.local_id) === true\n",
        "      input.heldOutside?.(draft.local_id) === true\n",
      ),
  },
  {
    id: "MU-902",
    title:
      "R46 (revision 28): (REAL ENGINE) neither the claim nor the step that issues the request asks for the marker or the page's memory (the draft is sent through a stop recorded after the queue read)",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R46: (marker|memory): recorded while the queue read is held",
    expect: /R46: (marker|memory): recorded while the queue read is held/,
    patch: (t) =>
      sub(
        sub(t, "      heldOutside: () => heldOutside(service, pick),\n", ""),
        "    if (heldOutside(service, pick) || announcedSince(pick.local_id)) {",
        "    if (false as boolean) {",
      ),
  },
  {
    id: "MU-903",
    title:
      "R47 (revision 28): (REAL ENGINE) a failed enumeration of `localStorage` reports no marker (the facade hides the warning and the dispatcher sends the stopped draft)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47: marker, (directory|getItem) unreadable",
    expect: /R47: marker, (directory|getItem) unreadable/,
    patch: (t) =>
      sub(
        t,
        /(for \(const instance of instances\)\n\s+established\.add\(id, operation, instance\);\n\s+return \{\n\s+)operations: established\s*\.operations\(id\)[\s\S]*?known: false,/,
        "$1operations: [],\n        known: false,",
      ),
  },
  {
    id: "MU-904",
    title:
      "R47 (revision 28): (REAL ENGINE) the facade's look is complete whenever the database could be read (an unreadable marker enumeration replaces the warning)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47: marker, (directory|getItem) unreadable",
    expect: /R47: marker, (directory|getItem) unreadable/,
    patch: (t) =>
      sub(t, "    let known = markers.known;", "    let known = true;"),
  },
  {
    id: "MU-905",
    title:
      "R47 (revision 28): (REAL ENGINE) a marker this page established is forgotten when its individual read fails (the follower's gate opens for an invalid cache)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "revision 28, R47",
    expect:
      /(enumeration|both) unreadable: the follower that read the marker stays hidden/,
    patch: (t) =>
      sub(
        t,
        '    return instances.length === 0\n      ? { kind: "unread" }\n      : { kind: "instance", instances };\n  };\n  /**\n   * The removals this page owes',
        '    return { kind: "unread" };\n  };\n  /**\n   * The removals this page owes',
      ),
  },
  {
    id: "MU-942",
    title:
      "R47 (revision 29): (REAL ENGINE) admission takes a marker it could not read for no marker (a reloaded page sends the stopped draft)",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47 cold: (marker, both unreadable: the fresh page|both unreadable and NO marker)",
    expect:
      /R47 cold: (marker, both unreadable: the fresh page|both unreadable and NO marker)/,
    patch: (t) =>
      sub(
        t,
        '      if (state === "unknown" && (inFlight || operation === operations[0]))\n        unknown = true;',
        "      if (false as boolean) unknown = true;",
      ),
  },
  {
    id: "MU-944",
    title:
      "R47 (revision 29): (REAL ENGINE) the drafts held for an unreadable marker are not asked about again on the rescan",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47 cold: both unreadable and NO marker",
    expect: /R47 cold: both unreadable and NO marker/,
    patch: (t) =>
      sub(
        t,
        "      if (window.blocked > 0 || unreadable.size > 0) {",
        "      if (window.blocked > 0) {",
      ),
  },
  {
    id: "MU-946",
    title:
      "R47 (revision 29): (REAL ENGINE) the capture gate asks the markers' enumeration, which answers `[]` when it throws (a request goes out through a stop)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-cold-sync.spec.ts",
    grep: "R47 sync: (capture|retry-state|sizing|page|invalidate): the directories unreadable",
    expect:
      /R47 sync: (capture|retry-state|sizing|page|invalidate): the directories unreadable/,
    patch: (t) =>
      sub(
        t,
        '        const seen = deps.markers?.witness(service, operation);\n        if (seen === undefined) return "unmarked";\n        saw.set(operation, seen);\n        return markerStateOf(seen);',
        '        return deps.markers?.operations(service).includes(operation)\n          ? "marked"\n          : "unmarked";',
      ),
  },
  {
    id: "MU-947",
    title:
      "R47 (revision 29): (REAL ENGINE) the capture gate does not stop for a record it cannot read (a request goes out when nothing can be read)",
    file: "src/data/plans/sync-writers.ts",
    spec: "tests/e2e/fixture.data-cold-sync.spec.ts",
    grep: "R47 sync: (page|invalidate): both unreadable",
    expect: /R47 sync: (page|invalidate): both unreadable/,
    patch: (t) =>
      sub(
        t,
        '      if (unreadableOperations.length > 0) return "unreadable";\n',
        "",
      ),
  },
  {
    id: "MU-948",
    title:
      "R47 (revision 29): (REAL ENGINE) the unreadable gate waits for an event, not for a pace (the sync does not resume when the store can be read)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-cold-sync.spec.ts",
    grep: "R47 sync: both unreadable and NO marker",
    expect: /R47 sync: both unreadable and NO marker/,
    patch: (t) =>
      sub(
        t,
        '        unreadableRun += 1;\n        return { when: "after", ms: wait };',
        '        unreadableRun += 1;\n        void wait;\n        return { when: "event" };',
      ),
  },
  {
    id: "MU-949",
    title:
      "R47 (revision 29): (REAL ENGINE) a store whose access threw is taken for an empty one (the gate opens for an invalid cache)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R47 getter: (marker|control)",
    expect: /R47 getter: (marker|control)/,
    patch: (t) =>
      sub(
        t,
        '    return { kind: "blocked" };\n  }\n}',
        '    return { kind: "none" };\n  }\n}',
      ),
  },
  {
    id: "MU-950",
    title:
      "R47 (revision 29): (REAL ENGINE) a refusal is kept for good (the gate never finds the marker when access returns)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R47 getter: (marker|control)",
    expect: /R47 getter: (marker|control)/,
    patch: (t) =>
      sub(
        t,
        '    if (kept !== undefined) return { kind: "store", storage: kept };\n    const found = obtainStorage();',
        '    if (kept !== undefined) return { kind: "store", storage: kept };\n    if (refused) return { kind: "blocked" };\n    const found = obtainStorage();',
      ),
  },
  {
    id: "MU-951",
    title:
      "R47 (revision 29): (REAL ENGINE) the controller does not look again at an unreadable marker (the cache stays hidden when the store can be read)",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R47 getter: (marker|control)",
    expect: /R47 getter: (marker|control)/,
    patch: (t) => sub(t, "    lookAtMarker();\n  };", "  };"),
  },
  {
    id: "MU-956",
    title:
      "R47 (revision 30, re-anchored in revision 34 on the incomplete-read branch of `see`): (REAL ENGINE) a removal that returned is kept as evidence that the key is gone (the gate opens over a newer invalidation marker)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R47 genuine supersession",
    expect: /R47 genuine supersession: .*a NEW marker/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const stops = createLocalStops();\n  // A name for each failure this page records",
            "  const removedOnce = new Set<string>();\n  const stops = createLocalStops();\n  // A name for each failure this page records",
          ),
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : { kind: "unread" };\n    }\n    learn(',
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : removedOnce.has(scopeId(scope) + "\\u0000" + operation)\n          ? { kind: "none" }\n          : { kind: "unread" };\n    }\n    learn(',
        ),
        "    written.remove(scopeId(scope), operation, instance);\n  };",
        '    written.remove(scopeId(scope), operation, instance);\n    removedOnce.add(scopeId(scope) + "\\u0000" + operation);\n  };',
      ),
  },
  {
    id: "MU-957",
    title:
      "R47 (revision 30, re-anchored in revision 34 on the incomplete-read branch of `see`): (REAL ENGINE) a removal that returned is kept as evidence that the key is gone (a draft is sent through a newer stop)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47 newer stop",
    expect: /R47 newer stop/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const stops = createLocalStops();\n  // A name for each failure this page records",
            "  const removedOnce = new Set<string>();\n  const stops = createLocalStops();\n  // A name for each failure this page records",
          ),
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : { kind: "unread" };\n    }\n    learn(',
          '      return known.kind === "instance"\n        ? { kind: "instance", instances: known.instances }\n        : removedOnce.has(scopeId(scope) + "\\u0000" + operation)\n          ? { kind: "none" }\n          : { kind: "unread" };\n    }\n    learn(',
        ),
        "    written.remove(scopeId(scope), operation, instance);\n  };",
        '    written.remove(scopeId(scope), operation, instance);\n    removedOnce.add(scopeId(scope) + "\\u0000" + operation);\n  };',
      ),
  },
  {
    id: "MU-958",
    title:
      "R47 (revision 30): (REAL ENGINE) the dispatcher keeps a memory of the person's retry and treats an unreadable marker as free for it",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R47 newer stop: the dispatcher's own retry",
    expect: /R47 newer stop: the dispatcher's own retry/,
    patch: (t) =>
      sub(
        sub(
          sub(
            t,
            "  const unreadable = new Map<LocalId, boolean>();",
            "  const unreadable = new Map<LocalId, boolean>();\n  const recovered = new Set<string>();",
          ),
          "    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
          "    recovered.add(operation);\n    retireStops(deps.markers, stops, issued.seen, {\n      operations: [operation],\n      explicit: options.explicit === true,\n    });",
        ),
        '      const state = deps.markers?.probe(service, operation);\n      if (state === "marked") return "held";',
        '      const probed = deps.markers?.probe(service, operation);\n      const state =\n        probed === "unknown" && recovered.has(operation) ? "unmarked" : probed;\n      if (state === "marked") return "held";',
      ),
  },
  {
    id: "MU-989",
    title:
      "R50 (revision 31): (REAL ENGINE) the facade's success takes its witness when its result is delivered (a newer stop recorded meanwhile, by the page or by another, is ended)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R50: ",
    expect: /R50: (marker|memory|ANOTHER page's stop).*delivered late/,
    patch: (t) =>
      sub(
        t,
        "    retireStops(deps.markers, stops, issued.seen, {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
        "    retireStops(deps.markers, stops, witnessStops(deps.markers, stops, service, operations), {\n      operations: operations.filter((o) => !abandoned.includes(o)),\n    });",
      ),
  },
  {
    id: "MU-990",
    title:
      "R52 (revision 32): (REAL ENGINE) every page names its failures from the same page part (another page's newer failure of an operation has the key of the one the older write saw)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R50: a stop that stood when the older write was issued",
    expect: /R50: a stop that stood when the older write was issued/,
    patch: (t) =>
      sub(
        t,
        "function randomPart(): string {",
        'function randomPart(): string {\n  if (!Number.isNaN(0)) return "fixed";',
      ),
  },
  {
    id: "MU-991",
    title:
      "R51 (revision 31): (REAL ENGINE) the engine's page success removes whatever invalidation marker stands at the position (the old unconditional retirement)",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R51 older completion",
    expect: /R51 older completion: delayed-marker/,
    patch: (t) =>
      sub(
        t,
        '    deps.markers?.retire(\n      service,\n      operation,\n      saw.get(operation) ?? { kind: "none" },\n    );',
        "    deps.markers?.clear(service, operation);",
      ),
  },
  {
    id: "MU-992",
    title:
      "R51 (revision 31): (REAL ENGINE) the engine's page success takes its witness when its completion is delivered, not when the gate admitted the request",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-gate.spec.ts",
    grep: "R51 older completion",
    expect: /R51 older completion: delayed-marker/,
    patch: (t) =>
      sub(
        t,
        '    deps.markers?.retire(\n      service,\n      operation,\n      saw.get(operation) ?? { kind: "none" },\n    );',
        "    deps.markers?.retire(\n      service,\n      operation,\n      deps.markers.witness(service, operation),\n    );",
      ),
  },
  {
    id: "MU-993",
    title:
      "R52 (revision 32): (REAL ENGINE) a marker's retirement removes every failure of the operation that a listing finds, whatever instance the write saw",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-claim-admission.spec.ts",
    grep: "R50: a stop that stood when the older write was issued",
    expect: /R50: a stop that stood when the older write was issued/,
    patch: (t) =>
      sub(
        t,
        "      for (const instance of seen.instances) {",
        '      const everything =\n        found.kind === "store"\n          ? (standing(found.storage, scope)?.found ?? [])\n              .filter((entry) => entry.operation === operation)\n              .map((entry) => entry.instance)\n          : seen.instances;\n      for (const instance of [...new Set([...seen.instances, ...everything])]) {',
      ),
  },
  {
    id: "MU-1007",
    title:
      "R52 (revision 32): (REAL ENGINE) an owed removal reaches every failure of the operation that a listing finds, a newer one another real page recorded included",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-exact-keys.spec.ts",
    grep: "R52: owed",
    expect: /R52: owed/,
    patch: (t) =>
      sub(
        t,
        "      if (remove(storage, scope, due.operation, due.instance)) {",
        "      for (const entry of listed.filter((e) => e.operation === due.operation))\n        remove(storage, scope, due.operation, entry.instance);\n      listed.splice(0, listed.length, ...listed.filter((e) => e.operation !== due.operation));\n      if (false as boolean) {",
      ),
  },

  {
    id: "MU-1008",
    title:
      "R52 (revision 32): (REAL ENGINE) a marker's retirement removes every failure of the operation that a listing finds (a newer failure of another real page is removed)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-exact-keys.spec.ts",
    grep: "R52: retire:",
    expect: /R52: retire:/,
    patch: (t) =>
      sub(
        t,
        "      for (const instance of seen.instances) {",
        '      const everything =\n        found.kind === "store"\n          ? (standing(found.storage, scope)?.found ?? [])\n              .filter((entry) => entry.operation === operation)\n              .map((entry) => entry.instance)\n          : seen.instances;\n      for (const instance of [...new Set([...seen.instances, ...everything])]) {',
      ),
  },

  {
    id: "MU-1009",
    title:
      "R53 (revision 32): (REAL ENGINE) a reset of the durable failure state does not compare the version it was decided on (a delayed retry ends three newer failures)",
    file: "src/data/model/retry.ts",
    spec: "tests/e2e/fixture.data-exact-keys.spec.ts",
    grep: "E-O11 \\(revision 32, R53\\)",
    expect: /R53: draft b durable, newer failure=true/,
    patch: (t) =>
      sub(
        t,
        "  if (version !== expect) return { patch: null, cleared: false, version };\n",
        "",
      ),
  },

  {
    id: "MU-1010",
    title:
      "R53 (revision 32): (REAL ENGINE) the facade's retry resets a streak on the version it sees when the reset runs, not the one it saw when the person asked",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-exact-keys.spec.ts",
    grep: "E-O11 \\(revision 32, R53\\)",
    expect: /R53: draft b durable, newer failure=true/,
    patch: (t) =>
      sub(
        t,
        "          expect: issued.durable.get(operation) ?? null,",
        "          expect: observed.get(operation) ?? null,",
      ),
  },

  {
    id: "MU-1011",
    title:
      "R53 (revision 32): (REAL ENGINE) the retry's marker removal reaches every failure of the operation, a newer marker another real page recorded included",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-exact-keys.spec.ts",
    grep: "E-O11 \\(revision 32, R53\\)",
    expect: /R53: draft b marker-(readable|unreadable), newer failure=true/,
    patch: (t) =>
      sub(
        t,
        "      for (const instance of seen.instances) {",
        '      const everything =\n        found.kind === "store"\n          ? (standing(found.storage, scope)?.found ?? [])\n              .filter((entry) => entry.operation === operation)\n              .map((entry) => entry.instance)\n          : seen.instances;\n      for (const instance of [...new Set([...seen.instances, ...everything])]) {',
      ),
  },
  {
    id: "MU-1032",
    title:
      "R56 (revision 33): (REAL ENGINE) the facade records the stop of a failed counter after its service was closed and its database deleted (the old rejection writes into the page's real localStorage)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-lifetime.spec.ts",
    grep: "R56 facade",
    expect: /R56 facade: the service closed and the database deleted/,
    patch: (t) =>
      sub(
        t,
        "        () => service.live,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
        "        () => true,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
      ),
  },
  {
    id: "MU-1033",
    title:
      "R56 (revision 33): (REAL ENGINE) the dispatcher records a stop under `queue` after its service was closed and its database deleted",
    file: "src/data/engine/outbox-dispatcher.ts",
    spec: "tests/e2e/fixture.data-lifetime.spec.ts",
    grep: "R56 dispatcher",
    expect: /R56 dispatcher: the service closed and the database deleted/,
    patch: (t) =>
      sub(
        t,
        "        () => service.live,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
        "        () => true,\n        {\n          hold: () => {\n            stops.hold(service, operation);",
      ),
  },
  {
    id: "MU-1034",
    title:
      "R56 (revision 33): (REAL ENGINE) the sync engine records a stop under `capture` after its service was closed and its database deleted",
    file: "src/data/engine/sync-engine.ts",
    spec: "tests/e2e/fixture.data-lifetime.spec.ts",
    grep: "R56 engine",
    expect: /R56 engine: the service closed and the database deleted/,
    patch: (t) =>
      sub(
        t,
        "      if (!service.live) return lifetimeOver(id);\n      stop = true;\n      lifted.delete(key);\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => service.live,",
        "      stop = true;\n      lifted.delete(key);\n      const recorded = recordStop(\n        deps.markers,\n        service,\n        operation,\n        () => true,",
      ),
  },
  {
    id: "MU-1036",
    title:
      "R55 (revision 33): (REAL ENGINE) a page takes a directory slot without holding its lock (two pages can write one directory)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-directories.spec.ts",
    grep: "D2:",
    expect: /D2:/,
    patch: (t) =>
      sub(
        t,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the anchor is source text.
        "          handle = await locks.tryAcquire(`${SLOT_LOCK_PREFIX}${slot}`);",
        "          handle = { release: () => undefined };",
      ),
  },
  {
    id: "MU-1037",
    title:
      "R55 (revision 33): (REAL ENGINE) a page that takes over a directory slot drops the failures the previous owner listed",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-directories.spec.ts",
    grep: "D4:",
    expect: /D4:/,
    patch: (t) =>
      sub(
        sub(t, "      kept = parsed;", "      kept = [];"),
        "    for (const entry of unlistedStanding(storage, scope, slot))\n      if (!kept.some((have) => have[0] === entry[0] && have[1] === entry[1]))\n        kept.push(entry);\n",
        "",
      ),
  },
  {
    id: "MU-1039",
    title:
      "R57 (revision 33): (REAL ENGINE) the fixture's binding report says the captured service is live whatever happened to it (the helper cannot see an ended writer)",
    file: "src/fixture/data-harness/main.ts",
    spec: "tests/e2e/fixture.data-peer-readiness.spec.ts",
    grep: "H1 control",
    expect: /H1 control/,
    patch: (t) =>
      // Re-anchored, revision 35: the binding is built by `bindingOf` (shared with the refusal log); the meaning is unchanged.
      sub(t, "    live: bound.service.live,", "    live: true,"),
  },
  {
    id: "MU-1040",
    title:
      "R57 (revision 33): (REAL ENGINE) the fixture's rebind builds nothing (the outbox stays bound to the service that ended)",
    file: "src/fixture/data-harness/main.ts",
    spec: "tests/e2e/fixture.data-peer-readiness.spec.ts",
    grep: "H1 control|H5 diagnosis",
    expect: /(H1 control|H5 diagnosis)/,
    patch: (t) =>
      sub(
        t,
        "    await harness.startOutbox(bound.account, rest);",
        "    void rest;",
      ),
  },
  {
    id: "MU-1058",
    title:
      "R55 (revision 34): (REAL ENGINE) the listing of the origin's keys is ignored (a failure that no directory lists is not found: two pages that hand one slot over lose failures, a page without a slot records ones nobody finds)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-directories.spec.ts",
    grep: "D6|D7",
    expect: /(D6|D7)/,
    patch: (t) =>
      sub(
        t,
        "    const listing = listScope(storage, scope);\n    if (listing === null) complete = false;",
        "    const listing: Standing[] | null = [];\n    if (listing === null) complete = false;",
      ),
  },
  {
    id: "MU-1059",
    title:
      "R58 (revision 34): (REAL ENGINE) a failure is recorded only while the page holds a slot (the lock is granted and its delivery held: the durable record depends on it, and a recovery cannot reach what it never saw)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-durable.spec.ts",
    grep: "P1|P3",
    expect: /(P1|P3)/,
    patch: (t) =>
      sub(
        t,
        '    if (live !== undefined && !live()) return "obsolete";\n    const key = markerKey(scope, operation, instance);',
        '    if (live !== undefined && !live()) return "obsolete";\n    if (slot === null) return "unavailable";\n    const key = markerKey(scope, operation, instance);',
      ),
  },
  {
    id: "MU-1060",
    title:
      "R55 (revision 34): (REAL ENGINE) a failure's directory is never written (the first witness is gone: with the origin's listing refused, no read finds a failure)",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-directories.spec.ts",
    grep: "D8",
    expect: /D8/,
    patch: (t) =>
      sub(
        t,
        "    if (kept.length === 0) storage.removeItem(directory);\n    else storage.setItem(directory, text);",
        "    if (kept.length === 0) storage.removeItem(directory);\n    else void text;",
      ),
  },
  {
    id: "MU-1061",
    title:
      "R57 (revision 34): (REAL ENGINE) the fixture harness records no refusal of its outbox with the binding at that moment (a schedule that fails at its measured action cannot say why: the observation the original MU-990 failure lacked)",
    file: "src/fixture/data-harness/main.ts",
    spec: "tests/e2e/fixture.data-peer-readiness.spec.ts",
    grep: "H1 control",
    expect: /H1 control/,
    patch: (t) =>
      sub(
        t,
        '  if (answer.kind !== "refused") return;\n  refusals.push({',
        "  return;\n  refusals.push({",
      ),
  },
  {
    id: "MU-1067",
    title:
      "R55 (revision 35): (REAL ENGINE) the listing walks the origin's keys by index again (`Storage.key`): with `Storage.key` refused a cold page no longer finds a failure that no directory lists",
    file: "src/data/engine/write-failure-marker.ts",
    spec: "tests/e2e/fixture.data-directories.spec.ts",
    grep: "D9",
    expect: /D9/,
    patch: (t) =>
      sub(
        t,
        "  const keys = snapshotKeys(storage);",
        "  const keys = ((): string[] | null => {\n    try {\n      const walked: string[] = [];\n      for (let at = 0; at < storage.length; at += 1) {\n        const key = storage.key(at);\n        if (key === null) return null;\n        walked.push(key);\n      }\n      return walked;\n    } catch {\n      return null;\n    }\n  })();",
      ),
  },
  {
    id: "MU-1068",
    title:
      "R57 (revision 35): (REAL ENGINE) the fixture harness describes a refusal by the page's CURRENT outbox, read when the answer arrives (an outbox rebuilt while the action awaited is described instead of the facade that refused: the diagnostic gap of revision 34)",
    file: "src/fixture/data-harness/main.ts",
    spec: "tests/e2e/fixture.data-peer-readiness.spec.ts",
    grep: "H6",
    expect: /H6/,
    patch: (t) =>
      sub(
        t,
        "    binding: action === null ? null : bindingOf(action.bound, action.facade),",
        "    binding: harness.outboxBinding(),",
      ),
  },
  {
    id: "MU-1084",
    title:
      "R55 (revision 36): (REAL ENGINE) a look that could not read every record schedules no paced look (a follower whose marker reads come back with no event never shows the existing notice)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-public-recovery.spec.ts",
    grep: "E-R55: reads refused=true, marker standing=true",
    expect: /E-R55: reads refused=true, marker standing=true/,
    patch: (t) =>
      sub(
        t,
        "    else if (known) storage.set(false);\n    pace(known);\n",
        "    else if (known) storage.set(false);\n",
      ),
  },
  {
    id: "MU-1096",
    title:
      "R60 (revision 37): (REAL ENGINE) a healthy facade ignores a hint naming the stop records (the follower page never shows the writer's durable stop)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-stop-publication.spec.ts",
    grep: "E-R60: the writer's 3 failed saves",
    expect: /E-R60: the writer's 3 failed saves/,
    patch: (t) =>
      sub(
        t,
        "      else if (message.stores.includes(LOCAL_WRITE_STOPS_STORE))\n        void reconcile();\n",
        "",
      ),
  },
  {
    id: "MU-1097",
    title:
      "R60 (revision 37): (REAL ENGINE) the facade's durable stop is announced to its own page only (no hint crosses to the follower page)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-stop-publication.spec.ts",
    grep: "E-R60: the writer's 3 failed saves",
    expect: /E-R60: the writer's 3 failed saves/,
    patch: (t) =>
      sub(
        t,
        "        stopped(operation);\n        stopsChanged();\n",
        "        stopped(operation);\n",
      ),
  },
  {
    id: "MU-1098",
    title:
      "R60 (revision 37): (REAL ENGINE) the facade's Try again ends a durable stop without telling the other pages (the follower keeps the warning)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-stop-publication.spec.ts",
    grep: "E-R60: the writer's 3 failed saves",
    expect: /E-R60: the writer's 3 failed saves/,
    patch: (t) =>
      sub(t, "      if (issued.durable.has(operation)) stopsChanged();\n", ""),
  },
  {
    id: "MU-1115",
    title:
      "R60 (revision 38, DA-R60-C): (REAL ENGINE) the discard of a draft that never existed ends its stop without telling the other pages (the follower page keeps the warning)",
    file: "src/data/outbox/outbox.ts",
    spec: "tests/e2e/fixture.data-stop-publication.spec.ts",
    grep: "E-R60-C \\(revision 38\\)",
    expect: /E-R60-C \(revision 38\)/,
    patch: (t) =>
      sub(
        t,
        "        if (endedStreak >= config.localWritePauseAfter) stopsChanged();\n",
        "",
      ),
  }, // ---- WEB-09b review cycle 1 (10 October 2026): the planned native mutants NM-B1 to NM-B4 (plan 10.5) and the real-engine sensitivity
  // of the cycle's fixes (R1, R2, R3, R6, R8). Each is selected by its own case of the leader or recovery spec, all three browsers.
  {
    id: "MU-1252",
    title:
      "WEB-09b NM-B1: (REAL ENGINE) the leader gives its lock up on an account transition (a follower is granted it; the lock's scope is the page's life)",
    file: "src/data/leader/leader.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-B8 lock scope",
    expect: /E-B8 lock scope/,
    patch: (t) =>
      sub(
        t,
        "    b.controller.abort();",
        "    b.controller.abort();\n    deps.election.dispose();",
      ),
  },
  {
    id: "MU-1253",
    title:
      "WEB-09b NM-B2: (REAL ENGINE) the final page and the swap are TWO transactions (the final page is staged first, then activated): a page closed between them leaves a staged attempt at the wrong position",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.data-leader.spec.ts",
    grep: "E-B11 the activation is held open",
    expect: /E-B11 the activation is held open/,
    patch: (t) =>
      sub(
        t,
        "              : await service.commit(activateSnapshot, {\n                  ...common,\n                  operation: issued.capture.operation,\n                  activateOperation: issued.capture.activateOperation as string,\n                  now: deps.clock.iso(),\n                  mode: issued.mode,\n                });",
        '              : await (async () => {\n                  const first = await service.commit(commitStagingPage, {\n                    ...common,\n                    scan: { ...ok, hasMore: true },\n                    operation: issued.capture.operation,\n                  });\n                  if (first.kind !== "applied" || first.value.kind !== "staged")\n                    return first;\n                  return service.commit(activateSnapshot, {\n                    ...common,\n                    captured: { ...issued.captured, expectedPosition: ok.nextCursor },\n                    operation: issued.capture.operation,\n                    activateOperation: issued.capture.activateOperation as string,\n                    now: deps.clock.iso(),\n                    mode: issued.mode,\n                  });\n                })();',
      ),
  },
  {
    id: "MU-1254",
    title:
      "WEB-09b NM-B3: (REAL ENGINE) an adopted attempt ignores its staging position (the reloaded leader asks cursor-less, never for the staged page)",
    file: "src/data/plans/recovery-writers.ts",
    spec: "tests/e2e/fixture.data-leader.spec.ts",
    grep: "E-B3 the leader's page reloads mid-snapshot",
    expect: /E-B3 the leader's page reloads mid-snapshot/,
    patch: (t) =>
      sub(
        t,
        "const position = snapshot ? sync.staging_position : sync.cursor;",
        "const position = snapshot ? null : sync.cursor;",
      ),
  },
  {
    id: "MU-1255",
    title:
      "WEB-09b NM-B4: (REAL ENGINE) a follower page binds and issues `/sync` as if it led",
    file: "src/data/leader/leader.ts",
    spec: "tests/e2e/fixture.data-leader.spec.ts",
    grep: "E-B1 one leader among three pages",
    expect: /E-B1 one leader among three pages/,
    patch: (t) =>
      sub(
        t,
        "const leading = (): boolean =>",
        "const leading = (): boolean => true || ",
      ),
  },
  {
    id: "MU-1256",
    title:
      "WEB-09b R1: (REAL ENGINE) a second re-authentication finishes on the earlier epoch's data commit, without its own catch-up (both layers removed)",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R7 T24 G and R1|E-R7b T24 G and R1",
    expect: /E-R7 T24 G and R1|E-R7b T24 G and R1/,
    patch: (t) =>
      sub(
        sub(
          t,
          "        commitProof.handle === handle\n",
          "        (true as boolean)\n",
        ),
        "        handle = null;\n        commitProof = null;\n        const begun",
        "        handle = null;\n        const begun",
      ),
  },
  {
    id: "MU-1257",
    title:
      "WEB-09b R2: (REAL ENGINE) state 3's visible 'Try again' does not reach the recovery job (the account stays hidden)",
    file: "src/session/session.ts",
    spec: "tests/e2e/fixture.data-leader.spec.ts",
    grep: "E-R4 T24 D",
    expect: /E-R4 T24 D/,
    patch: (t) => sub(t, "      recovery.retried();", "      void 0;"),
  },
  {
    id: "MU-1258",
    title:
      "WEB-09b R2: (REAL ENGINE) a follower's 'Try again' on the blocking state asks nobody",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-B15 R2",
    expect: /E-B15 R2/,
    patch: (t) =>
      sub(
        t,
        "      if (follower !== null && leader.engine === undefined) {\n        const identity = deps.identity.get();",
        "      if (follower !== null && leader.engine === undefined && (false as boolean)) {\n        const identity = deps.identity.get();",
      ),
  },
  {
    id: "MU-1259",
    title:
      "WEB-09b R3: (REAL ENGINE) a gate resolved in the same epoch (O11, a finished attempt) never wakes the waiting recovery",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R10 T24 H and R3|E-R12 T24 H and R3",
    expect: /E-R10 T24 H and R3|E-R12 T24 H and R3/,
    // Redefined in review cycle 2 (R3), like MU-1239: `awaitsRecord` is gone; the defect is a record refusal left as a bare event wait.
    patch: (t) =>
      sub(
        t,
        'return awaitAdmission(b, "recovery", epoch, "begin");',
        'return { when: "event" };',
      ),
  },
  {
    id: "MU-1260",
    title:
      "WEB-09b R6: (REAL ENGINE) a follower ignores the leader's durable stops and says 'Up to date'",
    file: "src/data/model/status.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-B16 R6 and R2",
    expect: /E-B16 R6 and R2/,
    patch: (t) =>
      sub(
        t,
        "        (stops.paused || stops.pageStopped || stops.floor)",
        "        (false as boolean)",
      ),
  },
  {
    id: "MU-1261",
    title:
      "WEB-09b R8: (REAL ENGINE) a recovery-mode catch-up page writes the queue's bookkeeping (an acknowledged draft written while fenced)",
    file: "src/data/plans/reconcile-windows.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R11 R8",
    expect: /E-R11 R8/,
    patch: (t) =>
      sub(
        t,
        "  if (input.recovery === true) {",
        "  if (input.recovery === true && (false as boolean)) {",
      ),
  },
  {
    id: "MU-1278",
    title:
      "WEB-09b R3 (cycle 2): (REAL ENGINE) a cover that closes after `begin` leaves the job running with nothing to wake it",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R14 R3",
    expect: /E-R14 R3/,
    patch: (t) =>
      sub(
        t,
        '          return awaitAdmission(\n            issued.binding,\n            issued.mode,\n            issued.epoch,\n            "closed",\n          );',
        '          return { when: "event" };',
      ),
  },
  {
    id: "MU-1279",
    title:
      "WEB-09b R3 (cycle 2): (REAL ENGINE) a not_sent that outlasts the immediate retries ends in a bare event wait",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R15 R3",
    expect: /E-R15 R3/,
    patch: (t) =>
      sub(
        t,
        '          return awaitAdmission(\n            issued.binding,\n            issued.mode,\n            issued.epoch,\n            "not_sent",\n          );',
        '          return { when: "event" };',
      ),
  },
  {
    id: "MU-1280",
    title:
      "WEB-09b R7 (cycle 2): (REAL ENGINE) the authorised current read hands back the command's result without sealing it at the durable record",
    file: "src/data/ui/env.ts",
    spec: "tests/e2e/fixture.data-recovery.spec.ts",
    grep: "E-R16 R7",
    expect: /E-R16 R7/,
    patch: (t) =>
      sub(
        t,
        "result = await seal(account, epoch, interpreted);",
        "result = await interpreted;",
      ),
  },
];
