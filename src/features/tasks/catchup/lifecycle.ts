/**
 * Revision 16 (review 17's R36-J; design assessment C1/C3; Kieran's D1 decision approval/web10c-d1-preserve-rule-20261102.json: the
 * existing observed-failure protection is kept, no weaker departure limitation): the page's lifecycle as the catch-up runner reads it,
 * PER CALL. A call takes a `mark` when it is issued. It was cancelled by the page's DEPARTURE when, by the time its outcome is judged,
 * the page's `pagehide` has BEGUN since that mark (and no `pageshow` came after it): either this module's `pagehide` listener has run,
 * or the outcome is judged while a `pagehide` is being dispatched (`dispatching`: the `window.event` of the moment). That is the existing
 * rule, "after the page's pagehide", unchanged; nothing else counts:
 * - an ATTEMPTED departure (`beforeunload`) proves nothing: a navigation answered with 204, a download or one the person cancelled
 *   leaves the page running, with no `pagehide` and no `pageshow` (review 17's native evidence, all three engines). Revision 15 counted
 *   it (`tornSince`), which was R36-J;
 * - no delay, error type, disposal or later mark counts either: a failure delivered BEFORE the page's `pagehide` began is one the page
 *   observed, however soon the page leaves after it, and is protected (R36-H/I).
 * A RESTORE (`pageshow` after `pagehide`) is told to subscribers: the page goes on, and what it observed is its own again. A hidden tab
 * (`visibilitychange`) is none of these.
 *
 * Why it is exact (revision 16's native evidence, Chromium 153, Firefox 155, WebKit 26.6): Chromium delivers the rejection of a call it
 * cancels with its page DURING the page's `pagehide` dispatch (between its listeners; `window.event` is that `pagehide` when the rejection
 * and the microtasks after it run), so it is judged a departure even before this module's listener runs. Firefox and WebKit deliver it
 * BEFORE `pagehide`, in an earlier task, and the page then runs further tasks: there the cancellation cannot be told from a genuine
 * failure, so it is protected as one (its first write lands before the page unloads, E-M12-diag; that recorded outcome is what the next
 * page recovers, E-M2). A genuine network failure is delivered in a task of its own, never inside another task's `pagehide` dispatch; one
 * delivered before `pagehide` began is therefore never taken for a departure, provided it is judged in the task it is delivered in (the
 * session's failure path and the runner's classification add no task between them: catchup-lifecycle's no-task-between test).
 */
export interface PageLifecycle {
  /** The page's lifecycle now, taken when a call is issued. */
  mark(): number;
  /** The page's departure (`pagehide`) began after `mark` (seen, or being dispatched now), and it has not been shown again since. */
  departedSince(mark: number): boolean;
  /** Told when the page is shown again (`pageshow`) after its `pagehide`. */
  subscribe(listener: () => void): () => void;
}

/** A `pagehide` is being dispatched at this moment (the page's `window.event`; a test's double can set it). */
export type Dispatching = () => boolean;

const windowDispatching: Dispatching = () => {
  if (typeof window === "undefined") return false;
  // The legacy `window.event` (DOM: the global's current event) is the event whose listener, or whose microtask checkpoint, runs now.
  return (window as { event?: Event }).event?.type === "pagehide";
};

/**
 * One page's lifecycle and its inputs (the page's events; a test's double): `pagehide` (a departure), `pageshow` (a restore after
 * it), and `beforeunload`, an attempted departure, which this lifecycle records nowhere: it proves nothing. `teardown` and `show` are
 * revision 15's names, kept so its recorded witnesses run unchanged: `teardown` is the `beforeunload` (revision 15 read it as both, R36-J),
 * `show` the `pageshow`.
 */
export function createPageLifecycle(
  options: { dispatching?: Dispatching } = {},
): {
  lifecycle: PageLifecycle;
  beforeunload(): void;
  pagehide(): void;
  pageshow(): void;
  teardown(): void;
  show(): void;
} {
  const dispatching = options.dispatching ?? (() => false);
  let seq = 0;
  let hidden = 0;
  let shown = 0;
  const listeners = new Set<() => void>();
  const beforeunload = () => undefined;
  const show = () => {
    seq += 1;
    const restored = hidden > shown;
    shown = seq;
    if (restored) for (const listener of [...listeners]) listener();
  };
  return {
    lifecycle: {
      mark: () => seq,
      departedSince: (mark) =>
        (hidden > mark && hidden > shown) || dispatching(),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    beforeunload,
    pagehide() {
      seq += 1;
      hidden = seq;
    },
    pageshow: show,
    teardown: beforeunload,
    show,
  };
}

let page: ReturnType<typeof createPageLifecycle> | null = null;

/** The page's one lifecycle (its listeners are added to `window` on the first call, before the first runner's first call). */
export function pageLifecycle(): PageLifecycle {
  if (page === null) {
    const created = createPageLifecycle({ dispatching: windowDispatching });
    page = created;
    // Not capturing: a page Firefox closes does not invoke a capturing `pagehide` listener of `window` (E-M12a, revision 15). Its order
    // among the page's listeners does not matter: a judgement made during the dispatch reads `window.event` (Chromium runs the page's
    // listeners in the order they were added, capturing ones included, revision 16's native diagnostic).
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => created.pagehide());
      window.addEventListener("pageshow", () => created.pageshow());
    }
  }
  return page.lifecycle;
}
