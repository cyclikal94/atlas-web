import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { captureDefaults, type DraftRow } from "../../../src/data";
import { createDefaultsSource } from "../../../src/data/engine/defaults-source";
import type { ReadResult } from "../../../src/data/engine/identity-task";
import * as copy from "../../../src/features/sharing/copy";
import { DefaultsReview } from "../../../src/features/sharing/DefaultsReview";
import * as syncCopy from "../../../src/features/sync/copy";
import { QueuePanel } from "../../../src/features/sync/QueuePanel";
import { describeRow } from "../../../src/features/sync/rows";
import type { Identity } from "../../../src/session";
import { Cell } from "../../support/data/defaults-world";
import { draftRow } from "../../support/data/rows";
import {
  ELSEWHERE,
  HOME,
  household,
  JAMIE,
  ME,
  PRIYA,
  record,
  revision,
  SAM,
  snapshot,
} from "../../support/data/sharing";
import { type StubEnv, stubEnv } from "../../support/data/ui-env";
import { mountSharing } from "../../support/sharing/mount";

/**
 * A5, A11, A12 (component layer): the defaults review (WEB-04 §5.7) and its entry from the `/sync` queue, over the data env double, in
 * jsdom. FIXTURE evidence: what the screens do with each state; the outbox's own rules are tested over the double of IndexedDB
 * (`outbox-defaults-review.test.ts`) and in real engines (E-SH5).
 */
afterEach(cleanup);

const homeWith = (...names: string[]) =>
  household({
    id: HOME,
    members: [
      { account_id: ME, username: "me", role: "manager" },
      ...names.map((name, n) => ({
        account_id: [SAM, PRIYA][n] as string,
        username: name,
        role: "member" as const,
      })),
    ],
  });

/** A draft queued with a capture of `then` for `kinds`, blocked (or sent and refused when `inFlight`). */
function reviewDraft(
  then: ReturnType<typeof record> | null,
  kinds: Array<"person" | "progress" | "task">,
  inFlight = false,
): DraftRow {
  const capture = captureDefaults(then, kinds);
  return draftRow({
    local_id: "aaaaaaaa-0000-4000-8000-000000000001",
    status: inFlight ? "in_flight" : "queued",
    defaults_revision: capture.defaultsRevision,
    defaults_context: capture.defaultsContext,
    review_block: { kind: "defaults", kinds: inFlight ? [] : kinds },
    kind: "create_person",
  });
}

/** The current snapshot, delivered by the review's own refresh (issued after it opened). */
function serveNow(env: StubEnv, snap: ReturnType<typeof snapshot>) {
  env.refreshDefaults = async () => {
    const now = Date.now() + 1;
    env.setDefaults(record(snap, { issued_at: now, fetched_at: now }));
    return "fetched";
  };
}

function mountReview(draft: DraftRow, env: StubEnv, online = true) {
  const onClose = vi.fn();
  const view = mountSharing(
    <DefaultsReview draft={draft} onClose={onClose} />,
    {
      env,
      sharing: { online },
    },
  );
  return { ...view, onClose };
}

const confirmButton = () =>
  document.querySelector<HTMLButtonElement>(
    "[data-confirm]",
  ) as HTMLButtonElement;

