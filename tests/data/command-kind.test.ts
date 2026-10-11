// @vitest-environment node
import { describe, expect, test } from "vitest";
import { commandKindOf } from "../../src/data/model/outbox";

/**
 * The header kind of a draft (WEB-11a §3.1 item 1, the same rule as WEB-13a's D-13a-3): a SINGLE wrapped command (`{command: {kind}}`,
 * the body of `/task-commands`) has its own kind, so `put_field` and `archive` can be registered and described apart. PURE.
 */
describe("commandKindOf", () => {
  test("a top-level kind wins", () => {
    expect(commandKindOf({ kind: "edit", command: { kind: "x" } }, "/c")).toBe(
      "edit",
    );
  });

  test("a wrapped command's kind is the kind (put_field, archive), not the endpoint", () => {
    expect(
      commandKindOf(
        { command: { kind: "put_field", id: "f" }, defaults_revision: "r" },
        "/task-commands",
      ),
    ).toBe("put_field");
    expect(
      commandKindOf(
        { command: { kind: "archive", id: "p", archived: true } },
        "/task-commands",
      ),
    ).toBe("archive");
  });

  test("a group's first member names a group; an empty group falls through to the endpoint", () => {
    expect(
      commandKindOf(
        { commands: [{ kind: "create_person" }, { kind: "create_field" }] },
        "/commands",
      ),
    ).toBe("create_person");
    expect(commandKindOf({ commands: [] }, "/commands")).toBe("/commands");
  });

  test("a wrapped value that is not an object with a string kind falls through to the endpoint", () => {
    for (const command of [
      { command: "put_field" },
      { command: null },
      { command: [{ kind: "put_field" }] },
      { command: { kind: 3 } },
      { command: {} },
    ])
      expect(commandKindOf(command as never, "/task-commands")).toBe(
        "/task-commands",
      );
  });

  test("nothing recognisable: the endpoint", () => {
    expect(commandKindOf({ n: 1 }, "/task-commands")).toBe("/task-commands");
  });
});
