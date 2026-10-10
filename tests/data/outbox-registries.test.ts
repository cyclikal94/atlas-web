// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  commandKind,
  createCommandRegistry,
  createConflictHandlerRegistry,
} from "../../src/data/outbox/registries";
import { cacheRow, draftRow } from "../support/data/rows";

/** The seams a feature slice registers through (plan 5.9). Fixture-level: nothing here is a real command. */
describe("CommandRegistry", () => {
  test("the kind is command.kind, else the first member of a command group, else the endpoint", () => {
    expect(commandKind(draftRow({ command: { kind: "create_person" } }))).toBe(
      "create_person",
    );
    expect(
      commandKind(
        draftRow({ command: { commands: [{ kind: "edit" }, { kind: "x" }] } }),
      ),
    ).toBe("edit");
    expect(
      commandKind(draftRow({ command: { n: 1 }, endpoint: "/task-commands" })),
    ).toBe("/task-commands");
    expect(
      commandKind(
        draftRow({ command: { commands: [] }, endpoint: "/commands" }),
      ),
    ).toBe("/commands");
  });

  test("describe and projectCreate follow the registered kind; an unregistered kind describes as nothing", () => {
    const registry = createCommandRegistry();
    registry.register("create_person", {
      describe: () => "Create a person",
      projectCreate: (d) =>
        cacheRow({ id: d.target_resource_ids[0] as string }),
    });
    const draft = draftRow({
      command: { kind: "create_person" },
      target_resource_ids: ["p"],
    });
    expect(registry.describe(draft)).toBe("Create a person");
    expect(registry.projectCreate(draft)?.id).toBe("p");
    expect(
      registry.describe(draftRow({ command: { kind: "other" } })),
    ).toBeNull();
    expect(
      registry.projectCreate(draftRow({ command: { kind: "other" } })),
    ).toBeNull();
  });

  test("registering a kind twice is a defect", () => {
    const registry = createCommandRegistry();
    registry.register("k", { describe: () => "a" });
    expect(() => registry.register("k", { describe: () => "b" })).toThrow();
  });
});

describe("ConflictHandlerRegistry", () => {
  test("no handler leaves the generic rule; a handler may reclassify; a throwing handler falls back to the generic rule", () => {
    const registry = createConflictHandlerRegistry();
    const context = { draft: draftRow(), status: 409, code: "conflict" };
    expect(registry.decide(context)).toEqual({ kind: "default" });
    registry.register("conflict", () => ({
      kind: "reclassify",
      as: "operation_conflict",
    }));
    expect(registry.decide(context)).toEqual({
      kind: "reclassify",
      as: "operation_conflict",
    });
    registry.register("boom", () => {
      throw new Error("bug");
    });
    expect(registry.decide({ ...context, code: "boom" })).toEqual({
      kind: "default",
    });
    expect(() =>
      registry.register("conflict", () => ({ kind: "default" })),
    ).toThrow();
  });
});