describe("the four cases (WEB-04 §5.7)", () => {
  test("2. sent and refused with defaults_changed: 'have changed', and Was/Now show the member lists (a membership-only change is visible)", async () => {
    const env = stubEnv();
    const then = record(snapshot({ households: [homeWith("sam")] }));
    serveNow(
      env,
      snapshot({
        revision: revision(2),
        households: [homeWith("sam", "priya")],
      }),
    );
    mountReview(reviewDraft(then, ["person"], true), env);
    expect(
      await screen.findByText(copy.REVIEW_HEADINGS.changed_rejected),
    ).toBeInTheDocument();
    expect(
      screen.getByText(copy.REVIEW_BODIES.changed_rejected),
    ).toBeInTheDocument();
    const section = document.querySelector(
      '[data-review-kind="person"]',
    ) as HTMLElement;
    const was = within(section).getByText(copy.REVIEW_WAS)
      .parentElement as HTMLElement;
    const now = within(section).getByText(copy.REVIEW_NOW)
      .parentElement as HTMLElement;
    // The same template (primary household · edit) both times; only the members differ.
    expect(was).toHaveTextContent("Primary household “Home” · edit");
    expect(now).toHaveTextContent("Primary household “Home” · edit");
    expect(was).toHaveTextContent("Home · Edit: me, sam");
    expect(was).not.toHaveTextContent("priya");
    expect(now).toHaveTextContent("Home · Edit: me, sam, priya");
    expect(was).toHaveTextContent(copy.REVIEW_WAS_NOTE(revision(1)));
    expect((await axe(document.body)).violations).toEqual([]);
  });

  test("1. never fetched: 'review before sending', Was is not recorded, and nothing claims the defaults changed", async () => {
    const env = stubEnv();
    serveNow(env, snapshot());
    mountReview(reviewDraft(null, ["person"]), env);
    expect(
      await screen.findByText(copy.REVIEW_BODIES.never_fetched),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.REVIEW_NOT_RECORDED)).toBeInTheDocument();
    expect(
      screen.queryByText(copy.REVIEW_HEADINGS.changed_rejected),
    ).toBeNull();
  });

  test("3. queued, never sent, revision unchanged: says the defaults have NOT changed", async () => {
    const env = stubEnv();
    serveNow(env, snapshot());
    mountReview(reviewDraft(record(), ["person"]), env);
    expect(
      await screen.findByText(copy.REVIEW_BODIES.review_unchanged),
    ).toBeInTheDocument();
  });

  test("4. queued, never sent, revision moved: says they appear to have changed and the change was never sent", async () => {
    const env = stubEnv();
    serveNow(env, snapshot({ revision: revision(5) }));
    mountReview(reviewDraft(record(), ["person"]), env);
    expect(
      await screen.findByText(copy.REVIEW_BODIES.changed_never_sent),
    ).toBeInTheDocument();
  });

  test("one section per template kind the draft consumes, labelled by kind", async () => {
    const env = stubEnv();
    serveNow(env, snapshot());
    mountReview(reviewDraft(record(), ["task", "progress"]), env);
    await screen.findByText(copy.REVIEW_BODIES.review_unchanged);
    expect(
      [...document.querySelectorAll("[data-review-kind]")].map((s) =>
        s.getAttribute("data-review-kind"),
      ),
    ).toEqual(["task", "progress"]);
    expect(screen.getByText("Task sharing")).toBeInTheDocument();
    expect(screen.getByText("Progress sharing")).toBeInTheDocument();
  });
});

describe("Confirm and Discard", () => {
  test("MU-S9: a record persisted BEFORE the review opened is not 'Now': Confirm stays disabled until the review's own read lands", async () => {
    const env = stubEnv();
    // What the page already had: issued long before the review opened.
    env.setDefaults(record(snapshot(), { issued_at: 1, fetched_at: 1 }));
    let deliver: () => void = () => undefined;
    env.refreshDefaults = () =>
      new Promise((resolve) => {
        deliver = () => {
          const now = Date.now() + 1;
          env.setDefaults(
            record(snapshot({ revision: revision(3) }), {
              issued_at: now,
              fetched_at: now,
            }),
          );
          resolve("fetched");
        };
      });
    mountReview(reviewDraft(record(), ["person"]), env);
    await screen.findByText(copy.REVIEW_NOW_LOADING);
    expect(confirmButton()).toBeDisabled();
    deliver();
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
  });

  test("Confirm sends the reviewed revision and the captured 'Now' through the data layer's confirmation, then closes", async () => {
    const env = stubEnv();
    serveNow(env, snapshot({ revision: revision(8) }));
    const t = mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    const call = env.calls.find((c) => c.action === "confirmDefaultsReview");
    expect(call?.args[0]).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(call?.args[1]).toMatchObject({
      defaultsRevision: revision(8),
      defaultsContext: {
        revision: revision(8),
        kinds: { person: expect.any(Object) },
      },
      replacementId: expect.any(String),
    });
  });

  test("a refusal because the draft's versions moved says to review it from its own screen", async () => {
    const env = stubEnv();
    env.confirmResult = { kind: "refused", reason: "rebuild_refused" };
    serveNow(env, snapshot());
    mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    expect(await screen.findByText(copy.REVIEW_OWN_SCREEN)).toBeInTheDocument();
  });

  test("offline: Now needs a connection, Confirm is disabled with that reason, Discard is still offered", async () => {
    const env = stubEnv();
    const t = mountReview(reviewDraft(record(), ["person"]), env, false);
    expect(
      (await screen.findAllByText(copy.REVIEW_NOW_NEEDS_CONNECTION)).length,
    ).toBeGreaterThan(0);
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: copy.REVIEW_DISCARD }));
    await waitFor(() => expect(t.onClose).toHaveBeenCalled());
    expect(env.calls.some((c) => c.action === "discard")).toBe(true);
    expect(env.calls.some((c) => c.action === "refreshDefaults")).toBe(false);
  });
});

