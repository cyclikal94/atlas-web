/**
 * The level-0 resume gate (account-lifecycle matrix 3.7.2 step 1): a MODAL `<dialog aria-labelledby>` opened with
 * `showModal()`, so it is the topmost modal dialog, with the heading "Checking your account" as the focus target and a
 * `role="status"` message.
 *
 * It is built with the DOM directly, not React: the gate must close over the page synchronously, inside the
 * `visibilitychange` and `pagehide` handlers, and React's scheduler gives no such guarantee. It lives in
 * `src/components/ui` because that is where a dialog may be attached to the document (lint rule R3), and it shares the
 * neutral gate's classes so it looks the same. The heading and message never contain account data.
 */
export const GATE_HEADING = "Checking your account";
export const GATE_ID = "resume-gate";
const HEADING_ID = "resume-gate-heading";

export interface GateDialog {
  /** Opens the modal dialog (idempotent). Called last in the level-0 step, so it is topmost. */
  open(message?: string): void;
  /** Closes it (idempotent). */
  close(): void;
  isOpen(): boolean;
  /** Moves focus to the heading: the programmatic focus target while the page decides. */
  focusHeading(): void;
  setMessage(message: string): void;
}

/**
 * Whether the resume gate is open in this document. While it is, it owns keyboard focus (its heading; matrix 3.7.2 step 3,
 * "Read pending"), and whatever renders beneath a modal dialog must not take focus from it.
 */
export function isGateOpen(doc: Document = document): boolean {
  const element = doc.getElementById(GATE_ID);
  return element instanceof HTMLDialogElement && element.open;
}

export function createGateDialog(doc: Document = document): GateDialog {
  let dialog: HTMLDialogElement | null = null;
  let heading: HTMLElement | null = null;
  let message: HTMLElement | null = null;

  const build = (): HTMLDialogElement => {
    const element = doc.createElement("dialog");
    element.id = GATE_ID;
    element.className = "neutral-gate";
    element.setAttribute("aria-labelledby", HEADING_ID);
    const body = doc.createElement("div");
    body.className = "neutral-gate__body";
    const mark = doc.createElement("span");
    mark.className = "neutral-gate__mark";
    mark.setAttribute("aria-hidden", "true");
    heading = doc.createElement("h1");
    heading.id = HEADING_ID;
    heading.tabIndex = -1;
    heading.textContent = GATE_HEADING;
    message = doc.createElement("p");
    message.setAttribute("role", "status");
    body.append(mark, heading, message);
    element.append(body);
    // Escape must not dismiss it: the gate lifts only when the protocol says so.
    element.addEventListener("cancel", (event) => event.preventDefault());
    doc.body.append(element);
    return element;
  };

  return {
    open(text) {
      dialog ??= build();
      if (text !== undefined && message) message.textContent = text;
      if (dialog.open) return;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    },
    close() {
      if (!dialog?.open) return;
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (message) message.textContent = "";
    },
    isOpen: () => dialog?.open === true,
    focusHeading() {
      heading?.focus();
    },
    setMessage(text) {
      if (message) message.textContent = text;
    },
  };
}
