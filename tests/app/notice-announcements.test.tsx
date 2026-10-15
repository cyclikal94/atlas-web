import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  REMAINED_SIGNED_IN,
  SessionNotices,
} from "../../src/app/SessionNotices";
import {
  type Announcer,
  AnnouncerProvider,
  liveRegions,
  useAnnouncer,
} from "../../src/components/ui/announcer";
import { NEUTRAL_COPY } from "../../src/components/ui/neutral-state";
import { authFeedback } from "../../src/features/authentication/feedback";
import {
  LOCK_WAIT_BANNER,
  MESSAGE_TEXT,
} from "../../src/features/authentication/outcome-copy";
import { DISCARDED } from "../../src/features/sync/copy";
import { ANNOUNCE_SAVED } from "../../src/features/tasks/copy";
import {
  type SessionNotice,
  SessionProvider,
  type Store,
} from "../../src/session";
import { sessionDouble } from "../helpers/session-double";

/**
 * WEB-10a revision 8 (review 8 R20; design assessment N1-N10): a notice's announcement is an EVENT of the notice's arrival, not of its
 * position in the list. Dismissing one notice must never announce a survivor (whether the survivor announced before or was observed
 * without announcing), so a later message from another caller (a task save, a delayed sync discard) is neither replaced nor has its
 * pending frame cancelled. Frames are held in a deterministic queue (no elapsed-time dependence); every announcement requests exactly
 * one frame, so "nothing was announced" is "no frame was requested", and a cancelled frame is recorded by id.
 */

const SUPERSEDED = NEUTRAL_COPY["1c.superseded"].message;
const SSO = MESSAGE_TEXT.sso_linked;

let frames = new Map<number, FrameRequestCallback>();
let requested = 0;
let cancelled: number[] = [];
beforeEach(() => {
  authFeedback.clearOnBegin();
  frames = new Map();
  requested = 0;
  cancelled = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    requested += 1;
    frames.set(requested, cb);
    return requested;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    if (frames.delete(id)) cancelled.push(id);
  });
});
afterEach(() => {
  cleanup();
  authFeedback.clearOnBegin();
  vi.restoreAllMocks();
});

const flush = () =>
  act(() => {
    const batch = [...frames];
    frames.clear();
    for (const [, cb] of batch) cb(performance.now());
  });

