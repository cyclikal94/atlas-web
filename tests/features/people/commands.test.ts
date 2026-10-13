// @vitest-environment node
import { describe, expect, test } from "vitest";
import { estimateDraftBytes } from "../../../src/data/model/outbox";
import {
  archiveRequest,
  BaseMoved,
  baseGuard,
  createPersonRequest,
  editCreateRequest,
  putFieldCreateRequest,
  putFieldSharedBody,
  putFieldUpdateRequest,
  renameEditRequest,
  renameProfileBody,
  unlinkBody,
} from "../../../src/features/people/model/commands";
import { outboxWorld } from "../../support/data/outbox-world";
import { draftRow } from "../../support/data/rows";
import { HOME, REVISION, record } from "../../support/people/records";

/**
 * What WEB-11a sends (§3.3): TASK-10a's create/update preconditions, Q1's policy version on every update, SHARE-10's ordered batch,
 * WEB-12a's defaults capture, and the online-only bodies. Builds are asserted directly, then through the REAL outbox (fixture IndexedDB)
 * for the stored header (kind, review block, revision).
 */
const PERSON = "55555555-5555-4555-8555-555555555555";
const FIELD = "66666666-6666-4666-8666-666666666666";
const TEXT = { kind: "text" as const, text: "Penicillin allergy" };
const PRIVATE = { grants: [], exclude_accounts: [] };

describe("put_field create (TASK-10a)", () => {
  test("Only you: an explicit empty policy, no expected_version, no expected_policy_version, and NO defaults capture", () => {
    const request = putFieldCreateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "Medical note",
      value: TEXT,
      audience: "only_you",
      record: record(),
    });
    expect(request.endpoint).toBe("/task-commands");
    expect(request.targets).toEqual([
      {
        resourceId: FIELD,
        role: "primary",
        basis: "resource",
        versionChecked: false,
        seedIfUntracked: 1,
      },
    ]);
    const built = request.build({ [FIELD]: 1 });
    expect(built).toEqual({
      command: {
        command: {
          kind: "put_field",
          id: FIELD,
          parent_id: PERSON,
          label: "Medical note",
          value: TEXT,
          initial_policy: PRIVATE,
        },
      },
    });
  });

  test("Use my defaults: no policy, the field template captured with its revision as defaults_revision", () => {
    const built = putFieldCreateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "Phone",
      value: TEXT,
      audience: "defaults",
      record: record({ field: { kind: "primary_household", edit: false } }),
    }).build({});
    expect(built.command).toEqual({
      command: {
        kind: "put_field",
        id: FIELD,
        parent_id: PERSON,
        label: "Phone",
        value: TEXT,
      },
      defaults_revision: REVISION,
    });
    expect(built.defaultsRevision).toBe(REVISION);
    expect(built.defaultsReview).toEqual([]);
    expect(
      (built.defaultsContext as { kinds: Record<string, unknown> }).kinds,
    ).toHaveProperty("field");
  });

  test("Use my defaults with defaults never fetched: blocked for review, no defaults_revision sent", () => {
    const built = putFieldCreateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "Phone",
      value: TEXT,
      audience: "defaults",
      record: null,
    }).build({});
    expect(built.command).not.toHaveProperty("defaults_revision");
    expect(built.defaultsReview).toEqual(["field"]);
  });

  test("a field of a person that exists only on this device waits for the person's create", () => {
    const request = putFieldCreateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "x",
      value: TEXT,
      audience: "only_you",
      record: null,
      dependsOn: ["create-draft"],
    });
    expect(request.dependsOnExtra).toEqual(["create-draft"]);
  });
});

describe("put_field update (TASK-10a, Q1)", () => {
  test("carries the base as expected_version AND the policy version; never an initial_policy", () => {
    const request = putFieldUpdateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "Medical note",
      value: TEXT,
      policyVersion: 7,
      sameKind: true,
    });
    expect(request.targets[0]).toMatchObject({ versionChecked: true });
    const built = request.build({ [FIELD]: 4 });
    expect(built.command).toEqual({
      command: {
        kind: "put_field",
        id: FIELD,
        parent_id: PERSON,
        expected_version: 4,
        expected_policy_version: 7,
        label: "Medical note",
        value: TEXT,
      },
    });
    expect(built.displayPatch).toEqual({
      [FIELD]: { label: "Medical note", value: TEXT },
    });
  });

  test("a change of type patches only the label (the overlay's value merge is shallow)", () => {
    const built = putFieldUpdateRequest({
      fieldId: FIELD,
      personId: PERSON,
      label: "Weight",
      value: { kind: "quantity", amount: "70", unit: "kg" },
      policyVersion: 7,
      sameKind: false,
    }).build({ [FIELD]: 4 });
    expect(built.displayPatch).toEqual({ [FIELD]: { label: "Weight" } });
  });
});

