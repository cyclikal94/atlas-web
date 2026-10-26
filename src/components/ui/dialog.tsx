import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { enterFocusLoop } from "./focus-loop";
import { enterModal } from "./modal-background";
import { useRequiredPortalContainer } from "./portal";
import { SyncStatusChip } from "./sync-status";

export interface DialogProps {
  open: boolean;
  /** Called after the dialog decides to close, whatever the cause. */
  onClose(): void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Escape and the close icon discard the edit. */
  onDiscard?(): void;
  /** Activating the in-dialog sync control retains the draft, closes, then navigates (ia.md 1.3.3, 3). */
  onRetainDraft?(): void;
  onCloseAutoFocus?(event: Event): void;
  /** A CSS selector for the element that takes focus on open. Defaults to the first focusable element. */
  initialFocusSelector?: string;
  /**
   * Where focus returns on close. Defaults to the element focused when the dialog opened. Pass this when the opener
   * may not hold focus: Safari and iOS do not focus a button on click or tap.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Whether the header carries the in-dialog sync control (default true). WF-SWITCH-02 is the one documented exception: it is a
   * credential step for a DIFFERENT account, so it reports no sync state (`wireframes/switch/states.md`, the I1 exception).
   */
  syncControl?: boolean;
  /**
   * Where the full-screen sheet gives way to the centred dialog. `tablet` (the default): from 768 px, the generic rule (ia.md §3 and
   * design-coverage §6). `desktop`: from 1280 px, for a dialog whose accepted tablet frames draw it as a full-bleed sheet at both
   * tablet orientations (the sharing editors: WEB-05.5 `tablet/sharing-portrait.html` and `sharing-landscape.html`, Q14; WEB-12a R6).
   */
  sheetBelow?: "tablet" | "desktop";
}

/**
 * The panel's classes (shadcn/ui's dialog content, as a full-screen sheet below the breakpoint and a centred panel from it).
 * Written out whole for Tailwind. The panel itself never animates its geometry (a control's measured size must not change);
 * the veil over it clears and its body settles (`atlas-dialog` in base.css).
 */
const PANEL: Readonly<Record<"tablet" | "desktop", string>> = {
  tablet:
    "atlas-dialog fixed inset-0 z-50 flex flex-col overflow-hidden bg-card text-card-foreground tablet:inset-auto tablet:left-1/2 tablet:top-[8vh] tablet:max-h-[84vh] tablet:w-[460px] tablet:max-w-[calc(100vw-32px)] tablet:-translate-x-1/2 tablet:rounded-xl tablet:border tablet:shadow-lg",
  desktop:
    "atlas-dialog fixed inset-0 z-50 flex flex-col overflow-hidden bg-card text-card-foreground desktop:inset-auto desktop:left-1/2 desktop:top-[8vh] desktop:max-h-[84vh] desktop:w-[460px] desktop:max-w-[calc(100vw-32px)] desktop:-translate-x-1/2 desktop:rounded-xl desktop:border desktop:shadow-lg",
};

/**
 * A control that takes focus inside the dialog's scrolling body is revealed WHOLE (WCAG 2.4.11, as `chrome-insets.ts` does for the
 * shell's bars). WebKit reveals a text field's caret rather than the field, so a field can stay half under the footer: measured in
 * WEB-10a revision 2 (the correction dialog's lower fields, WebKit, keyboard traversal). Block "nearest": nothing moves when the control
 * is already wholly in view, so engines that reveal it themselves are unchanged.
 */
function revealInBody(body: HTMLElement): () => void {
  const reveal = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const box = target.getBoundingClientRect();
    const port = body.getBoundingClientRect();
    if (box.height > port.height) return;
    if (box.top >= port.top && box.bottom <= port.bottom) return;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  body.addEventListener("focusin", reveal);
  return () => body.removeEventListener("focusin", reveal);
}

/**
 * The dialog pattern (ia.md 3). Header: title, the in-dialog sync control (inside the focus trap, because the
 * page behind is inert), then the close icon. Escape, the overlay and the close icon discard; only the
 * sync control retains. Renders in the registered portal container, so it stays inside #protected-root.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  onDiscard,
  onRetainDraft,
  onCloseAutoFocus,
  initialFocusSelector,
  returnFocusRef,
  syncControl = true,
  sheetBelow = "tablet",
}: DialogProps) {
  const container = useRequiredPortalContainer();
  const opener = useRef<HTMLElement | null>(null);
  // Runs before Radix moves focus into the dialog, so this is still the opener.
  useLayoutEffect(() => {
    if (open)
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
  }, [open]);
  // Modal behaviour without a style element: see modal-background.ts.
  useEffect(() => {
    if (!open || !container) return;
    return enterModal(container);
  }, [open, container]);
  // Tab wraps inside the dialog whatever modifier is held: Radix's own loop ignores Option or Alt (see focus-loop.ts).
  const [content, setContent] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!content) return;
    return enterFocusLoop(content);
  }, [content]);
  const [body, setBody] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!body) return;
    return revealInBody(body);
  }, [body]);
  if (!container) return null;

  const discard = () => {
    onDiscard?.();
    onClose();
  };

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(next) => (next ? undefined : discard())}
    >
      <DialogPrimitive.Portal container={container}>
        <div
          aria-hidden="true"
          data-dialog-scrim=""
          className="fixed inset-0 z-40 bg-black/60 animate-in fade-in-0 duration-200 backdrop-blur-[2px]"
        />
        <DialogPrimitive.Content
          ref={setContent}
          aria-modal="true"
          // Modal semantics are ours: focus leaving is not a dismissal, and Tab loops inside (focus-loop.ts).
          onFocusOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            // Radix would focus a Trigger, which this dialog does not use; return focus explicitly instead.
            event.preventDefault();
            const target = returnFocusRef?.current ?? opener.current;
            if (target?.isConnected && target !== document.body) target.focus();
          }}
          onOpenAutoFocus={(event) => {
            if (!initialFocusSelector) return;
            const target =
              event.currentTarget instanceof HTMLElement
                ? event.currentTarget.querySelector<HTMLElement>(
                    initialFocusSelector,
                  )
                : null;
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
          data-dialog-sheet-below={sheetBelow}
          className={PANEL[sheetBelow]}
        >
          <header className="flex items-center gap-3 border-b px-5 py-4">
            {/*
              The title never squeezes below its longest word, so the sync control gives way first (a flex item's automatic minimum is
              its min-content width). That minimum is capped by the max-width, which keeps 160 px for the sync control and Close: a word
              wider than the rest of the header (a valid 64-character device name with no spaces) breaks there instead of pushing the
              controls out of the dialog.
            */}
            <div className="max-w-[calc(100%-160px)] break-words">
              <DialogPrimitive.Title className="text-lg font-semibold leading-tight tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              {syncControl ? (
                <SyncStatusChip
                  variant="dialog"
                  onBeforeOpen={() => {
                    onRetainDraft?.();
                    onClose();
                  }}
                />
              ) : null}
              <DialogPrimitive.Close
                aria-label="Close"
                onClick={(event) => {
                  event.preventDefault();
                  discard();
                }}
                className="atlas-transition flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <X aria-hidden="true" className="size-[18px]" />
              </DialogPrimitive.Close>
            </div>
          </header>
          <div ref={setBody} className="flex-1 overflow-y-auto p-5">
            {children}
          </div>
          {footer ? (
            <footer className="flex items-center gap-2 border-t bg-muted/60 px-5 py-3.5">
              {footer}
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
