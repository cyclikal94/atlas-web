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
const media = installMatchMedia({ width: 1440 });
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
    expect(
      within(row(R1)).queryByText("user1", { exact: false }),
    ).not.toBeNull();
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.NO_REQUESTS).length).toBeGreaterThan(0),
    );
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
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.REQUESTS_FAILED).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText(copy.NO_REQUESTS)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.NO_REQUESTS).length).toBeGreaterThan(0),
    );
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
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.ANSWERED_ELSEWHERE).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryAllByText("Reference: ref-404").length).toBeGreaterThan(
      0,
    );
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
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.LINK_OUT_OF_DATE("user1")).length,
      ).toBeGreaterThan(0),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    const first = commands(w)[0];
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.DECLINE }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.ANSWER_UNCERTAIN_FIRST).length,
      ).toBeGreaterThan(0),
    );
    expect(commands(w)).toHaveLength(1);
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.TRY_AGAIN }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(first);
  });
});

describe("an uncertain answer whose request is no longer listed (A8)", () => {
  test("its report stays above the list with Try again, which resends the same key and body", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await waitFor(() => expect(row(R1)).not.toBeNull());
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    // It committed: the list read again no longer has it.
    w.api.requests.incoming = [];
    fireEvent.click(within(row(R1)).getByRole("button", { name: copy.ACCEPT }));
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.CONFIRM_ACCEPT }),
    );
    await waitFor(() => expect(row(R1)).toBeNull());
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="retry-answer"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0);
    fireEvent.click(
      document.querySelector(
        '[data-people-action="retry-answer"]',
      ) as HTMLElement,
    );
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="retry-answer"]'),
      ).toBeNull(),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.PAGE_MORE).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(copy.NO_SENT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.NEXT }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: copy.NEXT })).toBeNull(),
    );
    expect(screen.queryByText(copy.NO_SENT)).toBeNull();
    /**
     * ADAPTATION (DA-N1 of review 2's design assessment; Q9: at most three retained history pages): the history now keeps only the page
     * shown, so Previous READS the earlier page again by its kept cursor (the fake server answers those reads below), and its buttons are
     * offered once that page is shown, as after Next. The original intent stands: Previous returns to the page it came from, and shows it.
     */
    w.api.next.sent.push({ ok: true, value: { items: [], next_after: R3 } });
    w.api.next.sent.push({
      ok: true,
      value: { items: page1, next_after: page1[49]?.id ?? null },
    });
    fireEvent.click(await screen.findByRole("button", { name: copy.PREVIOUS }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.PAGE_MORE).length).toBeGreaterThan(0),
    );
    fireEvent.click(await screen.findByRole("button", { name: copy.PREVIOUS }));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-sent-request]")).toHaveLength(50),
    );
    expect(
      w.api.calls
        .filter((call) => call.op === "readSentRequests")
        .map((call) => (call.args[0] as { after: string | null }).after),
    ).toEqual([null, page1[49]?.id, R3, page1[49]?.id, null]);
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
    await waitFor(() =>
      expect(
        within(sentRow(R1)).queryByText(copy.ANSWERED_ELSEWHERE),
      ).not.toBeNull(),
    );
    expect(within(sentRow(R1)).queryByText("Reference: ref-c")).not.toBeNull();
  });

  test("no sent requests: the empty state needs the first page's end", async () => {
    const w = world();
    await w.mount("/people/requests");
    await waitFor(() =>
      expect(screen.queryAllByText(copy.NO_SENT).length).toBeGreaterThan(0),
    );
  });
});

describe("Ask to link (A5)", () => {
  const lookups = (w: ReturnType<typeof peopleWorld>) =>
    w.sharing.calls.filter((call) => call.op === "lookup");

  async function chooseAndSend(
    w: ReturnType<typeof peopleWorld>,
    inPicker: () => void = () => {},
  ) {
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    const ada = await found(`[data-pick-person="${ADA}"]`);
    // What the picker offers, judged while it is open (the whole page of summaries has been read by then).
    inPicker();
    fireEvent.click(ada);
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
    await chooseAndSend(w, () =>
      expect(document.querySelector(`[data-pick-person="${BEA}"]`)).toBeNull(),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.CHOOSE).length).toBeGreaterThan(0),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.ACCOUNT_GONE).length).toBeGreaterThan(
        0,
      ),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.CAPACITY("mo")).length).toBeGreaterThan(
        0,
      ),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
  });

  test("offline the form stays editable and Send says it needs a connection", async () => {
    const w = world();
    await w.mount("/people/requests");
    act(() => w.setOnline(false));
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.CHOOSE_PERSON_FIRST).length,
      ).toBeGreaterThan(0),
    );
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
    await waitFor(() =>
      expect(screen.queryAllByText(copy.MERGE_INTRO).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.ASK_TO_LINK }));
    expect(document.querySelector('[data-link-recipient="mo"]')).not.toBeNull();
    expect(
      document.querySelector(`[data-link-person="${ADA}"]`),
    ).not.toBeNull();
  });
});

