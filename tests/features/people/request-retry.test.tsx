import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  forgetAllPeopleMemory,
  type PeopleMemory,
  peopleMemory,
} from "../../../src/features/people/memory";
import type {
  IncomingRequest,
  SentRequest,
} from "../../../src/features/people/model/requests";
import * as copy from "../../../src/features/people/requests/copy";
import { retryRequestRead } from "../../../src/features/people/requests/reads";
import { forgetRefusedPolicies } from "../../../src/features/sharing/api";
import { installMatchMedia } from "../../helpers/match-media";
import { ME, MO, record } from "../../support/people/records";
import { peopleWorld, person } from "../../support/people/world";

/**
 * R7 of review 3 (3 November 2026; family `people-request-stale-refusal-cache`, classification incomplete_fix): EVERY explicit Try again
 * of a failed request read retires the key's remembered refusal and every dispatch made before it, then reads. Review 3 found the sender's
 * and the recipient's failed-preview Try again reading WITHOUT that boundary (an obsolete 403 refused the retry, or came back after it);
 * the incoming and Sent lists did it in their own handlers. The design assessment's Q1/Q2/Q8 schedules (`.agtx/design-assessment.md`),
 * run here against every request-read adapter as the screens wire it: the sender's comparison from BOTH of its routes, the recipient's
 * review, the incoming list and Sent's first and a later page. Healthy and current-403 controls run on the same adapters.
 *
 * FIXTURE evidence at the component level (the production providers, routes and summaries machinery, over the people world's fake server).
 * Each answer is ordered by explicit holds and observed dispatches, never by sleeps; the short quiet waits only check that nothing MORE is
 * asked, and are not what any ordering depends on.
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

const ADA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the sender's source (merged into Bea)
const BEA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the sender's target (kept)
const R_LINK = "10000000-0000-4000-8000-000000000001";
const R_MERGE = "10000000-0000-4000-8000-000000000009";
const DAY = 86_400;
const inDays = (days: number) =>
  Math.floor(Date.now() / 1000) + days * DAY + 60;
const OBSOLETE = {
  ok: false,
  kind: "forbidden",
  requestId: "obsolete-403-ref",
} as const;
const CURRENT = {
  ok: false,
  kind: "forbidden",
  requestId: "current-403-ref",
} as const;
const UNCERTAIN = { ok: false, kind: "uncertain" } as const;

type World = ReturnType<typeof peopleWorld>;
type Answer = unknown;

/** An answer held until the test releases it (the read is ISSUED when the fake is called, and recorded in `calls`). */
function held() {
  let release: (value: Answer) => void = () => {};
  const answer = () =>
    new Promise<Answer>((resolve) => {
      release = resolve;
    });
  return { answer, release: (value: Answer) => release(value) };
}

