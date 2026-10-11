// @vitest-environment node
import { beforeEach, describe, expect, test } from "vitest";
import type { CurrentReadIo } from "../../../src/data";
import { createCommandRegistry } from "../../../src/data/outbox/registries";
import {
  forgetArchiveReaders,
  registerArchiveKind,
  registerArchiveReader,
} from "../../../src/features/content/archive-registration";
import { registerPeopleCommands } from "../../../src/features/people/register";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * WEB-11a's registrations (§3.4): describe, the authorised current read (never the cache) and rebuild per kind, and EXACTLY ONE `archive`
 * registration, shared with WEB-10a through `content/archive-registration.ts`. The `/sync` screens use them (A18).
 */
const P = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const person = (over = {}) => ({
  id: P,
  kind: "person",
  parent_id: null,
  label: "Ada",
  value: null,
  version: 4,
  can_edit: true,
  policy_version: 2,
  archived: false,
  ...over,
});
const field = (over = {}) => ({
  ...person(),
  id: F,
  kind: "field",
  parent_id: P,
  label: "Phone",
  value: { kind: "text", text: "0770" },
  ...over,
});

function io(
  routes: Record<string, () => Response>,
): CurrentReadIo & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    signal: new AbortController().signal,
    get: async (path) => {
      asked.push(path);
      const route = routes[path];
      return route ? route() : new Response("{}", { status: 404 });
    },
  };
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

const putDraft = (update: boolean) =>
  draftRow({
    endpoint: "/task-commands",
    command: {
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        ...(update ? { expected_version: 1, expected_policy_version: 1 } : {}),
        label: "Mobile",
        value: { kind: "text", text: "0771" },
      },
    },
  });
const renameDraft = () =>
  draftRow({
    command: {
      commands: [
        {
          kind: "edit",
          id: P,
          expected_version: 1,
          expected_policy_version: 1,
          label: "Ada L.",
          value: "",
        },
      ],
    },
  });
const archiveDraft = (id: string) =>
  draftRow({
    endpoint: "/task-commands",
    command: {
      command: { kind: "archive", id, expected_version: 1, archived: true },
    },
  });

beforeEach(() => forgetArchiveReaders());

describe("registration", () => {
  test("describes every kind; registering twice is harmless; archive is registered once", () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    registerPeopleCommands(registry);
    // A second registrant of `archive` (WEB-10a's) goes through the same module and does not throw.
    registerArchiveKind(registry);
    expect(
      registry.describe(
        draftRow({ command: { commands: [{ kind: "create_person" }] } }),
      ),
    ).toBe("New person");
    expect(registry.describe(putDraft(true))).toBe("Field change");
    expect(registry.describe(renameDraft())).toBe("Name change");
    expect(registry.describe(archiveDraft(P))).toBe("Archive or restore");
    expect(() =>
      registry.register("archive", { describe: () => "x" }),
    ).toThrow();
  });
});

describe("current reads (authorised, never the cache)", () => {
  test("a field: its person's fields, then the archived ones", async () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const reader = io({
      [`/fields?parent_id=${P}&limit=200`]: json({
        items: [],
        next_after: null,
      }),
      [`/fields?parent_id=${P}&limit=200&archived=true`]: json({
        items: [field({ archived: true, version: 7 })],
        next_after: null,
      }),
    });
    const read = await registry.readCurrent(putDraft(true), reader);
    expect(read).toEqual({
      kind: "loaded",
      value: { ...field({ archived: true, version: 7 }), kind_date: null },
    });
  });

  test("a field that is in neither list is indeterminate; a 403 is inaccessible", async () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const empty = io({
      [`/fields?parent_id=${P}&limit=200`]: json({
        items: [],
        next_after: null,
      }),
      [`/fields?parent_id=${P}&limit=200&archived=true`]: json({
        items: [],
        next_after: null,
      }),
    });
    expect(await registry.readCurrent(putDraft(true), empty)).toEqual({
      kind: "indeterminate",
    });
    const refused = io({
      [`/fields?parent_id=${P}&limit=200`]: json(
        { code: "forbidden", message: "", request_id: "x", details: [] },
        403,
      ),
    });
    expect(await registry.readCurrent(putDraft(true), refused)).toEqual({
      kind: "failed",
      reason: "inaccessible",
    });
  });

  test("a person rename reads GET /people/{id}; a merged id resolving to another person is indeterminate", async () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const ok = io({
      [`/people/${P}`]: json({ person: person(), linked_account_id: null }),
    });
    expect(await registry.readCurrent(renameDraft(), ok)).toMatchObject({
      kind: "loaded",
    });
    const merged = io({
      [`/people/${P}`]: json({
        person: person({ id: F }),
        linked_account_id: null,
      }),
    });
    expect(await registry.readCurrent(renameDraft(), merged)).toEqual({
      kind: "indeterminate",
    });
  });

  test("archive: the person reader answers for a person; a 404 there passes to the next reader, and none is indeterminate", async () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const ok = io({
      [`/people/${P}`]: json({ person: person(), linked_account_id: null }),
    });
    expect(await registry.readCurrent(archiveDraft(P), ok)).toMatchObject({
      kind: "loaded",
    });
    expect(await registry.readCurrent(archiveDraft(F), io({}))).toEqual({
      kind: "indeterminate",
    });
    // A later reader (WEB-10a's task reader) is asked after the person reader declined.
    const asked: string[] = [];
    registerArchiveReader(async (id) => {
      asked.push(id);
      return { kind: "loaded", value: cacheRow({ id, kind: "task" }) };
    });
    expect(await registry.readCurrent(archiveDraft(F), io({}))).toMatchObject({
      kind: "loaded",
    });
    expect(asked).toEqual([F]);
  });
});

describe("rebuild (on the authorised current read)", () => {
  test("a field update: the same name and value on the CURRENT version and policy version", () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const current = cacheRow({
      id: F,
      kind: "field",
      parent_id: P,
      version: 7,
      policy_version: 3,
    });
    const request = registry.rebuild(putDraft(true), current);
    expect(request?.build({}).command).toEqual({
      command: {
        kind: "put_field",
        id: F,
        parent_id: P,
        expected_version: 7,
        expected_policy_version: 3,
        label: "Mobile",
        value: { kind: "text", text: "0771" },
      },
    });
  });

  test("nothing is rebuilt without a current read, without a policy version, or for a create", () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const current = cacheRow({
      id: F,
      kind: "field",
      parent_id: P,
      version: 7,
      policy_version: 3,
    });
    expect(registry.rebuild(putDraft(true), null)).toBeNull();
    expect(
      registry.rebuild(
        putDraft(true),
        cacheRow({ id: F, kind: "field", version: 7 }),
      ),
    ).toBeNull();
    expect(registry.rebuild(putDraft(false), current)).toBeNull();
  });

  test("a rename and an archive rebuild on the current versions", () => {
    const registry = createCommandRegistry();
    registerPeopleCommands(registry);
    const current = cacheRow({
      id: P,
      kind: "person",
      version: 9,
      policy_version: 4,
    });
    expect(registry.rebuild(renameDraft(), current)?.build({}).command).toEqual(
      {
        commands: [
          {
            kind: "edit",
            id: P,
            expected_version: 9,
            expected_policy_version: 4,
            label: "Ada L.",
            value: "",
          },
        ],
      },
    );
    expect(
      registry.rebuild(archiveDraft(P), current)?.build({}).command,
    ).toEqual({
      command: { kind: "archive", id: P, expected_version: 9, archived: true },
    });
  });
});
