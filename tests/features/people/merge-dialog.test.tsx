import { readFileSync } from "node:fs";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PeopleResult } from "../../../src/features/people/api";
import * as peopleCopy from "../../../src/features/people/copy";
import { forgetAllPeopleMemory } from "../../../src/features/people/memory";
import type { RecipientPreview } from "../../../src/features/people/model/requests";
import * as copy from "../../../src/features/people/requests/copy";
import { mergeNameDraft } from "../../../src/features/people/requests/mergeName";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, MO, record } from "../../support/people/records";
import { fieldRow, peopleWorld, person } from "../../support/people/world";

/**
 * WF-PEOPLE-05 at the component level (A3, A6, A7, A9, A11), with the production providers and routes: "Compare & merge" over the
 * duplicates (`/people/$personId/duplicates/$otherId`), the recipient's review (`/people/requests/$requestId`), the slots and the merged
 * alias. FIXTURE evidence over the people world's fake server.
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

const MOHAMMED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the source (merged into the other)
const MOPERSON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the target (kept)
const PHONE_S = "c0000000-0000-4000-8000-000000000001";
const PHONE_T = "c0000000-0000-4000-8000-000000000002";
const NICK = "c0000000-0000-4000-8000-000000000003";
const R = "10000000-0000-4000-8000-000000000009";
const T1 = "1".repeat(64);
const T2 = "2".repeat(64);
type Receipt = PeopleResult<{ revision: number; person_id: string }>;
const COMPARE = `/people/${MOPERSON}/duplicates/${MOHAMMED}`;

function world() {
  const w = peopleWorld();
  w.env.setDefaults(record({ members: [ME, MO] }));
  w.setCache([
    person({ id: MOHAMMED, label: "Mohammed A." }),
    person({ id: MOPERSON, label: "Mo" }),
    fieldRow({
      id: PHONE_S,
      parent_id: MOHAMMED,
      label: "Phone",
      version: 2,
      value: { kind: "text", text: "07700 900802" },
    }),
    fieldRow({
      id: PHONE_T,
      parent_id: MOPERSON,
      label: "phone",
      version: 3,
      value: { kind: "text", text: "07700 900461" },
    }),
    fieldRow({
      id: NICK,
      parent_id: MOHAMMED,
      label: "Nickname",
      version: 1,
      value: { kind: "text", text: "Mo-Mo" },
    }),
  ]);
  w.api.linked.set(MOHAMMED, null);
  w.api.linked.set(MOPERSON, null);
  return w;
}
/** The body a recorded command was sent with (unknown until it is cast). */
const bodyAt = (calls: Array<{ args: unknown[] }>, index: number): unknown =>
  calls[index]?.args[1];
const commands = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls.filter((call) => call.op === "peopleCommand");
const dialog = () => screen.getByRole("dialog");
const action = (name: string | RegExp) =>
  within(dialog()).getByRole("button", { name });
const PARTIAL = {
  disclosure: "partial" as const,
  in_home: false,
  households: [],
  your_direct_grant: { can_edit: false },
  direct_grant_count: null,
  excluded_count: null,
};