describe("People 01's entry (A7)", () => {
  test("no count before a successful read (never '0'); the count after it; nothing while offline", async () => {
    const w = world();
    let release: (value: PeopleResult<IncomingRequest[]>) => void = () => {};
    w.api.next.requests.push(
      () => new Promise((resolve) => (release = resolve)),
    );
    await w.mount("/people");
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="requests"]'),
      ).not.toBeNull(),
    );
    expect(document.querySelector("[data-requests-count]")).toBeNull();
    await act(async () =>
      release({ ok: true, value: [linkRequest(), mergeRequest()] }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-requests-count]")?.textContent).toBe(
        "2",
      ),
    );
    act(() => w.setOnline(false));
    await waitFor(() =>
      expect(document.querySelector("[data-requests-count]")).toBeNull(),
    );
  });
});

describe("Ask to link: what the press is judged on (A5)", () => {
  async function ready(w: ReturnType<typeof peopleWorld>) {
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
    await found('[data-link-recipient="mo"]');
  }

  test("the same username now naming ANOTHER account sends nothing", async () => {
    const w = world();
    let asked = 0;
    w.sharing.defaults.lookup = () => {
      asked += 1;
      return {
        ok: true,
        value: [{ id: asked === 1 ? MO : STRANGER, username: "mo" }],
      };
    };
    await ready(w);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.ACCOUNT_GONE).length).toBeGreaterThan(
        0,
      ),
    );
    expect(commands(w)).toHaveLength(0);
  });

  test("a success clears only what it sent: a person chosen while it was sending stays", async () => {
    const w = world();
    w.sharing.defaults.lookup = () => ({
      ok: true,
      value: [{ id: MO, username: "mo" }],
    });
    let release: (value: Receipt) => void = () => {};
    w.api.next.people.push(() => new Promise((resolve) => (release = resolve)));
    await ready(w);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    fireEvent.click(await found('[data-people-action="change-person"]'));
    fireEvent.click(await found(`[data-pick-person="${BEA}"]`));
    await found(`[data-link-person="${BEA}"]`);
    await act(async () =>
      release({ ok: true, value: { revision: 1, person_id: ADA } }),
    );
    await waitFor(() =>
      expect(
        document.querySelector(`[data-link-person="${BEA}"]`),
      ).not.toBeNull(),
    );
    expect(document.querySelector('[data-link-recipient="mo"]')).not.toBeNull();
  });
});