const sentItem = (id: string): SentRequest => ({
  id,
  recipient_id: MO,
  recipient_username: "mo",
  expires_at: inDays(4),
  state: "pending",
  proposal: { kind: "link", person_id: ADA, account_id: MO, name: "Ada" },
});
/** 51 sent requests: the first page is 50 (its cursor is the 50th id), the second holds the 51st. */
const SENT = Array.from({ length: 51 }, (_, i) =>
  sentItem(`20000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
);
const CURSOR = SENT[49]?.id as string;
const LAST = SENT[50]?.id as string;

const linkRequest: IncomingRequest = {
  id: R_LINK,
  sender_id: MO,
  expires_at: inDays(5),
  proposal: { kind: "link", person_id: ADA, account_id: ME, name: "Ada" },
};
const mergeRequest: IncomingRequest = {
  id: R_MERGE,
  sender_id: MO,
  expires_at: inDays(1),
  proposal: { kind: "merge", source_id: ADA, target_id: BEA, name: "Ada" },
};

function world(): World {
  const w = peopleWorld();
  w.env.setDefaults(record({ members: [ME, MO] }));
  w.setCache([
    person({ id: ADA, label: "Ada" }),
    person({ id: BEA, label: "Bea" }),
  ]);
  w.api.linked.set(ADA, null);
  w.api.linked.set(BEA, null);
  return w;
}

type Queue = "mergePreview" | "recipientPreview" | "requests" | "sent";
interface Adapter {
  name: string;
  /** The read key in page memory (`requests/reads.ts`). */
  key: string;
  queue: Queue;
  /** This adapter's dispatches so far (only those of its own key). */
  asked(w: World): number;
  /** Server state that makes a read with no scripted answer succeed. */
  setup(w: World): void;
  /** Scripts `answers` for this key's next reads and shows the view (its first read is the first answer). */
  start(w: World, answers: Answer[]): Promise<void>;
  /** The element that holds this view (its Try again is within it). */
  panel(): HTMLElement | null;
  /** The healthy result is shown. */
  shown(): boolean;
  /** A current 403 is shown, as this view shows it. */
  refusalShown(): boolean;
  preview: boolean;
}

const callsOf = (w: World, op: string) =>
  w.api.calls.filter((call) => call.op === op);
const comparison = () =>
  document.querySelector("[data-merge-comparison]") !== null;
const dialog = () =>
  document.querySelector('[role="dialog"]') as HTMLElement | null;
/** Within the dialog: the page's assertive live region keeps the last announced message after the view recovers. */
const previewRefused = () => {
  const shown = dialog();
  return (
    shown !== null &&
    within(shown).queryAllByText(copy.PREVIEW_FORBIDDEN).length > 0
  );
};
const listFailed = (panel: HTMLElement | null) =>
  panel !== null &&
  within(panel).queryAllByText(copy.REQUESTS_FAILED).length > 0;

function sender(name: string, path: string): Adapter {
  return {
    name,
    key: `merge:${ADA}:${BEA}`,
    queue: "mergePreview",
    asked: (w) =>
      callsOf(w, "previewMerge").filter(
        (call) => call.args[0] === ADA && call.args[1] === BEA,
      ).length,
    setup: () => {},
    start: async (w, answers) => {
      w.api.next.mergePreview.push(...(answers as never[]));
      await w.mount(path);
    },
    panel: dialog,
    shown: comparison,
    refusalShown: previewRefused,
    preview: true,
  };
}

const ADAPTERS: Adapter[] = [
  sender("sender (Compare & merge route)", `/people/${BEA}/duplicates/${ADA}`),
  sender(
    "sender (Requests merge route)",
    `/people/requests/merge/${ADA}/${BEA}`,
  ),
  {
    name: "recipient",
    key: `requests:review:${R_MERGE}`,
    queue: "recipientPreview",
    asked: (w) => callsOf(w, "readRecipientPreview").length,
    setup: (w) => {
      w.api.requests.incoming = [mergeRequest];
      w.api.requests.previews.set(R_MERGE, {
        token: "1".repeat(64),
        source: null,
        target: {
          id: BEA,
          kind: "person",
          parent_id: null,
          label: "Bea",
          value: null,
          version: 3,
          can_edit: true,
          archived: false,
          policy_version: 2,
        },
        fields: [],
        requires_approval: true,
        combines_identity_audiences: true,
        freezes_field_policies: true,
        stale: false,
      });
    },
    start: async (w, answers) => {
      w.api.next.recipientPreview.push(...(answers as never[]));
      await w.mount(`/people/requests/${R_MERGE}`);
    },
    panel: dialog,
    shown: comparison,
    refusalShown: previewRefused,
    preview: true,
  },
  {
    name: "incoming",
    key: "requests:incoming",
    queue: "requests",
    asked: (w) => callsOf(w, "readRequests").length,
    setup: (w) => {
      w.api.requests.incoming = [linkRequest];
    },
    start: async (w, answers) => {
      w.api.next.requests.push(...(answers as never[]));
      await w.mount("/people/requests");
    },
    panel: () => document.querySelector("[data-requests-incoming]"),
    shown: () =>
      document.querySelector(`[data-incoming-request="${R_LINK}"]`) !== null,
    refusalShown: () =>
      listFailed(document.querySelector("[data-requests-incoming]")),
    preview: false,
  },
  {
    name: "Sent (first page)",
    key: "requests:sent:",
    queue: "sent",
    asked: (w) =>
      callsOf(w, "readSentRequests").filter(
        (call) => (call.args[0] as { after: string | null }).after === null,
      ).length,
    setup: (w) => {
      w.api.requests.sent = [SENT[0] as SentRequest];
    },
    start: async (w, answers) => {
      w.api.next.sent.push(...(answers as never[]));
      await w.mount("/people/requests");
    },
    panel: () => document.querySelector("[data-requests-sent]"),
    shown: () =>
      document.querySelector(`[data-sent-request="${SENT[0]?.id}"]`) !== null,
    refusalShown: () =>
      listFailed(document.querySelector("[data-requests-sent]")),
    preview: false,
  },
  {
    name: "Sent (a later page)",
    key: `requests:sent:${CURSOR}`,
    queue: "sent",
    asked: (w) =>
      callsOf(w, "readSentRequests").filter(
        (call) => (call.args[0] as { after: string | null }).after === CURSOR,
      ).length,
    setup: (w) => {
      w.api.requests.sent = SENT;
    },
    start: async (w, answers) => {
      await w.mount("/people/requests");
      await waitFor(() =>
        expect(document.querySelectorAll("[data-sent-request]")).toHaveLength(
          50,
        ),
      );
      // The later page's reads are the scripted ones (the first page was read from the fake server's history).
      w.api.next.sent.push(...(answers as never[]));
      fireEvent.click(screen.getByRole("button", { name: copy.NEXT }));
    },
    panel: () => document.querySelector("[data-requests-sent]"),
    shown: () =>
      document.querySelector(`[data-sent-request="${LAST}"]`) !== null,
    refusalShown: () =>
      listFailed(document.querySelector("[data-requests-sent]")),
    preview: false,
  },
];

const stateOf = (w: World, key: string) =>
  w.people.memory.summaries.get(key)?.state.kind;
const commands = (w: World) => callsOf(w, "peopleCommand");
/** The failed view's own Try again (waits until it is offered). */
const tryAgain = async (adapter: Adapter) =>
  waitFor(() =>
    within(adapter.panel() as HTMLElement).getByRole("button", {
      name: copy.TRY_AGAIN,
    }),
  );
const quiet = () => new Promise((resolve) => setTimeout(resolve, 40));
/** The view itself mentions `text` (its panel, not the page's live region). */
const mentions = (adapter: Adapter, text: string) =>
  (adapter.panel()?.textContent ?? "").includes(text);

describe("R7 (review 3): every failed request read's Try again retires the key's refusal and earlier dispatches, then reads", () => {
  for (const adapter of ADAPTERS) {
    test(`Q1 ${adapter.name}: A held; an invalidation; B uncertain; A's 403 arrives while the read is failed; Try again: C reaches the server and is shown`, async () => {
      const w = world();
      adapter.setup(w);
      const a = held();
      await adapter.start(w, [a.answer, UNCERTAIN]);
      await waitFor(() => expect(adapter.asked(w)).toBe(1));
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() => expect(stateOf(w, adapter.key)).toBe("failed"));
      expect(adapter.asked(w)).toBe(2);
      await act(async () => a.release(OBSOLETE));
      expect(stateOf(w, adapter.key), "the read stays failed").toBe("failed");
      expect(
        w.people.memory.requestRefusals.has(adapter.key),
        "precondition: A's 403 is the newest definite answer so far (B's was uncertain), so it is remembered until an explicit retry",
      ).toBe(true);
      fireEvent.click(await tryAgain(adapter));
      await waitFor(() => expect(stateOf(w, adapter.key)).not.toBe("loading"));
      expect(
        adapter.asked(w),
        "the explicit Try again reaches the server (it does not reuse A's obsolete refusal)",
      ).toBe(3);
      await waitFor(() => expect(adapter.shown()).toBe(true));
      expect(adapter.refusalShown()).toBe(false);
      expect(
        mentions(adapter, OBSOLETE.requestId),
        "A's reference is not shown",
      ).toBe(false);
      expect(w.people.memory.requestRefusals.has(adapter.key)).toBe(false);
      const ledger = w.people.memory.requestReads.get(adapter.key);
      expect(ledger?.answered).toBe(ledger?.issued);
      expect(commands(w), "a read's retry sends no command").toHaveLength(0);
    });

    test(`Q2 ${adapter.name}: A held; B uncertain; Try again asks C (held); A then answers 403 and C is uncertain: A cannot remember a refusal, the next invalidation asks D and shows it`, async () => {
      const w = world();
      adapter.setup(w);
      const a = held();
      const c = held();
      await adapter.start(w, [a.answer, UNCERTAIN, c.answer]);
      await waitFor(() => expect(adapter.asked(w)).toBe(1));
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() => expect(stateOf(w, adapter.key)).toBe("failed"));
      expect(adapter.asked(w)).toBe(2);
      fireEvent.click(await tryAgain(adapter));
      await waitFor(() => expect(adapter.asked(w)).toBe(3));
      await act(async () => a.release(OBSOLETE));
      expect(
        w.people.memory.requestRefusals.has(adapter.key),
        "A was dispatched before the explicit retry: its 403 is obsolete",
      ).toBe(false);
      // C stays uncertain: a successful C would end any refusal by itself and hide a missing retirement.
      await act(async () => c.release(UNCERTAIN));
      await waitFor(() => expect(stateOf(w, adapter.key)).toBe("failed"));
      act(() => w.people.memory.invalidateSummaries());
      await waitFor(() => expect(stateOf(w, adapter.key)).not.toBe("loading"));
      expect(
        adapter.asked(w),
        "automatic freshness after the explicit retry asks again (D)",
      ).toBe(4);
      await waitFor(() => expect(adapter.shown()).toBe(true));
      expect(adapter.refusalShown()).toBe(false);
      expect(mentions(adapter, OBSOLETE.requestId)).toBe(false);
      expect(w.people.memory.requestRefusals.has(adapter.key)).toBe(false);
      expect(commands(w)).toHaveLength(0);
    });

    test(`Q8 ${adapter.name}: two presses of one failed view's Try again make ONE read, and the ignored press does not retire it (its own 403 is remembered: no storm)`, async () => {
      const w = world();
      adapter.setup(w);
      const c = held();
      await adapter.start(w, [UNCERTAIN, c.answer]);
      await waitFor(() => expect(stateOf(w, adapter.key)).toBe("failed"));
      expect(adapter.asked(w)).toBe(1);
      // Both presses reach the SAME rendered button: the read installs its loading entry without re-rendering before its answer.
      const button = await tryAgain(adapter);
      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => expect(adapter.asked(w)).toBe(2));
      await quiet();
      expect(adapter.asked(w), "one admitted read").toBe(2);
      await act(async () => c.release(CURRENT));
      await waitFor(() => expect(adapter.refusalShown()).toBe(true));
      expect(
        w.people.memory.requestRefusals.has(adapter.key),
        "the admitted read's own 403 is current: the ignored press retired nothing after it",
      ).toBe(true);
      act(() => w.people.memory.invalidateSummaries());
      await quiet();
      expect(
        adapter.asked(w),
        "a current 403 is not asked again by itself",
      ).toBe(2);
      expect(adapter.refusalShown()).toBe(true);
    });

    test(`control ${adapter.name}: a failed read with no older dispatch: Try again asks once and shows`, async () => {
      const w = world();
      adapter.setup(w);
      await adapter.start(w, [UNCERTAIN]);
      await waitFor(() => expect(stateOf(w, adapter.key)).toBe("failed"));
      expect(adapter.asked(w)).toBe(1);
      fireEvent.click(await tryAgain(adapter));
      await waitFor(() => expect(adapter.shown()).toBe(true));
      expect(adapter.asked(w)).toBe(2);
    });

    test(`control ${adapter.name}: a CURRENT 403 is not asked again by an invalidation; its explicit action asks once and shows`, async () => {
      const w = world();
      adapter.setup(w);
      await adapter.start(w, [CURRENT]);
      await waitFor(() => expect(adapter.refusalShown()).toBe(true));
      expect(adapter.asked(w)).toBe(1);
      act(() => w.people.memory.invalidateSummaries());
      await quiet();
      expect(adapter.asked(w), "not asked again by itself").toBe(1);
      expect(adapter.refusalShown()).toBe(true);
      if (adapter.preview)
        fireEvent.click(
          document.querySelector(
            '[data-people-action="preview-again"]',
          ) as HTMLElement,
        );
      else fireEvent.click(await tryAgain(adapter));
      await waitFor(() => expect(adapter.shown()).toBe(true));
      expect(adapter.asked(w)).toBe(2);
      expect(adapter.refusalShown()).toBe(false);
    });
  }
});