describe("new person (SHARE-10)", () => {
  test("one /commands batch, person FIRST, then the note under the same person", () => {
    const built = createPersonRequest({
      personId: PERSON,
      name: "Ada",
      sharing: "defaults",
      note: { fieldId: FIELD, label: "Note", text: "Allergic to nuts" },
      record: record(),
    }).build({});
    const body = built.command as { commands: Array<Record<string, unknown>> };
    expect(body.commands.map((c) => c.kind)).toEqual([
      "create_person",
      "create_field",
    ]);
    expect(body.commands[1]).toEqual({
      kind: "create_field",
      id: FIELD,
      person_id: PERSON,
      label: "Note",
      value: "Allergic to nuts",
    });
    expect(built.command).toHaveProperty("defaults_revision", REVISION);
    expect(
      Object.keys(
        (built.defaultsContext as { kinds: Record<string, unknown> }).kinds,
      ),
    ).toEqual(["person", "field"]);
  });

  test("Only you: both created with an explicit private policy, nothing captured", () => {
    const request = createPersonRequest({
      personId: PERSON,
      name: "Ada",
      sharing: "only_you",
      note: { fieldId: FIELD, label: "Note", text: "x" },
      record: null,
    });
    const built = request.build({});
    expect(built).toEqual({
      command: {
        commands: [
          {
            kind: "create_person",
            id: PERSON,
            name: "Ada",
            initial_policy: PRIVATE,
          },
          {
            kind: "create_field",
            id: FIELD,
            person_id: PERSON,
            label: "Note",
            value: "x",
            initial_policy: PRIVATE,
          },
        ],
      },
    });
    expect(request.targets.map((t) => t.resourceId)).toEqual([PERSON, FIELD]);
  });

  test("without a note: only the person, capturing only the person template", () => {
    const built = createPersonRequest({
      personId: PERSON,
      name: "Ada",
      sharing: "defaults",
      note: null,
      record: record(),
    }).build({});
    expect((built.command as { commands: unknown[] }).commands).toHaveLength(1);
    expect(
      Object.keys(
        (built.defaultsContext as { kinds: Record<string, unknown> }).kinds,
      ),
    ).toEqual(["person"]);
  });
});

describe("person rename and archive", () => {
  test("an unlinked person's rename is the content edit, with both versions and an empty value", () => {
    const built = renameEditRequest({
      personId: PERSON,
      name: "Ada L.",
      policyVersion: 2,
    }).build({ [PERSON]: 5 });
    expect(built.command).toEqual({
      commands: [
        {
          kind: "edit",
          id: PERSON,
          expected_version: 5,
          expected_policy_version: 2,
          label: "Ada L.",
          value: "",
        },
      ],
    });
  });

  test("archive and restore carry the base and the choice", () => {
    expect(
      archiveRequest({ id: FIELD, archived: true }).build({ [FIELD]: 3 }),
    ).toEqual({
      command: {
        command: {
          kind: "archive",
          id: FIELD,
          expected_version: 3,
          archived: true,
        },
      },
      displayPatch: { [FIELD]: { archived: true } },
    });
    expect(
      archiveRequest({ id: PERSON, archived: false }).build({ [PERSON]: 9 })
        .command,
    ).toEqual({
      command: {
        kind: "archive",
        id: PERSON,
        expected_version: 9,
        archived: false,
      },
    });
  });
});

describe("editing an unsent create in place (D-11a-15)", () => {
  test("the stored body with the new name and value; its captured defaults untouched and no review named", () => {
    const draft = draftRow({
      endpoint: "/task-commands",
      target_resource_ids: [FIELD],
      command: {
        command: {
          kind: "put_field",
          id: FIELD,
          parent_id: PERSON,
          label: "Old",
          value: TEXT,
        },
        defaults_revision: REVISION,
      },
    });
    const request = editCreateRequest(draft, {
      label: "New",
      value: { kind: "boolean", value: true },
    });
    const built = request?.build({});
    expect(built).toEqual({
      command: {
        command: {
          kind: "put_field",
          id: FIELD,
          parent_id: PERSON,
          label: "New",
          value: { kind: "boolean", value: true },
        },
        defaults_revision: REVISION,
      },
    });
    expect(built).not.toHaveProperty("defaultsReview");
  });
});

describe("online-only bodies", () => {
  test("rename_profile, unlink and the shared create", () => {
    expect(
      renameProfileBody({ personId: PERSON, version: 3, name: "Mo" }),
    ).toEqual({
      command: {
        kind: "rename_profile",
        person_id: PERSON,
        expected_version: 3,
        name: "Mo",
      },
    });
    expect(unlinkBody({ personId: PERSON, version: 3 })).toEqual({
      command: { kind: "unlink", person_id: PERSON, expected_version: 3 },
    });
    const policy = {
      grants: [{ kind: "household" as const, id: HOME, edit: false }],
      exclude_accounts: [],
    };
    expect(
      putFieldSharedBody({
        fieldId: FIELD,
        personId: PERSON,
        label: "Phone",
        value: TEXT,
        policy,
      }),
    ).toEqual({
      command: {
        kind: "put_field",
        id: FIELD,
        parent_id: PERSON,
        label: "Phone",
        value: TEXT,
        initial_policy: policy,
      },
    });
  });
});