describe("Ask to merge (A6, A7)", () => {
  test("'One of your people' offers the reader's own; 'The same person' then offers anyone visible but the first, another owner's included", async () => {
    const w = world();
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
    const { router } = await w.mount("/people/requests");
    fireEvent.click(
      await screen.findByRole("button", { name: copy.ASK_TO_MERGE }),
    );
    fireEvent.click(await found('[data-people-action="choose-first"]'));
    fireEvent.click(await found(`[data-pick-person="${ADA}"]`));
    expect(document.querySelector(`[data-pick-person="${BEA}"]`)).toBeNull();
    fireEvent.click(await found('[data-people-action="choose-second"]'));
    await waitFor(() =>
      expect(
        document.querySelector(`[data-pick-person="${BEA}"]`),
      ).not.toBeNull(),
    );
    const bea = document.querySelector(
      `[data-pick-person="${BEA}"]`,
    ) as HTMLElement;
    expect(document.querySelector(`[data-pick-person="${ADA}"]`)).toBeNull();
    fireEvent.click(bea);
    fireEvent.click(await found('[data-people-action="compare"]'));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/people/requests/merge/${BEA}/${ADA}`,
      ),
    );
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

// ---- review 1 (2 November 2026): R1–R4 -------------------------------------------------------------------------------------------
/** Every exact lookup finds one account: "mo" is MO, any other username is STRANGER. */
function lookupAll(w: ReturnType<typeof peopleWorld>) {
  w.sharing.defaults.lookup = (username: string) => ({
    ok: true,
    value: [{ id: username === "mo" ? MO : STRANGER, username }],
  });
}
async function chooseRecipient(username: string) {
  const exact = await screen.findByLabelText("Exact username");
  fireEvent.change(exact, { target: { value: username } });
  fireEvent.submit(exact.closest("form") as HTMLFormElement);
  fireEvent.click(
    await within(await present("[data-lookup=exact]")).findByRole("button", {
      name: /choose/i,
    }),
  );
  await present(`[data-link-recipient="${username}"]`);
}
/** Ada asked of "mo", ready to send. */
async function linkReady(w: ReturnType<typeof peopleWorld>) {
  await w.mount("/people/requests");
  fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
  fireEvent.click(await present(`[data-pick-person="${ADA}"]`));
  fireEvent.click(screen.getByRole("button", { name: copy.SEARCH_DIRECTORY }));
  await chooseRecipient("mo");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: copy.SEND_REQUEST }),
    ).toHaveProperty("disabled", false),
  );
}
/** The element `selector` finds, once it is there; its absence fails an ASSERTION (a mutant that removes it is caught, not crashed). */
const present = async (selector: string, timeout = 1_000) => {
  await waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), {
    timeout,
  });
  return document.querySelector(selector) as HTMLElement;
};
const said = (text: string) => document.body.textContent?.includes(text);

describe("R1: a replayed link request completes as the attempt it replays", () => {
  test("control, nothing changed: Try again resends it exactly; its success names its recipient and clears the form", async () => {
    const w = world();
    lookupAll(w);
    await linkReady(w);
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    expect(document.querySelector("[data-retry-sends]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() => expect(w.people.memory.attempts.size).toBe(0));
    await waitFor(() => expect(said(copy.REQUEST_SENT("mo"))).toBe(true));
    await waitFor(() =>
      expect(document.querySelector("[data-link-recipient]")).toBeNull(),
    );
    expect(document.querySelector("[data-link-person]")).toBeNull();
  });

  test("the recipient changed between attempts: Try again says and sends the EARLIER request exactly, names its recipient, and keeps the newer one", async () => {
    const w = world();
    lookupAll(w);
    await linkReady(w);
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    fireEvent.click(await present('[data-people-action="change-recipient"]'));
    await chooseRecipient("other");
    expect((await present("[data-retry-sends]")).textContent).toBe(
      copy.RETRY_SENDS_EARLIER("mo"),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.TRY_AGAIN }));
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() => expect(w.people.memory.attempts.size).toBe(0));
    await waitFor(() => expect(said(copy.REQUEST_SENT("mo"))).toBe(true));
    expect(said(copy.REQUEST_SENT("other"))).toBe(false);
    // The newer input stays: the request that succeeded was not made of it.
    expect(
      document.querySelector('[data-link-recipient="other"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(`[data-link-person="${ADA}"]`),
    ).not.toBeNull();
  });

  test("the person changed after an uncertain send: the earlier request stays reachable, is resent exactly, and the newer form stays", async () => {
    const w = world();
    lookupAll(w);
    await linkReady(w);
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(screen.getByRole("button", { name: copy.SEND_REQUEST }));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    fireEvent.click(await present('[data-people-action="change-person"]'));
    fireEvent.click(await present(`[data-pick-person="${BEA}"]`));
    await present(`[data-link-person="${BEA}"]`);
    const earlier = await present(`[data-earlier-link="${ADA}"]`);
    expect(earlier.textContent).toContain(copy.EARLIER_LINK("Ada", "mo"));
    fireEvent.click(
      within(earlier).getByRole("button", { name: copy.TRY_AGAIN }),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() =>
      expect(document.querySelector("[data-earlier-link]")).toBeNull(),
    );
    await waitFor(() => expect(said(copy.REQUEST_SENT("mo"))).toBe(true));
    expect(
      document.querySelector(`[data-link-person="${BEA}"]`),
    ).not.toBeNull();
    expect(document.querySelector('[data-link-recipient="mo"]')).not.toBeNull();
  });
});

describe("R2: the picker reaches every person, a bounded window at a time", () => {
  const pid = (n: number) =>
    `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const people = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      person({ id: pid(i + 1), label: `Person ${i + 1}` }),
    );
  const shownRows = () =>
    document.querySelectorAll("[data-pick-person]").length;
  /** A row of a window of up to 300 people: jsdom draws them slowly under load, so this waits longer than `found` (a test wait only). */
  const picked = (n: number) =>
    present(`[data-pick-person="${pid(n)}"]`, 10_000);
  const filterTo = (text: string) =>
    fireEvent.change(screen.getByLabelText(copy.FILTER_PEOPLE), {
      target: { value: text },
    });

  test("control, 200 people: the whole list in one window; a filter with no match says nobody matches", async () => {
    const w = world();
    w.setCache(people(200));
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    await picked(100);
    fireEvent.click(await present('[data-people-action="picker-more"]'));
    await picked(200);
    // Two full pages have not yet SEEN the end (the server answers a cursor after a full page): one more read finds it.
    fireEvent.click(await present('[data-people-action="picker-more"]'));
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="picker-more"]'),
      ).toBeNull(),
    );
    expect(shownRows()).toBe(200);
    expect(
      document.querySelector('[data-people-action="picker-next"]'),
    ).toBeNull();
    filterTo("nobody here");
    expect((await present("[data-picker-empty]")).textContent).toBe(
      copy.NO_MATCHES,
    );
    expect(document.querySelector("[data-picker-partial]")).toBeNull();
  });

  test("301 people: three pages kept, then the next window reaches the 301st (the earlier one is not kept) and Show earlier people returns; a filter says it searched only what is shown", async () => {
    const w = world();
    w.setCache(people(301));
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    await picked(100);
    fireEvent.click(await present('[data-people-action="picker-more"]'));
    await picked(200);
    fireEvent.click(await present('[data-people-action="picker-more"]'));
    await picked(300);
    expect(shownRows()).toBe(300);
    expect(
      document.querySelector('[data-people-action="picker-more"]'),
    ).toBeNull();
    filterTo("Person 301");
    expect((await present("[data-picker-empty]")).textContent).toBe(
      copy.NO_MATCHES_SHOWN,
    );
    expect((await present("[data-picker-partial]")).textContent).toBe(
      copy.FILTER_SHOWN_ONLY,
    );
    fireEvent.click(await present('[data-people-action="picker-next"]'));
    const last = await picked(301);
    expect(shownRows()).toBe(1);
    expect(document.querySelector(`[data-pick-person="${pid(1)}"]`)).toBeNull();
    filterTo("");
    fireEvent.click(await present('[data-people-action="picker-earlier"]'));
    await picked(300);
    fireEvent.click(await present('[data-people-action="picker-next"]'));
    fireEvent.click(await picked(301));
    expect(last).toBeTruthy();
    expect(
      document.querySelector(`[data-link-person="${pid(301)}"]`),
    ).not.toBeNull();
  }, 30_000);

  test("a page whose rows are all filtered out is not 'none can be offered': Show more reads on and finds them", async () => {
    const w = world();
    const all = people(150);
    w.setCache(all);
    // The first hundred are other people's (seen, never offered to Ask to link).
    for (let n = 1; n <= 100; n += 1)
      w.api.summary.persons.set(pid(n), {
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
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    expect((await present("[data-picker-empty]")).textContent).toBe(
      copy.NONE_OFFERED_SHOWN,
    );
    fireEvent.click(await present('[data-people-action="picker-more"]'));
    await picked(150);
    expect(shownRows()).toBe(50);
    expect(document.querySelector(`[data-pick-person="${pid(1)}"]`)).toBeNull();
  });
});