describe("the sender's merge (A6)", () => {
  test("values only from synced rows at the preview's version; the conflict note; the consequence before the action; one exact merge, then the kept person", async () => {
    const w = world();
    // The preview names the target's phone at a later version than this device holds: no value is shown for it.
    w.api.requests.merge.set(`${MOHAMMED}:${MOPERSON}`, {
      token: T1,
      fields: [
        { id: PHONE_S, parent_id: MOHAMMED, label: "Phone", version: 2 },
        { id: PHONE_T, parent_id: MOPERSON, label: "phone", version: 4 },
        { id: NICK, parent_id: MOHAMMED, label: "Nickname", version: 1 },
      ],
    });
    const { router } = await w.mount(COMPARE);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.MERGE_TITLE("Mohammed A.", "Mo")).length,
      ).toBeGreaterThan(0),
    );
    const table = document.querySelector(
      "[data-merge-comparison]",
    ) as HTMLElement;
    expect(within(table).queryByText("07700 900802")).not.toBeNull();
    expect(within(table).queryByText("07700 900461")).toBeNull();
    expect(within(table).queryByText(copy.NOT_ON_DEVICE)).not.toBeNull();
    expect(
      screen.queryAllByText(copy.BOTH_HAVE("phone", "Mohammed A.")).length,
    ).toBeGreaterThan(0);
    const consequence = document.querySelector(
      "[data-merge-consequence]",
    ) as HTMLElement;
    await waitFor(() => expect(action(copy.MERGE_THEM)).toBeTruthy());
    expect(
      consequence.compareDocumentPosition(action(copy.MERGE_THEM)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryAllByText(copy.OWN_BOTH).length).toBeGreaterThan(0);
    fireEvent.click(action(copy.MERGE_THEM));
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toEqual({
      command: {
        kind: "merge",
        source_id: MOHAMMED,
        target_id: MOPERSON,
        preview_token: T1,
        name: "Mo",
      },
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/people/${MOPERSON}`),
    );
  });

  test("approval needed: the owner is named from their summary and a request_merge with a fresh id is sent", async () => {
    const w = world();
    w.api.requests.merge.set(`${MOHAMMED}:${MOPERSON}`, {
      token: T1,
      requires_approval: true,
    });
    w.api.summary.persons.set(MOHAMMED, {
      your_access: "view",
      added_by_you: "no",
      owner: { account_id: MO, username: "mo", you: false, person: null },
      audience: PARTIAL,
    });
    const { router } = await w.mount(COMPARE);
    await waitFor(() =>
      expect(action(copy.ASK_TO_MERGE_WITH("mo"))).toBeTruthy(),
    );
    expect(
      screen.queryAllByText(copy.HAS_TO_ACCEPT("mo")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryAllByText(copy.EXPIRES_IN_7).length).toBeGreaterThan(0);
    fireEvent.click(action(copy.ASK_TO_MERGE_WITH("mo")));
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    const body = commands(w)[0]?.args[1] as {
      command: Record<string, unknown>;
    };
    expect(body.command).toMatchObject({
      kind: "request_merge",
      source_id: MOHAMMED,
      target_id: MOPERSON,
      preview_token: T1,
      name: "Mo",
    });
    expect(body.command.id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/people/${MOPERSON}/duplicates`,
      ),
    );
  });

  test("both linked: the cause and no action, nothing sent; one linked: its name, fixed and sent exactly", async () => {
    const w = world();
    w.api.linked.set(MOHAMMED, MO);
    w.api.linked.set(MOPERSON, ME);
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(screen.queryAllByText(copy.BOTH_LINKED).length).toBeGreaterThan(0),
    );
    expect(
      within(dialog()).getByRole("button", { name: copy.MERGE_THEM }),
    ).toHaveProperty("disabled", true);
    expect(commands(w)).toHaveLength(0);
    cleanup();
    forgetAllPeopleMemory();
    const v = world();
    v.api.linked.set(MOHAMMED, MO);
    await v.mount(COMPARE);
    await waitFor(() =>
      expect(screen.queryAllByText(copy.LINKED_NAME).length).toBeGreaterThan(0),
    );
    expect(
      (document.querySelector("[data-merge-name-fixed]") as HTMLElement)
        .textContent,
    ).toBe("Mohammed A.");
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() => expect(commands(v)).toHaveLength(1));
    expect(
      (bodyAt(commands(v), 0) as { command: { name: string } }).command.name,
    ).toBe("Mohammed A.");
  });

  test("a linkage that cannot be read disables the action with its reason", async () => {
    const w = world();
    for (let n = 0; n < 4; n += 1)
      w.api.next.person.push({ ok: false, kind: "uncertain" });
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.LINKAGE_UNKNOWN).length,
      ).toBeGreaterThan(0),
    );
    expect(
      within(dialog()).getByRole("button", { name: copy.MERGE_THEM }),
    ).toHaveProperty("disabled", true);
  });

  test("409: the comparison is read again and only a new press sends, with the NEW token", async () => {
    const w = world();
    w.api.requests.merge.set(`${MOHAMMED}:${MOPERSON}`, { token: T1 });
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    w.api.next.people.push({
      ok: false,
      kind: "conflict",
      requestId: "ref-9",
    } as Receipt);
    w.api.requests.merge.set(`${MOHAMMED}:${MOPERSON}`, { token: T2 });
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.COMPARISON_CHANGED).length,
      ).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(
        w.api.calls.filter((c) => c.op === "previewMerge").length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(commands(w)).toHaveLength(1);
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(
      (bodyAt(commands(w), 1) as { command: { preview_token: string } }).command
        .preview_token,
    ).toBe(T2);
  });

  test("an uncertain merge survives a remount: the dialog says so and Try again resends the same key and body (A8, A11)", async () => {
    const w = world();
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    const first = commands(w)[0];
    // The protected tree remounts (a 403 elsewhere): same page memory, a new tree.
    cleanup();
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(action(copy.TRY_AGAIN)).toBeTruthy());
    fireEvent.click(action(copy.TRY_AGAIN));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(first);
  });

  test("a retained uncertain merge stays reachable while the comparison is refused: Try again resends it exactly", async () => {
    const w = world();
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    // Every later comparison read is refused.
    for (let n = 0; n < 10; n += 1)
      w.api.next.mergePreview.push({
        ok: false,
        kind: "forbidden",
        requestId: "ref-403",
      });
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length,
      ).toBeGreaterThan(0),
    );
    const first = commands(w)[0];
    fireEvent.click(action(copy.TRY_AGAIN));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(first);
  });

  test("R1: a replayed merge completes as ITS attempt: the name it carried is said, not the name chosen since", async () => {
    const w = world();
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    const { router } = await w.mount(COMPARE);
    await waitFor(() =>
      expect(action(copy.MERGE_THEM)).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      within(dialog()).getByRole("radio", { name: "Mohammed A." }),
    );
    fireEvent.click(action(copy.MERGE_THEM));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    expect(
      (bodyAt(commands(w), 0) as { command: { name: string } }).command.name,
    ).toBe("Mohammed A.");
    // The choice changes before Try again: the replay still sends, and completes as, the earlier attempt.
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Mo" }));
    fireEvent.click(action(copy.TRY_AGAIN));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        copy.MERGED_INTO("Mohammed A."),
      ),
    );
    expect(document.body.textContent).not.toContain(copy.MERGED_INTO("Mo"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/people/${MOPERSON}`),
    );
    // R1 of review 4: the success consumes only the choice ITS attempt was made of; the choice made before Try again is kept.
    expect(mergeNameDraft(w.people.memory, MOHAMMED, MOPERSON)?.choice).toBe(
      "target",
    );
  });

  test("Cancel sends nothing and returns to the duplicates", async () => {
    const w = world();
    const { router } = await w.mount(COMPARE);
    await waitFor(() => expect(action(copy.MERGE_THEM)).toBeTruthy());
    fireEvent.click(action(copy.CANCEL));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/people/${MOPERSON}/duplicates`,
      ),
    );
    expect(commands(w)).toHaveLength(0);
  });
});