describe("through the real outbox (fixture IndexedDB)", () => {
  test("a put_field draft's header kind is put_field (the wrapped kind), and a never-fetched capture is held for review", async () => {
    const w = await outboxWorld();
    const answer = await w.outbox.enqueue(
      putFieldCreateRequest({
        fieldId: FIELD,
        personId: PERSON,
        label: "Phone",
        value: TEXT,
        audience: "defaults",
        record: null,
      }),
    );
    expect(answer.kind).toBe("queued");
    const [draft] = w.rows("drafts") as Array<{
      kind: string;
      review_block: unknown;
      defaults_revision: unknown;
    }>;
    expect(draft?.kind).toBe("put_field");
    expect(draft?.review_block).toEqual({ kind: "defaults", kinds: ["field"] });
    expect(draft?.defaults_revision).toBeNull();
  });

  test("an archive draft's header kind is archive; a person create batch's is create_person", async () => {
    const w = await outboxWorld();
    w.put("cache", [
      {
        id: PERSON,
        kind: "person",
        parent_id: null,
        label: "Ada",
        value: null,
        version: 2,
        can_edit: true,
        policy_version: 1,
        archived: false,
        kind_date: null,
      },
    ]);
    await w.outbox.enqueue(archiveRequest({ id: PERSON, archived: true }));
    await w.outbox.enqueue(
      createPersonRequest({
        personId: FIELD,
        name: "Bo",
        sharing: "only_you",
        note: null,
        record: null,
      }),
    );
    const kinds = (
      w.rows("drafts") as Array<{ kind: string; expected_version?: number }>
    ).map((d) => [d.kind, d.expected_version]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["archive", 2],
        ["create_person", undefined],
      ]),
    );
  });
});

describe("the base guard (finding 1 of the review of 13 October)", () => {
  test("only the writing transaction's base is judged: the outbox estimate's placeholder builds neither refuse nor flag", () => {
    const guard = baseGuard(4);
    const request = putFieldUpdateRequest({
      fieldId: "f",
      personId: "p",
      label: "Phone",
      value: { kind: "text", text: "0771" },
      policyVersion: 6,
      sameKind: true,
      guard,
    });
    // What `estimateDraftBytes` asks for: no bases, then the widest version.
    expect(estimateDraftBytes(request)).toBeGreaterThan(0);
    expect(() => request.build({})).not.toThrow();
    expect(() => request.build({ f: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(guard.moved).toBe(false);
    expect(request.build({ f: 4 }).command).toMatchObject({
      command: { expected_version: 4, expected_policy_version: 6 },
    });
    expect(guard.moved).toBe(false);
    expect(() => request.build({ f: 5 })).toThrow(BaseMoved);
    expect(guard.moved).toBe(true);
  });
});

describe("the base guard through the REAL outbox (estimate, then the transaction)", () => {
  const field = (version: number) => ({
    id: FIELD,
    kind: "field" as const,
    parent_id: PERSON,
    label: "Medical note",
    value: TEXT as unknown as null,
    version,
    can_edit: true,
    policy_version: 7,
    archived: false,
    kind_date: null,
  });

  test("the base the edit began on: queued, and the guard is not flagged", async () => {
    const w = await outboxWorld();
    w.put("cache", [field(4)]);
    const guard = baseGuard(4);
    const answer = await w.outbox.enqueue(
      putFieldUpdateRequest({
        fieldId: FIELD,
        personId: PERSON,
        label: "Medical note",
        value: TEXT,
        policyVersion: 7,
        sameKind: true,
        guard,
      }),
    );
    expect(answer.kind).toBe("queued");
    expect(guard.moved).toBe(false);
    expect(
      (w.rows("drafts") as Array<{ expected_version?: number }>).map(
        (d) => d.expected_version,
      ),
    ).toEqual([4]);
  });

  test("another base resolved in the transaction: nothing is written and the guard says why", async () => {
    const w = await outboxWorld();
    w.put("cache", [field(5)]);
    const guard = baseGuard(4);
    await expect(
      w.outbox.enqueue(
        putFieldUpdateRequest({
          fieldId: FIELD,
          personId: PERSON,
          label: "Medical note",
          value: TEXT,
          policyVersion: 7,
          sameKind: true,
          guard,
        }),
      ),
    ).rejects.toThrow();
    expect(guard.moved).toBe(true);
    expect(w.rows("drafts")).toEqual([]);
  });
});
