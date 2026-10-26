// Accepted WEB-08c lifecycle mutants, separated during the WEB-10a base merge to retain Biome's existing file-size limit.
// IDs, ordering, selections, assertions and patch bodies are unchanged.
import { sub } from "./data-catalogue.mjs";

export const UNIT_LIFECYCLE = [
  {
    id: "MU-8C-01",
    title:
      "WEB-08c §2.1: a rejected indeterminate listing (indexedDB.databases()) is reported as 'no other accounts'",
    file: "src/data/store/retained-accounts.ts",
    tests: [
      "tests/data/retained-accounts.test.ts",
      "tests/features/switch/switch-flow.test.tsx",
    ],
    expect: /MU-8C-01/,
    patch: (t) =>
      sub(
        t,
        '    names = await deps.host.list();\n  } catch {\n    return { kind: "unknown" };',
        '    names = await deps.host.list();\n  } catch {\n    return { kind: "ok", accounts: [] };',
      ),
  },
  {
    id: "MU-8C-02",
    title:
      "WEB-08c §2.1: the settled account is not excluded from the retained list",
    file: "src/data/store/retained-accounts.ts",
    tests: ["tests/data/retained-accounts.test.ts"],
    expect: /MU-8C-02/,
    patch: (t) =>
      sub(
        t,
        "if (account === null || account === options.exclude || seen.has(account))",
        "if (account === null || seen.has(account))",
      ),
  },
  {
    id: "MU-8C-03",
    title:
      "WEB-08c §2.1 (D-8c-01): an account without its own profile record is labelled with another account's name",
    file: "src/data/store/retained-accounts.ts",
    tests: ["tests/data/retained-accounts.test.ts"],
    expect: /MU-8C-03/,
    patch: (t) =>
      sub(
        t,
        "    if (read !== null) accounts.push(read);",
        "    if (read !== null)\n      accounts.push(\n        read.lastVerifiedName === null && accounts.length > 0\n          ? { ...read, lastVerifiedName: accounts[accounts.length - 1].lastVerifiedName }\n          : read,\n      );",
      ),
  },
  {
    id: "MU-8C-04",
    title:
      "WEB-08c §2.1: an account this page latched closed_for_deletion is still listed (and read)",
    file: "src/data/store/retained-accounts.ts",
    tests: ["tests/data/retained-accounts.test.ts"],
    expect: /MU-8C-04/,
    patch: (t) =>
      sub(
        t,
        '    if (deps.registry.latch(account) === "closed_for_deletion") continue;\n',
        "",
      ),
  },
  {
    id: "MU-8C-05",
    title:
      "WEB-08c G-9: the rail's account control is given a name that is not verified for the current epoch (the account id)",
    file: "src/app/protected-tree.tsx",
    tests: ["tests/app/web08c-composition.test.tsx"],
    expect: /MU-8C-05/,
    patch: (t) =>
      sub(
        sub(
          t,
          "...(label === null || account === null",
          "...(account === null",
        ),
        "                label={label}",
        "                label={label ?? account}",
      ),
  },
  {
    id: "MU-8C-06",
    title: "WEB-08c WF-SWITCH-02: the queued caution is shown at zero",
    file: "src/features/switch/SwitchFlow.tsx",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect: /MU-8C-06/,
    patch: (t) =>
      sub(
        t,
        '        {waiting !== null && waiting > 0 ? (\n          <div\n            role="note"',
        '        {waiting !== null && waiting >= 0 ? (\n          <div\n            role="note"',
      ),
  },
  {
    id: "MU-8C-07",
    title:
      "WEB-08c D-8c-04: 'That sign-in didn't finish' is raised on an exit to a fence (1b, 1d, 1a, 1e) or catching up",
    file: "src/features/authentication/attempt-end.ts",
    tests: ["tests/features/authentication/attempt-end.test.ts"],
    expect: /MU-8C-07/,
    patch: (t) =>
      sub(
        t,
        '  if (view.kind === "displaying") return true;\n  return view.kind === "signed_out" && view.state === null;',
        '  return view.kind !== "booting";',
      ),
  },
  {
    id: "MU-8C-08",
    title:
      "WEB-08c D-8c-04: 'That sign-in didn't finish' is raised although a newer epoch settled",
    file: "src/features/authentication/attempt-end.ts",
    tests: ["tests/features/authentication/attempt-end.test.ts"],
    expect: /MU-8C-08/,
    patch: (t) =>
      sub(
        t,
        "if (advanced || !endedExit(view)) return;",
        "if (!endedExit(view)) return;",
      ),
  },
  {
    id: "MU-8C-09",
    title:
      "WEB-08c D-8c-03: a return destination is applied for (or survives) another account",
    file: "src/app/return-destination.ts",
    tests: ["tests/app/web08c-composition.test.tsx"],
    expect: /MU-8C-09/,
    patch: (t) => sub(t, "      found.account !== account ||\n", ""),
  },
  {
    id: "MU-8C-10",
    title:
      "WEB-08c D-8c-03: a return destination ignores the epoch it asks for",
    file: "src/app/return-destination.ts",
    tests: ["tests/app/web08c-composition.test.tsx"],
    expect: /MU-8C-10/,
    patch: (t) => sub(t, "    if (!due) return null;\n", ""),
  },
  {
    id: "MU-8C-11",
    title: "WEB-08c G-10: boot does not pass onReviewDevice",
    file: "src/app/boot.tsx",
    tests: ["tests/app/web08c-composition.test.tsx"],
    expect: /MU-8C-11/,
    patch: (t) =>
      sub(
        t,
        "      onReviewDevice: () => lifecycle.reviewDevice(session),\n",
        "",
      ),
  },
  {
    id: "MU-8C-12",
    title:
      "WEB-08c D-8c-02: the switch sends the picked account's id instead of an ordinary attempt with what was typed",
    file: "src/features/switch/SwitchFlow.tsx",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect: /MU-8C-12/,
    patch: (t) =>
      sub(
        t,
        "onSubmit={(credentials) => submitSwitch(session, owner, credentials)}",
        'onSubmit={(credentials) =>\n            submitSwitch(session, owner, {\n              ...credentials,\n              username: target.kind === "retained" ? target.account_id : credentials.username,\n            })\n          }',
      ),
  },
  {
    id: "MU-8C-13",
    title:
      "WEB-08c G-23: 'Confirm it's you' sends whatever username the (read-only) field holds instead of this account's",
    file: "src/features/settings/signing-in/ConfirmItsYou.tsx",
    tests: ["tests/features/settings/confirm-its-you.test.tsx"],
    expect: /whatever the field holds/,
    // Anchor moved (WEB-08c, R1 of the review of 11 October 2026): the sign-in is now `confirmSignIn`'s journey; same mutation.
    patch: (t) =>
      sub(
        t,
        "confirmSignIn(session, owner, username, credentials.password)",
        "confirmSignIn(session, owner, credentials.username, credentials.password)",
      ),
  },
  {
    id: "MU-8C-14",
    title:
      "WEB-08c §3: the switch flow opened by one account is shown over another account's display",
    file: "src/features/switch/entry.tsx",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect: /belongs to the account it was opened for/,
    patch: (t) =>
      sub(
        sub(
          t,
          '    if (account !== null && stage.stage !== "closed" && stage.owner !== account)\n      switchFlow.dropUnless(account);',
          "    void switchFlow;",
        ),
        '  if (account === null || stage.stage === "closed" || stage.owner !== account)',
        '  if (account === null || stage.stage === "closed")',
      ),
  },
  {
    id: "MU-8C-15",
    title:
      "WEB-08c D-8c-04: the password sign-in does not tell the watcher that its activation is indeterminate (a page that resolves its own activation before 1c.resolving is published raises no 1c.ended)",
    file: "src/features/authentication/controller.ts",
    tests: ["tests/features/authentication/attempt-end.test.ts"],
    expect: /MU-8C-15/,
    patch: (t) =>
      sub(
        t,
        '  if (outcome.kind === "gating") attemptEnd.indeterminate(before);\n',
        "",
      ),
  },
  {
    id: "MU-8C-E1",
    title:
      "WEB-08c D-8c-05: the switch journey is imported statically into the protected tree (no behavioural difference in an engine: the static lazy-load check and check-initial-chunk are its detectors)",
    file: "src/features/switch/entry.tsx",
    tests: ["tests/features/switch/switch-copy.test.ts"],
    expect: /D-8c-05/,
    patch: (t) =>
      sub(
        t,
        'const SwitchFlow = lazy(() => import("./SwitchFlow"));',
        'import SwitchFlowEager from "./SwitchFlow";\nconst SwitchFlow = SwitchFlowEager;\nvoid lazy;',
      ),
  },
  {
    id: "MU-8C-K1a",
    title:
      "WEB-08c K-1: an identity read's 200-other-account / 401 answer leaves the credential_unverified entry beside the stronger fence (the unbounded re-verification)",
    file: "src/session/kernel/identity.ts",
    tests: [
      "tests/session/web08c-k1.test.ts",
      "tests/session/web08c-traces.test.ts",
    ],
    expect: /K-1|T21/,
    patch: (t) => sub(t, "      replaces_unverified: inflight.fenceSeq,\n", ""),
  },
  {
    id: "MU-8C-K1b",
    title:
      "WEB-08c K-1: the recording transaction does not replace the covered credential_unverified entries",
    file: "src/session/model/reducers/observation.ts",
    tests: [
      "tests/session/web08c-k1.test.ts",
      "tests/session/web08c-traces.test.ts",
    ],
    expect: /K-1|T21/,
    patch: (t) =>
      sub(
        t,
        "    if (replaces === undefined) return;",
        "    if (replaces === undefined || (true as boolean)) return;",
      ),
  },
  // WEB-08c revision 1 (review of 11 October 2026): R1 cancellation, R2 return-destination ownership, R3 recovery report and refusal continuity.
  {
    id: "MU-8C-R1a",
    title:
      "WEB-08c R1: `attempts.cancel` does not mark the attempt cancelled in page memory (a late grant activates when the clear has to wait for atlas-auth)",
    file: "src/session/kernel/attempts.ts",
    tests: ["tests/session/web08c-cancel.test.ts"],
    expect:
      /cancelled while another page holds atlas-auth|cancelled while the activating write waits/,
    patch: (t) => sub(t, "    this.cancelled.add(handle.epoch);\n", ""),
  },
  {
    id: "MU-8C-R1b",
    title:
      "WEB-08c R1: a cancelled attempt's grant is recorded and activated when its exchange answers",
    file: "src/session/kernel/attempts.ts",
    tests: ["tests/session/web08c-cancel.test.ts"],
    expect: /cancelled while another page holds atlas-auth/,
    patch: (t) =>
      sub(
        t,
        "    if (this.cancelled.has(handle.epoch)) {",
        "    if (this.cancelled.has(handle.epoch) && (false as boolean)) {",
      ),
  },
  {
    id: "MU-8C-R1c",
    title:
      "WEB-08c R1: the activating write is not abandoned for a cancellation that came while it waited for atlas-auth",
    file: "src/session/kernel/attempts.ts",
    tests: ["tests/session/web08c-cancel.test.ts"],
    expect: /cancelled while the activating write waits/,
    patch: (t) =>
      sub(
        t,
        "        () => hiddenNow() || cancelledNow(),\n",
        "        hiddenNow,\n",
      ),
  },
  {
    id: "MU-8C-R1d",
    title:
      "WEB-08c R1: the controller never cancels the attempt when its caller's signal aborts",
    file: "src/features/authentication/controller.ts",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect: /while the exchange is outstanding|cancels it too/,
    patch: (t) =>
      sub(
        t,
        "  const cancel = () => void session.attempts.cancel(handle);",
        "  const cancel = () => undefined;",
      ),
  },
  {
    id: "MU-8C-R1e",
    title:
      "WEB-08c R1: 'Cancel — stay as …' returns to the picker without cancelling the sign-in in flight",
    file: "src/features/switch/state.ts",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect:
      /Cancel — stay as …' while the exchange|cancelled BEFORE `begin` returned/,
    patch: (t) =>
      sub(
        t,
        '    if (state.stage !== "sign-in" || state.owner !== owner) return;\n    abandon();\n    set({ stage: "picker", owner });',
        '    if (state.stage !== "sign-in" || state.owner !== owner) return;\n    set({ stage: "picker", owner });',
      ),
  },
  {
    id: "MU-8C-R1f",
    title:
      "WEB-08c R1: Escape or Close ends the switch flow without cancelling the sign-in in flight",
    file: "src/features/switch/state.ts",
    tests: ["tests/features/switch/switch-flow.test.tsx"],
    expect:
      /Escape while the exchange is outstanding|Close while the exchange is outstanding/,
    patch: (t) =>
      sub(t, "  close(): void {\n    abandon();\n", "  close(): void {\n"),
  },
  {
    id: "MU-8C-R1g",
    title:
      "WEB-08c R1: 'Confirm it's you' Cancel closes the section without cancelling the sign-in in flight",
    file: "src/features/settings/signing-in/confirm-state.ts",
    tests: ["tests/features/settings/confirm-its-you.test.tsx"],
    expect: /R1: Cancel while the confirmation is in flight/,
    patch: (t) =>
      sub(t, "  cancel(): void {\n    abandon();\n", "  cancel(): void {\n"),
  },
  {
    id: "MU-8C-R2a",
    title:
      "WEB-08c R2: an indeterminate (gating) re-authentication drops its return destination",
    file: "src/features/settings/signing-in/ConfirmItsYou.tsx",
    tests: ["tests/features/settings/confirm-its-you.test.tsx"],
    expect: /an indeterminate activation keeps the destination/,
    patch: (t) =>
      sub(t, '  if (result.kind === "gating") return result;\n', ""),
  },
  {
    id: "MU-8C-R2b",
    title:
      "WEB-08c R2: a re-authentication's terminal result drops whatever destination is pending, including a newer request's",
    file: "src/features/settings/signing-in/ConfirmItsYou.tsx",
    tests: ["tests/features/settings/confirm-its-you.test.tsx"],
    expect: /R2: an older request's terminal result/,
    patch: (t) =>
      sub(
        t,
        "  returnDestination.clearIf(destination);",
        "  returnDestination.clear();",
      ),
  },
  {
    id: "MU-8C-R3a",
    title:
      "WEB-08c R3: the recovery job's admission wait ignores `begin`'s own revision (a gate that ended before the first probe strands state 3)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect:
      /R3 \((attempt_gating|operation_pending)\): begin reported the gate/,
    patch: (t) =>
      sub(t, "      admission.revision = baseline;", "      void baseline;"),
  },
  {
    id: "MU-8C-R3b",
    title:
      "WEB-08c R3: the session's `recovery.begin` refusal carries no admission revision",
    file: "src/session/kernel/recovery.ts",
    tests: [
      "tests/session/admission-probe.test.ts",
      "tests/session/recovery-api.test.ts",
    ],
    expect:
      /refuses with the revision of its read|a gating attempt|no fence at all/,
    patch: (t) =>
      sub(
        t,
        '        revision: admissionFrom(k, records, "recovery", account, settled.epoch)\n          .revision,',
        "        revision: undefined,",
      ),
  },
  {
    id: "MU-8C-R3c",
    title:
      "WEB-08c R3: the admission revision ignores `latest_epoch` (an attempt that came and went between two probes is invisible)",
    file: "src/session/kernel/admission.ts",
    tests: ["tests/session/admission-probe.test.ts"],
    expect: /still changes the revision/,
    patch: (t) => sub(t, "        state.latest_epoch,\n", ""),
  },
  {
    id: "MU-8C-R4a",
    title:
      "WEB-08c R4 (revision 2): the stall bound regains a 250 ms grace (a lease completing at 5,200 ms is sent; the review's regression)",
    file: "src/session/kernel/state.ts",
    tests: ["tests/session/web08c-stall-bound.test.ts"],
    expect: /is late: stalled \(no grace\)|NOT_COVERED, never sent/,
    patch: (t) =>
      sub(
        t,
        '      const timer = this.ports.clock.setTimeout(() => resolve("stalled"), ms);',
        '      const timer = this.ports.clock.setTimeout(() => resolve("stalled"), ms + 250);',
      ),
  },
  {
    id: "MU-8C-R4d",
    title:
      "WEB-08c R4 (revision 2): the bound's verdict waits one more timer turn (revision 1's first tie-break: an answer observed after the bound's timer still wins)",
    file: "src/session/kernel/state.ts",
    tests: ["tests/session/web08c-stall-bound.test.ts"],
    expect: /observed AFTER the bound's timer is late/,
    patch: (t) =>
      sub(
        t,
        '      const timer = this.ports.clock.setTimeout(() => resolve("stalled"), ms);',
        '      const timer = this.ports.clock.setTimeout(\n        () => this.ports.clock.setTimeout(() => resolve("stalled"), 0),\n        ms,\n      );',
      ),
  },
  {
    id: "MU-8C-R4e",
    title:
      "WEB-08c R4 (T22-READ-BOUND-20261012): the display read keeps the 5 s recording bound (T22's 5 s read ties with the timer and fails closed)",
    file: "src/session/kernel/evaluate.ts",
    tests: ["tests/session/web08c-stall-bound.test.ts"],
    expect: /is an answer: the page stays displayed/,
    patch: (t) =>
      sub(
        t,
        "  const records = await readRecords(k, k.config.displayReadStallMs);",
        "  const records = await readRecords(k);",
      ),
  },
  {
    id: "MU-8C-R4f",
    title:
      "WEB-08c R4 (T22-READ-BOUND-20261012): every record reader gets the display read's 6 s (the longer bound leaks beyond the display check)",
    file: "src/session/kernel/evaluate.ts",
    tests: ["tests/session/web08c-stall-bound.test.ts"],
    expect: /every other reader keeps the hard 5 s/,
    patch: (t) =>
      sub(
        t,
        "  bound = k.config.recordingStallMs,",
        "  bound = k.config.displayReadStallMs,",
      ),
  },
  {
    id: "MU-8C-HF1a",
    title:
      "WEB-08c HF-1 (HF1-SHARED-CONFIRMATION-20261013): the settlement does not share the activation's token (every other page makes its own identity read again)",
    file: "src/session/kernel/attempts.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect:
      /writes the confirmation of exactly the settled session|adopts the token and the confirmation/,
    patch: (t) => sub(t, "            csrf_token: session.csrf_token,\n", ""),
  },
  {
    id: "MU-8C-HF1b",
    title:
      "WEB-08c HF-1: a page adopts a shared token that names another session",
    file: "src/session/kernel/evaluate.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /names ANOTHER session is neither adopted/,
    patch: (t) =>
      sub(
        t,
        "    shared.session_id === settled.session_id\n  ) {",
        "    true\n  ) {",
      ),
  },
  {
    id: "MU-8C-HF1c",
    title: "WEB-08c HF-1: a page adopts a shared token of an older epoch",
    file: "src/session/kernel/evaluate.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /older epoch .* is never adopted/,
    patch: (t) => sub(t, "    shared.epoch === settled.epoch &&\n", ""),
  },
  {
    id: "MU-8C-HF1d",
    title:
      "WEB-08c HF-1: a confirmation of another session spares the resume verification",
    file: "src/session/session.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /does not spare the resume verification/,
    patch: (t) =>
      sub(
        t,
        "      shared.session_id !== identity.session_id\n",
        "      false\n",
      ),
  },
  {
    id: "MU-8C-HF1e",
    title:
      "WEB-08c HF-1: a confirmation dated in the future spares the resume verification",
    file: "src/session/session.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /dated in the FUTURE/,
    patch: (t) => sub(t, "    return age >= 0 && age <", "    return age <"),
  },
  {
    id: "MU-8C-HF1f",
    title:
      "WEB-08c HF-1: the lease retirement records a confirmation for a session the record does not settle",
    file: "src/session/model/reducers/observation.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /writes NO confirmation/,
    patch: (t) =>
      sub(
        t,
        "    settled.session_id === confirm.session_id;",
        "    settled.account_id === confirm.account_id;",
      ),
  },
  {
    id: "MU-8C-HF1g",
    title:
      "WEB-08c HF-1: a clean identity read does not refresh the shared confirmation",
    file: "src/session/kernel/identity.ts",
    tests: ["tests/session/web08c-shared-confirmation.test.ts"],
    expect: /refreshes the shared confirmation/,
    patch: (t) =>
      sub(
        t,
        "  cleanRelease(k, inflight, {\n    account_id: inflight.account,",
        "  cleanRelease(k, inflight, undefined && {\n    account_id: inflight.account,",
      ),
  },
  {
    id: "MU-8C-R4b",
    title:
      "WEB-08c R4: the resume gate's polite status never says 'Checking your account' while the local check is pending",
    file: "src/components/ui/gate-dialog.ts",
    tests: ["tests/session/resume-gate.test.tsx"],
    expect: /Read pending/,
    patch: (t) =>
      sub(
        t,
        '    if (message.textContent === "") message.textContent = GATE_HEADING;',
        "    void GATE_HEADING;",
      ),
  },
  {
    id: "MU-8C-R4c",
    title:
      "WEB-08c R4: a tree for a different account keeps the previous account's address (a Settings dialog route opens again; focus is not the main heading)",
    file: "src/app/protected-tree.tsx",
    tests: ["tests/app/protected-tree-join.test.tsx"],
    expect: /where a tree starts/,
    patch: (t) =>
      sub(
        t,
        '        history.replaceState(null, "", "/");\n      lastMounted = account;',
        "        void account;\n      lastMounted = account;",
      ),
  },
  {
    id: "MU-8C-R3d",
    title:
      "WEB-08c R3: a re-authentication refusal is not kept in page memory (lost when the activation's gate remounts the tree)",
    file: "src/features/settings/signing-in/ConfirmItsYou.tsx",
    tests: ["tests/features/settings/confirm-its-you.test.tsx"],
    expect: /R3: a refusal that arrives after the activation's gate/,
    patch: (t) =>
      sub(
        t,
        "    confirmFlow.fail(journey, result.message);",
        "    void journey;",
      ),
  },
  {
    id: "MU-8C-HF13b",
    title:
      "WEB-08c revision 3 (R8, HF-13): the level-0 gate does not cancel a heading attempt still waiting from the mount",
    file: "src/session/adapters/protected-surface.ts",
    tests: ["tests/session/resume-gate.test.tsx"],
    expect: /a level-0 gate cancels the pending heading attempt/,
    patch: (t) =>
      sub(
        t,
        "      // The gate owns focus until the lift: a heading attempt still waiting from the mount is obsolete (HF-13).\n      focusToken += 1;\n",
        "",
      ),
  },
  {
    id: "MU-8C-HF13c",
    title:
      "WEB-08c revision 3 (R8, HF-13): a deferred heading attempt takes focus from a control the person moved to inside the tree",
    file: "src/session/adapters/protected-surface.ts",
    tests: ["tests/session/resume-gate.test.tsx"],
    expect: /does not take focus from a control the person moved to/,
    patch: (t) => sub(t, "      if (deferred && moved) return;\n", ""),
  },
  {
    id: "MU-8C-HF13d",
    title:
      "WEB-08c revision 3 (R8, HF-13 sensitivity): a same-account lift does not restore the keyed control (the original assertion must fail)",
    file: "src/session/adapters/protected-surface.ts",
    tests: ["tests/session/resume-gate.test.tsx"],
    expect:
      /focus returns to the control that had it|the original schedule of HF-13/,
    patch: (t) =>
      sub(
        t,
        "        if (target) target.focus();\n",
        "        if (target) void target;\n",
      ),
  },
  {
    id: "MU-8C-RR1",
    title:
      "WEB-08c revision 3 (R5, S9): the leading page does not announce its recovery report (a follower keeps showing 'Catching up' after the recovery stopped) (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /adopts the leader's 'failed' report/,
    patch: (t) =>
      sub(
        t,
        "        failure,\n      };\n      postStatus();\n",
        "        failure,\n      };\n",
      ),
  },
  {
    id: "MU-8C-RR2",
    title:
      "WEB-08c revision 3 (R5, S9): a hint for another identity replaces the page's kept report (and withdraws its card 3) (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect:
      /a report for another epoch is not adopted|a report for another account is not adopted/,
    patch: (t) =>
      sub(
        t,
        "      identity.account_id !== message.account ||\n      identity.epoch !== message.epoch\n    )\n      return;\n    const kept = ownStatus();",
        "      false\n    )\n      return;\n    const kept = ownStatus();",
      ),
  },
  {
    id: "MU-8C-RR3",
    title:
      "WEB-08c revision 3 (R5, S9): the leading page applies another page's recovery report instead of showing its own job's (both leader guards: adoption and application) (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /the leading page never adopts/,
    patch: (t) =>
      sub(
        sub(
          t,
          "  ): void => {\n    if (leading()) return;\n    const identity = deps.identity.get();\n",
          "  ): void => {\n    const identity = deps.identity.get();\n",
        ),
        "    if (leading() || !showingRecoveryCard() || !visible()) return;\n",
        "    if (!showingRecoveryCard() || !visible()) return;\n",
      ),
  },
  {
    id: "MU-8C-RR4",
    title:
      "WEB-08c revision 3 (R5, S9): a page that starts after the report never asks for the standing one (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /opened AFTER the report/,
    patch: (t) =>
      sub(
        t,
        '    deps.channel.post({\n      type: "recovery_state_query",\n',
        '    void ({\n      type: "recovery_state_query",\n',
      ),
  },
  {
    id: "MU-8C-RR5",
    title:
      "WEB-08c revision 3 (R5, S9): the leading page does not answer a query for its standing report (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /opened AFTER the report/,
    patch: (t) =>
      sub(
        t,
        "              };\n            postStatus();\n            return;\n",
        "              };\n            return;\n",
      ),
  },
  {
    id: "MU-8C-RR6",
    title:
      "WEB-08c revision 3 (R5, S9): a page whose identity changed keeps the report kept for the previous identity (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /identity changes drops the adopted report/,
    patch: (t) =>
      sub(
        t,
        "    return kept !== null &&\n      identity !== null &&\n      kept.account === identity.account_id &&\n      kept.epoch === identity.epoch\n",
        "    return kept !== null &&\n      identity !== null\n",
      ),
  },
  {
    id: "MU-8C-RR7",
    title:
      "WEB-08c revision 3 (R5, S9): a page is given a report that changes nothing it shows (every hint re-evaluates it) (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /is NOT re-evaluated by a report that changes nothing/,
    patch: (t) =>
      sub(
        t,
        "    if (failed === showsFailed) return;\n    const phase = failed",
        "    const phase = failed",
      ),
  },
  {
    id: "MU-8C-RR8",
    title:
      "WEB-08c revision 3 (R5, S9; the T22 (i) regression): a page that is not showing the recovery card is given a report (a hint wakes a gated or hidden page) (re-anchored in WEB-08c revision 4 to the versioned report protocol; same intent)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /T22 \(i\): a page that is NOT showing the recovery card/,
    patch: (t) =>
      sub(
        t,
        "    if (leading() || !showingRecoveryCard() || !visible()) return;\n",
        "    if (leading() || !visible()) return;\n",
      ),
  },
  {
    id: "MU-8C-R9a",
    title:
      "WEB-08c revision 4 (R9): the session never withdraws a held recovery report at its record read (another identity's report, or one held after the fence was cleared, stays)",
    file: "src/session/kernel/evaluate.ts",
    tests: ["tests/session/recovery-api.test.ts"],
    expect:
      /a report scoped to ANOTHER identity shows nothing|a report made while the account has NO fence is withdrawn/,
    patch: (t) =>
      sub(
        t,
        "  if (\n    k.neutral.recovery &&\n    !(",
        "  if (\n    (false as boolean) &&\n    !(",
      ),
  },
  {
    id: "MU-8C-R9b",
    title:
      "WEB-08c revision 4 (R9): a recovery report names state 2 or 3 with no fence at all (the WEB-08a fallback that stranded the follower)",
    file: "src/session/model/neutral-state.ts",
    tests: ["tests/session/model/neutral-state.test.ts"],
    expect: /the catch-up states/,
    patch: (t) =>
      sub(
        t,
        '  if (memory.waitingOnOtherWindow) return "1e.waiting";\n',
        '  if (memory.waitingOnOtherWindow) return "1e.waiting";\n  if (memory.recovery === "catching_up") return "2";\n  if (memory.recovery === "failed") return "3";\n',
      ),
  },
  {
    id: "MU-8C-R9c",
    title:
      "WEB-08c revision 4 (R9, S3): the scan reads only a displaying page (a visible page on recovery state 2 or 3 waits for a hint that was lost)",
    file: "src/session/session.ts",
    tests: ["tests/session/recovery-api.test.ts"],
    expect: /S3: every hint to the follower is LOST too/,
    patch: (t) =>
      sub(
        t,
        '(view.kind === "neutral" && /^[23]$/.test(view.state))',
        '(view.kind === "neutral" && (false as boolean))',
      ),
  },
  {
    id: "MU-8C-R9d",
    title:
      "WEB-08c revision 4 (R9, S8): the scan reads a hidden page too (a recovery-card scan wakes a hidden page)",
    file: "src/session/session.ts",
    tests: ["tests/session/recovery-api.test.ts"],
    expect: /a HIDDEN page on state 3 reads nothing on its own/,
    patch: (t) =>
      sub(
        t,
        "        if (\n          ports.page.isVisible() &&\n",
        "        if (\n          (true as boolean) &&\n",
      ),
  },
  {
    id: "MU-8C-R9e",
    title:
      "WEB-08c revision 4 (R9, S2): a follower asks for the leader's report ONCE per card (a lost report or answer is never repaired)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /S2 \(lost report\)|S2 \(lost question, then lost answer\)/,
    patch: (t) =>
      sub(
        t,
        "        followStatus(Math.min(delay * 2, STATUS_ASK_MAX_MS));\n",
        "        void delay;\n",
      ),
  },
  {
    id: "MU-8C-R9f",
    title:
      "WEB-08c revision 4 (R9, S4): reports of one producer are not ordered (a late 'none' replaces its newer 'failed')",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /S4: a late report of the SAME producer/,
    patch: (t) =>
      sub(t, "      message.seq <= kept.seq\n", "      (false as boolean)\n"),
  },
  {
    id: "MU-8C-R9g",
    title:
      "WEB-08c revision 4 (R9, S11): the leading page applies a follower's retry whatever failure it was pressed against (a spent retry resets the current stop)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /S11: a follower's retry names the failure it saw/,
    patch: (t) =>
      sub(
        t,
        "    if (\n      target.failure !== undefined &&\n",
        "    if (\n      (false as boolean) &&\n      target.failure !== undefined &&\n",
      ),
  },
  {
    id: "MU-8C-R9h",
    title:
      "WEB-08c revision 4 (R9, S8): a hidden follower is given the kept report (a hint wakes a hidden page)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /S8: a HIDDEN follower neither asks nor is given a report/,
    patch: (t) =>
      sub(
        t,
        "    if (leading() || !showingRecoveryCard() || !visible()) return;\n",
        "    if (leading() || !showingRecoveryCard()) return;\n",
      ),
  },
  {
    id: "MU-8C-R9i",
    title:
      "WEB-08c revision 4 (R9): the leading page answers a question only when it has a failure or progress to report (revision 3: 'none' was never answered)",
    file: "src/data/leader/leader.ts",
    tests: ["tests/data/recovery-report-routing.test.ts"],
    expect: /the leader answers a question with 'none' too/,
    patch: (t) =>
      sub(
        t,
        '              announced === null ||\n              announced.account !== message.account ||\n              announced.epoch !== message.epoch\n            )\n              announced = {\n                account: message.account,\n                epoch: message.epoch,\n                phase: "none",\n                failure: null,\n              };\n',
        '              announced === null ||\n              announced.phase === "none" ||\n              announced.account !== message.account ||\n              announced.epoch !== message.epoch\n            )\n              return;\n',
      ),
  },
  {
    id: "MU-8C-Q1",
    title:
      "WEB-08c revision 4 (DA-N1): a wake (a notification that changes connectivity, the view or the identity object) re-enters a recovery quota stop",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /S9: quota once/,
    patch: (t) =>
      sub(
        t,
        "    if (quotaHeld()) return;\n    void tick();\n",
        "    void tick();\n",
      ),
  },
  {
    id: "MU-8C-Q2",
    title:
      "WEB-08c revision 4 (DA-N1): connectivity returning re-enters a recovery quota stop",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /S9: quota once|D2 \(accepted limit\)/,
    patch: (t) =>
      sub(
        t,
        "              if (alive(b) && !quotaHeld()) {\n",
        "              if (alive(b)) {\n",
      ),
  },
  {
    id: "MU-8C-Q3",
    title:
      "WEB-08c revision 4 (DA-N1, S7): a recovery quota stop is not recorded in the write-failure marker (a reload or a takeover retries it)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /S9: quota once|S7\/S6: the stop survives a reload/,
    patch: (t) =>
      sub(
        t,
        '    const recorded = recordStop(\n      deps.markers,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => memoryStops.add(memoryKey(service, operation)) },\n    );\n    if (recorded === "obsolete") return quiet();\n    stoppedOperation = operation;',
        '    const recorded = recordStop(\n      undefined,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => memoryStops.add(memoryKey(service, operation)) },\n    );\n    if (recorded === "obsolete") return quiet();\n    stoppedOperation = operation;',
      ),
  },
  {
    id: "MU-8C-Q4",
    title:
      "WEB-08c revision 4 (DA-N1): 'Try again' does not retire a recovery quota stop's marker (the person's act cannot end it)",
    file: "src/data/engine/recovery-job.ts",
    tests: ["tests/data/recovery-job.test.ts"],
    expect: /S9: quota once|S7\/S6: the stop survives a reload/,
    patch: (t) =>
      sub(
        t,
        '              current.cause === "storage_full") &&\n',
        "              (false as boolean)) &&\n",
      ),
  },
  // Merge qualification: the accepted lifecycle fact uses WEB-10a's announcement ownership.
  {
    id: "MU-2424",
    title:
      "WEB-10a accepted-base merge: an ended sign-in announces the lock-wait heading instead of its own",
    file: "src/app/SessionNotices.tsx",
    tests: ["tests/app/notice-announcements.test.tsx"],
    expect: /merged lifecycle: an ended sign-in announces its own heading/,
    patch: (t) =>
      sub(t, "? ENDED_IN_TREE.heading", "? LOCK_WAIT_BANNER.heading"),
  },
  {
    id: "MU-2425",
    title:
      "WEB-10a accepted-base merge: inventory rejects accepted lifecycle IDs",
    file: "scripts/lib/mutation-inventory.mjs",
    tests: ["tests/static/mutation-inventory.test.ts"],
    expect: /merged lifecycle IDs retain namespace validation/,
    patch: (t) =>
      sub(
        t,
        String.raw`/^MU-(?:\d+|8C-[A-Z]*\d+[a-z]?)$/`,
        String.raw`/^MU-\d+$/`,
      ),
  },
];

