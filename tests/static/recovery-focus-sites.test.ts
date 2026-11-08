// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * WEB-14a revision 57 (Review 57, F-R57-1; design assessment of 6 November 2026, C-F3, I-F4): every `<RecoveryNotice>` site names where a
 * restored editor's focus goes (`firstFieldRef`, and `discardFocus` where it differs), and each is registered here with the KIND of its
 * target:
 *
 *  - `ref`: a ref to the control itself (`useRef` in the file): valid by construction;
 *  - `region`: a resolver answered from a region of the editor that never holds the notice (a grants list, the fix form, the order);
 *  - `closure`: a resolver over a body that also holds the notice (its answer must still be the editor's own control).
 *
 * A `region` or `closure` site must name a jsdom test that asserts focus after a restore (`toHaveFocus` or the active element). A new
 * site, a site gone, a changed target or kind, or a named test that does not exist fails here until the registry and its test are
 * written. `focus.ts` refuses any target inside a recovery surface at runtime (C-F2); this is the per-site half of the contract.
 */
type Kind = "ref" | "region" | "closure";
interface Site {
  firstFieldRef: string;
  discardFocus?: string;
  kind: Kind;
  /** The test that asserts where focus lands after a restore (required for `region` and `closure`). */
  focusTest?: { file: string; title: string };
}

const SITES: Record<string, Site[]> = {
  "src/features/calendars/AddSourceDialog.tsx": [
    { firstFieldRef: "labelRef", kind: "ref" },
  ],
  // WEB-13b maintenance merge of accepted main, correction M-13b-1 G-2: the anchor panel's first field (the reference's first radio).
  "src/features/calendars/AnchorDialog.tsx": [
    { firstFieldRef: "referenceRef", kind: "ref" },
  ],
  // M-13b-1 G-3: the import dialog's From (a copy never holds a file, so the file's button is never where focus goes).
  "src/features/calendars/ImportDialog.tsx": [
    { firstFieldRef: "fromRef", kind: "ref" },
  ],
  "src/features/calendars/LinkCalendarDialog.tsx": [
    { firstFieldRef: "labelRef", kind: "ref" },
  ],
  "src/features/calendars/ManageSourceDialog.tsx": [
    { firstFieldRef: "timezoneRef", kind: "ref" },
  ],
  "src/features/people/detail/IdentityHeader.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
  "src/features/people/field/FieldEditorDialog.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
  "src/features/people/list/NewPersonDialog.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
  "src/features/settings/sessions-devices/NameDeviceDialog.tsx": [
    { firstFieldRef: "field", kind: "ref" },
  ],
  "src/features/sharing/DefaultsEditor.tsx": [
    {
      firstFieldRef: "choiceFocus",
      kind: "region",
      focusTest: {
        file: "tests/features/recovery-owner-discard.test.tsx",
        title:
          "revision 51 (F-R51-1): restore focuses the layer's CHOSEN option; a keyboard discard focuses the option its reset chose, choosing nothing",
      },
    },
  ],
  // WEB-12b merge correction M-1: HouseholdsMinimal's two inline forms are WEB-12b's dialogs (New household and Rename; an invitation).
  "src/features/sharing/households/InvitationsDialog.tsx": [
    { firstFieldRef: "usernameRef", kind: "ref" },
  ],
  "src/features/sharing/households/NameDialogs.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
  "src/features/sharing/ResourcePolicyEditor.tsx": [
    {
      firstFieldRef: "grantsFocus",
      kind: "region",
      focusTest: {
        file: "tests/features/recovery-owner-discard.test.tsx",
        title:
          "revision 51 (F-R51-1): restore focuses the first grant (its chosen access); a keyboard discard focuses that grant as read again, choosing nothing",
      },
    },
  ],
  "src/features/tasks/detail/CorrectionDialog.tsx": [
    { firstFieldRef: "firstField", kind: "ref" },
  ],
  "src/features/tasks/detail/Dependencies.tsx": [
    {
      firstFieldRef: "firstField",
      kind: "ref",
      focusTest: {
        file: "tests/features/tasks/web10c-editors-recovery.test.tsx",
        title:
          "Q-F2: after the reload the editor opened on the copy focuses the Task select (not a chosen day's Remove, not the banner)",
      },
    },
  ],
  "src/features/tasks/detail/EntryHistory.tsx": [
    {
      firstFieldRef: "restoredFocus",
      discardFocus: "discardFocus",
      kind: "region",
      focusTest: {
        file: "tests/features/recovery-owner-hosts.test.tsx",
        title:
          "revision 51 (F-R51-1, decision D1): the opened restored fix focuses its new value; a keyboard discard closes it and focus goes to that entry's Fix this entry",
      },
    },
  ],
  "src/features/tasks/detail/RecordCard.tsx": [
    {
      firstFieldRef: "restoredFocus",
      kind: "region",
      focusTest: {
        file: "tests/features/recovery-owner-discard.test.tsx",
        title:
          "restore focuses the chosen mode, Just checked on it (no amount field); a keyboard discard focuses the amount field its reset brings back",
      },
    },
  ],
  "src/features/tasks/detail/Rota.tsx": [
    {
      firstFieldRef: "firstField",
      kind: "region",
      focusTest: {
        file: "tests/features/tasks/web10c-editors-recovery.test.tsx",
        title:
          "Q-F1: after the reload the dialog opened on the copy focuses the order's first usable control (Move down), inside the order, not the banner's Discard instead",
      },
    },
  ],
  "src/features/tasks/form/PresetPicker.tsx": [
    {
      firstFieldRef: "choiceFocus",
      kind: "closure",
      focusTest: {
        file: "tests/features/tasks/task-recovery-choice.test.tsx",
        title:
          "revision 51 (F-R51-1): the restored choice is focused (the checked preset); a keyboard discard focuses the preset its reset checks, choosing nothing",
      },
    },
  ],
  "src/features/tasks/form/TaskFormPage.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
  "src/features/tasks/lists/TaskPicker.tsx": [
    { firstFieldRef: "searchRef", kind: "ref" },
  ],
  "src/features/tasks/lists/dialogs.tsx": [
    { firstFieldRef: "nameRef", kind: "ref" },
    { firstFieldRef: "nameRef", kind: "ref" },
  ],
};

const ROOT = join(import.meta.dirname, "..", "..");

function sources(dir: string, out: Record<string, string> = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(name))
      out[relative(ROOT, full)] = readFileSync(full, "utf8");
  }
  return out;
}