describe("R3: People 01's Requests entry below 1280 px", () => {
  const entry = () =>
    document.querySelector(
      'a[href="/people/requests"][data-people-action="requests"]',
    );

  test("control, one waiting: the entry and the banner", async () => {
    media.set({ width: 390 });
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people");
    await present("[data-requests-banner]");
    expect(entry()).not.toBeNull();
  });

  test("none waiting, unknown and offline: the entry stays, with no banner and no claimed count", async () => {
    media.set({ width: 390 });
    const w = world();
    let release: (value: PeopleResult<IncomingRequest[]>) => void = () => {};
    w.api.next.requests.push(
      () => new Promise((resolve) => (release = resolve)),
    );
    await w.mount("/people");
    // Unknown: the read is held.
    await waitFor(() => expect(entry()).not.toBeNull());
    expect(document.querySelector("[data-requests-count]")).toBeNull();
    await act(async () => release({ ok: true, value: [] }));
    await waitFor(() =>
      expect(
        w.people.memory.summaries.get("requests:incoming")?.state.kind,
      ).toBe("ready"),
    );
    // None waiting: the entry (to Sent and New request), no banner.
    expect(entry()).not.toBeNull();
    expect(document.querySelector("[data-requests-banner]")).toBeNull();
    act(() => w.setOnline(false));
    await waitFor(() =>
      expect(document.querySelector("[data-requests-count]")).toBeNull(),
    );
    expect(entry()).not.toBeNull();
  });
});