/** A mutable session-notice store (the kernel's page-memory notices), dismissed through the session as production does. */
function noticeStore(initial: SessionNotice[]) {
  let value: readonly SessionNotice[] = initial;
  const listeners = new Set<() => void>();
  const store: Store<readonly SessionNotice[]> & {
    set(next: readonly SessionNotice[]): void;
  } = {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
  return store;
}

/** Another caller of the shared announcer, as the task actions and the sync screens are (`useAnnouncer`). */
let caller: Announcer;
function Caller() {
  caller = useAnnouncer();
  return null;
}

function mount(options: { notices?: SessionNotice[]; strict?: boolean } = {}) {
  const notices = noticeStore(options.notices ?? []);
  const session = sessionDouble(
    {},
    {
      notices,
      dismissNotice: (id: string) =>
        notices.set(notices.get().filter((notice) => notice.id !== id)),
    },
  );
  const tree = (
    <SessionProvider session={session}>
      <AnnouncerProvider>
        <SessionNotices />
        <Caller />
      </AnnouncerProvider>
    </SessionProvider>
  );
  const view = render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  const within = view.container;
  return {
    notices,
    view,
    polite: () =>
      within.querySelector('[aria-live="polite"]') as HTMLElement | null,
    assertive: () =>
      within.querySelector('[aria-live="assertive"]') as HTMLElement | null,
    banner: (selector: string) =>
      within.querySelector(`[data-notice="${selector}"]`),
    dismiss: (selector: string, index = 0) =>
      fireEvent.click(
        (
          within.querySelectorAll(`[data-notice="${selector}"]`)[
            index
          ] as HTMLElement
        ).querySelector("button") as HTMLElement,
      ),
  };
}

const addSuperseded = () => act(() => authFeedback.add({ kind: "superseded" }));
const addSso = () =>
  act(() =>
    authFeedback.add({
      kind: "message",
      tone: "info",
      message: { id: "sso_linked" },
    }),
  );
const durable = (id: string): SessionNotice => ({
  id,
  kind: "remained_signed_in",
});

describe("R20 (revision 8): removing a notice announces nothing", () => {
  test("N1: dismissing the newest of two notices keeps a later CURRENT task-save announcement and announces no survivor", () => {
    const m = mount();
    addSuperseded();
    flush();
    addSso();
    flush();
    act(() => void caller.announce(ANNOUNCE_SAVED, "polite"));
    flush();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
    const before = requested;
    m.dismiss("feedback-message");
    expect(requested).toBe(before);
    flush();
    expect(m.banner("feedback-message")).toBeNull();
    expect(m.banner("feedback-superseded")).not.toBeNull();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
  });

  test("N2: dismissing the newest of two notices leaves a later PENDING announcement's frame alone; it is written when due", () => {
    const m = mount();
    addSuperseded();
    flush();
    addSso();
    flush();
    act(() => void caller.announce(ANNOUNCE_SAVED, "polite"));
    const saveFrame = requested;
    m.dismiss("feedback-message");
    expect(cancelled).not.toContain(saveFrame);
    expect(frames.has(saveFrame)).toBe(true);
    expect(requested).toBe(saveFrame);
    flush();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
  });

  test("N2 (delayed sync discard): a discard announced 250 ms after the act survives dismissing the newest notice before and after its frame", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const m = mount();
      addSuperseded();
      flush();
      addSso();
      flush();
      // The sync screens' shape: the discard is announced on a 250 ms timer after the act (QueuePanel, ItemDetailDialog).
      window.setTimeout(() => caller.announce(DISCARDED), 250);
      act(() => vi.advanceTimersByTime(250));
      const discardFrame = requested;
      m.dismiss("feedback-message");
      expect(cancelled).not.toContain(discardFrame);
      flush();
      expect(m.polite()?.textContent).toBe(DISCARDED);
      m.dismiss("feedback-superseded");
      flush();
      expect(m.polite()?.textContent).toBe(DISCARDED);
    } finally {
      vi.useRealTimers();
    }
  });

  test("N3 control: a single notice dismissed after its frame withdraws its own text; dismissed before its frame it is never written", () => {
    const m = mount();
    addSuperseded();
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    m.dismiss("feedback-superseded");
    expect(m.polite()?.textContent).toBe("");
    addSso();
    const frame = requested;
    m.dismiss("feedback-message");
    expect(cancelled).toContain(frame);
    flush();
    expect(m.polite()?.textContent).toBe("");
  });

  test("N4: two session notices shown; dismissing the first does not announce the second (it was observed, never announced) over a later message", () => {
    const m = mount({ notices: [durable("d1"), durable("d2")] });
    expect(requested).toBe(1);
    flush();
    expect(m.polite()?.textContent).toBe(REMAINED_SIGNED_IN);
    act(() => void caller.announce(ANNOUNCE_SAVED));
    flush();
    const before = requested;
    m.dismiss("remained_signed_in", 0);
    expect(requested).toBe(before);
    flush();
    expect(m.view.container.querySelectorAll("[data-notice]").length).toBe(1);
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
  });

  test("N4 (pending): the later message's frame is not cancelled when the first session notice is dismissed", () => {
    const m = mount({ notices: [durable("d1"), durable("d2")] });
    flush();
    act(() => void caller.announce(ANNOUNCE_SAVED));
    const saveFrame = requested;
    m.dismiss("remained_signed_in", 0);
    expect(cancelled).not.toContain(saveFrame);
    flush();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
  });

  test("N4 control: a genuinely new session notice is announced, also while another is shown", () => {
    const m = mount({ notices: [durable("d1")] });
    flush();
    act(() => void caller.announce(ANNOUNCE_SAVED));
    flush();
    const before = requested;
    act(() => m.notices.set([durable("d1"), durable("d2")]));
    expect(requested).toBe(before + 1);
    flush();
    expect(m.polite()?.textContent).toBe(REMAINED_SIGNED_IN);
  });

  test("N5: facts that arrive in one render announce the latest only; removing it does not announce the unannounced survivor; a later new fact is announced", () => {
    const m = mount();
    act(() => {
      authFeedback.add({ kind: "superseded" });
      authFeedback.add({
        kind: "message",
        tone: "info",
        message: { id: "sso_linked" },
      });
    });
    expect(requested).toBe(1);
    flush();
    expect(m.polite()?.textContent).toBe(SSO);
    act(() => void caller.announce(ANNOUNCE_SAVED));
    flush();
    const before = requested;
    m.dismiss("feedback-message");
    expect(requested).toBe(before);
    flush();
    expect(m.banner("feedback-superseded")).not.toBeNull();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
    act(() => authFeedback.add({ kind: "lock_wait" }));
    expect(requested).toBe(before + 1);
    flush();
    expect(m.polite()?.textContent).toBe(LOCK_WAIT_BANNER.heading);
  });

  test("N6: two notices with the same words are two announcements: dismissing the earlier keeps the later one's text, dismissing the later withdraws it", () => {
    const m = mount();
    addSuperseded();
    flush();
    addSso();
    flush();
    addSuperseded();
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    const before = requested;
    m.dismiss("feedback-superseded", 0);
    expect(requested).toBe(before);
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    m.dismiss("feedback-message");
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    m.dismiss("feedback-superseded", 0);
    expect(m.polite()?.textContent).toBe("");
  });

  test("N7: session notice and sign-in fact together; a new sign-in clears the facts (their own announcement is withdrawn), the session notice is not replayed; an unknown dismissal is nothing; a new fact still speaks", () => {
    act(() => authFeedback.add({ kind: "superseded" }));
    const m = mount({ notices: [durable("d1")] });
    // One announcement per source, the sign-in fact last (as the two separate effects did before).
    expect(requested).toBe(2);
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    const before = requested;
    act(() => authFeedback.clearOnBegin());
    expect(requested).toBe(before);
    expect(m.polite()?.textContent).toBe("");
    expect(m.banner("remained_signed_in")).not.toBeNull();
    act(() => authFeedback.dismiss(999));
    expect(requested).toBe(before);
    addSso();
    expect(requested).toBe(before + 1);
    flush();
    expect(m.polite()?.textContent).toBe(SSO);
  });

  test("N8: dismissing a polite notice never touches a later assertive message, and an assertive retraction never touches the polite region", () => {
    const m = mount();
    addSuperseded();
    flush();
    act(() => void caller.announce("Could not save.", "assertive"));
    flush();
    m.dismiss("feedback-superseded");
    expect(m.polite()?.textContent).toBe("");
    expect(m.assertive()?.textContent).toBe("Could not save.");
    addSso();
    flush();
    let error = caller.announce("Second failure.", "assertive");
    flush();
    act(() => error.retract());
    expect(m.assertive()?.textContent).toBe("");
    expect(m.polite()?.textContent).toBe(SSO);
    error = caller.announce("Third failure.", "assertive");
    flush();
    m.dismiss("feedback-message");
    expect(m.assertive()?.textContent).toBe("Third failure.");
  });

  test("N9: StrictMode's rehearsed effects leave ONE pending announcement of a fact shown at mount; a rerender adds none; unmounting cancels it; a fresh tree presents the surviving fact again", () => {
    act(() => authFeedback.add({ kind: "superseded" }));
    const m = mount({ strict: true });
    expect(frames.size).toBe(1);
    flush();
    expect(m.polite()?.textContent).toBe(SUPERSEDED);
    const before = requested;
    act(() => authFeedback.add({ kind: "superseded" })); // the same fact twice in a row is one fact: nothing changes
    expect(requested).toBe(before);
    addSso();
    expect(frames.size).toBe(1);
    m.view.unmount();
    expect(frames.size).toBe(0);
    const again = mount();
    expect(requested).toBe(before + 2);
    flush();
    expect(again.polite()?.textContent).toBe(SSO);
  });

  test("N9 (gate): after the level-0 gate clears the regions, dismissing a notice does not erase a later message", () => {
    const m = mount();
    addSuperseded();
    addSso();
    flush();
    act(() => liveRegions.clearAll());
    expect(m.polite()?.textContent).toBe("");
    act(() => void caller.announce(ANNOUNCE_SAVED));
    flush();
    const before = requested;
    m.dismiss("feedback-message");
    m.dismiss("feedback-superseded");
    expect(requested).toBe(before);
    flush();
    expect(m.polite()?.textContent).toBe(ANNOUNCE_SAVED);
  });

  test("N10: two trees (as two tabs) have their own regions: dismissing a session notice in one never changes the other's", () => {
    const a = mount({ notices: [durable("a1")] });
    const callerA = caller;
    const b = mount({ notices: [durable("b1")] });
    flush();
    act(() => void callerA.announce(ANNOUNCE_SAVED));
    flush();
    expect(a.polite()?.textContent).toBe(ANNOUNCE_SAVED);
    expect(b.polite()?.textContent).toBe(REMAINED_SIGNED_IN);
    b.dismiss("remained_signed_in");
    flush();
    expect(b.polite()?.textContent).toBe("");
    expect(a.polite()?.textContent).toBe(ANNOUNCE_SAVED);
    expect(a.banner("remained_signed_in")).not.toBeNull();
  });
});
