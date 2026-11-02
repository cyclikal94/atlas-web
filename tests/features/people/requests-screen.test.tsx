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
import {
  forgetAllPeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import type {
  IncomingRequest,
  SentRequest,
} from "../../../src/features/people/model/requests";
import * as copy from "../../../src/features/people/requests/copy";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, MO, record } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * WF-PEOPLE-06 at the component level (A1–A5, A8, A10, A13), with the production providers and routes (`/people/requests`) over the
 * people world's fake server. FIXTURE evidence: what the screen does with each answer, never what the backend answers.
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

const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "99999999-9999-4999-8999-999999999999";
const R1 = "10000000-0000-4000-8000-000000000001";
const R2 = "10000000-0000-4000-8000-000000000002";
const R3 = "10000000-0000-4000-8000-000000000003";
const DAY = 86_400;
const inDays = (days: number) =>
  Math.floor(Date.now() / 1000) + days * DAY + 60;
type Receipt = PeopleResult<{ revision: number; person_id: string }>;

const linkRequest = (over: Partial<IncomingRequest> = {}): IncomingRequest => ({
  id: R1,
  sender_id: MO,
  expires_at: inDays(5),
  proposal: { kind: "link", person_id: ADA, account_id: ME, name: "Ada" },
  ...over,
});
const mergeRequest = (
  over: Partial<IncomingRequest> = {},
): IncomingRequest => ({
  id: R2,
  sender_id: STRANGER,
  expires_at: inDays(1),
  proposal: { kind: "merge", source_id: ADA, target_id: BEA, name: "Ada" },
  ...over,
});
const sent = (
  id: string,
  state: SentRequest["state"],
  over: Partial<SentRequest> = {},
): SentRequest => ({
  id,
  recipient_id: MO,
  recipient_username: "mo",
  expires_at: inDays(4),
  state,
  proposal: { kind: "link", person_id: ADA, account_id: MO, name: "Ada" },
  ...over,
});

function world(options: { online?: boolean } = {}) {
  const w = peopleWorld(options);
  w.env.setDefaults(record({ members: [ME, MO] }));
  w.setCache([
    person({ id: ADA, label: "Ada" }),
    person({ id: BEA, label: "Bea" }),
  ]);
  return w;
}
/** The body a recorded command was sent with (unknown until it is cast). */
const bodyAt = (calls: Array<{ args: unknown[] }>, index: number): unknown =>
  calls[index]?.args[1];
const commands = (w: ReturnType<typeof peopleWorld>) =>
  w.api.calls.filter((call) => call.op === "peopleCommand");
/** The element `selector` finds, once it is there (waits; throws while absent). */
const found = (selector: string) =>
  waitFor(() => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`no ${selector}`);
    return element as HTMLElement;
  });
const row = (id: string) =>
  document.querySelector(`[data-incoming-request="${id}"]`) as HTMLElement;
const sentRow = (id: string) =>
  document.querySelector(`[data-sent-request="${id}"]`) as HTMLElement;