describe("the /sync queue's defaults-review rows (A11)", () => {
  test("a queued blocked draft and a refused one both offer Review sharing and Discard", () => {
    expect(
      describeRow(reviewDraft(record(), ["person"]), true)?.actions,
    ).toEqual(["review", "discard"]);
    expect(
      describeRow(reviewDraft(record(), ["person"], true), true)?.actions,
    ).toEqual(["review", "discard"]);
    expect(describeRow(reviewDraft(record(), ["person"]), true)?.body).toBe(
      syncCopy.DEFAULTS_REVIEW_BODY,
    );
  });

  test("Review sharing opens the review for that draft", async () => {
    const env = stubEnv({ drafts: [reviewDraft(record(), ["person"])] });
    serveNow(env, snapshot());
    mountSharing(
      <QueuePanel
        tab="decision"
        onTabChange={() => undefined}
        onClose={() => undefined}
      />,
      { env },
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: new RegExp(`^${syncCopy.ACTION_REVIEW}`),
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: copy.REVIEW_TITLE }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(copy.REVIEW_BODIES.review_unchanged),
    ).toBeInTheDocument();
  });
});

/** WEB-12a review cycle 1: the review covers every consumed kind (R3), shows who and how (R4), and confirms only what it showed (R2). */
describe("R3: every consumed kind is reviewed, not only the blocked ones", () => {
  test("MU-S26: a capture of person (known) and task (unavailable household) shows BOTH, and Confirm captures both", async () => {
    const env = stubEnv();
    const then = record(
      snapshot({
        templates: {
          person: { kind: "private" },
          task: {
            kind: "explicit",
            policy: {
              grants: [{ kind: "household", id: ELSEWHERE, edit: false }],
              exclude_accounts: [],
            },
          },
        },
      }),
    );
    const capture = captureDefaults(then, ["person", "task"]);
    expect(capture.defaultsReview).toEqual(["task"]);
    // Before the review, the person default moved from Private to the household: it must be presented for consent.
    serveNow(
      env,
      snapshot({
        revision: revision(2),
        templates: { person: { kind: "primary_household", edit: true } },
      }),
    );
    const draft = draftRow({
      local_id: "aaaaaaaa-0000-4000-8000-000000000002",
      status: "queued",
      defaults_revision: capture.defaultsRevision,
      defaults_context: capture.defaultsContext,
      review_block: { kind: "defaults", kinds: capture.defaultsReview },
      kind: "create_task",
    });
    mountReview(draft, env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    expect(
      [...document.querySelectorAll("[data-review-kind]")].map((e) =>
        e.getAttribute("data-review-kind"),
      ),
    ).toEqual(["person", "task"]);
    const person = document.querySelector(
      '[data-review-kind="person"]',
    ) as HTMLElement;
    expect(
      within(person).getByText(copy.REVIEW_WAS).parentElement,
    ).toHaveTextContent("Private");
    expect(
      within(person).getByText(copy.REVIEW_NOW).parentElement,
    ).toHaveTextContent("Primary household “Home” · edit");
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(env.calls.some((c) => c.action === "confirmDefaultsReview")).toBe(
        true,
      ),
    );
    const sent = env.calls.find((c) => c.action === "confirmDefaultsReview")
      ?.args[1] as { defaultsContext: { kinds: object } };
    expect(Object.keys(sent.defaultsContext.kinds).sort()).toEqual([
      "person",
      "task",
    ]);
  });
});

