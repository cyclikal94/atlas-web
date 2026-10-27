// @vitest-environment node
import { describe, expect, test } from "vitest";
import type {
  DependencyItem,
  DependencyPreview,
} from "../../../src/features/tasks/model/contract";
import { parseDependencyPreview } from "../../../src/features/tasks/model/contract";
import {
  admittedMode,
  causeOf,
  editorBlock,
  MAX_PREREQUISITES,
  modesOf,
  prerequisitesOf,
  progressOf,
  rootAdmitted,
  satisfiedPreview,
  validateList,
} from "../../../src/features/tasks/model/dependencies";

/** WF-TASK-04's pure parts (A8, A10, A11; D-10c-6/7): modes and their reasons, causes after a conflict, the editor's rules, the parser. */
const ROOT = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "aaaaaaaa-0000-4000-8000-0000000000b1";
const TASK = "aaaaaaaa-0000-4000-8000-0000000000ff";
const item = (
  id: string,
  over: Partial<DependencyItem> = {},
): DependencyItem => ({
  occurrence_id: id,
  task_id: TASK,
  complete: false,
  can_complete: true,
  progress_version: null,
  ...over,
});
const preview = (
  items: DependencyItem[],
  over: Partial<DependencyPreview> = {},
): DependencyPreview => ({
  token: "a".repeat(64),
  items: [...items, item(ROOT)],
  unavailable: false,
  strict: false,
  ...over,
});

