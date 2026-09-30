import { type RefObject, useEffect, useRef } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";

/**
 * Recovery banners for form-recovery-reload.html, states 2 and 3. They never submit anything and never
 * reload on their own: the caller decides what each action does. Each announces itself once through the
 * announcer (the only home of live regions), so a screen-reader user hears a failed save or a restore.
 */
export type RecoveryBannerState =
  | { kind: "save-failed"; onRetry(): void; onDiscardAndReload(): void }
  | { kind: "restored"; onDiscard(): void };

export interface RecoveryBannerProps {
  state: RecoveryBannerState;
  /** The form's first field. On restore, focus returns here, never to the banner. */
  firstFieldRef?: RefObject<HTMLElement | null>;
}

export const SAVE_FAILED_TEXT =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";
export const RESTORED_TEXT =
  "Restored your unfinished form from before the update. Nothing was submitted automatically — review and submit when ready.";

export function RecoveryBanner({ state, firstFieldRef }: RecoveryBannerProps) {
  const { announce } = useAnnouncer();
  const focused = useRef(false);
  const kind = state.kind;

  useEffect(() => {
    announce(
      kind === "save-failed" ? SAVE_FAILED_TEXT : RESTORED_TEXT,
      kind === "save-failed" ? "assertive" : "polite",
    );
  }, [kind, announce]);

  useEffect(() => {
    if (kind !== "restored" || focused.current) return;
    focused.current = true;
    firstFieldRef?.current?.focus();
  }, [kind, firstFieldRef]);

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
  return (
    <div
      data-recovery-state="restored"
      className="flex flex-col gap-3 rounded-row border border-action-tint-edge bg-action-tint p-3.5"
    >
      <p className="text-[13.5px] leading-[1.6] text-ink-1">{RESTORED_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" onClick={state.onDiscard}>
          Discard instead
        </Button>
      </div>
    </div>
  );
}
