import { type RefObject, useEffect, useRef } from "react";
import { onNavigation } from "../pwa/navigation";
import { appUpdates } from "../pwa/store";

/**
 * Where an update's Q4 states put focus (WEB-14a revisions 19 and 20, R26/R27; form-recovery-reload.html, "Focus order"): state 1 its
 * primary action when the prompt appears, state 2 its recovery action when a failure appears, state 3 the restored form's first field. A
 * plain update notice never takes focus. Page memory only: nothing here is persisted, broadcast or kept for an account.
 *
 * Each of these is a REQUEST (revision 20; design assessment of 16 October 2026, RC1/C1-C4, I1-I12): pending until its target really
 * became the active element, then done, or cancelled. A refused attempt is still pending. Behind a closed session gate, the gate dialog,
 * an app dialog or a form's hold the browser refuses focus, and the tree is usually lifted later WITHOUT another render, so a pending
 * request is attempted again whenever the document's eligibility can have changed: ANY attribute or the node tree changed. That covers
 * the gate lifting, a dialog closing and a hold being released (`inert`, `open`), a target rendered or `hidden`/`disabled` no longer, and
 * (revision 21, R26/R27) a target or an ancestor revealed by its `class` or `style`, or by any attribute a stylesheet selects on (`data-*`,
 * `aria-*`), since CSS can hide by any of them. That is one MutationObserver on the whole document, kept only while a request is pending,
 * whose callback runs once per batch of changes at the microtask checkpoint after the synchronous step that changed the document (so after
 * `act` has finished exposing the account), never a timer or a poll. It sees DOM changes only: a reveal by a stylesheet edit, a media query
 * or the end of a transition, with no change to the document, would need its owner to say so (no current caller reveals a target like
 * that: the shell's layouts are chosen by rendering, revision 21 inventory). Each attempt reads its target afresh (never a kept node)
 * and checks it is attached, not inside `[inert]` and not behind a modal dialog, then lets the browser decide. A request belongs to the
 * component that made it: an unmount (a different account, another route, the shell going) withdraws it, so old work cannot focus a new
 * owner's tree.
 *
 * A presentation is a change of what the update state says (an equal state published again is the same one), so a remount of the shell, a
 * move to the neutral root, a re-render or a repeated publication never takes focus again for one already focused. Where both surfaces
 * hold a pending request for it, the shell's goes first (the neutral banner is going when the account is shown).
 *
 * Precedence: DA-F1 (Kieran, 15 October 2026): a restored form's first field wins over a state-1 prompt of the same arrival, in either
 * order, until the next in-app navigation; a prompt waits while a restored field is pending. DA-F2 (Kieran, 16 October 2026; approval
 * FIXTURE-BUDGETS-FOCUS-PRECEDENCE-20261016): a failure of the person's save or discard (state 2) cancels a restored-field request still
 * pending, so that older request can never take focus from it later. Focusing never chooses anything.
 */
type Kind =
  | "prompt"
  | "failure"
  | "refused"
  | "restored"
  | "returned"
  | "chosen";
interface Request {
  kind: Kind;
  target(): HTMLElement | null | undefined;
  /** An update request's presentation. */
  at: number;
  state: "pending" | "done" | "cancelled";
  /** A restored field's arrival (navigations so far) when it took focus; any other request's when it was made. */
  arrival?: number;
  /** A returned request: the "Discard instead" button the person used (focus still there, or nowhere, is focus not yet placed). */
  from?: Element;
  /** A chosen request (revision 53): where focus was at the person's choice (a browser that does not focus a clicked button keeps it). */
  kept?: Element | null;
}

/**
 * Where a restored editor puts focus (WEB-14a revision 51, F-R51-1; design assessment of 3 November 2026, C2/C3): the element itself (a
 * ref, read at each attempt), or a resolver the owner answers from its committed DOM at each attempt (a checked radio, the first control
 * of a grants list, the entry a fix belonged to), so a target inserted, replaced or removed by a reset is the one focused.
 */
export type FocusTarget =
  | RefObject<HTMLElement | null>
  | (() => HTMLElement | null | undefined);