describe("R4: each audience shows its principals, their access and its exclusions", () => {
  const explicit = (
    grants: Array<{ kind: "account" | "household"; id: string; edit: boolean }>,
    exclude_accounts: string[],
  ) => ({
    kind: "explicit" as const,
    policy: { grants, exclude_accounts },
  });
  /** Was and Now of the person section, after the review's own read landed. */
  async function sides(
    was: ReturnType<typeof explicit>,
    now: ReturnType<typeof explicit>,
    households = [homeWith("sam", "priya")],
  ) {
    const env = stubEnv();
    const then = record(snapshot({ templates: { person: was }, households }));
    serveNow(
      env,
      snapshot({
        revision: revision(2),
        templates: { person: now },
        households,
      }),
    );
    mountReview(reviewDraft(then, ["person"], true), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    const section = document.querySelector(
      '[data-review-kind="person"]',
    ) as HTMLElement;
    return {
      was: within(section).getByText(copy.REVIEW_WAS)
        .parentElement as HTMLElement,
      now: within(section).getByText(copy.REVIEW_NOW)
        .parentElement as HTMLElement,
    };
  }

  test("MU-S27: an equal-count recipient swap with a permission increase and an exclusion swap is visible on both sides", async () => {
    const { was, now } = await sides(
      explicit([{ kind: "account", id: SAM, edit: false }], [PRIYA]),
      explicit([{ kind: "account", id: PRIYA, edit: true }], [SAM]),
    );
    expect(was).toHaveTextContent(copy.REVIEW_ACCOUNT_ACCESS("sam", false));
    expect(was).toHaveTextContent(copy.REVIEW_EXCLUDED("priya"));
    expect(now).toHaveTextContent(copy.REVIEW_ACCOUNT_ACCESS("priya", true));
    expect(now).toHaveTextContent(copy.REVIEW_EXCLUDED("sam"));
    expect(was).not.toHaveTextContent(
      copy.REVIEW_ACCOUNT_ACCESS("priya", true),
    );
    expect(
      was
        .querySelector(`[data-review-account="${SAM}"]`)
        ?.getAttribute("data-review-access"),
    ).toBe("read");
    expect(
      now
        .querySelector(`[data-review-account="${PRIYA}"]`)
        ?.getAttribute("data-review-access"),
    ).toBe("edit");
  });

  test("MU-S35: a permission-only change of a household grant (Read → Edit) is visible", async () => {
    const { was, now } = await sides(
      explicit([{ kind: "household", id: HOME, edit: false }], []),
      explicit([{ kind: "household", id: HOME, edit: true }], []),
    );
    expect(was).toHaveTextContent("Home · Read: me, sam, priya");
    expect(now).toHaveTextContent("Home · Edit: me, sam, priya");
  });

  test("an exclusion-only change is visible", async () => {
    const { was, now } = await sides(
      explicit([{ kind: "household", id: HOME, edit: false }], []),
      explicit([{ kind: "household", id: HOME, edit: false }], [SAM]),
    );
    expect(was.querySelector("[data-review-excluded]")).toBeNull();
    expect(now).toHaveTextContent(copy.REVIEW_EXCLUDED("sam"));
  });

  test("names come only from each side's own households: an account neither names keeps an abbreviated id, never today's name on the old side", async () => {
    const env = stubEnv();
    // Was: Home had only me. Now: Home has jamie too. A direct grant to jamie existed then: the old side must not learn the name.
    const then = record(
      snapshot({
        templates: {
          person: explicit([{ kind: "account", id: JAMIE, edit: false }], []),
        },
        households: [homeWith()],
      }),
    );
    serveNow(
      env,
      snapshot({
        revision: revision(2),
        templates: {
          person: explicit([{ kind: "account", id: JAMIE, edit: false }], []),
        },
        households: [
          household({
            id: HOME,
            members: [
              { account_id: ME, username: "me", role: "manager" },
              { account_id: JAMIE, username: "jamie", role: "member" },
            ],
          }),
        ],
      }),
    );
    mountReview(reviewDraft(then, ["person"], true), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    const section = document.querySelector(
      '[data-review-kind="person"]',
    ) as HTMLElement;
    const was = within(section).getByText(copy.REVIEW_WAS)
      .parentElement as HTMLElement;
    const now = within(section).getByText(copy.REVIEW_NOW)
      .parentElement as HTMLElement;
    expect(was).not.toHaveTextContent("jamie");
    expect(was).toHaveTextContent(`Account ${JAMIE.slice(0, 4)}…`);
    expect(now).toHaveTextContent(copy.REVIEW_ACCOUNT_ACCESS("jamie", false));
  });
});

describe("R2: the confirmation names the draft exactly as the review showed it", () => {
  test("MU-S28: Confirm passes the shown row (body digest, revision, context, block, status) as `reviewed`", async () => {
    const env = stubEnv();
    serveNow(env, snapshot());
    const draft = reviewDraft(record(), ["person"]);
    mountReview(draft, env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(env.calls.some((c) => c.action === "confirmDefaultsReview")).toBe(
        true,
      ),
    );
    const sent = env.calls.find((c) => c.action === "confirmDefaultsReview")
      ?.args[1] as { reviewed: unknown };
    expect(sent.reviewed).toEqual({
      local_id: draft.local_id,
      status: draft.status,
      command_digest: draft.command_digest,
      defaults_revision: draft.defaults_revision,
      defaults_context: draft.defaults_context,
      review_block: draft.review_block,
    });
  });

  test("a draft changed while it was reviewed is refused, and the person is told to check it again (nothing closes)", async () => {
    const env = stubEnv();
    env.confirmResult = { kind: "refused", reason: "draft_changed" };
    serveNow(env, snapshot());
    const t = mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    expect(
      await screen.findByText(copy.REVIEW_CHANGED, {
        selector: "[data-sharing-banner] p",
      }),
    ).toBeInTheDocument();
    expect(t.onClose).not.toHaveBeenCalled();
  });
});

// ---- WEB-12a review 2 ------------------------------------------------------------------------------------------------------------
/**
 * The PRODUCTION defaults source, started, with a screen already using it (its first read answered: following is done), and a
 * controlled clock; every read is held until the test answers it. The review is mounted over it, as any screen embedding it would be.
 */
async function overSource(connection: { online: boolean } = { online: true }) {
  let time = 100;
  const held: Array<(result: ReadResult<unknown>) => void> = [];
  const identity = new Cell<Identity | null>({
    account_id: "11111111-1111-4111-8111-111111111111",
    epoch: 1,
    session_id: "s",
  });
  const source = createDefaultsSource({
    identity,
    online: () => connection.online,
    onOnline: () => () => undefined,
    service: () => null,
    clock: { now: () => time },
    quota: {
      reserve: async () => {
        throw new Error("no database");
      },
    },
    readSnapshot: () =>
      new Promise((resolve) => {
        held.push(resolve);
      }),
  });
  const stop = source.start();
  const unuse = source.use();
  await act(async () => {
    await Promise.resolve();
  });
  held.shift()?.({ kind: "ok", value: snapshot() });
  await act(async () => {
    await Promise.resolve();
  });
  expect(held).toHaveLength(0);
  const env = stubEnv();
  Object.assign(env, { defaults: source });
  return {
    env,
    source,
    held,
    setTime: (next: number) => {
      time = next;
    },
    mount: (draft: DraftRow, online = true) =>
      mountSharing(<DefaultsReview draft={draft} onClose={vi.fn()} />, {
        env,
        sharing: { now: () => time, online },
      }),
    stop: () => {
      unuse();
      stop();
    },
  };
}
const blocked = () =>
  draftRow({
    defaults_context: null,
    defaults_revision: null,
    review_block: { kind: "defaults", kinds: ["person"] },
  });

describe("R7: 'Now' is the review's OWN read, asked for after it opened", () => {
  test("control: a review opened with no read under way asks once and offers Confirm on that answer", async () => {
    const t = await overSource();
    t.setTime(200);
    t.mount(blocked());
    expect(t.held).toHaveLength(1);
    await act(async () => {
      t.held.shift()?.({
        kind: "ok",
        value: snapshot({ revision: revision(4) }),
      });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    t.stop();
  });

  test("MU-S49: an older refresh under way when the review opens is not its answer: the review asks for its own snapshot, and Confirm comes on THAT one", async () => {
    const t = await overSource();
    t.setTime(150);
    const older = t.source.refresh();
    t.setTime(200);
    t.mount(blocked());
    // Its own read is issued at once, beside the older one.
    expect(t.held).toHaveLength(2);
    const [a, b] = t.held.splice(0, 2);
    await act(async () => {
      a?.({ kind: "ok", value: snapshot({ revision: revision(2) }) });
      await older;
    });
    // The older answer (issued before the review opened) is not "Now".
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(copy.REVIEW_NOW_LOADING)).toBeInTheDocument();
    await act(async () => {
      b?.({ kind: "ok", value: snapshot({ revision: revision(3) }) });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        t.env.calls.some((c) => c.action === "confirmDefaultsReview"),
      ).toBe(true),
    );
    const call = t.env.calls.find((c) => c.action === "confirmDefaultsReview");
    expect(call?.args[1]).toMatchObject({ defaultsRevision: revision(3) });
    t.stop();
  });

  test("MU-S49: its own read failing beside an older success is a failure the person can retry (never an endless loading), and Retry asks again", async () => {
    const t = await overSource();
    t.setTime(150);
    const older = t.source.refresh();
    t.setTime(200);
    t.mount(blocked());
    const [a, b] = t.held.splice(0, 2);
    await act(async () => {
      a?.({ kind: "ok", value: snapshot({ revision: revision(2) }) });
      await older;
      b?.({ kind: "failure" });
    });
    await waitFor(() =>
      expect(screen.queryByText(copy.REVIEW_NOW_LOADING)).toBeNull(),
    );
    const retry = screen.queryByRole("button", { name: copy.TRY_AGAIN });
    expect(retry).not.toBeNull();
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(retry as HTMLElement);
    expect(t.held).toHaveLength(1);
    await act(async () => {
      t.held.shift()?.({
        kind: "ok",
        value: snapshot({ revision: revision(3) }),
      });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    t.stop();
  });

  test("MU-S50: an answer that still predates the opening (the clock went back) is not 'Now': a retryable failure, Confirm disabled", async () => {
    const env = stubEnv();
    let issued = 1;
    env.refreshDefaults = async () => {
      env.setDefaults(
        record(snapshot({ revision: revision(6) }), {
          issued_at: issued,
          fetched_at: issued,
        }),
      );
      return "fetched";
    };
    mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() =>
      expect(screen.queryByText(copy.REVIEW_NOW_LOADING)).toBeNull(),
    );
    expect(confirmButton()).toBeDisabled();
    expect(screen.queryByText(copy.REVIEW_NOW_FAILED)).not.toBeNull();
    const retry = screen.queryByRole("button", { name: copy.TRY_AGAIN });
    expect(retry).not.toBeNull();
    issued = Date.now() + 1;
    fireEvent.click(retry as HTMLElement);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
  });

  test("MU-S51: an answer landing after the page went offline does not replace the offline state", async () => {
    const env = stubEnv();
    let deliver: () => void = () => undefined;
    env.refreshDefaults = () =>
      new Promise((resolve) => {
        deliver = () => {
          const now = Date.now() + 1;
          env.setDefaults(
            record(snapshot({ revision: revision(3) }), {
              issued_at: now,
              fetched_at: now,
            }),
          );
          resolve("fetched");
        };
      });
    const t = mountReview(reviewDraft(record(), ["person"]), env);
    await screen.findByText(copy.REVIEW_NOW_LOADING);
    t.setSharing({ online: false });
    await act(async () => {
      deliver();
    });
    expect(document.querySelector("[data-review-now] p")?.textContent).toBe(
      copy.REVIEW_NOW_NEEDS_CONNECTION,
    );
    expect(confirmButton()).toBeDisabled();
  });

  test("the snapshot shown is the one confirmed: a newer record reaching the page meanwhile changes neither", async () => {
    const env = stubEnv();
    serveNow(env, snapshot({ revision: revision(8) }));
    mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    const now = document.querySelector("[data-review-now]")?.textContent;
    act(() =>
      env.setDefaults(
        record(
          snapshot({
            revision: revision(9),
            templates: { person: { kind: "private" } },
          }),
          { issued_at: Date.now() + 5, fetched_at: Date.now() + 5 },
        ),
      ),
    );
    expect(document.querySelector("[data-review-now]")?.textContent).toBe(now);
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(env.calls.some((c) => c.action === "confirmDefaultsReview")).toBe(
        true,
      ),
    );
    expect(
      env.calls.find((c) => c.action === "confirmDefaultsReview")?.args[1],
    ).toMatchObject({ defaultsRevision: revision(8) });
  });
});

describe("DA-C1 (review 3 design assessment): each load after the opening asks for a read issued after IT", () => {
  test("MU-S64: a read under way when the connection drops is not 'Now' once it returns: the review asks again at once, and Confirm comes only on that read", async () => {
    const connection = { online: true };
    const t = await overSource(connection);
    t.setTime(200);
    const view = t.mount(blocked());
    expect(t.held).toHaveLength(1);
    t.setTime(250);
    connection.online = false;
    view.setSharing({ online: false });
    expect(confirmButton()).toBeDisabled();
    t.setTime(300);
    connection.online = true;
    view.setSharing({ online: true });
    // Asserted before anything is answered: reconnecting issues its own read beside the one from before the disconnection.
    expect(t.held).toHaveLength(2);
    const [a, b] = t.held.splice(0, 2);
    await act(async () => {
      a?.({ kind: "ok", value: snapshot({ revision: revision(2) }) });
    });
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(copy.REVIEW_NOW_LOADING)).toBeInTheDocument();
    await act(async () => {
      b?.({ kind: "ok", value: snapshot({ revision: revision(3) }) });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        t.env.calls.find((c) => c.action === "confirmDefaultsReview")?.args[1],
      ).toMatchObject({ defaultsRevision: revision(3) }),
    );
    t.stop();
  });

  test("MU-S65: Try again asks for a read issued after it, not one another screen started after the opening", async () => {
    const t = await overSource();
    t.setTime(200);
    t.mount(blocked());
    expect(t.held).toHaveLength(1);
    // Another screen asks after the opening (it would satisfy the opening's boundary) but before Try again.
    t.setTime(250);
    const other = t.source.acquire(t.source.boundary());
    expect(t.held).toHaveLength(2);
    const [own, shared] = t.held.splice(0, 2);
    await act(async () => {
      own?.({ kind: "failure" });
    });
    const retry = await screen.findByRole("button", { name: copy.TRY_AGAIN });
    t.setTime(300);
    fireEvent.click(retry);
    // Asserted before anything is answered: Try again issues its own read.
    expect(t.held).toHaveLength(1);
    await act(async () => {
      shared?.({ kind: "ok", value: snapshot({ revision: revision(2) }) });
      await other;
    });
    expect(confirmButton()).toBeDisabled();
    await act(async () => {
      t.held.shift()?.({
        kind: "ok",
        value: snapshot({ revision: revision(3) }),
      });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(
        t.env.calls.find((c) => c.action === "confirmDefaultsReview")?.args[1],
      ).toMatchObject({ defaultsRevision: revision(3) }),
    );
    t.stop();
  });

  test("control: opened offline, the first read after the connection returns is the review's own, and its answer is 'Now'", async () => {
    const connection = { online: true };
    const t = await overSource(connection);
    connection.online = false;
    t.setTime(200);
    const view = t.mount(blocked(), false);
    expect(t.held).toHaveLength(0);
    expect(confirmButton()).toBeDisabled();
    t.setTime(300);
    connection.online = true;
    view.setSharing({ online: true });
    expect(t.held).toHaveLength(1);
    await act(async () => {
      t.held.shift()?.({
        kind: "ok",
        value: snapshot({ revision: revision(4) }),
      });
    });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    t.stop();
  });
});

describe("C3 (plan §4.6): Confirm needs the connection and the review's own read", () => {
  test("MU-S54: going offline after a fresh read disables Confirm with the connection reason; back online it is offered again only after the review reads again", async () => {
    const env = stubEnv();
    serveNow(env, snapshot({ revision: revision(8) }));
    const t = mountReview(reviewDraft(record(), ["person"]), env);
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    const reads = () =>
      env.calls.filter((c) => c.action === "refreshDefaults").length;
    expect(reads()).toBe(1);
    t.setSharing({ online: false });
    expect(confirmButton()).toBeDisabled();
    expect(
      document.getElementById(
        confirmButton().getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe(copy.REVIEW_NOW_NEEDS_CONNECTION);
    fireEvent.click(confirmButton());
    expect(env.calls.some((c) => c.action === "confirmDefaultsReview")).toBe(
      false,
    );
    t.setSharing({ online: true });
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    expect(reads()).toBe(2);
  });
});