describe("R7 (review 3): the explicit retry's admission and order (`retryRequestRead`)", () => {
  const KEY = "requests:incoming";
  /** A key whose read failed, with a refusal its dispatch 1 remembered and dispatch 2 (uncertain) since. */
  const failedAndRefused = (memory: PeopleMemory) => {
    memory.summaries.set(KEY, {
      generation: memory.summaryGeneration,
      state: { kind: "failed", reason: "failed" },
    });
    memory.requestRefusals.set(KEY, {
      refusal: { ok: false, kind: "forbidden", requestId: "kept" },
      dispatch: 1,
    });
    memory.requestReads.set(KEY, { issued: 2, answered: 1, latest: null });
  };
  const untouched = (memory: PeopleMemory) => {
    expect(memory.requestRefusals.has(KEY)).toBe(true);
    expect(memory.requestReads.get(KEY)?.answered).toBe(1);
  };

  test("admitted: the refusal and every earlier dispatch are retired BEFORE the forced read starts", () => {
    const memory = peopleMemory(`${ME}:1`);
    failedAndRefused(memory);
    const seen: Array<{ refused: boolean; answered?: number }> = [];
    retryRequestRead({ memory, online: true }, KEY, () =>
      seen.push({
        refused: memory.requestRefusals.has(KEY),
        answered: memory.requestReads.get(KEY)?.answered,
      }),
    );
    expect(seen).toEqual([{ refused: false, answered: 2 }]);
  });

  test("a press kept from before another identity was shown retires and reads nothing, in either memory", () => {
    const old = peopleMemory(`${ME}:1`);
    failedAndRefused(old);
    const next = peopleMemory(`${MO}:1`);
    failedAndRefused(next);
    let reads = 0;
    retryRequestRead({ memory: old, online: true }, KEY, () => {
      reads += 1;
    });
    expect(reads).toBe(0);
    untouched(old);
    untouched(next);
  });

  test("offline: nothing is retired and nothing is read", () => {
    const memory = peopleMemory(`${ME}:1`);
    failedAndRefused(memory);
    let reads = 0;
    retryRequestRead({ memory, online: false }, KEY, () => {
      reads += 1;
    });
    expect(reads).toBe(0);
    untouched(memory);
  });

  for (const state of [
    { kind: "loading" } as const,
    { kind: "ready", value: null, checkedAt: 1 } as const,
    null,
  ])
    test(`not failed (${state?.kind ?? "no entry: released or invalidated"}): nothing is retired and nothing is read`, () => {
      const memory = peopleMemory(`${ME}:1`);
      failedAndRefused(memory);
      if (state === null) memory.summaries.delete(KEY);
      else
        memory.summaries.set(KEY, {
          generation: memory.summaryGeneration,
          state,
        });
      let reads = 0;
      retryRequestRead({ memory, online: true }, KEY, () => {
        reads += 1;
      });
      expect(reads).toBe(0);
      untouched(memory);
    });

  test("another key's refusal and dispatches are untouched", () => {
    const memory = peopleMemory(`${ME}:1`);
    failedAndRefused(memory);
    memory.requestRefusals.set("requests:sent:", {
      refusal: { ok: false, kind: "forbidden" },
      dispatch: 1,
    });
    memory.requestReads.set("requests:sent:", {
      issued: 2,
      answered: 1,
      latest: null,
    });
    retryRequestRead({ memory, online: true }, KEY, () => {});
    expect(memory.requestRefusals.has(KEY)).toBe(false);
    expect(memory.requestRefusals.has("requests:sent:")).toBe(true);
    expect(memory.requestReads.get("requests:sent:")?.answered).toBe(1);
  });
});