describe("the recipient's review (A3)", () => {
  const preview = (over: Partial<RecipientPreview> = {}): RecipientPreview => ({
    token: T1,
    source: null,
    target: {
      id: MOPERSON,
      kind: "person",
      parent_id: null,
      label: "Mo",
      value: null,
      version: 3,
      can_edit: true,
      archived: false,
      policy_version: 2,
    },
    fields: [{ id: PHONE_T, parent_id: MOPERSON, label: "phone", version: 3 }],
    requires_approval: true,
    combines_identity_audiences: true,
    freezes_field_policies: true,
    stale: false,
    ...over,
  });
  function review() {
    const w = world();
    w.api.requests.incoming = [
      {
        id: R,
        sender_id: MO,
        expires_at: Math.floor(Date.now() / 1000) + 5 * 86_400 + 60,
        proposal: {
          kind: "merge",
          source_id: MOHAMMED,
          target_id: MOPERSON,
          name: "Mo",
        },
      },
    ];
    return w;
  }

  test("a side the recipient cannot see: 'Not visible to you' and the unavailable note; Accept echoes THIS preview's token", async () => {
    const w = review();
    w.api.requests.previews.set(R, preview());
    const { router } = await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.COMPARISON_UNAVAILABLE).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryAllByText(copy.NOT_VISIBLE).length).toBeGreaterThan(0);
    expect(
      screen.queryAllByText(copy.PARTIAL_VIEW("user1")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryAllByText(copy.ASKED("user1"), { exact: false }).length,
    ).toBeGreaterThan(0);
    await waitFor(() =>
      expect(action(copy.ACCEPT)).toHaveProperty("disabled", false),
    );
    fireEvent.click(action(copy.ACCEPT));
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toEqual({
      command: {
        kind: "respond_request",
        id: R,
        accept: true,
        recipient_preview_token: T1,
      },
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/people/${MOPERSON}`),
    );
  });

  test("stale: the banner, Accept still offered", async () => {
    const w = review();
    w.api.requests.previews.set(R, preview({ stale: true }));
    await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(screen.queryAllByText(copy.STALE("user1")).length).toBeGreaterThan(
        0,
      ),
    );
    await waitFor(() =>
      expect(action(copy.ACCEPT)).toHaveProperty("disabled", false),
    );
  });

  test("410: expired, Accept withdrawn, Decline stays; 404: gone, only Close", async () => {
    const w = review();
    // The server keeps saying so: the review reads again after a refusal (the lists too).
    for (let n = 0; n < 4; n += 1)
      w.api.next.recipientPreview.push({
        ok: false,
        kind: "expired",
        requestId: "ref-410",
      });
    await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.REQUEST_EXPIRED).length,
      ).toBeGreaterThan(0),
    );
    expect(
      within(dialog()).queryByRole("button", { name: copy.ACCEPT }),
    ).toBeNull();
    expect(action(copy.DECLINE)).toBeTruthy();
    cleanup();
    forgetAllPeopleMemory();
    const v = review();
    await v.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(screen.queryAllByText(copy.REQUEST_GONE).length).toBeGreaterThan(
        0,
      ),
    );
    expect(
      within(dialog()).queryByRole("button", { name: copy.DECLINE }),
    ).toBeNull();
  });

  test("409 on accept: read again; the next Accept carries the new token only after a new press", async () => {
    const w = review();
    w.api.requests.previews.set(R, preview());
    await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(action(copy.ACCEPT)).toHaveProperty("disabled", false),
    );
    w.api.next.people.push({ ok: false, kind: "conflict" } as Receipt);
    w.api.requests.previews.set(R, preview({ token: T2 }));
    fireEvent.click(action(copy.ACCEPT));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.MERGE_CHANGED).length).toBeGreaterThan(
        0,
      ),
    );
    await waitFor(() =>
      expect(
        w.api.calls.filter((c) => c.op === "readRecipientPreview").length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(commands(w)).toHaveLength(1);
    await waitFor(() =>
      expect(action(copy.ACCEPT)).toHaveProperty("disabled", false),
    );
    fireEvent.click(action(copy.ACCEPT));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(
      (bodyAt(commands(w), 1) as { command: Record<string, unknown> }).command
        .recipient_preview_token,
    ).toBe(T2);
  });

  test("Decline carries no token", async () => {
    const w = review();
    w.api.requests.previews.set(R, preview());
    await w.mount(`/people/requests/${R}`);
    await waitFor(() => expect(action(copy.DECLINE)).toBeTruthy());
    fireEvent.click(action(copy.DECLINE));
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toEqual({
      command: { kind: "respond_request", id: R, accept: false },
    });
  });
});

describe("N1 (revision 1): a refused (403) preview is remembered, never asked again by itself", () => {
  const asked = (w: ReturnType<typeof peopleWorld>, op: string) =>
    w.api.calls.filter((call) => call.op === op).length;
  const FORBIDDEN = { ok: false, kind: "forbidden", requestId: "ref-403" };

  test("sender: a remount and an invalidation do not ask again; Reload asks once more and shows the comparison (control)", async () => {
    const w = world();
    w.api.next.mergePreview.push(FORBIDDEN as never);
    await w.mount(COMPARE);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length,
      ).toBeGreaterThan(0),
    );
    expect(asked(w, "previewMerge")).toBe(1);
    // A 403 re-evaluates the session, which remounts the tree; every summary is then read again.
    cleanup();
    await w.mount(COMPARE);
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length,
      ).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked(w, "previewMerge")).toBe(1);
    const reload = document.querySelector(
      '[data-people-action="preview-again"]',
    ) as HTMLElement;
    expect(reload, "the refusal's explicit Reload").not.toBeNull();
    fireEvent.click(reload);
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(2));
    await waitFor(() => expect(action(copy.MERGE_THEM)).toBeTruthy());
  });

  test("recipient: a 403 review is remembered across a remount and does not read the lists again by itself; Reload asks once more", async () => {
    const w = world();
    w.api.requests.incoming = [
      {
        id: R,
        sender_id: MO,
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        proposal: {
          kind: "merge",
          source_id: MOHAMMED,
          target_id: MOPERSON,
          name: "Mo",
        },
      },
    ];
    w.api.next.recipientPreview.push(FORBIDDEN as never);
    await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length,
      ).toBeGreaterThan(0),
    );
    const lists = asked(w, "readRequests");
    cleanup();
    await w.mount(`/people/requests/${R}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length,
      ).toBeGreaterThan(0),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked(w, "readRecipientPreview")).toBe(1);
    expect(asked(w, "readRequests")).toBe(lists);
    const reload = document.querySelector(
      '[data-people-action="preview-again"]',
    ) as HTMLElement;
    expect(reload, "the refusal's explicit Reload").not.toBeNull();
    fireEvent.click(reload);
    await waitFor(() => expect(asked(w, "readRecipientPreview")).toBe(2));
  });
});