describe("Waiting for you (A1, A13)", () => {
  test("rows by expiry with time left; the sender named from a shared household, else cautioned, never by id", async () => {
    const w = world();
    w.api.requests.incoming = [
      linkRequest({ expires_at: inDays(5) }),
      mergeRequest({ expires_at: inDays(1) }),
    ];
    await w.mount("/people/requests");
    const rows = await screen.findAllByRole("listitem");
    const incoming = rows.filter((li) =>
      li.hasAttribute("data-incoming-request"),
    );
    expect(
      incoming.map((li) => li.getAttribute("data-incoming-request")),
    ).toEqual([R2, R1]);
    expect(within(row(R1)).getByText("user1", { exact: false })).toBeTruthy();
    expect(row(R1).textContent).toContain(copy.WANTS_TO_LINK("Ada"));
    expect(row(R1).textContent).toContain(copy.TIME_LEFT.days(5));
    expect(row(R2).textContent).toContain(copy.SOMEONE);
    expect(row(R2).textContent).toContain(copy.UNNAMED_CAUTION);
    expect(document.body.textContent).not.toContain(STRANGER);
    expect(document.body.textContent).toContain(copy.CHECKED_AT("").trim());
  });

  test("no requests: the empty state; offline: unavailable, nothing kept from an earlier read; reconnecting reads again", async () => {
    const w = world();
    await w.mount("/people/requests");
    expect(
      (await screen.findAllByText(copy.NO_REQUESTS)).length,
    ).toBeGreaterThan(0);
    w.api.requests.incoming = [linkRequest()];
    act(() => w.setOnline(false));
    await waitFor(() =>
      expect(
        document.querySelector('[data-requests-state="offline"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText(copy.NO_REQUESTS)).toBeNull();
    const before = w.api.calls.filter(
      (call) => call.op === "readRequests",
    ).length;
    act(() => w.setOnline(true));
    await waitFor(() => expect(row(R1)).not.toBeNull());
    expect(
      w.api.calls.filter((call) => call.op === "readRequests").length,
    ).toBeGreaterThan(before);
  });

  test("a read that fails says so with Try again; nothing is claimed", async () => {
    const w = world();
    w.api.next.requests.push({ ok: false, kind: "uncertain" });
    await w.mount("/people/requests");
    expect(
      (await screen.findAllByText(copy.REQUESTS_FAILED)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(copy.NO_REQUESTS)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    expect(
      (await screen.findAllByText(copy.NO_REQUESTS)).length,
    ).toBeGreaterThan(0);
  });
});

describe("answering a link request (A2)", () => {
  test("Accept sends nothing and reveals the consequence; Confirm accept sends respond_request without a token, once", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await waitFor(() => expect(row(R1)).not.toBeNull());
    fireEvent.click(within(row(R1)).getByRole("button", { name: copy.ACCEPT }));
    expect(commands(w)).toHaveLength(0);
    expect(row(R1).textContent).toContain(copy.LINK_CONSEQUENCE("Ada"));
    const confirm = within(row(R1)).getByRole("button", {
      name: copy.CONFIRM_ACCEPT,
    });
    // The consequence is read before the confirmation (DOM and focus order).
    const note = row(R1).querySelector(
      "[data-link-consequence] p:nth-of-type(2)",
    ) as HTMLElement;
    expect(
      note.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    w.api.requests.incoming = [];
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toEqual({
      command: { kind: "respond_request", id: R1, accept: true },
    });
    await waitFor(() => expect(row(R1)).toBeNull());
  });

  test("Decline sends accept:false; a 404 says the request was answered elsewhere, with its reference, after its row is gone", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await waitFor(() => expect(row(R1)).not.toBeNull());
    w.api.next.people.push({
      ok: false,
      kind: "not_found",
      requestId: "ref-404",
    } as Receipt);
    w.api.requests.incoming = [];
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.DECLINE }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(
      (bodyAt(commands(w), 0) as { command: { accept: boolean } }).command
        .accept,
    ).toBe(false);
    expect(
      (await screen.findAllByText(copy.ANSWERED_ELSEWHERE)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Reference: ref-404")).toBeTruthy();
    await waitFor(() => expect(row(R1)).toBeNull());
    expect(screen.getAllByText(copy.ANSWERED_ELSEWHERE).length).toBeGreaterThan(
      0,
    );
  });

  test("a 409 on a link accept says the sender's person changed", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await waitFor(() => expect(row(R1)).not.toBeNull());
    w.api.next.people.push({ ok: false, kind: "conflict" } as Receipt);
    fireEvent.click(within(row(R1)).getByRole("button", { name: copy.ACCEPT }));
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.CONFIRM_ACCEPT }),
    );
    expect(
      (await screen.findAllByText(copy.LINK_OUT_OF_DATE("user1"))).length,
    ).toBeGreaterThan(0);
  });

  test("an uncertain accept is tried again exactly; a Decline meanwhile is refused and sends nothing (A8)", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await waitFor(() => expect(row(R1)).not.toBeNull());
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(within(row(R1)).getByRole("button", { name: copy.ACCEPT }));
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.CONFIRM_ACCEPT }),
    );
    expect((await screen.findAllByText(copy.UNCERTAIN)).length).toBeGreaterThan(
      0,
    );
    const first = commands(w)[0];
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.DECLINE }),
    );
    expect(
      (await screen.findAllByText(copy.ANSWER_UNCERTAIN_FIRST)).length,
    ).toBeGreaterThan(0);
    expect(commands(w)).toHaveLength(1);
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.TRY_AGAIN }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(first);
  });
});