describe("the preview", () => {
  test("parses exactly the contract: a 64-hex token, at most 200 unique items, booleans; anything else is null", () => {
    const ok = preview([item(A)]);
    expect(parseDependencyPreview(ok)).toEqual(ok);
    expect(parseDependencyPreview({ ...ok, token: "A".repeat(64) })).toBeNull();
    expect(parseDependencyPreview({ ...ok, extra: 1 })).toBeNull();
    expect(
      parseDependencyPreview({ ...ok, items: [item(A), item(A)] }),
    ).toBeNull();
    expect(
      parseDependencyPreview({
        ...ok,
        items: Array.from({ length: 201 }, (_, i) =>
          item(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`),
        ),
      }),
    ).toBeNull();
    expect(
      parseDependencyPreview({
        ...ok,
        items: [{ ...item(A), progress_version: 0 }, item(ROOT)],
      }),
    ).toBeNull();
  });

  test("the root is last and not a prerequisite; progress counts the visible prerequisites", () => {
    const p = preview([item(A, { complete: true }), item(B)]);
    expect(prerequisitesOf(p, ROOT).map((i) => i.occurrence_id)).toEqual([
      A,
      B,
    ]);
    expect(progressOf(p, ROOT)).toMatchObject({ done: 1, total: 2 });
    expect(progressOf(p, ROOT).firstOpen?.occurrence_id).toBe(B);
    expect(satisfiedPreview(p, ROOT)).toBe(false);
    expect(satisfiedPreview(preview([item(A, { complete: true })]), ROOT)).toBe(
      true,
    );
    // Something private is never "all done".
    expect(satisfiedPreview(preview([], { unavailable: true }), ROOT)).toBe(
      false,
    );
  });
});

describe("modes", () => {
  test("MU-10C-16: Start anyway is refused by a strict rule, offered otherwise", () => {
    expect(
      modesOf(preview([item(A)], { strict: true }), ROOT, true)
        .advisory_override,
    ).toBe("strict");
    expect(
      modesOf(preview([item(A)]), ROOT, true).advisory_override,
    ).toBeNull();
  });

  test("Tick the others off needs nothing private, every open item completable by me, and a root I can complete", () => {
    expect(
      modesOf(preview([item(A)]), ROOT, true).complete_prerequisites,
    ).toBeNull();
    expect(
      modesOf(preview([item(A)], { unavailable: true }), ROOT, true)
        .complete_prerequisites,
    ).toBe("unavailable");
    expect(
      modesOf(preview([item(A, { can_complete: false })]), ROOT, true)
        .complete_prerequisites,
    ).toBe("cannot_complete");
    // A completed item that I could not complete does not matter.
    expect(
      modesOf(
        preview([item(A, { complete: true, can_complete: false })]),
        ROOT,
        true,
      ).complete_prerequisites,
    ).toBeNull();
    expect(
      modesOf(preview([item(A)]), ROOT, false).complete_prerequisites,
    ).toBe("root");
  });
});

describe("the cause of a conflict, from a fresh preview", () => {
  const token = "a".repeat(64);
  test("all done now; private now; strict; cannot complete; changed", () => {
    expect(
      causeOf(
        "complete_prerequisites",
        token,
        preview([item(A, { complete: true })]),
        ROOT,
      ),
    ).toBe("satisfied");
    expect(
      causeOf(
        "complete_prerequisites",
        token,
        preview([item(A)], { unavailable: true }),
        ROOT,
      ),
    ).toBe("unavailable");
    expect(
      causeOf(
        "advisory_override",
        token,
        preview([item(A)], { strict: true }),
        ROOT,
      ),
    ).toBe("strict");
    expect(
      causeOf(
        "complete_prerequisites",
        token,
        preview([item(A, { can_complete: false })]),
        ROOT,
      ),
    ).toBe("cannot_complete");
    expect(
      causeOf(
        "require_satisfied",
        token,
        preview([item(A)], { token: "b".repeat(64) }),
        ROOT,
      ),
    ).toBe("changed");
  });
});

describe("the editor", () => {
  test("validates the whole list: at most 32, unique, never the day itself", () => {
    const many = Array.from(
      { length: MAX_PREREQUISITES + 1 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
    );
    expect(validateList(ROOT, many.slice(0, MAX_PREREQUISITES))).toBeNull();
    expect(validateList(ROOT, many)).toBe("too_many");
    expect(validateList(ROOT, [A, A])).toBe("duplicate");
    expect(validateList(ROOT, [A, ROOT])).toBe("self");
  });

  test("MU-10C-17: it opens only online, for an editor, with a fresh preview that holds nothing private", () => {
    const fresh = preview([item(A)]);
    expect(
      editorBlock({ online: true, canEdit: true, preview: fresh }),
    ).toBeNull();
    expect(
      editorBlock({
        online: true,
        canEdit: true,
        preview: { ...fresh, unavailable: true },
      }),
    ).toBe("unavailable");
    expect(editorBlock({ online: false, canEdit: true, preview: fresh })).toBe(
      "offline",
    );
    expect(editorBlock({ online: true, canEdit: false, preview: fresh })).toBe(
      "denied",
    );
    expect(editorBlock({ online: true, canEdit: true, preview: null })).toBe(
      "loading",
    );
  });
});

/**
 * Revision 3 (review R15): EVERY mode completes the root, so every mode needs it admitted, with what is sent for it: a tick-box root by
 * its `can_complete`, a numeric or checklist root only by the evidence entered for it.
 */
describe("R15: the root's admission in every mode", () => {
  test("rootAdmitted: a tick-box root by can_complete; any other by its entered evidence; no root item admits nothing", () => {
    const can = preview([item(A)]);
    const cannot: DependencyPreview = {
      ...can,
      items: [item(A), item(ROOT, { can_complete: false })],
    };
    expect(rootAdmitted(can, ROOT, "checkbox", false)).toBe(true);
    expect(rootAdmitted(cannot, ROOT, "checkbox", false)).toBe(false);
    // Entered evidence is not sent for a tick-box root: it admits nothing there.
    expect(rootAdmitted(cannot, ROOT, "checkbox", true)).toBe(false);
    expect(rootAdmitted(cannot, ROOT, "numeric", true)).toBe(true);
    expect(rootAdmitted(cannot, ROOT, "checklist", true)).toBe(true);
    // A numeric root's can_complete would record a tick its goal refuses.
    expect(rootAdmitted(can, ROOT, "numeric", false)).toBe(false);
    expect(rootAdmitted(can, ROOT, "checklist", false)).toBe(false);
    const rootless: DependencyPreview = { ...can, items: [item(A)] };
    expect(rootAdmitted(rootless, ROOT, "checkbox", true)).toBe(false);
    expect(rootAdmitted(rootless, ROOT, "numeric", true)).toBe(false);
  });

  test("modesOf: without the root, Mark done, Tick the others off and Start anyway all say root (strict still says strict)", () => {
    const done = preview([item(A, { complete: true })]);
    const open = preview([item(A)]);
    expect(modesOf(done, ROOT, false).require_satisfied).toBe("root");
    expect(modesOf(done, ROOT, true).require_satisfied).toBeNull();
    expect(modesOf(open, ROOT, true).require_satisfied).toBe("open");
    expect(modesOf(open, ROOT, false).advisory_override).toBe("root");
    expect(modesOf(open, ROOT, true).advisory_override).toBeNull();
    expect(
      modesOf(preview([item(A)], { strict: true }), ROOT, false)
        .advisory_override,
    ).toBe("strict");
    expect(modesOf(open, ROOT, false).complete_prerequisites).toBe("root");
  });

  test("admittedMode: no mode is sent without the root; each is sent with it where its own rule allows", () => {
    const done = preview([item(A, { complete: true })]);
    const open = preview([item(A)]);
    for (const mode of [
      "require_satisfied",
      "complete_prerequisites",
      "advisory_override",
    ] as const) {
      expect(admittedMode(done, ROOT, false, mode)).toBeNull();
      expect(admittedMode(open, ROOT, false, mode)).toBeNull();
    }
    expect(admittedMode(done, ROOT, true, "require_satisfied")).toBe(
      "require_satisfied",
    );
    expect(admittedMode(done, ROOT, true, "advisory_override")).toBeNull();
    expect(admittedMode(open, ROOT, true, "require_satisfied")).toBeNull();
    expect(admittedMode(open, ROOT, true, "advisory_override")).toBe(
      "advisory_override",
    );
    expect(admittedMode(open, ROOT, true, "complete_prerequisites")).toBe(
      "complete_prerequisites",
    );
    expect(admittedMode(open, ROOT, true, "wait")).toBeNull();
  });
});