/** Each `<RecoveryNotice …/>` element of `text`, with the two props that name focus targets. */
function noticeSites(
  text: string,
): Array<{ firstFieldRef: string | null; discardFocus: string | null }> {
  const found: Array<{
    firstFieldRef: string | null;
    discardFocus: string | null;
  }> = [];
  for (const match of text.matchAll(/<RecoveryNotice\b([\s\S]*?)\/>/g)) {
    const props = match[1] ?? "";
    found.push({
      firstFieldRef: /firstFieldRef=\{([^}]*)\}/.exec(props)?.[1] ?? null,
      discardFocus: /discardFocus=\{([^}]*)\}/.exec(props)?.[1] ?? null,
    });
  }
  return found;
}

/** Every difference between the source tree `files` and the registry `sites` (empty when they agree). */
function audit(
  files: Record<string, string>,
  sites: Record<string, Site[]>,
  read: (path: string) => string | null,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith("RecoveryNotice.tsx")) continue;
    const found = noticeSites(text);
    if (found.length === 0) continue;
    seen.add(file);
    const registered = sites[file];
    if (!registered) {
      problems.push(
        `${file}: ${found.length} unregistered RecoveryNotice site(s)`,
      );
      continue;
    }
    if (registered.length !== found.length) {
      problems.push(
        `${file}: ${found.length} RecoveryNotice site(s), ${registered.length} registered`,
      );
      continue;
    }
    found.forEach((site, i) => {
      const entry = registered[i] as Site;
      if (site.firstFieldRef !== entry.firstFieldRef)
        problems.push(
          `${file} #${i + 1}: firstFieldRef is ${site.firstFieldRef}, registered ${entry.firstFieldRef}`,
        );
      if ((site.discardFocus ?? undefined) !== entry.discardFocus)
        problems.push(
          `${file} #${i + 1}: discardFocus is ${site.discardFocus}, registered ${entry.discardFocus}`,
        );
      const name = entry.firstFieldRef.split(".").pop() as string;
      const declaredRef = new RegExp(`\\b${name}\\s*=\\s*useRef\\b`).test(text);
      if (entry.kind === "ref" && !declaredRef)
        problems.push(
          `${file} #${i + 1}: ${name} is registered as a ref but is not a useRef`,
        );
      if (entry.kind !== "ref" && declaredRef)
        problems.push(
          `${file} #${i + 1}: ${name} is a useRef, registered as ${entry.kind}`,
        );
      if (entry.kind !== "ref" && !entry.focusTest)
        problems.push(
          `${file} #${i + 1}: a ${entry.kind} target needs a focus test`,
        );
      if (entry.focusTest) {
        const test = read(entry.focusTest.file);
        if (test === null)
          problems.push(
            `${file} #${i + 1}: focus test file ${entry.focusTest.file} does not exist`,
          );
        else if (!test.includes(entry.focusTest.title))
          problems.push(
            `${file} #${i + 1}: no test titled "${entry.focusTest.title}" in ${entry.focusTest.file}`,
          );
        else if (!/toHaveFocus\(|document\.activeElement/.test(test))
          problems.push(
            `${file} #${i + 1}: ${entry.focusTest.file} asserts no focus`,
          );
      }
    });
  }
  for (const file of Object.keys(sites))
    if (!seen.has(file))
      problems.push(`${file}: registered, but has no RecoveryNotice site`);
  return problems;
}