describe("Sent (A4)", () => {
  test("every state verbatim, the recipient's username, Cancel on pending only, no device caveat", async () => {
    const w = world();
    w.api.requests.sent = [
      sent(R1, "pending"),
      sent(R2, "accepted"),
      sent(R3, "cancelled", {
        proposal: {
          kind: "merge",
          source_id: ADA,
          target_id: BEA,
          name: "Bea",
        },
      }),
    ];
    await w.mount("/people/requests");
    await waitFor(() => expect(sentRow(R1)).not.toBeNull());
    expect(sentRow(R1).textContent).toContain(copy.SENT_LINK("mo", "Ada"));
    expect(sentRow(R1).textContent).toContain(copy.TIME_LEFT.days(4));
    expect(
      within(sentRow(R1)).getByRole("button", {
        name: copy.CANCEL_REQUEST_TO("mo"),
      }),
    ).toBeTruthy();
    expect(sentRow(R2).textContent).toContain(copy.STATE.accepted);
    expect(sentRow(R3).textContent).toContain(copy.SENT_MERGE("mo", "Bea"));
    expect(sentRow(R3).textContent).toContain(copy.STATE.cancelled);
    expect(sentRow(R3).textContent).not.toContain(copy.STATE.expired);
    expect(within(sentRow(R2)).queryByRole("button")).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toContain(
      "this device",
    );
  });

  test("a full page then an empty page with a cursor says there are more; the end; Previous restores", async () => {
    const w = world();
    const page1 = Array.from({ length: 50 }, (_, i) =>
      sent(
        `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        "declined",
      ),
    );
    w.api.next.sent.push({
      ok: true,
      value: { items: page1, next_after: page1[49]?.id ?? null },
    });
    w.api.next.sent.push({ ok: true, value: { items: [], next_after: R3 } });
    w.api.next.sent.push({ ok: true, value: { items: [], next_after: null } });
    await w.mount("/people/requests");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-sent-request]")).toHaveLength(50),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.NEXT }));
    expect((await screen.findAllByText(copy.PAGE_MORE)).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(copy.NO_SENT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.NEXT }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: copy.NEXT })).toBeNull(),
    );
    expect(screen.queryByText(copy.NO_SENT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.PREVIOUS }));
    fireEvent.click(screen.getByRole("button", { name: copy.PREVIOUS }));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-sent-request]")).toHaveLength(50),
    );
  });

  test("Cancel sends cancel_request; a 404 is said on the row with its reference", async () => {
    const w = world();
    w.api.requests.sent = [sent(R1, "pending")];
    await w.mount("/people/requests");
    await waitFor(() => expect(sentRow(R1)).not.toBeNull());
    w.api.next.people.push({
      ok: false,
      kind: "not_found",
      requestId: "ref-c",
    } as Receipt);
    fireEvent.click(
      within(sentRow(R1)).getByRole("button", {
        name: copy.CANCEL_REQUEST_TO("mo"),
      }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(commands(w)[0]?.args[1]).toEqual({
      command: { kind: "cancel_request", id: R1 },
    });
    expect(
      await within(sentRow(R1)).findByText(copy.ANSWERED_ELSEWHERE),
    ).toBeTruthy();
    expect(within(sentRow(R1)).getByText("Reference: ref-c")).toBeTruthy();
  });

  test("no sent requests: the empty state needs the first page's end", async () => {
    const w = world();
    await w.mount("/people/requests");
    expect((await screen.findAllByText(copy.NO_SENT)).length).toBeGreaterThan(
      0,
    );
  });
});

describe("Ask to link (A5)", () => {
  const lookups = (w: ReturnType<typeof peopleWorld>) =>
    w.sharing.calls.filter((call) => call.op === "lookup");

  async function chooseAndSend(w: ReturnType<typeof peopleWorld>) {
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    fireEvent.click(await found(`[data-pick-person="${ADA}"]`));
    fireEvent.click(
      screen.getByRole("button", { name: copy.SEARCH_DIRECTORY }),
    );
    const exact = await screen.findByLabelText("Exact username");
    fireEvent.change(exact, { target: { value: "mo" } });
    fireEvent.submit(exact.closest("form") as HTMLFormElement);
    fireEvent.click(
      await within(
        document.querySelector("[data-lookup=exact]") as HTMLElement,
      ).findByRole("button", { name: /choose/i }),
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-link-recipient="mo"]'),
      ).not.toBeNull(),
    );
  }

  test("only owned, unlinked, unarchived people are offered; the recipient is re-checked before the command, which carries the linkage version", async () => {
    const w = world();
    w.setCache([
      person({ id: ADA, label: "Ada", version: 7 }),
      person({ id: BEA, label: "Bea" }),
    ]);
    w.api.summary.persons.set(BEA, {
      your_access: "view",
      added_by_you: "no",
      owner: { account_id: MO, username: "mo", you: false, person: null },
      audience: {
        disclosure: "partial",
        in_home: false,
        households: [],
        your_direct_grant: { can_edit: false },
        direct_grant_count: null,
        excluded_count: null,
      },
    });
    w.sharing.defaults.lookup = (username) => ({
      ok: true,
      value: username === "mo" ? [{ id: MO, username: "mo" }] : [],
    });
    await chooseAndSend(w);
    expect(document.querySelector(`[data-pick-person="${BEA}"]`)).toBeNull();
    const send = await screen.findByRole("button", { name: copy.SEND_REQUEST });
    const before = lookups(w).length;
    fireEvent.click(send);
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    expect(lookups(w).length).toBe(before + 1);
    const body = commands(w)[0]?.args[1] as {
      command: Record<string, unknown>;
    };
    expect(body.command).toMatchObject({
      kind: "request_link",
      person_id: ADA,
      account_id: MO,
      expected_version: 7,
    });
    expect(Object.keys(body.command).sort()).toEqual([
      "account_id",
      "expected_version",
      "id",
      "kind",
      "person_id",
    ]);
    expect((await screen.findAllByText(copy.CHOOSE)).length).toBeGreaterThan(0);
  });

  test("an account that no longer exists sends nothing", async () => {
    const w = world();
    let asked = 0;
    w.sharing.defaults.lookup = () => {
      asked += 1;
      return {
        ok: true,
        value: asked === 1 ? [{ id: MO, username: "mo" }] : [],
      };
    };
    await chooseAndSend(w);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    expect(
      (await screen.findAllByText(copy.ACCOUNT_GONE)).length,
    ).toBeGreaterThan(0);
    expect(commands(w)).toHaveLength(0);
  });

  test("503 slice_capacity names the recipient; the form keeps its values", async () => {
    const w = world();
    w.sharing.defaults.lookup = () => ({
      ok: true,
      value: [{ id: MO, username: "mo" }],
    });
    await chooseAndSend(w);
    w.api.next.people.push({ ok: false, kind: "capacity" } as Receipt);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    expect(
      (await screen.findAllByText(copy.CAPACITY("mo"))).length,
    ).toBeGreaterThan(0);
    expect(document.querySelector('[data-link-recipient="mo"]')).not.toBeNull();
  });

  test("an uncertain send is tried again with the same key and body (the same request id)", async () => {
    const w = world();
    w.sharing.defaults.lookup = () => ({
      ok: true,
      value: [{ id: MO, username: "mo" }],
    });
    await chooseAndSend(w);
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    expect((await screen.findAllByText(copy.UNCERTAIN)).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
  });

  test("offline the form stays editable and Send says it needs a connection", async () => {
    const w = world();
    await w.mount("/people/requests");
    act(() => w.setOnline(false));
    expect(
      (await screen.findAllByText(copy.CHOOSE_PERSON_FIRST)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: copy.CHOOSE })).toBeTruthy();
  });

  test("switching to Ask to merge and back keeps the link form's values (PRODUCT-DECISIONS item 2)", async () => {
    const w = world();
    w.sharing.defaults.lookup = () => ({
      ok: true,
      value: [{ id: MO, username: "mo" }],
    });
    await chooseAndSend(w);
    fireEvent.click(screen.getByRole("button", { name: copy.ASK_TO_MERGE }));
    expect(
      (await screen.findAllByText(copy.MERGE_INTRO)).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: copy.ASK_TO_LINK }));
    expect(document.querySelector('[data-link-recipient="mo"]')).not.toBeNull();
    expect(
      document.querySelector(`[data-link-person="${ADA}"]`),
    ).not.toBeNull();
  });
});

describe("identity (A10)", () => {
  test("a late incoming read of another identity is never shown under the next", async () => {
    const w = world();
    let release: (value: PeopleResult<IncomingRequest[]>) => void = () => {};
    w.api.next.requests.push(
      () => new Promise((resolve) => (release = resolve)),
    );
    await w.mount("/people/requests");
    const before = peopleMemory(w.people.identity);
    // Another identity asks for its memory: the first one's late answer writes into a memory nobody reads.
    peopleMemory("someone-else:1");
    await act(async () => release({ ok: true, value: [linkRequest()] }));
    expect(before.summaries.get("requests:incoming")?.state.kind).toBe(
      "loading",
    );
    expect(row(R1)).toBeNull();
  });
});