export const resolveTarget = (
  target: FocusTarget | undefined,
): HTMLElement | null | undefined =>
  typeof target === "function" ? target() : target?.current;

/**
 * Where a dialog's opening puts focus when it names no field (WEB-14a revision 51, decision D1, Kieran, 3 November 2026: a restored editor
 * with no field to focus uses its owner's surviving control): the first control of the dialog holding `within` that the keyboard reaches,
 * as the dialog's own opening does, never a recovery banner's action. Null outside a dialog or before it has a control.
 */
export function openingFocus(within: Element | null): HTMLElement | null {
  const dialog = within?.closest('[role="dialog"]');
  return dialog ? firstControl(dialog) : null;
}

/**
 * The first control in `root` the keyboard reaches (enabled, not hidden or inert), never a recovery banner's action: an owner's own
 * section (a grants list, WEB-14a revision 51) or a dialog. Null when it has none yet.
 */
export function firstControl(root: Element | null): HTMLElement | null {
  if (!root) return null;
  for (const control of root.querySelectorAll<HTMLElement>(
    "button, [href], input, select, textarea, [tabindex]",
  ))
    if (
      control.tabIndex >= 0 &&
      !(control as HTMLButtonElement).disabled &&
      (control as HTMLInputElement).type !== "hidden" &&
      !control.closest(
        "[hidden],[inert],[data-recovery-state],[data-recovery-check]",
      )
    )
      return control;
  return null;
}

/**
 * A section's heading, made focusable from script only (D1: where an owner's control is gone, its heading). Null when there is none.
 */
export function headingFocus(heading: HTMLElement | null): HTMLElement | null {
  if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  return heading;
}

/** Focus is nowhere now: no active element, the body, or an element no longer in the document. */
const unplacedNow = (): boolean => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
};

/**
 * Focus is not placed yet: nowhere (the document's body) or still on the control the person used, attached or just removed, or (a choice)
 * still where it was at the choice.
 */
const unplaced = (request: Request) =>
  unplacedNow() ||
  document.activeElement === request.from ||
  document.activeElement === request.kept;

let shown = JSON.stringify(appUpdates.get());
let presentation = 0;
appUpdates.subscribe(() => {
  const next = JSON.stringify(appUpdates.get());
  if (next !== shown) presentation += 1;
  shown = next;
});
let placed: { at: number; back: Element | null } | null = null;
let arrivals = 0;
/**
 * The CURRENT restore grant (WEB-14a revision 52, F-R52-2; design assessment of 3 November 2026, C2, F1-F3): the restored request that
 * most recently took focus in this arrival, and the element focus actually landed on. A successful pre-emption replaces it, so it is never
 * the first request that once took focus. Completed requests stay as history (a prompt of the arrival stays suppressed, DA-F1) but never
 * arbitrate. A navigation ends it (so it is always of this arrival). Revision 55 (F-R54-1): it records WHY focus is there as well as where,
 * by its request's kind: an automatic restore ("restored") or the person's applied choice ("chosen", never pre-empted while focus is on it).
 */
let grant: { request: Request; element: HTMLElement } | null = null;
/** The element this arbiter last focused for a restored form or a discard's return (focus it placed itself, not the person). */
let arbiterPlaced: Element | null = null;
onNavigation(() => {
  arrivals += 1;
  grant = null;
});

const requests = new Set<Request>();
let observer: MutationObserver | null = null;

const modal = (dialog: Element) => {
  try {
    return dialog.matches(":modal");
  } catch {
    return true;
  }
};
/** The target can take focus now: attached, not inert, not behind a modal dialog (the browser has the last word). */
const eligible = (target: HTMLElement) =>
  target.isConnected &&
  !target.closest("[inert]") &&
  !Array.from(target.ownerDocument.querySelectorAll("dialog[open]")).some(
    (dialog) => !dialog.contains(target) && modal(dialog),
  );

const focus = (target: HTMLElement | null | undefined): boolean => {
  target?.focus();
  return !!target && target.ownerDocument.activeElement === target;
};

