// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { CurrentReadIo } from "../../../src/data";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import { forgetArchiveReaders } from "../../../src/features/content/archive-registration";
import { registerPeopleCommands } from "../../../src/features/people/register";
import { registerTaskCommands } from "../../../src/features/tasks/register";
import { cacheRow, draftRow, uuid } from "../../support/data/rows";

const ID = uuid(1);
const revision = "a".repeat(64);
const draft = () =>
  draftRow({
    endpoint: "/task-commands",
    target_resource_ids: [ID],
    status: "version_conflict",
    defaults_revision: revision,
    command: {
      defaults_revision: revision,
      command: { kind: "archive", id: ID, expected_version: 1, archived: true },
    },
  });
const row = (kind: "person" | "task") =>
  cacheRow({ id: ID, kind, version: 7, policy_version: 2 });
function reader(
  kind: "person" | "task",
  status = 200,
): CurrentReadIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    signal: new AbortController().signal,
    get: async (path) => {
      asked.push(path);
      const matches =
        path === `/${kind === "person" ? "people" : "tasks"}/${ID}`;
      const { kind_date: _date, ...projection } = row(kind);
      const body =
        kind === "person"
          ? { person: projection, linked_account_id: null }
          : { task: projection, execution: null, materialisation: null };
      return new Response(JSON.stringify(body), {
        status: matches ? status : 404,
      });
    },
  };
}

beforeEach(forgetArchiveReaders);

describe.each(["people-first", "tasks-first"] as const)(
  "shared archive: %s",
  (order) => {
    const registry = () => {
      const value = createCommandRegistry();
      const registrations =
        order === "people-first"
          ? [registerPeopleCommands, registerTaskCommands]
          : [registerTaskCommands, registerPeopleCommands];
      for (const register of [...registrations, ...registrations])
        register(value);
      return value;
    };

    test("both real registrars are idempotent and retain each slice's commands", () => {
      expect(registry).not.toThrow();
      const commands = registry();
      expect(commands.describe(draft())).toBe("Archive or restore");
      expect(commands.describe(draftRow({ kind: "create_person" }))).toBe(
        "New person",
      );
      expect(commands.describe(draftRow({ kind: "create_task" }))).toBe(
        "New task",
      );
    });

    test.each(["person", "task"] as const)(
      "reads the authorised %s after another slice's 404",
      async (kind) => {
        const io = reader(kind);
        expect(await registry().readCurrent(draft(), io)).toMatchObject({
          kind: "loaded",
          value: row(kind),
        });
        expect(io.asked.at(-1)).toBe(
          `/${kind === "person" ? "people" : "tasks"}/${ID}`,
        );
        expect(io.asked).toHaveLength(
          (order === "people-first") === (kind === "person") ? 1 : 2,
        );
      },
    );

    test("task replacement retains the reviewed base, permission, captured defaults and draft identity", () => {
      const commands = registry();
      const stored = draft();
      const replacement = commands.rebuild(stored, row("task"));
      expect(replacement).not.toBeNull();
      expect(replacement?.targets).toEqual([
        expect.objectContaining({
          resourceId: ID,
          reviewedBase: 7,
          requiresEdit: true,
          versionChecked: true,
        }),
      ]);
      expect(replacement?.build({ [ID]: 7 })).toMatchObject({
        command: {
          defaults_revision: revision,
          command: {
            kind: "archive",
            id: ID,
            expected_version: 7,
            archived: true,
          },
        },
        defaultsRevision: revision,
      });
      expect(replacement?.expectDraft?.(stored)).toBe(true);
      expect(
        replacement?.expectDraft?.({ ...stored, command_digest: "changed" }),
      ).toBe(false);
      expect(
        commands.rebuild(stored, { ...row("task"), can_edit: false }),
      ).toBeNull();
      expect(commands.admission(stored)).toEqual({
        [ID]: { requiresEdit: true },
      });
      expect(
        commands.rebuild(stored, row("person"))?.build({}).command,
      ).toEqual({
        command: {
          kind: "archive",
          id: ID,
          expected_version: 7,
          archived: true,
        },
      });
    });

    test("a task permission refusal is retained and an unknown target stays indeterminate", async () => {
      const commands = registry();
      expect(await commands.readCurrent(draft(), reader("task", 403))).toEqual({
        kind: "failed",
        reason: "inaccessible",
      });
      expect(await commands.readCurrent(draft(), reader("task", 404))).toEqual({
        kind: "indeterminate",
      });
    });
  },
);
