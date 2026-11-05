// Main reconciliation, 26 October 2026: WEB-13b MU-2501..MU-2551 are now MU-2586..MU-2636 (+85). Base merge, 5 November 2026: those
// that collided with WEB-11a's catalogue are now MU-5065..MU-5109 (`web13b-id-map-20261105.json`).
// Historical reports keep their original IDs; mutation patches, selectors and assertions are unchanged.
// WEB-13b revision 2's mutants (review 2, R3a/R3b; the design assessment's sensitivity list), in the form and under the rules of
// `data-catalogue.mjs`, which spreads them into its `UNIT` list after `catalogue-web13b-r1.mjs`. Each removes ONE guard of the anchor
// editing session (`anchor-editor.ts`) or its visit owner (`anchor-kept.ts`); `expect` names the tests written for it, so only an assertion
// of those tests catches it. `sub` is the catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

const EDITOR = "src/features/calendars/anchor-editor.ts";
const ANCHOR_DIALOG = "src/features/calendars/AnchorDialog.tsx";
const KEPT = "src/features/tasks/detail/anchor-kept.ts";
const SECTION = "src/features/tasks/detail/AnchorSection.tsx";
const T_EDITOR = "tests/features/calendars/anchor-editor.test.ts";
const T_SECTION = "tests/features/tasks/anchor-section.test.tsx";

/**
 * Unit mutants (layer L1b, the production composition over the IndexedDB double; L1a for the session alone), MU-5069..MU-5080. Not kept,
 * as equivalent (recorded in the revision report): the panel closing on a session that ended before it mounted (no panel is ever shown for
 * an ended session) and the section's "only the panel shown closes" check on its own `onClose` (an unmounted panel has no subscription).
 */
export const UNIT_13B_R2 = [
  {
    id: "MU-5069",
    title:
      "WEB-13b R3a: a kept session shown again is copied into a NEW session (the save being made settles on a session no panel shows)",
    file: KEPT,
    tests: [T_SECTION],
    expect:
      /R3a: newer input kept by the sync control while its earlier save was being made is saved next as a new change, shown again before|an unchanged save shown again before it completes/,
    patch: (t) =>
      sub(
        t,
        "    held.editor.resume();\n    return held.editor as AnchorEditor<C>;\n",
        "    return createAnchorEditor<C>({\n      draft: held.editor.state().draft,\n      names: held.editor.state().names,\n      context: held.editor.context() as C,\n      renew,\n    });\n",
      ),
  },
  {
    id: "MU-5070",
    title:
      "WEB-13b R3b: an ended (cancelled) session's late completion still settles, and its consumption removes the session the task has now",
    file: EDITOR,
    tests: [T_SECTION, T_EDITOR],
    expect: /R3b|an ended session's late completion changes nothing/,
    patch: (t) =>
      sub(
        t,
        "    if (over || waiting?.submission !== ticket.submission) return;\n",
        "    if (waiting?.submission !== ticket.submission) return;\n",
      ),
  },
  {
    id: "MU-5071",
    title:
      "WEB-13b R3a: a session admits a second save while one is still being made (a panel shown again saves twice)",
    file: EDITOR,
    tests: [T_SECTION, T_EDITOR],
    expect:
      /an unchanged save shown again before it completes|at most one save at a time/,
    patch: (t) =>
      sub(
        t,
        "      if (over || waiting !== null) return false;\n",
        "      if (over) return false;\n",
      ),
  },
  {
    id: "MU-5072",
    title:
      "WEB-13b R3a: a save being made is not shown as such (a panel shown again offers Save while the session cannot take it)",
    file: EDITOR,
    tests: [T_SECTION, T_EDITOR],
    expect:
      /shown again before the earlier save completes|an unchanged save shown again before it completes|kept, shown, kept and shown again|R3b \(pending\)|done with nothing edited since/,
    patch: (t) =>
      sub(
        t,
        "      change({ busy: true, note: null });\n",
        "      change({ note: null });\n",
      ),
  },
  {
    id: "MU-5073",
    title:
      "WEB-13b R3b: a refused save is settled as a done one (the refused input is consumed)",
    file: EDITOR,
    tests: [T_SECTION, T_EDITOR],
    expect:
      /R3b: a cancelled panel's save completing|refused: nothing is consumed or renewed/,
    patch: (t) =>
      sub(
        t,
        "    } else if (refused !== null) change({ busy: false, note: refused });\n",
        "    }\n",
      ),
  },
  {
    id: "MU-5074",
    title:
      "WEB-13b R2/R3: a change's identity is the section mount's, not the visit's (retried after a hand-off, a change that may be stored is stored twice)",
    file: KEPT,
    tests: [T_SECTION],
    expect:
      /retried as the same operation|R3b: a cancelled panel's save completing|the same change pressed in a NEW panel of a NEW section mount/,
    patch: (t) =>
      sub(
        t,
        "  if (owner === null || owner.ended()) return mine;\n",
        "  return mine;\n",
      ),
  },
  {
    id: "MU-5075",
    title:
      "WEB-13b R3a: showing a kept session again takes it from its visit (kept again by the sync control, it is lost)",
    file: KEPT,
    tests: [T_SECTION],
    expect: /kept, shown, kept and shown again/,
    patch: (t) =>
      sub(
        t,
        "    held.editor.resume();\n",
        "    held.editor.resume();\n    panels.delete(key);\n",
      ),
  },
  {
    id: "MU-5076",
    title:
      "WEB-13b R3: a panel that left without Cancel while its visit goes on leaves nothing (its input is lost)",
    file: KEPT,
    tests: [T_SECTION],
    expect: /a panel that left without Cancel/,
    patch: (t) =>
      sub(
        t,
        "  return state.revision > 0 || state.busy;\n",
        "  return false;\n",
      ),
  },
  {
    id: "MU-5077",
    title:
      "WEB-13b R3b: Cancel does not end the session it showed (the next panel resumes the cancelled input)",
    file: SECTION,
    tests: [T_SECTION],
    expect:
      /Cancel discards|R3b|an earlier, cancelled session's completion never closes/,
    patch: (t) =>
      sub(
        t,
        "            if (!dialog.editor.retained())\n              discardPanel(panelKey, dialog.editor as AnchorEditor<unknown>);\n",
        "",
      ),
  },
  {
    id: "MU-5078",
    title:
      "WEB-13b R3: a session consumed by its own save does not close the panel showing it",
    file: ANCHOR_DIALOG,
    tests: [T_SECTION],
    expect:
      /R3 control: nothing edited while saving closes the panel|an unchanged save shown again before it completes/,
    patch: (t) =>
      sub(t, '      if (event === "consumed") close.current();\n', ""),
  },
  {
    id: "MU-5079",
    title:
      "WEB-13b R3 (changed refusal): told that the task changed, saving again is checked against what the panel was opened from (refused for ever)",
    file: SECTION,
    tests: [T_SECTION],
    expect: /told that the task changed/,
    patch: (t) =>
      sub(
        t,
        "          context: { ...context, renewed: true },\n",
        "          context,\n",
      ),
  },
  {
    id: "MU-5080",
    title:
      "WEB-13b R3 (changed refusal): a refusal's renewed context is ignored by the session",
    file: EDITOR,
    tests: [T_SECTION, T_EDITOR],
    expect: /told that the task changed|a refusal that renews/,
    patch: (t) => sub(t, "      current = refused.context;\n", ""),
  },
];
