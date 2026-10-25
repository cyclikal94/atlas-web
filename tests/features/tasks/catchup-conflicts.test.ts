// @vitest-environment node
import { describe, expect, test } from "vitest";
import { createConflictHandlerRegistry } from "../../../src/data/outbox/registries";
import { registerCatchUpConflicts } from "../../../src/features/tasks/catchup/useCatchUp";
import { draftRow } from "../../support/data/rows";

/**
 * The command path of catch-up (CM-432, A7; fixture-only: the released backend raises `materialisation_required` on no command). A task
 * command is retried with its own key; any other draft keeps the generic rule (MU-10C-34). Registered once per registry.
 */
const TASK = "aaaaaaaa-0000-4000-8000-0000000000c1";
const decide = (
  registry: ReturnType<typeof createConflictHandlerRegistry>,
  command: Record<string, string | number | boolean>,
  kind?: string,
) =>
  registry.decide({
    draft: draftRow({ command: { command }, ...(kind ? { kind } : {}) }),
    status: 409,
    code: "materialisation_required",
  });

describe("the materialisation_required handler", () => {
  test("a task command naming its task is retried; an occurrence-level one or another slice's draft keeps the generic rule", () => {
    const registry = createConflictHandlerRegistry();
    registerCatchUpConflicts(registry);
    registerCatchUpConflicts(registry);
    expect(
      decide(
        registry,
        { kind: "archive", id: TASK, expected_version: 1, archived: true },
        "archive",
      ),
    ).toEqual({ kind: "reclassify", as: "retry" });
    expect(
      decide(registry, { kind: "revise_task", id: TASK }, "revise_task"),
    ).toEqual({ kind: "reclassify", as: "retry" });
    // MU-10C-34: a non-task draft is never reclassified.
    expect(
      decide(
        registry,
        { kind: "configure_source", task_id: TASK },
        "configure_source",
      ),
    ).toEqual({
      kind: "default",
    });
    expect(
      decide(registry, { kind: "record", occurrence_id: TASK }, "record"),
    ).toEqual({ kind: "default" });
    // Another code is not this handler's.
    expect(
      registry.decide({
        draft: draftRow({
          command: { command: { kind: "archive", id: TASK } },
          kind: "archive",
        }),
        status: 409,
        code: "conflict",
      }),
    ).toEqual({ kind: "default" });
  });
});