describe("R7 (review 2): only the key's newest answer remembers a 403 or ends one; a superseded 403 has no effect", () => {
  const asked = (w: ReturnType<typeof peopleWorld>, op: string) =>
    w.api.calls.filter((call) => call.op === op).length;
  const FORBIDDEN = { ok: false, kind: "forbidden", requestId: "old-403" };
  /** An answer held until the test releases it (the read is ISSUED when the fake is called, and recorded in `calls`). */
  function held<T>() {
    let release: (value: T) => void = () => {};
    const answer = () =>
      new Promise<T>((resolve) => {
        release = resolve;
      });
    return { answer, release: (value: T) => release(value) };
  }
  const SENDER_KEY = `merge:${MOHAMMED}:${MOPERSON}`;
  /** The fake server's successful comparison, made without recording a read (the test's own lookup, not the screen's). */
  const success = async (w: ReturnType<typeof peopleWorld>) => {
    const answer = await w.api.previewMerge(MOHAMMED, MOPERSON);
    w.api.calls.pop();
    return answer;
  };
  const comparison = () =>
    document.querySelector("[data-merge-comparison]") as HTMLElement | null;
  const refusalShown = () =>
    screen.queryAllByText(copy.PREVIEW_FORBIDDEN).length > 0;

  test("S1 sender: A held; an invalidation; B succeeds; A released 403; another invalidation: C reaches the server and the comparison stays", async () => {
    const w = world();
    const a = held<unknown>();
    w.api.next.mergePreview.push(a.answer as never);
    await w.mount(COMPARE);
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(2));
    await waitFor(() => expect(comparison()).not.toBeNull());
    await act(async () => a.release(FORBIDDEN));
    expect(comparison(), "A's visible result is discarded").not.toBeNull();
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(3));
    await waitFor(() =>
      expect(w.people.memory.summaries.get(SENDER_KEY)?.state.kind).toBe(
        "ready",
      ),
    );
    expect(comparison(), "C succeeded and is shown").not.toBeNull();
    expect(refusalShown()).toBe(false);
    expect(
      w.people.memory.requestRefusals.has(SENDER_KEY),
      "the superseded 403 is not remembered",
    ).toBe(false);
  });

  test("S2 sender: A released 403 while the newer B is held (and a read meanwhile waits for B, sending nothing); B succeeds: no refusal is shown or kept", async () => {
    const w = world();
    const a = held<unknown>();
    const b = held<unknown>();
    w.api.next.mergePreview.push(a.answer as never, b.answer as never);
    await w.mount(COMPARE);
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(2));
    await act(async () => a.release(FORBIDDEN));
    // Another invalidation while B is on its way: the read waits for B (it is newer than A's answer) and shows no refusal meanwhile.
    act(() => w.people.memory.invalidateSummaries());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asked(w, "previewMerge")).toBe(2);
    expect(refusalShown(), "no refusal while a newer answer is due").toBe(
      false,
    );
    const ok = await success(w);
    await act(async () => b.release(ok));
    await waitFor(() => expect(comparison()).not.toBeNull());
    expect(refusalShown()).toBe(false);
    // The read that waited is of a LATER generation than B's dispatch: once B ended the refusal, it asks afresh (C).
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(3));
    // B's success ENDED the refusal A's late answer had remembered: the next invalidation asks again and shows the comparison.
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(4));
    await waitFor(() =>
      expect(w.people.memory.summaries.get(SENDER_KEY)?.state.kind).toBe(
        "ready",
      ),
    );
    expect(comparison()).not.toBeNull();
    expect(refusalShown()).toBe(false);
    expect(w.people.memory.requestRefusals.has(SENDER_KEY)).toBe(false);
  });

  test("S2 reversed: B's current 403 is remembered; A's older success, released after it, changes nothing", async () => {
    const w = world();
    const a = held<unknown>();
    w.api.next.mergePreview.push(a.answer as never, FORBIDDEN as never);
    await w.mount(COMPARE);
    await waitFor(() => expect(asked(w, "previewMerge")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(refusalShown()).toBe(true));
    const ok = await success(w);
    const issued = asked(w, "previewMerge");
    await act(async () => a.release(ok));
    expect(w.people.memory.requestRefusals.has(SENDER_KEY)).toBe(true);
    act(() => w.people.memory.invalidateSummaries());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(refusalShown()).toBe(true);
    expect(asked(w, "previewMerge"), "not asked again by itself").toBe(issued);
  });

  for (const late of ["before", "after"] as const)
    test(`S4: an explicit Reload cannot be undone by an older callback (A's 403 released ${late} C's success)`, async () => {
      const w = world();
      const a = held<unknown>();
      const c = held<unknown>();
      w.api.next.mergePreview.push(
        a.answer as never,
        FORBIDDEN as never,
        c.answer as never,
      );
      await w.mount(COMPARE);
      await waitFor(() => expect(asked(w, "previewMerge")).toBe(1));
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() => expect(refusalShown()).toBe(true));
      fireEvent.click(
        document.querySelector(
          '[data-people-action="preview-again"]',
        ) as HTMLElement,
      );
      await waitFor(() => expect(asked(w, "previewMerge")).toBe(3));
      const ok = await success(w);
      if (late === "before") await act(async () => a.release(FORBIDDEN));
      await act(async () => c.release(ok));
      if (late === "after") await act(async () => a.release(FORBIDDEN));
      await waitFor(() => expect(comparison()).not.toBeNull());
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() =>
        expect(w.people.memory.summaries.get(SENDER_KEY)?.state.kind).toBe(
          "ready",
        ),
      );
      expect(comparison()).not.toBeNull();
      expect(w.people.memory.requestRefusals.has(SENDER_KEY)).toBe(false);
    });

  test("storm ordering (N1 kept): each 403's own consequence invalidates and the next read is issued BEFORE that 403 reaches the dialog; the reads still settle", async () => {
    const w = world();
    /**
     * The production order on every hop (`ordinaryCall`): the 403 arrives after a round trip; the session evaluates again on it (the tree
     * remounts, every summary is invalidated) BEFORE the answer is released to the read; the next read is issued; only then does the earlier
     * read go on. Each answer here takes a 5 ms round trip, invalidates, and waits until the NEXT read is issued (or 30 ms pass with none)
     * before it answers 403. A remembered refusal that had to be of the current generation is never kept under this order (each read is
     * superseded by its own consequence): bounded at 25 here, so such a defect fails the count, not the test's time.
     */
    let invalidations = 0;
    const answer = async () => {
      const mine = asked(w, "previewMerge");
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (invalidations < 25) {
        invalidations += 1;
        w.people.memory.invalidateSummaries();
        const until = Date.now() + 30;
        while (asked(w, "previewMerge") === mine && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return FORBIDDEN;
    };
    for (let n = 0; n < 30; n += 1)
      w.api.next.mergePreview.push(answer as never);
    await w.mount(COMPARE);
    await waitFor(() => expect(refusalShown()).toBe(true), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const settled = asked(w, "previewMerge");
    expect(
      settled,
      "settled: the first 403 and at most the one read its own consequence issued",
    ).toBeLessThanOrEqual(2);
    expect(w.people.memory.requestRefusals.has(SENDER_KEY)).toBe(true);
    act(() => w.people.memory.invalidateSummaries());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(asked(w, "previewMerge"), "then quiet").toBe(settled);
    expect(refusalShown()).toBe(true);
  });

  test("S1 recipient: a superseded 403 of the review does not refuse the newer review", async () => {
    const w = world();
    w.api.requests.incoming = [
      {
        id: R,
        sender_id: MO,
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        proposal: {
          kind: "merge",
          source_id: MOHAMMED,
          target_id: MOPERSON,
          name: "Mo",
        },
      },
    ];
    // Every later read answers this review (the fake server's fallback); A is held.
    w.api.requests.previews.set(R, {
      token: T1,
      source: null,
      target: {
        id: MOPERSON,
        kind: "person",
        parent_id: null,
        label: "Mo",
        value: null,
        version: 3,
        can_edit: true,
        archived: false,
        policy_version: 2,
      },
      fields: [
        { id: PHONE_T, parent_id: MOPERSON, label: "phone", version: 3 },
      ],
      requires_approval: true,
      combines_identity_audiences: true,
      freezes_field_policies: true,
      stale: false,
    });
    const a = held<unknown>();
    w.api.next.recipientPreview.push(a.answer as never);
    await w.mount(`/people/requests/${R}`);
    await waitFor(() => expect(asked(w, "readRecipientPreview")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "readRecipientPreview")).toBe(2));
    await waitFor(() => expect(comparison()).not.toBeNull());
    await act(async () => a.release(FORBIDDEN));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(asked(w, "readRecipientPreview")).toBe(3));
    await waitFor(() => expect(comparison()).not.toBeNull());
    expect(refusalShown()).toBe(false);
    expect(w.people.memory.requestRefusals.has(`requests:review:${R}`)).toBe(
      false,
    );
  });
});

