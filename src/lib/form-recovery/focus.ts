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
type Kind = "prompt" | "failure" | "refused" | "restored";
interface Request {
  kind: Kind;
  target(): HTMLElement | null | undefined;
  /** An update request's presentation. */
  at: number;
  state: "pending" | "done" | "cancelled";
  /** A restored field's arrival (navigations so far) when it took focus. */
  arrival?: number;
}

let shown = JSON.stringify(appUpdates.get());
let presentation = 0;
appUpdates.subscribe(() => {
  const next = JSON.stringify(appUpdates.get());
  if (next !== shown) presentation += 1;
  shown = next;
});
let placed: { at: number; back: Element | null } | null = null;
let arrivals = 0;
onNavigation(() => {
  arrivals += 1;
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

const cancel = (kind: Kind) => {
  for (const request of requests)
    if (request.kind === kind && request.state === "pending")
      request.state = "cancelled";
};

/** Failures first (the shell's before the neutral root's), then a restored field, then the prompt. */
const rank = (request: Request) =>
  (request.kind === "restored" ? 2 : request.kind === "prompt" ? 4 : 0) +
  (request.target()?.closest("#neutral-root") ? 1 : 0);

function attempt(request: Request): boolean {
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
  const back = target.ownerDocument.activeElement;
  if (!focus(target)) return false;
  request.state = "done";
  if (request.kind === "restored") {
    request.arrival = arrivals;
    cancel("prompt");
    cancel("restored");
  } else {
    placed = { at: request.at, back };
    if (request.kind !== "prompt") cancel("restored");
  }
  return true;
}

/** Every pending request, in precedence order, until one takes focus; then watch while any is still pending. */
function reconcile(): void {
  const pending = [...requests]
    .filter((request) => request.state === "pending")
    .sort((a, b) => rank(a) - rank(b));
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
function request(kind: Kind, target: Request["target"], at = 0): () => void {
  const made: Request = { kind, target, at, state: "pending" };
  // DA-F2: a failure of the person's own act supersedes a restored field still waiting for focus.
  if (kind === "failure" || kind === "refused") cancel("restored");
  requests.add(made);
  reconcile();
  return () => {
    requests.delete(made);
    reconcile();
  };
}

/** State 3: the restored form's first field (`field` is read at each attempt, so a field rendered or replaced later is the one focused). */
export function useRestoredFocus(
  shown: boolean,
  field: RefObject<HTMLElement | null> | undefined,
): void {
  const current = useRef(field);
  current.current = field;
  useEffect(
    () =>
      shown ? request("restored", () => current.current?.current) : undefined,
    [shown],
  );
  // A field given by a different ref is a new target with no change to the document: attempt it now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref object itself is the change
  useEffect(reconcile, [field]);
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