/** DA-F1: a restored field has focus in this arrival (`done`), or is waiting for it with its field in the page (`pending`). */
const restored = (state: "pending" | "done") => {
  for (const request of requests)
    if (
      request.kind === "restored" &&
      request.state === state &&
      (state === "done"
        ? request.arrival === arrivals
        : request.target()?.isConnected)
    )
      return true;
  return false;
};

/** `a` comes before `b` in the document. */
const precedes = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Decision D2 (Kieran, 3 November 2026; WEB-14a revision 51), with revision 52 (F-R52-2): whether a restored request of this arrival,
 * whose target `target` can take focus now, may take it. Yes when no restore of this arrival has taken focus. Otherwise only from
 * the CURRENT grant (never an earlier, superseded one), only while focus is still on the element that grant focused, and only when
 * `target` comes first in the page: so any number of restores settle on the first in the page, whatever order they arrive in (C, then B,
 * then A ends on A). Focus the person (or anything else) moved elsewhere is never taken, even onto another restored form's field. When the
 * granted element itself went (its owner unmounted or replaced it) and focus is nowhere, a later restore may take it: that takes nobody's
 * focus. Revision 55 (F-R54-1, F-5): a CHOSEN grant (the person's applied choice) is never pre-empted while its element is there, as focus
 * the person moved by hand is not; only its "element went and focus is nowhere" case remains.
 */
const mayTakeFocus = (target: HTMLElement): boolean =>
  !grant ||
  (grant.request.kind !== "chosen" && document.activeElement === grant.element
    ? precedes(target, grant.element)
    : !grant.element.isConnected && unplacedNow());

const cancel = (kind: Kind) => {
  for (const request of requests)
    if (request.kind === kind && request.state === "pending")
      request.state = "cancelled";
};

/**
 * Failures first (the shell's before the neutral root's), then a restored field (or a discard's return to it, or a choice's), then the
 * prompt.
 */
const rank = (request: Request) =>
  (request.kind === "prompt"
    ? 4
    : request.kind === "failure" || request.kind === "refused"
      ? 0
      : 2) + (request.target()?.closest("#neutral-root") ? 1 : 0);

function attempt(request: Request): boolean {
  if (request.kind === "returned" || request.kind === "chosen") {
    // A discard's return (revision 51), or a chosen copy's restored form (revision 53): only while focus is not placed yet, in the arrival
    // it was made in. Focus the person (or another request) placed since is left alone, so a late reset, a slow removal or read, or a new
    // route never takes it.
    if (request.arrival !== arrivals || !unplaced(request)) {
      request.state = "cancelled";
      return false;
    }
    // The control used is still there: the owner's change is not in the document yet (it is, once React has committed it).
    if (request.from?.isConnected) return false;
    const target = request.target();
    if (!target || !eligible(target) || !focus(target)) return false;
    request.state = "done";
    if (request.kind === "chosen") {
      // Revision 55 (Review 54, F-R54-1; design assessment of 5 November 2026, C-F1, F-5/F-6): a landed choice is the PERSON's placement,
      // so it becomes the arrival's current grant, of its own kind, whichever form held the automatic grant before (the chosen form itself,
      // or another whose restore is withdrawn later). It is not `arbiterPlaced`: a withdrawal never mistakes it for focus this arbiter put.
      grant = { request, element: target };
      // The person's own choice supersedes an automatic restore still waiting for focus (as a failure of their act does, DA-F2).
      cancel("restored");
    } else arbiterPlaced = target;
    return true;
  }
  if (request.kind !== "restored" && placed?.at === request.at) {
    request.state = "done";
    return false;
  }
  if (request.kind === "prompt") {
    // DA-F1: a restored field that has focus ends this prompt's claim; one still waiting holds it back.
    if (restored("done")) request.state = "cancelled";
    if (restored("done") || restored("pending")) return false;
  }
  const target = request.target();
  if (!target || !eligible(target)) return false;
  if (request.kind === "restored") {
    // D2: a restored form of this arrival already took focus: this one takes it only from the current grant, still on its element, and
    // only if it comes first in the page (never focus the person moved, never back and forth).
    if (!mayTakeFocus(target)) {
      request.state = "cancelled";
      return false;
    }
  }
  const back = target.ownerDocument.activeElement;
  if (!focus(target)) return false;
  request.state = "done";
  if (request.kind === "restored") {
    request.arrival = arrivals;
    grant = { request, element: target };
    arbiterPlaced = target;
    cancel("prompt");
    cancel("restored");
  } else {
    placed = { at: request.at, back };
    if (request.kind !== "prompt") cancel("restored");
  }
  return true;
}

/** Equal precedence: restored forms pending together in page order (D2), the rest as they came. */
const order = (a: Request, b: Request) => {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0 || a.kind !== "restored" || b.kind !== "restored")
    return byRank;
  const first = a.target();
  const second = b.target();
  return first && second && first !== second
    ? precedes(first, second)
      ? -1
      : 1
    : 0;
};

