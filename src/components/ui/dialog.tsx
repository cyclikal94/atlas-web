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
          className="fixed inset-0 z-40 bg-scrim"
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
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel tablet:inset-auto tablet:left-1/2 tablet:top-[8vh] tablet:max-h-[84vh] tablet:w-[440px] tablet:max-w-[calc(100vw-32px)] tablet:-translate-x-1/2 tablet:rounded-dialog tablet:border tablet:border-hairline-strong tablet:shadow-modal"
        >
          <header className="flex items-center gap-3 border-b border-hairline px-[18px] py-4">
            {/* min-w-min: the title never squeezes below its longest word; the sync control gives way instead. */}
            <div className="min-w-min break-words">
              <DialogPrimitive.Title className="text-[16px] font-medium tracking-[-0.01em] text-ink-1">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-[12.5px] text-ink-2">
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
                className="atlas-transition flex size-11 shrink-0 items-center justify-center rounded-control text-ink-2 hover:text-ink-1"
              >
                <X aria-hidden="true" size={18} />
              </DialogPrimitive.Close>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto p-[18px]">{children}</div>
          {footer ? (
            <footer className="flex items-center gap-2 border-t border-hairline bg-inset px-[18px] py-3.5">
              {footer}
            </footer>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
