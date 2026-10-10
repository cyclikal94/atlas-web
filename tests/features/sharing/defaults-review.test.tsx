import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, test, vi } from "vitest";
import { captureDefaults, type DraftRow } from "../../../src/data";
import * as copy from "../../../src/features/sharing/copy";
import { DefaultsReview } from "../../../src/features/sharing/DefaultsReview";
import * as syncCopy from "../../../src/features/sync/copy";
import { QueuePanel } from "../../../src/features/sync/QueuePanel";
import { describeRow } from "../../../src/features/sync/rows";
import { draftRow } from "../../support/data/rows";
import {
  HOME,
  household,
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
    expect(was).toHaveTextContent("Home: me, sam");
    expect(was).not.toHaveTextContent("priya");
    expect(now).toHaveTextContent("Home: me, sam, priya");
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