/** Every pending request, in precedence order, until one takes focus; then watch while any is still pending. */
function reconcile(): void {
  const pending = [...requests]
    .filter((request) => request.state === "pending")
    .sort(order);
  for (const request of pending)
    if (request.state === "pending" && attempt(request)) break;
  const waiting = [...requests].some((request) => request.state === "pending");
  if (waiting && !observer) {
    observer = new MutationObserver(reconcile);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
  } else if (!waiting && observer) {
    observer.disconnect();
    observer = null;
  }
}

/** Registers a request and attempts it at once; the result withdraws it (the owner's unmount or change). */
function request(
  kind: Kind,
  target: Request["target"],
  at = 0,
  from?: Element,
  kept?: Element | null,
): () => void {
  const made: Request = {
    kind,
    target,
    at,
    state: "pending",
    arrival: arrivals,
    ...(from ? { from, kept } : {}),
  };
  // DA-F2: a failure of the person's own act supersedes a restored field still waiting for focus.
  if (kind === "failure" || kind === "refused") cancel("restored");
  requests.add(made);
  reconcile();
  return () => {
    requests.delete(made);
    // Revision 52 (F-R52-2): the current grant's owner went (unmount, its copy discarded). The grant ends, as a withdrawn request
    // always did, when focus is nowhere (the granted field went with it) or where this arbiter put it (the granted field, a discard's
    // return): a later restore of the arrival is not held back by a form that is gone. Only when the person (or another surface) has
    // moved focus elsewhere does it stay, so a later restore still never takes that focus. It never falls back to an earlier grant.
    // Revision 55 (F-R54-1, F-7): a CHOSEN grant is the person's placement: its request's withdrawal (a newer choice, the owner's unmount)
    // ends it only when focus is nowhere (its field went), never while focus is on it, so no window opens for an automatic restore.
    if (
      grant?.request === made &&
      (unplacedNow() ||
        (made.kind !== "chosen" &&
          (document.activeElement === grant.element ||
            document.activeElement === arbiterPlaced)))
    )
      grant = null;
    reconcile();
  };
}

/** State 3: the restored form's first field (`field` is read at each attempt, so a field rendered or replaced later is the one focused). */
export function useRestoredFocus(
  shown: boolean,
  field: FocusTarget | undefined,
): void {
  const current = useRef(field);
  current.current = field;
  useEffect(
    () =>
      shown
        ? request("restored", () => resolveTarget(current.current))
        : undefined,
    [shown],
  );
  // A field given by a different ref is a new target with no change to the document: attempt it now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref object itself is the change
  useEffect(reconcile, [field]);
}

/**
 * After a focused "Discard instead" (WEB-14a revision 51, F-R51-1; RecoveryBanner, revision 19): the person continues in the form they
 * were reviewing, at `target`, although the banner they used goes with the copy. The returned function admits that at the gesture (with
 * the button used); it is a request held by the OWNER that survives the banner (this hook's component), pending until the target, read
 * from the committed DOM after the owner's reset, takes focus. It is attempted at once (a field that stays) and again when the document
 * changes (a field inserted or replaced by the reset, a fix's editor gone and its entry's control shown). It never waits on the copy's
 * removal. It ends, without focusing, as soon as focus is placed anywhere else (the person clicked or typed elsewhere, a prompt, a failure
 * or a new route took it) or a navigation happened, and is withdrawn by a newer discard or the owner's unmount (a different account, the
 * editor closed). DA-F1/DA-F2 are unchanged: this is not a restored request and never holds back or cancels one.
 */