export const ENGINE_LIFECYCLE = [
  {
    id: "MU-1301",
    title:
      "WEB-08c revision 3 (R5, T24 A/S4): (REAL ENGINE) the recovery finishes after its FIRST catch-up page, before the final data commit (the fence is cleared early)",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-1 T24 A",
    expect: /LR-1 T24 A/,
    patch: (t) =>
      sub(
        t,
        '    if (hasMore) {\n      setState({ kind: "running", mode: issued.mode, path: issued.path });',
        '    if (hasMore && issued.mode !== "recovery") {\n      setState({ kind: "running", mode: issued.mode, path: issued.path });',
      ),
  },
  {
    id: "MU-1302",
    title:
      "WEB-08c revision 3 (R5, T24 B\u2032): (REAL ENGINE) a recovery snapshot's `409 access_changed` does not restart the snapshot",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-2 T24 B",
    expect: /LR-2 T24 B/,
    patch: (t) =>
      sub(
        t,
        '      if (code === "access_changed" && issued.path === "snapshot")',
        '      if (code === "access_changed" && issued.path === "snapshot" && (false as boolean))',
      ),
  },
  {
    id: "MU-1303",
    title:
      "WEB-08c revision 3 (R5, T24 C, QR2-a attribution): (REAL ENGINE) a RECOVERY-class request's 401 is not recorded as an observation",
    file: "src/session/kernel/send.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-3 T24 C",
    expect: /LR-3 T24 C/,
    patch: (t) =>
      sub(
        t,
        '  if (response.status === 401) {\n    observe("unauthenticated");',
        '  if (response.status === 401) {\n    if (inflight.klass !== "recovery") observe("unauthenticated");',
      ),
  },
  {
    id: "MU-1304",
    title:
      "WEB-08c revision 3 (R5, T24 C3): (REAL ENGINE) `finish_recovery` does not refuse a current-epoch entry (NOT_ELIGIBLE never answered)",
    file: "src/session/model/reducers/operation.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-4 T24 C3",
    expect: /LR-4 T24 C3/,
    patch: (t) =>
      sub(
        t,
        "        f.epoch >= input.epoch,\n",
        "        f.epoch > input.epoch,\n",
      ),
  },
  {
    id: "MU-1305",
    title:
      "WEB-08c revision 3 (R5, T24 C3 RERUN): (REAL ENGINE) `finish_recovery` removes older-epoch entries above the captured `s` too (over-clearing)",
    file: "src/session/model/reducers/operation.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-5 T24 C3",
    expect: /LR-5 T24 C3/,
    patch: (t) =>
      sub(
        t,
        "  const kept = list.filter((f) => !(f.epoch < input.epoch && f.seq <= input.s));",
        "  const kept = list.filter((f) => !(f.epoch < input.epoch));",
      ),
  },
  {
    id: "MU-1306",
    title:
      "WEB-08c revision 3 (R5, T24 D, K-3): (REAL ENGINE) the leading page publishes no recovery report (a follower never shows state 3). Revision 4: a report is announced AND answered to questions, so the mutant silences both (the announcement alone was equivalent: a follower that opens later asks; pool request-18efefc5e2a04a89829c, survived)",
    file: "src/data/leader/leader.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-6 T24 D",
    expect: /LR-6 T24 D/,
    patch: (t) =>
      sub(
        t,
        "    if (standing === null) return;\n",
        "    if (standing === null || (true as boolean)) return;\n",
      ),
  },
  {
    id: "MU-1308",
    title:
      "WEB-08c revision 3 (R5, T24 H(ii)): (REAL ENGINE) the leader binds an account whose operation is unresolved (row 3)",
    file: "src/data/leader/leader.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-8 T24 H\\(ii\\)",
    expect: /LR-8 T24 H\(ii\)/,
    patch: (t) =>
      sub(
        t,
        "    if (deps.operationPending(identity.account_id)) return;\n",
        "    void deps.operationPending;\n",
      ),
  },
  {
    id: "MU-1309",
    title:
      "WEB-08c revision 3 (R5, T24 H(iv)): (REAL ENGINE) E5 never converts an older-epoch unresolved lease into an entry (the reducer refuses every lease; a call-site mutant of recovery.begin was EQUIVALENT: verifyUnresolved converts first too)",
    file: "src/session/model/reducers/observation.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-9 T24 H\\(iv\\)",
    expect: /LR-9 T24 H\(iv\)/,
    patch: (t) =>
      sub(
        t,
        "        lease.epoch >= settled.epoch\n      )\n        continue;\n      pushFence(",
        "        lease.epoch >= 0\n      )\n        continue;\n      pushFence(",
      ),
  },
  {
    id: "MU-1313",
    title:
      "WEB-08c revision 3 (R8, HF-13): (REAL ENGINE) both corrections reverted: the level-0 gate does not cancel the mount's heading attempt and a deferred attempt takes focus from the restored control",
    file: "src/session/adapters/protected-surface.ts",
    spec: "tests/e2e/fixture.session-gate.spec.ts",
    grep: "HF-13 \\(revision 3\\)",
    expect: /HF-13 \(revision 3\)/,
    patch: (t) =>
      sub(
        sub(
          t,
          "      // The gate owns focus until the lift: a heading attempt still waiting from the mount is obsolete (HF-13).\n      focusToken += 1;\n",
          "",
        ),
        "      if (deferred && moved) return;\n",
        "",
      ),
  },
  {
    id: "MU-1314",
    title:
      "WEB-08c revision 4 (R9, S2): (REAL ENGINE) a follower asks for the leader's report ONCE per card (its paced question never re-arms, so neither time nor its own evaluations ask again; the timer-only form was equivalent natively: pool request-18efefc5e2a04a89829c, survived)",
    file: "src/data/leader/leader.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-12 S2",
    expect: /LR-12 S2/,
    patch: (t) =>
      sub(
        t,
        "        if (asking?.key !== key) return;\n        asking = null;\n        followStatus(Math.min(delay * 2, STATUS_ASK_MAX_MS));\n",
        "        void delay;\n",
      ),
  },
  {
    id: "MU-1315",
    title:
      "WEB-08c revision 4 (R9, S3): (REAL ENGINE) the scan reads only a displaying page (a visible follower on a recovery card never learns the completion when every hint is lost)",
    file: "src/session/session.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-13 S3",
    expect: /LR-13 S3/,
    patch: (t) =>
      sub(
        t,
        '(view.kind === "neutral" && /^[23]$/.test(view.state))',
        '(view.kind === "neutral" && (false as boolean))',
      ),
  },
  {
    id: "MU-1316",
    title:
      "WEB-08c revision 4 (DA-N1, S7): (REAL ENGINE) a recovery quota stop is not recorded in the write-failure marker (a reload retries it)",
    file: "src/data/engine/recovery-job.ts",
    spec: "tests/e2e/fixture.lifecycle-recovery.spec.ts",
    grep: "LR-15 S7",
    expect: /LR-15 S7/,
    patch: (t) =>
      sub(
        t,
        '    const recorded = recordStop(\n      deps.markers,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => memoryStops.add(memoryKey(service, operation)) },\n    );\n    if (recorded === "obsolete") return quiet();\n    stoppedOperation = operation;',
        '    const recorded = recordStop(\n      undefined,\n      service,\n      operation,\n      () => service.live,\n      { hold: () => memoryStops.add(memoryKey(service, operation)) },\n    );\n    if (recorded === "obsolete") return quiet();\n    stoppedOperation = operation;',
      ),
  },
];
