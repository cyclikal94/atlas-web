import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  FIELDS_READ_FAILED,
  NO_FIELDS,
} from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { draftRow } from "../../support/data/rows";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * WEB-11a review 17 (R17.1; design assessment DA17-07): retained history (rejections and conflicts kept until dismissed) never makes a
 * cached field unreachable on the person detail or in Settings → "Archived items", on the first page or a later one, and live work among
 * it is still shown. Only more OUTSTANDING changes than one read answers whole leave a page unshown, and that page says it failed (never
 * "No fields yet."). Fixture evidence (jsdom, the People world's public reads, which follow the production plan's contract: the production
 * plan itself is `tests/data/child-reads-history.test.ts`).
 */
installMatchMedia({ width: 1440 });
beforeEach(() => {
  forgetAllPeopleMemory();
  forgetRefusedPolicies();
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const P = "55555555-5555-4555-8555-555555555555";
const ABSENT = "44444444-4444-4444-8444-444444444444";
const fieldId = (n: number) =>
  `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
const draftId = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (id: string) => document.querySelector(`[data-field-row="${id}"]`);
const archived = (id: string) =>
  document.querySelector(`[data-archived-row="${id}"]`);
/** Text shown by the DETAIL (not the announcer's live region or the list beside it). */
const text = (value: string) =>
  screen
    .queryAllByText(value)
    .find(
      (node) =>
        node.closest("[aria-live], .sr-only, [data-people-list]") === null,
    ) ?? null;

/** A put_field draft of `id` with `status` (a rejected one is kept until it is dismissed). */
const putField = (
  local: string,
  seq: number,
  id: string,
  status: "queued" | "rejected" | "version_conflict",
  label: string,
) =>
  draftRow({
    local_id: local,
    created_seq: seq,
    status,
    endpoint: "/task-commands",
    command: {
      command: {
        kind: "put_field",
        id,
        parent_id: P,
        label,
        value: { kind: "text", text: label },
        expected_version: 1,
      },
    },
    target_resource_ids: [id],
    index_targets: [id],
    ...(status === "rejected"
      ? { last_error: { stage: "dependency_rejected" } }
      : {}),
  } as never);
/** `count` retained drafts over `id`: rejections and conflicts in turn. */
const retained = (count: number, id: string, prefix: string) =>
  Array.from({ length: count }, (_, i) =>
    putField(
      draftId(prefix, i),
      10_000 + i,
      id,
      i % 2 === 0 ? "rejected" : "version_conflict",
      "Retained edit",
    ),
  );

describe("R17.1: the person detail with retained history (DA17-07)", () => {
  test("1,001 retained changes on the first page and on the second: both pages shown, a queued edit among them shown as not sent", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      ...Array.from({ length: 150 }, (_, n) =>
        fieldRow({ id: fieldId(n + 1), parent_id: P, label: `Field ${n + 1}` }),
      ),
    ]);
    w.setDrafts([
      ...retained(1001, fieldId(1), "11111111"),
      ...retained(1001, fieldId(120), "22222222"),
      putField(draftId("33333333", 1), 5, fieldId(120), "queued", "Queued"),
    ]);
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(row(fieldId(1))).not.toBeNull());
    expect(text("Field 1")).not.toBeNull();
    expect(text(FIELDS_READ_FAILED)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next fields" }));
    await waitFor(() => expect(row(fieldId(120))).not.toBeNull());
    expect(row(fieldId(101))).not.toBeNull();
    expect(row(fieldId(150))).not.toBeNull();
    // The queued edit is shown over the cached field; the retained ones are not.
    expect(row(fieldId(120))).toHaveTextContent("Queued");
    expect(row(fieldId(120))).not.toHaveTextContent("Retained edit");
    expect(
      row(fieldId(120))?.querySelector("[data-pending]"),
    ).toHaveTextContent("Not sent yet");
    fireEvent.click(screen.getByRole("button", { name: "Previous fields" }));
    await waitFor(() => expect(row(fieldId(1))).not.toBeNull());
    expect(text(FIELDS_READ_FAILED)).toBeNull();
  });

  test("control: 1,001 queued edits over a field (more than one read answers whole): the page says it failed, never 'No fields yet.'", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: fieldId(1), parent_id: P, label: "Field 1" }),
    ]);
    w.setDrafts(
      Array.from({ length: 1001 }, (_, i) =>
        putField(draftId("33333333", i), i + 1, fieldId(1), "queued", "Q"),
      ),
    );
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(text(FIELDS_READ_FAILED)).not.toBeNull());
    expect(text(NO_FIELDS)).toBeNull();
    expect(row(fieldId(1))).toBeNull();
  });

  test("control: 1,000 queued edits beside 1,001 retained changes: the field shown with its latest queued edit", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: fieldId(1), parent_id: P, label: "Field 1" }),
    ]);
    w.setDrafts([
      ...retained(1001, fieldId(1), "11111111"),
      ...Array.from({ length: 1000 }, (_, i) =>
        putField(
          draftId("33333333", i),
          i + 1,
          fieldId(1),
          "queued",
          i === 999 ? "Latest queued" : `Queued ${i}`,
        ),
      ),
    ]);
    await w.mount(`/people/${P}`);
    await waitFor(() => expect(row(fieldId(1))).not.toBeNull());
    expect(row(fieldId(1))).toHaveTextContent("Latest queued");
    expect(text(FIELDS_READ_FAILED)).toBeNull();
  });
});

describe("R17.1: Settings → Archived items with retained history (DA17-07)", () => {
  const failed = () => document.querySelector('[data-archived-state="failed"]');
  const restore = (id: string) =>
    archived(id)?.querySelector('[data-people-action="ledger-restore"]');

  test("a raw page of hidden fields, then 101 archived fields with 1,001 retained changes on the first and the last: every step reachable with Restore, and back", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      // 100 archived fields of a person not in the cache come first in id order: their raw page shows nothing.
      ...Array.from({ length: 100 }, (_, n) =>
        fieldRow({
          id: fieldId(n + 1),
          parent_id: ABSENT,
          label: "Hidden",
          archived: true,
        }),
      ),
      ...Array.from({ length: 101 }, (_, n) =>
        fieldRow({
          id: fieldId(501 + n),
          parent_id: P,
          label: `Old ${501 + n}`,
          archived: true,
        }),
      ),
    ]);
    w.setDrafts([
      ...retained(1001, fieldId(1), "11111111"),
      ...retained(1001, fieldId(501), "22222222"),
      ...retained(1001, fieldId(601), "44444444"),
    ]);
    await w.mount("/settings/archived");
    await waitFor(() => expect(archived(fieldId(501))).not.toBeNull());
    expect(failed()).toBeNull();
    expect(archived(fieldId(501))).toHaveTextContent("Old 501");
    expect(restore(fieldId(501))).toBeEnabled();
    expect(screen.queryByText("Hidden")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next items" }));
    await waitFor(() => expect(archived(fieldId(601))).not.toBeNull());
    expect(failed()).toBeNull();
    expect(archived(fieldId(601))).toHaveTextContent("Old 601");
    expect(restore(fieldId(601))).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous items" }));
    await waitFor(() => expect(archived(fieldId(501))).not.toBeNull());
    expect(failed()).toBeNull();
  });

  test("control: 1,001 queued edits over an archived field: the ledger says it failed, never 'Nothing archived'", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([
      person({ id: P, label: "Ada" }),
      fieldRow({ id: fieldId(1), parent_id: P, label: "Old", archived: true }),
    ]);
    w.setDrafts(
      Array.from({ length: 1001 }, (_, i) =>
        putField(draftId("33333333", i), i + 1, fieldId(1), "queued", "Q"),
      ),
    );
    await w.mount("/settings/archived");
    await waitFor(() => expect(failed()).not.toBeNull());
    expect(screen.queryByText(/Nothing archived/)).toBeNull();
    expect(archived(fieldId(1))).toBeNull();
  });
});