describe("R4: a retained uncertain answer or cancel stays reachable, and its Try again sends what was kept", () => {
  const cancelled = (w: ReturnType<typeof peopleWorld>, commit: boolean) => {
    const pending = sent(R1, "pending");
    w.api.requests.sent = [pending];
    w.api.next.people.push(async () => {
      if (commit) w.api.requests.sent = [{ ...pending, state: "cancelled" }];
      return { ok: false, kind: "uncertain" } as Receipt;
    });
  };
  for (const commit of [false, true])
    test(`an uncertain cancel ${commit ? "that committed (the row now says Cancelled)" : "that did not commit (control)"}: Try again on the row resends it exactly, and a definite answer ends it`, async () => {
      const w = world();
      cancelled(w, commit);
      await w.mount("/people/requests");
      fireEvent.click(
        within(await present(`[data-sent-request="${R1}"]`)).getByRole(
          "button",
          {
            name: copy.CANCEL_REQUEST_TO("mo"),
          },
        ),
      );
      await waitFor(() =>
        expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
      );
      await waitFor(() =>
        expect(sentRow(R1).getAttribute("data-sent-state")).toBe(
          commit ? "cancelled" : "pending",
        ),
      );
      const retry = within(sentRow(R1)).queryByRole("button", {
        name: copy.CANCEL_REQUEST_TO("mo"),
      }) as HTMLElement;
      expect(retry, "the kept cancel's Try again on its row").not.toBeNull();
      expect(retry.textContent).toBe(copy.TRY_AGAIN);
      fireEvent.click(retry);
      await waitFor(() => expect(commands(w)).toHaveLength(2));
      expect(commands(w)[1]).toEqual(commands(w)[0]);
      await waitFor(() => expect(w.people.memory.attempts.size).toBe(0));
      if (commit)
        await waitFor(() =>
          expect(
            within(sentRow(R1)).queryByRole("button", {
              name: copy.CANCEL_REQUEST_TO("mo"),
            }),
          ).toBeNull(),
        );
    });

  test("an uncertain Decline whose row is still listed: the row's Try again resends the DECLINE exactly; a different answer is refused", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(
      within(await present(`[data-incoming-request="${R1}"]`)).getByRole(
        "button",
        { name: copy.DECLINE },
      ),
    );
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    // No accept consequence is shown for a kept decline; Accept, then Confirm accept, is refused and sends nothing.
    expect(row(R1).querySelector("[data-link-consequence]")).toBeNull();
    fireEvent.click(within(row(R1)).getByRole("button", { name: copy.ACCEPT }));
    fireEvent.click(
      within(row(R1)).getByRole("button", { name: copy.CONFIRM_ACCEPT }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.ANSWER_UNCERTAIN_FIRST).length,
      ).toBeGreaterThan(0),
    );
    expect(commands(w)).toHaveLength(1);
    const retry = row(R1).querySelector(
      '[data-people-action="decline-request"]',
    ) as HTMLElement;
    expect(retry.textContent).toBe(copy.TRY_AGAIN);
    fireEvent.click(retry);
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    expect(
      (bodyAt(commands(w), 1) as { command: { accept: boolean } }).command
        .accept,
    ).toBe(false);
    await waitFor(() => expect(w.people.memory.attempts.size).toBe(0));
  });

  test("an uncertain Decline that committed (the row is gone): the kept answer cannot be closed away while unresolved; Try again resends it and then it ends", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    w.api.next.people.push(async () => {
      w.api.requests.incoming = [];
      return { ok: false, kind: "uncertain" } as Receipt;
    });
    fireEvent.click(
      within(await present(`[data-incoming-request="${R1}"]`)).getByRole(
        "button",
        { name: copy.DECLINE },
      ),
    );
    await waitFor(() => expect(row(R1)).toBeNull());
    const retry = await present('[data-people-action="retry-answer"]');
    expect(screen.queryByRole("button", { name: copy.CLOSE })).toBeNull();
    // Its report gone too (another view, a remount): the kept attempt alone still offers Try again.
    act(() => {
      w.people.memory.requestReports.clear();
      w.people.memory.touch();
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="retry-answer"]'),
      ).not.toBeNull(),
    );
    expect(retry).toBeTruthy();
    fireEvent.click(
      document.querySelector(
        '[data-people-action="retry-answer"]',
      ) as HTMLElement,
    );
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
    await waitFor(() =>
      expect(
        document.querySelector('[data-people-action="retry-answer"]'),
      ).toBeNull(),
    );
    expect(w.people.memory.attempts.size).toBe(0);
  });
});

