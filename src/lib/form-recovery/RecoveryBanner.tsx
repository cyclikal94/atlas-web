import { type RefObject, useEffect } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { useRestoredFocus } from "./focus";

/**
 * Recovery banners for form-recovery-reload.html, states 2 and 3. They never submit anything and never
 * reload on their own: the caller decides what each action does. Each announces itself once through the
 * announcer (the only home of live regions), so a screen-reader user hears a failed save or a restore.
 */
export type RecoveryBannerState =
  | { kind: "save-failed"; onRetry(): void; onDiscardAndReload(): void }
  /**
   * The account is being signed out, so the unfinished form cannot be saved (`FormRecoveryPort.save` returned `refused`).
   * There is nothing to retry: the form stays open and the reload is the person's choice. PROPOSED copy, not accepted.
   */
  | { kind: "save-refused"; onDiscardAndReload(): void }
  /**
   * "Discard and reload anyway" could not discard the copy saved earlier (WEB-14a revision 1, R6): a reload now may restore it. Nothing
   * reloads until the person tries again or chooses to reload anyway. PROPOSED copy, not accepted.
   */
  | { kind: "discard-failed"; onRetry(): void; onReloadAnyway(): void }
  /**
   * The form's look for what was left to it (an update's hand-off, another tab's copy) could not read the store (WEB-14a revision 7, R13:
   * `useRecoverableForm().unavailable`): nothing was restored or removed. `onRetry` is `retry`. PROPOSED copy, not accepted.
   */
  | { kind: "unavailable"; onRetry(): void }
  /**
   * `disabled` (WEB-14a revision 2, R3): this tab is preparing an update reload (`useRecoverableForm().locked`), so "Discard instead" would
   * change the form after its last save; it is shown unavailable, with its reason (PROPOSED copy, not accepted).
   */
  | { kind: "restored"; onDiscard(): void; disabled?: boolean };

export interface RecoveryBannerProps {
  state: RecoveryBannerState;
  /**
   * The form's first field. On restore, focus goes here, never to the banner (state 3; it also wins over a state-1 prompt of the same
   * arrival, `focus.ts`), and here again after "Discard instead". Render it with the restored form, or no field is focused.
   */
  firstFieldRef?: RefObject<HTMLElement | null>;
}

export const SAVE_FAILED_TEXT =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";
export const SAVE_REFUSED_TEXT =
  "Can't save your unfinished form while you're signing out. Nothing was lost — your form is still here.";
export const DISCARD_FAILED_TEXT =
  "Couldn't clear the saved copy of your unfinished form. If you reload now, that copy may be restored afterwards. Your form is still here.";
/** PROPOSED copy (WEB-14a revision 7, R13), not accepted. */
export const UNAVAILABLE_TEXT =
  "Couldn't check for a saved copy of this form. Nothing was removed — try again before you start.";
/** PROPOSED copy (WEB-14a revision 2, R3), not accepted: why a recovery action is unavailable while the tab reloads onto an update. */
export const UNAVAILABLE_WHILE_RELOADING =
  "Unavailable while Atlas saves your form and reloads.";
export const RESTORED_TEXT =
  "Restored your unfinished form from before the update. Nothing was submitted automatically — review and submit when ready.";

export function RecoveryBanner({ state, firstFieldRef }: RecoveryBannerProps) {
  const { announce } = useAnnouncer();
  const kind = state.kind;

  useEffect(() => {
    announce(
      kind === "save-failed"
        ? SAVE_FAILED_TEXT
        : kind === "save-refused"
          ? SAVE_REFUSED_TEXT
          : kind === "discard-failed"
            ? DISCARD_FAILED_TEXT
            : kind === "unavailable"
              ? UNAVAILABLE_TEXT
              : RESTORED_TEXT,
      kind === "restored" ? "polite" : "assertive",
    );
  }, [kind, announce]);

  // State 3 (revisions 19 and 20, R27): a request until the field really has focus, attempted again when it can take it (`focus.ts`): a
  // banner mounted behind the session gate focuses its field once the gate lifts.
  useRestoredFocus(kind === "restored", firstFieldRef);

  if (state.kind === "save-failed") {
    return (
      <div
        data-recovery-state="save-failed"
        className="flex flex-col gap-3 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
      >
        <p className="text-[13.5px] leading-[1.6] text-conflict-text">
          {SAVE_FAILED_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={state.onRetry}>
            Retry save
          </Button>
          <Button variant="quiet" onClick={state.onDiscardAndReload}>
            Discard and reload anyway
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "discard-failed") {
    return (
      <div
        data-recovery-state="discard-failed"
        className="flex flex-col gap-3 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
      >
        <p className="text-[13.5px] leading-[1.6] text-conflict-text">
          {DISCARD_FAILED_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={state.onRetry}>
            Try again
          </Button>
          <Button variant="quiet" onClick={state.onReloadAnyway}>
            Reload anyway
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "unavailable") {
    return (
      <div
        data-recovery-state="unavailable"
        className="flex flex-col gap-3 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
      >
        <p className="text-[13.5px] leading-[1.6] text-conflict-text">
          {UNAVAILABLE_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={state.onRetry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "save-refused") {
    return (
      <div
        data-recovery-state="save-refused"
        className="flex flex-col gap-3 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
      >
        <p className="text-[13.5px] leading-[1.6] text-conflict-text">
          {SAVE_REFUSED_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" onClick={state.onDiscardAndReload}>
            Discard and reload anyway
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      data-recovery-state="restored"
      className="flex flex-col gap-3 rounded-row border border-action-tint-edge bg-action-tint p-3.5"
    >
      <p className="text-[13.5px] leading-[1.6] text-ink-1">{RESTORED_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        {state.disabled ? (
          <Button variant="quiet" disabled reason={UNAVAILABLE_WHILE_RELOADING}>
            Discard instead
          </Button>
        ) : (
          <Button
            variant="quiet"
            onClick={(event) => {
              // The banner goes with the copy: the person continues in the form they were reviewing (revision 19).
              const used = event.currentTarget === document.activeElement;
              state.onDiscard();
              if (used) firstFieldRef?.current?.focus();
            }}
          >
            Discard instead
          </Button>
        )}
      </div>
    </div>
  );
}