export function useDiscardFocus(
  target: FocusTarget | undefined,
): (from: Element) => void {
  const current = useRef(target);
  current.current = target;
  const withdraw = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      withdraw.current?.();
      withdraw.current = null;
    },
    [],
  );
  return (from) => {
    withdraw.current?.();
    const withdrawn = request(
      "returned",
      () => resolveTarget(current.current),
      0,
      from,
    );
    withdraw.current = withdrawn;
    // The gesture's reset is committed by the microtask React queued with it, before this one. A banner still there then is a discard
    // that was not admitted (refused while an update reload is prepared): focus stays on it, and nothing later moves it.
    queueMicrotask(() => {
      if (from.isConnected && withdraw.current === withdrawn) {
        withdrawn();
        withdraw.current = null;
      }
    });
  };
}

/**
 * WEB-14a revision 53 (D-R53-2, Kieran, 3 November 2026): the person chose another saved copy while the restored banner stays shown, so
 * `useRestoredFocus` sees no new presentation. Called at the choice with the control used (its row goes when the copy is restored); the
 * function it returns is called once the choice has been APPLIED, and only then makes a request for `target`, the restored form's first
 * eligible field (or the owner's D1 fallback), read from the committed DOM. As a discard's return: pending until it can take focus, never
 * the removed control; ended without focusing once focus is placed anywhere other than where it was at the choice (the person moved it, a
 * prompt or failure took it), by a navigation, a newer choice or the owner's unmount. A choice not applied makes no request.
 */
export function useChoiceFocus(
  target: FocusTarget | undefined,
): (from: Element) => () => void {
  const current = useRef(target);
  current.current = target;
  const latest = useRef<{ withdraw?: () => void } | null>(null);
  useEffect(
    () => () => {
      latest.current?.withdraw?.();
      latest.current = null;
    },
    [],
  );
  return (from) => {
    latest.current?.withdraw?.();
    const choice: { withdraw?: () => void } = {};
    latest.current = choice;
    const kept = document.activeElement;
    const arrival = arrivals;
    return () => {
      if (latest.current === choice && arrival === arrivals && !choice.withdraw)
        choice.withdraw = request(
          "chosen",
          () => resolveTarget(current.current),
          0,
          from,
          kept,
        );
    };
  };
}

/**
 * States 1 and 2 for the banner `section` showing `state` (`kind` null: nothing to focus). The prompt and a failure focus their first button;
 * a refused save offers only a destructive choice, so the banner itself is focused instead.
 */
export function useUpdateFocus(
  state: unknown,
  kind: "prompt" | "failure" | "refused" | null,
): RefObject<HTMLElement | null> {
  const section = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new state is what may be a new presentation (`presentation` is page memory)
  useEffect(() => {
    if (!kind || placed?.at === presentation) return;
    return request(
      kind,
      () =>
        kind === "refused"
          ? section.current
          : section.current?.querySelector("button"),
      presentation,
    );
  }, [state, kind]);
  return section;
}

/**
 * The person chose something in the banner `section`, so the button they used goes. Focus stays at the banner (a save or a
 * reload is in progress, or a failure will take it); "Not now" (`dismissed`) returns it to where the prompt took it from, when that is still
 * on this surface and focusable, or else to the surface's heading. Focus elsewhere (a pointer that does not focus buttons) is left alone.
 */
export function keepFocus(
  section: HTMLElement | null,
  dismissed: boolean,
): void {
  if (!section?.contains(section.ownerDocument.activeElement)) return;
  if (!dismissed) {
    section.focus();
    return;
  }
  const surface = section.closest("#protected-root,#neutral-root");
  const back = placed?.at === presentation ? placed.back : null;
  if (
    back instanceof HTMLElement &&
    surface?.contains(back) &&
    !back.closest("[inert]") &&
    focus(back)
  )
    return;
  const heading = surface?.querySelector<HTMLElement>("[data-page-heading],h1");
  if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  focus(heading);
}