// ---- review 2 (3 November 2026): R7, R2 and the design assessment's DA-N1 ---------------------------------------------------------
/** An answer held until the test releases it (the read is ISSUED when the fake is called, and recorded in `calls`). */
function held<T>() {
  let release: (value: T) => void = () => {};
  const answer = () =>
    new Promise<T>((resolve) => {
      release = resolve;
    });
  return { answer, release: (value: T) => release(value) };
}
const issued = (w: ReturnType<typeof peopleWorld>, op: string) =>
  w.api.calls.filter((call) => call.op === op).length;
const FORBIDDEN_403 = { ok: false, kind: "forbidden", requestId: "old-403" };

describe("R7: a superseded 403 of a request list has no effect; a current one is remembered until Try again", () => {
  test("incoming S1: A held; an invalidation; B lists the request; A released 403; another invalidation: C is asked and the request stays", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    const a = held<unknown>();
    w.api.next.requests.push(a.answer as never);
    await w.mount("/people/requests");
    await waitFor(() => expect(issued(w, "readRequests")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(issued(w, "readRequests")).toBe(2));
    await present(`[data-incoming-request="${R1}"]`);
    await act(async () => a.release(FORBIDDEN_403));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(issued(w, "readRequests")).toBe(3));
    await waitFor(() =>
      expect(
        w.people.memory.summaries.get("requests:incoming")?.state.kind,
      ).toBe("ready"),
    );
    expect(row(R1)).not.toBeNull();
    expect(screen.queryByText(copy.REQUESTS_FAILED)).toBeNull();
    expect(w.people.memory.requestRefusals.has("requests:incoming")).toBe(
      false,
    );
  });

  test("incoming control: a CURRENT 403 is a failed list, not asked again by an invalidation; Try again asks and lists", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    w.api.next.requests.push(FORBIDDEN_403 as never);
    await w.mount("/people/requests");
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.REQUESTS_FAILED).length,
      ).toBeGreaterThan(0),
    );
    const asked = issued(w, "readRequests");
    act(() => w.people.memory.invalidateSummaries());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(issued(w, "readRequests"), "not asked again by itself").toBe(asked);
    fireEvent.click(
      within(
        document.querySelector("[data-requests-incoming]") as HTMLElement,
      ).getByRole("button", { name: copy.TRY_AGAIN }),
    );
    await present(`[data-incoming-request="${R1}"]`);
    expect(issued(w, "readRequests")).toBe(asked + 1);
  });

  test("incoming S4: A held; B fails (uncertain); Try again asks C; A then answers 403 and C is uncertain too: A, sent before the Try again, remembers nothing (an invalidation asks again)", async () => {
    const w = world();
    w.api.requests.incoming = [linkRequest()];
    const a = held<unknown>();
    const c = held<unknown>();
    w.api.next.requests.push(
      a.answer as never,
      { ok: false, kind: "uncertain" } as never,
      c.answer as never,
    );
    await w.mount("/people/requests");
    await waitFor(() => expect(issued(w, "readRequests")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.REQUESTS_FAILED).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(
      within(
        document.querySelector("[data-requests-incoming]") as HTMLElement,
      ).getByRole("button", { name: copy.TRY_AGAIN }),
    );
    await waitFor(() => expect(issued(w, "readRequests")).toBe(3));
    await act(async () => a.release(FORBIDDEN_403));
    await act(async () => c.release({ ok: false, kind: "uncertain" }));
    await waitFor(() =>
      expect(
        screen.queryAllByText(copy.REQUESTS_FAILED).length,
      ).toBeGreaterThan(0),
    );
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(issued(w, "readRequests")).toBe(4));
    await present(`[data-incoming-request="${R1}"]`);
    expect(w.people.memory.requestRefusals.has("requests:incoming")).toBe(
      false,
    );
  });

  test("Sent S1: A held; an invalidation; B shows the page; A released 403; another invalidation: C is asked and the page stays", async () => {
    const w = world();
    w.api.requests.sent = [sent(R1, "pending")];
    const a = held<unknown>();
    w.api.next.sent.push(a.answer as never);
    await w.mount("/people/requests");
    await waitFor(() => expect(issued(w, "readSentRequests")).toBe(1));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(issued(w, "readSentRequests")).toBe(2));
    await present(`[data-sent-request="${R1}"]`);
    await act(async () => a.release(FORBIDDEN_403));
    act(() => w.people.memory.invalidateSummaries());
    await waitFor(() => expect(issued(w, "readSentRequests")).toBe(3));
    await waitFor(() =>
      expect(w.people.memory.summaries.get("requests:sent:")?.state.kind).toBe(
        "ready",
      ),
    );
    expect(sentRow(R1)).not.toBeNull();
    expect(w.people.memory.requestRefusals.has("requests:sent:")).toBe(false);
  });
});

