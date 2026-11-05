// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  byName,
  changesOfAll,
  foldRows,
} from "../../../src/features/people/model/project";
import { cacheRow, draftRow } from "../../support/data/rows";

/**
 * What the screens show of this device's outstanding saves (§3.2 `project.ts`): a queued draft has no overlay until it is claimed, so a
 * create is projected and a later change folded over its row, in queue order, with the row marked.
 */
const P1 = "55555555-5555-4555-8555-555555555555";
const P2 = "77777777-7777-4777-8777-777777777777";
const F1 = "66666666-6666-4666-8666-666666666666";

const createBatch = (seq: number, note: boolean, over = {}) =>
  draftRow({
    local_id: `c${seq}`,
    created_seq: seq,
    command: {
      commands: [
        { kind: "create_person", id: P2, name: "Ada" },
        ...(note
          ? [
              {
                kind: "create_field",
                id: F1,
                person_id: P2,
                label: "Note",
                value: "nuts",
              },
            ]
          : []),
      ],
    },
    ...over,
  });

describe("foldRows", () => {
  test("a queued new person is projected, marked not sent, and has no version to act on", () => {
    const rows = foldRows(
      [cacheRow({ id: P1, label: "Mo" })],
      changesOfAll([createBatch(1, false)]),
      "person",
    );
    const ada = rows.find((r) => r.row.id === P2);
    expect(ada).toMatchObject({
      pending: "not_sent",
      projected: true,
      createDraft: "c1",
    });
    expect(ada?.row).toMatchObject({
      kind: "person",
      label: "Ada",
      version: 0,
    });
  });

  test("the first note of a queued person is a projected field under that person only", () => {
    const changes = changesOfAll([createBatch(1, true)]);
    expect(foldRows([], changes, "field", P2).map((r) => r.row)).toEqual([
      expect.objectContaining({
        id: F1,
        kind: "field",
        parent_id: P2,
        label: "Note",
        value: { kind: "text", text: "nuts" },
      }),
    ]);
    expect(foldRows([], changes, "field", P1)).toEqual([]);
    expect(foldRows([], changes, "person").map((r) => r.row.id)).toEqual([P2]);
  });

  test("a queued rename and archive are folded over the cached row in queue order, and the row is marked", () => {
    const changes = changesOfAll([
      draftRow({
        local_id: "a",
        created_seq: 2,
        command: {
          command: {
            kind: "archive",
            id: P1,
            expected_version: 2,
            archived: true,
          },
        },
        status: "in_flight",
      }),
      draftRow({
        local_id: "r",
        created_seq: 1,
        command: {
          commands: [
            {
              kind: "edit",
              id: P1,
              expected_version: 1,
              expected_policy_version: 1,
              label: "Mohammed",
              value: "",
            },
          ],
        },
      }),
    ]);
    const [row] = foldRows(
      [cacheRow({ id: P1, label: "Mo" })],
      changes,
      "person",
    );
    expect(row?.row).toMatchObject({ label: "Mohammed", archived: true });
    expect(row?.pending).toBe("sending");
    expect(row?.projected).toBe(false);
  });

  test("a put_field update replaces the shown value (a change of type included); its create projects a field", () => {
    const changes = changesOfAll([
      draftRow({
        local_id: "u",
        created_seq: 1,
        status: "acknowledged",
        command: {
          command: {
            kind: "put_field",
            id: F1,
            parent_id: P1,
            expected_version: 3,
            expected_policy_version: 1,
            label: "Weight",
            value: { kind: "quantity", amount: "70", unit: "kg" },
          },
        },
      }),
    ]);
    const [row] = foldRows(
      [
        cacheRow({
          id: F1,
          kind: "field",
          parent_id: P1,
          label: "Weight",
          value: { kind: "text", text: "about 70" },
        }),
      ],
      changes,
      "field",
      P1,
    );
    expect(row?.row.value).toEqual({
      kind: "quantity",
      amount: "70",
      unit: "kg",
    });
    expect(row?.pending).toBe("waiting");
  });

  test("a create held for the defaults review is marked as reviewing", () => {
    const [row] = foldRows(
      [],
      changesOfAll([
        createBatch(1, false, {
          review_block: { kind: "defaults", kinds: ["person"] },
        }),
      ]),
      "person",
    );
    expect(row?.pending).toBe("reviewing");
  });

  test("a create the cache already holds is not projected twice", () => {
    const rows = foldRows(
      [cacheRow({ id: P2, label: "Ada" })],
      changesOfAll([createBatch(1, false, { status: "acknowledged" })]),
      "person",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projected: false, pending: "waiting" });
  });

  test("an unrecognised body changes nothing shown", () => {
    expect(
      changesOfAll([draftRow({ command: { something: "else" } })]),
    ).toEqual([]);
  });
});

describe("byName", () => {
  test("by name, case-insensitive, then by id", () => {
    const rows = foldRows(
      [
        cacheRow({ id: "b", label: "ada" }),
        cacheRow({ id: "a", label: "Ada" }),
        cacheRow({ id: "c", label: "Bo" }),
      ],
      [],
      "person",
    ).sort(byName);
    expect(rows.map((r) => r.row.id)).toEqual(["a", "b", "c"]);
  });
});