describe("entry points and after-effects (A7, A9)", () => {
  test("the slots are filled by the people chunk, and route.tsx imports nothing of WEB-11b's screens", async () => {
    const { peopleSlots } = await import("../../../src/features/people/slots");
    await import("../../../src/features/people/screens");
    expect(peopleSlots.headerActions).toBeTypeOf("function");
    expect(peopleSlots.duplicateActions).toBeTypeOf("function");
    const source = readFileSync("src/features/people/route.tsx", "utf8");
    expect(source).not.toMatch(/from "\.\/requests\//);
    expect(source).not.toMatch(/import\("\.\/requests\//);
  });

  test("detail: 'Ask to link…' for a known unlinked person the reader owns opens the form with the person chosen; absent when linked", async () => {
    const w = world();
    const { router } = await w.mount(`/people/${MOPERSON}`);
    const link = await screen.findByRole("button", {
      name: copy.ASK_TO_LINK_ENTRY,
    });
    fireEvent.click(link);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/people/requests"),
    );
    await waitFor(() =>
      expect(
        document.querySelector(`[data-link-person="${MOPERSON}"]`),
      ).not.toBeNull(),
    );
    cleanup();
    forgetAllPeopleMemory();
    const v = world();
    v.api.linked.set(MOPERSON, MO);
    await v.mount(`/people/${MOPERSON}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(peopleCopy.LINK_OTHER("Mo")).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByRole("button", { name: copy.ASK_TO_LINK_ENTRY }),
    ).toBeNull();
  });

  test("detail offline: 'Ask to link…' is disabled with the reason, never inferred", async () => {
    const w = peopleWorld({ online: false });
    w.setCache([person({ id: MOPERSON, label: "Mo" })]);
    await w.mount(`/people/${MOPERSON}`);
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.CHECK_LINK_FIRST).length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.getByRole("button", { name: copy.ASK_TO_LINK_ENTRY }),
    ).toHaveProperty("disabled", true);
  });

  test("duplicates: each hint offers 'Compare & merge' to the dialog keeping the page's person", async () => {
    const w = world();
    w.api.next.duplicates.push({
      ok: true,
      value: {
        items: [person({ id: MOHAMMED, label: "Mohammed A." })],
        next_after: null,
      },
    });
    const { router } = await w.mount(`/people/${MOPERSON}/duplicates`);
    fireEvent.click(
      await screen.findByRole("link", { name: copy.COMPARE_AND_MERGE }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(COMPARE));
  });

  test("a merged alias: 'Merged into {name}', linked; Archive/Restore disabled with the reason", async () => {
    const w = world();
    w.setCache([
      person({
        id: MOHAMMED,
        label: "Mohammed A.",
        archived: true,
        value: { canonical_person_id: MOPERSON },
      }),
      person({ id: MOPERSON, label: "Mo" }),
    ]);
    await w.mount(`/people/${MOHAMMED}`);
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: copy.MERGED_ALIAS("Mo") }),
      ).not.toBeNull(),
    );
    expect(screen.queryAllByText(copy.ALIAS_NO_RESTORE).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole("button", { name: peopleCopy.RESTORE }),
    ).toHaveProperty("disabled", true);
    act(() => undefined);
  });
});