describe("R2 (review 2): the picker OWNS one bounded walk: at most three pages of rows are kept while it traverses", () => {
  const pid = (n: number) =>
    `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const people = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      person({ id: pid(i + 1), label: `Person ${i + 1}` }),
    );
  const picked = (n: number) =>
    present(`[data-pick-person="${pid(n)}"]`, 10_000);
  /**
   * What the page memory keeps of the pickers' walks: the entries, and EVERY row held across them (each walk's `read`, which includes its
   * `kept` rows; summed, not a union, so two copies of one aggregate count twice).
   */
  const retained = (w: ReturnType<typeof peopleWorld>) => {
    const entries = [...w.people.memory.summaries].filter(([key]) =>
      key.startsWith("picker:"),
    );
    let rows = 0;
    for (const [, entry] of entries)
      if (entry.state.kind === "ready")
        rows += (entry.state.value as { read: Map<string, unknown> }).read.size;
    return { entries: entries.length, rows };
  };
  const bounded = (w: ReturnType<typeof peopleWorld>, step: string) => {
    const now = retained(w);
    expect(now.entries, `${step}: one walk kept`).toBeLessThanOrEqual(1);
    expect(
      now.rows,
      `${step}: at most three 100-row pages`,
    ).toBeLessThanOrEqual(300);
  };
  const click = async (action: string) =>
    fireEvent.click(await present(`[data-people-action="${action}"]`));

  test("control, 100 people: one walk of 100 rows is kept", async () => {
    const w = world();
    w.setCache(people(100));
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    await picked(100);
    expect(retained(w)).toEqual({ entries: 1, rows: 100 });
  });

  test("601 people: every window forward to the 601st and back to the first, never more than one walk of three pages kept", async () => {
    const w = world();
    w.setCache(people(601));
    await w.mount("/people/requests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    await picked(100);
    bounded(w, "window 1, one page");
    for (const [action, last] of [
      ["picker-more", 200],
      ["picker-more", 300],
      ["picker-next", 400],
      ["picker-more", 500],
      ["picker-more", 600],
      ["picker-next", 601],
    ] as const) {
      await click(action);
      await picked(last);
      bounded(w, `${action} to ${last}`);
    }
    expect(document.querySelectorAll("[data-pick-person]")).toHaveLength(1);
    await click("picker-earlier");
    await picked(600);
    bounded(w, "back to window 2");
    await click("picker-earlier");
    await picked(1);
    await picked(300);
    bounded(w, "back to window 1");
    expect(retained(w)).toEqual({ entries: 1, rows: 300 });
  }, 60_000);

  for (const purpose of ["link", "merge-first", "merge-second"] as const)
    test(`${purpose}: the next window releases the earlier one, and Show earlier people reads it again`, async () => {
      const w = world();
      w.setCache(people(301));
      await w.mount("/people/requests");
      if (purpose === "link")
        fireEvent.click(
          await screen.findByRole("button", { name: copy.CHOOSE }),
        );
      else {
        fireEvent.click(
          await screen.findByRole("button", { name: copy.ASK_TO_MERGE }),
        );
        if (purpose === "merge-second") {
          await click("choose-first");
          fireEvent.click(await picked(1));
          await click("choose-second");
        } else await click("choose-first");
      }
      await picked(100);
      await click("picker-more");
      await picked(200);
      await click("picker-more");
      await picked(300);
      bounded(w, "three pages");
      const keyed =
        [...w.people.memory.summaries.keys()].find((key) =>
          key.startsWith("picker:"),
        ) ?? "";
      expect(keyed.startsWith(`picker:`)).toBe(true);
      expect(keyed).toContain(
        purpose === "merge-second" ? `merge-second:${pid(1)}` : purpose,
      );
      await click("picker-next");
      await picked(301);
      expect(retained(w)).toEqual({ entries: 1, rows: 1 });
      const before = issued(w, "readSummaries");
      await click("picker-earlier");
      await picked(300);
      expect(
        issued(w, "readSummaries"),
        "the earlier window is read again",
      ).toBe(before + 3);
      bounded(w, "back");
      if (purpose === "merge-second")
        expect(document.querySelector(`[data-pick-person="${pid(1)}"]`)).toBe(
          null,
        );
      else await picked(1);
    }, 30_000);

  test("S8: a page held while the picker is closed and another opened: the old walk applies nothing and reads no further page; the incoming list is untouched", async () => {
    const w = world();
    w.setCache(people(150));
    w.api.requests.incoming = [linkRequest()];
    await w.mount("/people/requests");
    await present(`[data-incoming-request="${R1}"]`);
    const lists = issued(w, "readRequests");
    fireEvent.click(await screen.findByRole("button", { name: copy.CHOOSE }));
    await picked(100);
    // The next walk (two pages) reads its first page again: that read is held.
    const first = await w.api.readSummaries("not_linked", {
      after: null,
      limit: 100,
      archived: false,
    });
    w.api.calls.pop();
    const page = held<unknown>();
    w.api.next.summaries.push(page.answer as never);
    await click("picker-more");
    await waitFor(() => expect(w.api.next.summaries).toHaveLength(0));
    fireEvent.click(screen.getByRole("button", { name: `‹ ${copy.CANCEL}` }));
    fireEvent.click(
      await screen.findByRole("button", { name: copy.ASK_TO_MERGE }),
    );
    await click("choose-first");
    await picked(100);
    const reads = issued(w, "readSummaries");
    await act(async () => page.release(first));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(issued(w, "readSummaries"), "no further page of the old walk").toBe(
      reads,
    );
    const keys = [...w.people.memory.summaries.keys()].filter((key) =>
      key.startsWith("picker:"),
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("merge-first");
    expect(w.people.memory.summaries.get("requests:incoming")?.state.kind).toBe(
      "ready",
    );
    expect(issued(w, "readRequests")).toBe(lists);
  });
});

describe("DA-N1 (review 2's design assessment): Sent keeps the page shown, not every page visited", () => {
  const sid = (n: number) =>
    `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const sentEntries = (w: ReturnType<typeof peopleWorld>) =>
    [...w.people.memory.summaries].filter(([key]) =>
      key.startsWith("requests:sent:"),
    );

  test("seven pages forward, then Previous: one page kept at each step, the earlier page read again by its cursor", async () => {
    const w = world();
    w.api.requests.sent = Array.from({ length: 350 }, (_, i) =>
      sent(sid(i + 1), "declined"),
    );
    await w.mount("/people/requests");
    await present(`[data-sent-request="${sid(50)}"]`);
    for (let page = 2; page <= 7; page += 1) {
      fireEvent.click(await screen.findByRole("button", { name: copy.NEXT }));
      await present(`[data-sent-request="${sid(page * 50)}"]`);
      const kept = sentEntries(w);
      expect(kept, `page ${page}: one page kept`).toHaveLength(1);
      const state = kept[0]?.[1].state;
      expect(
        state?.kind === "ready"
          ? (state.value as { value: { items: unknown[] } }).value.items.length
          : 0,
      ).toBe(50);
    }
    const before = issued(w, "readSentRequests");
    fireEvent.click(await screen.findByRole("button", { name: copy.PREVIOUS }));
    await present(`[data-sent-request="${sid(300)}"]`);
    expect(issued(w, "readSentRequests")).toBe(before + 1);
    expect(sentEntries(w)).toHaveLength(1);
  });

  test("S9: an uncertain cancel whose page is let go stays retryable when its row is shown again (the same key and body)", async () => {
    const w = world();
    w.api.requests.sent = [
      sent(sid(1), "pending"),
      ...Array.from({ length: 59 }, (_, i) => sent(sid(i + 2), "declined")),
    ];
    await w.mount("/people/requests");
    w.api.next.people.push({ ok: false, kind: "uncertain" } as Receipt);
    fireEvent.click(
      within(await present(`[data-sent-request="${sid(1)}"]`)).getByRole(
        "button",
        { name: copy.CANCEL_REQUEST_TO("mo") },
      ),
    );
    await waitFor(() => expect(commands(w)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryAllByText(copy.UNCERTAIN).length).toBeGreaterThan(0),
    );
    fireEvent.click(await screen.findByRole("button", { name: copy.NEXT }));
    await present(`[data-sent-request="${sid(60)}"]`);
    expect(sentEntries(w).map(([key]) => key)).toEqual([
      `requests:sent:${sid(50)}`,
    ]);
    expect(w.people.memory.attempts.size, "the attempt is kept").toBe(1);
    fireEvent.click(await screen.findByRole("button", { name: copy.PREVIOUS }));
    const retry = within(
      await present(`[data-sent-request="${sid(1)}"]`),
    ).getByRole("button", { name: copy.CANCEL_REQUEST_TO("mo") });
    expect(retry.textContent).toBe(copy.TRY_AGAIN);
    fireEvent.click(retry);
    await waitFor(() => expect(commands(w)).toHaveLength(2));
    expect(commands(w)[1]).toEqual(commands(w)[0]);
  });
});
