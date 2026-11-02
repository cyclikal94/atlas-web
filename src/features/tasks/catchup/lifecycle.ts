/**
 * Revision 15 (review 16's R36-H and R36-I; design assessment C1): the page's lifecycle as the catch-up runner reads it, PER CALL. A call
 * takes a `mark` when it is issued; it was cancelled by the page's teardown when the page began to be torn down AFTER that mark
 * (`tornSince`): a `beforeunload` or a `pagehide` since, and no `pageshow` (a back-forward restore) after it. A hidden tab
 * (`visibilitychange`) is not torn down: it may still observe answers, and its failures are protected like any other. A call issued
 * after a teardown that did not happen (a navigation abandoned after its `beforeunload`) is live again: its mark is later.
 *
 * Why the runner needs it, and why these events (the native order is E-M12a's evidence, revision 15): a browser cancels the calls of a
 * page it navigates away from, reloads or closes. Firefox and WebKit deliver that rejection BEFORE the page's `pagehide`; Chromium
 * after the first `pagehide` listener (listeners run in the order they were added, with a microtask checkpoint between them, and the
 * cancellation is already queued). Every engine runs every `beforeunload` listener before the cancellation of a navigation or reload is
 * delivered; a closed page (no `beforeunload` when a script closes it) had its route-held calls left unanswered, and the released
 * backend's Firefox close is I-10C-M4a's. Such a call's outcome was not observed by any page that goes on, so it must stay recoverable
 * as a call lost (E-M2, I-10C-M4a); a failure observed while the page is live must instead be protected before its first write (R36-H)
 * and fence its caller at its first failed write (R36-I). Only the page's own lifecycle tells the two apart: never an error's type, a
 * delay or a disposal.
 */
export interface PageLifecycle {
  /** The page's lifecycle now, taken when a call is issued. */
  mark(): number;
  /** The page began to be torn down after `mark` and has not been shown again since. */
  tornSince(mark: number): boolean;
  /** Told when the page is shown again (`pageshow`) after it began to be torn down. */
  subscribe(listener: () => void): () => void;
}

/** One page's lifecycle and its two inputs (the page's events; a test's double). */
export function createPageLifecycle(): {
  lifecycle: PageLifecycle;
  teardown(): void;
  show(): void;
} {
  let seq = 0;
  let teardown = 0;
  let shown = 0;
  const listeners = new Set<() => void>();
  return {
    lifecycle: {
      mark: () => seq,
      tornSince: (mark) => teardown > mark && teardown > shown,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    teardown() {
      seq += 1;
      teardown = seq;
    },
    show() {
      seq += 1;
      const restored = teardown > shown;
      shown = seq;
      if (restored) for (const listener of [...listeners]) listener();
    },
  };
}

let page: ReturnType<typeof createPageLifecycle> | null = null;

/** The page's one lifecycle (its listeners are added to `window` on the first call, before the first runner's first call). */
export function pageLifecycle(): PageLifecycle {
  if (page === null) {
    const created = createPageLifecycle();
    page = created;
    // Not capturing: a page Firefox closes does not invoke a capturing `pagehide` listener of `window` (E-M12a, revision 15).
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => created.teardown());
      window.addEventListener("pagehide", () => created.teardown());
      window.addEventListener("pageshow", () => created.show());
    }
  }
  return page.lifecycle;
}
