import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  cautionText,
  SWITCH_COPY,
  signInAs,
  stayAs,
  waitingTag,
} from "../../../src/features/switch/switch-copy";
import { sourceText } from "../../support/source-text";

/**
 * WEB-08c: copy conformance of WF-SWITCH-01/02, as `copy-conformance.test.ts` does for WEB-08b. Every [W]/[D] string is compared with
 * the staged source by script; every [P] is listed. Skipped (and reported as skipped) when the approval bundle is absent.
 */
const ROOT = resolve(__dirname, "../../..");
const STAGED = join(ROOT, ".agtx/approved");
const FILES = {
  switch01: join(
    STAGED,
    "artefacts/WEB-05.5/outputs/wireframes/gaps/switch-01-desktop.html",
  ),
  switch02: join(
    STAGED,
    "artefacts/WEB-05.5/outputs/wireframes/gaps/switch-02-desktop.html",
  ),
  states: join(
    STAGED,
    "artefacts/WEB-02/outputs/WEB-02/wireframes/switch/states.md",
  ),
  syncBoard: join(
    STAGED,
    "approval/design_handoff_atlas_web/Atlas Sync Screens.dc.html",
  ),
};
const staged = Object.values(FILES).every((file) => existsSync(file));

function textOf(file: string): string {
  const raw = readFileSync(file, "utf8");
  if (file.endsWith(".md")) return raw.replace(/\s+/g, " ");
  const html = raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe.skipIf(!staged)(
  "[W] and [D] switch strings equal their staged source",
  () => {
    const src = staged
      ? {
          switch01: textOf(FILES.switch01),
          switch02: textOf(FILES.switch02),
          states: textOf(FILES.states),
          syncBoard: textOf(FILES.syncBoard),
        }
      : { switch01: "", switch02: "", states: "", syncBoard: "" };

    const W01: Array<[string, string]> = [
      ["the title", SWITCH_COPY.title],
      ["the current row", SWITCH_COPY.signedInNow],
      ["a retained row", SWITCH_COPY.usedBefore],
      ["another account", SWITCH_COPY.differentAccount],
      ["the model note", SWITCH_COPY.note],
      ["the waiting tag", waitingTag(2)],
    ];
    test.each(W01)(
      "[W] switch-01-desktop.html and [D] Sync board: %s",
      (_name, text) => {
        expect(src.switch01).toContain(text);
        expect(src.syncBoard).toContain(text);
      },
    );

    test("[W] states.md E: the empty state and its action", () => {
      expect(src.states).toContain(SWITCH_COPY.onlyOne);
      expect(src.states).toContain(SWITCH_COPY.addAnother);
    });

    const W02: Array<[string, string]> = [
      ["the heading and primary control", signInAs("sam")],
      ["the caution heading", SWITCH_COPY.cautionHeading],
      ["the cancel control", stayAs("kieran")],
    ];
    test.each(W02)(
      "[W] switch-02-desktop.html and [D] Sync board: %s",
      (_name, text) => {
        expect(src.switch02).toContain(text);
        expect(src.syncBoard).toContain(text);
      },
    );

    test("[W] switch-02-desktop.html: the caution (the board's MOBILE frame says 'this phone'; the desktop wording is used)", () => {
      const caution = cautionText("kieran", 2);
      expect(src.switch02).toContain(caution);
      expect(src.syncBoard).toContain(
        caution.replace("this computer", "this phone"),
      );
    });
  },
);

describe("the provisional switch strings are listed", () => {
  test("every [P] in switch-copy.ts is one of the known provisional entries", () => {
    const source = sourceText("src/features/switch/switch-copy.ts");
    const provisional = [
      ...source.matchAll(/\/\*\* \[P\][^*]*\*\/\s*\n\s*(\w+)/g),
    ]
      .map((m) => m[1])
      .filter((name) => name !== "export");
    expect(provisional.sort()).toEqual(
      [
        "loading",
        "signInOther",
        "thisAccount",
        "unknownListing",
        "unnamedRetained",
      ].sort(),
    );
    // The singular "1 item" and the rail control's accessible name are provisional too (functions, listed here by hand).
    expect(cautionText("kieran", 1)).toContain(
      "kieran has 1 item still waiting",
    );
    expect(source).toMatch(/\[P\] the rail control's accessible name/);
  });
});

describe("D-8c-05: the switch journey is lazily loaded", () => {
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : /\.(ts|tsx)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  test("nothing under src imports SwitchFlow statically; entry.tsx imports it only through import()", () => {
    const offenders: string[] = [];
    for (const file of files("src")) {
      const text = sourceText(file);
      const rel = relative(ROOT, join(ROOT, file));
      if (/from\s+["'][^"']*\/SwitchFlow["']/.test(text)) offenders.push(rel);
      if (
        /import\s*\(\s*["'][^"']*SwitchFlow["']\s*\)/.test(text) &&
        rel !== "src/features/switch/entry.tsx"
      )
        offenders.push(`${rel} (dynamic)`);
    }
    expect(offenders).toEqual([]);
    expect(sourceText("src/features/switch/entry.tsx")).toMatch(
      /lazy\(\(\) => import\("\.\/SwitchFlow"\)\)/,
    );
  });
  test("the retained-account listing is imported only by the lazy switch chunk (never on the boot path)", () => {
    const users = files("src").filter((file) =>
      /listRetainedAccounts/.test(sourceText(file)),
    );
    expect(users.sort()).toEqual(
      [
        "src/data/index.ts",
        "src/data/store/retained-accounts.ts",
        "src/features/switch/SwitchFlow.tsx",
      ].sort(),
    );
  });
});