const readRepo = (path: string): string | null => {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return null;
  }
};

describe("revision 57 (C-F3, Q-F7): every RecoveryNotice site is registered with its focus target's kind", () => {
  const files = sources(join(ROOT, "src"));

  // M-13b-1 (WEB-13b maintenance merge of accepted main): main's 22 sites (with WEB-12b's household dialogs) + WEB-13b's anchor
  // panel and import dialog = 24.
  test("the registry and the source agree: 24 sites, their targets, kinds and named focus tests", () => {
    expect(audit(files, SITES, readRepo)).toEqual([]);
    expect(Object.values(SITES).flat()).toHaveLength(24);
  });

  test("a 25th site, unregistered, fails", () => {
    const extra = {
      ...files,
      "src/features/new/Editor.tsx":
        "<RecoveryNotice recovery={r} firstFieldRef={first} />",
    };
    expect(audit(extra, SITES, readRepo)).toEqual([
      "src/features/new/Editor.tsx: 1 unregistered RecoveryNotice site(s)",
    ]);
  });

  test("a closure site registered without its focus test, or naming a test that does not exist, fails", () => {
    const rota = SITES["src/features/tasks/detail/Rota.tsx"] as Site[];
    const without = {
      ...SITES,
      "src/features/tasks/detail/Rota.tsx": [
        {
          firstFieldRef: rota[0]?.firstFieldRef ?? "",
          kind: "closure" as const,
        },
      ],
    };
    expect(audit(files, without, readRepo)).toEqual([
      "src/features/tasks/detail/Rota.tsx #1: a closure target needs a focus test",
    ]);
    const missing = {
      ...SITES,
      "src/features/tasks/detail/Rota.tsx": [
        {
          ...(rota[0] as Site),
          focusTest: {
            file: (rota[0] as Site).focusTest?.file ?? "",
            title: "no such test",
          },
        },
      ],
    };
    expect(audit(files, missing, readRepo)).toEqual([
      `src/features/tasks/detail/Rota.tsx #1: no test titled "no such test" in tests/features/tasks/web10c-editors-recovery.test.tsx`,
    ]);
  });

  test("a site whose target changes kind (a ref replaced by a resolver) fails", () => {
    const changed = {
      ...files,
      "src/features/tasks/form/TaskFormPage.tsx": (
        files["src/features/tasks/form/TaskFormPage.tsx"] ?? ""
      ).replace(
        /\bnameRef\s*=\s*useRef\b/,
        "nameRef = () => null; const x = useRefX",
      ),
    };
    expect(audit(changed, SITES, readRepo)).toEqual([
      "src/features/tasks/form/TaskFormPage.tsx #1: nameRef is registered as a ref but is not a useRef",
    ]);
  });
});
