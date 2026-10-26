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
  /**
   * The account is being signed out, so the unfinished form cannot be saved (`FormRecoveryPort.save` returned `refused`).
   * There is nothing to retry: the form stays open and the reload is the person's choice. PROPOSED copy, not accepted.
   */
  | { kind: "save-refused"; onDiscardAndReload(): void }
  | { kind: "restored"; onDiscard(): void };

export interface RecoveryBannerProps {
  state: RecoveryBannerState;
  /** The form's first field. On restore, focus returns here, never to the banner. */
  firstFieldRef?: RefObject<HTMLElement | null>;
}

export const SAVE_FAILED_TEXT =
  "Couldn't save your unfinished form before reloading. Nothing was lost — your form is still here.";
export const SAVE_REFUSED_TEXT =
  "Can't save your unfinished form while you're signing out. Nothing was lost — your form is still here.";
export const RESTORED_TEXT =
  "Restored your unfinished form from before the update. Nothing was submitted automatically — review and submit when ready.";

export function RecoveryBanner({ state, firstFieldRef }: RecoveryBannerProps) {
  const { announce } = useAnnouncer();
  const focused = useRef(false);
  const kind = state.kind;

  useEffect(() => {
    announce(
      kind === "save-failed"
        ? SAVE_FAILED_TEXT
        : kind === "save-refused"
          ? SAVE_REFUSED_TEXT
          : RESTORED_TEXT,
      kind === "restored" ? "polite" : "assertive",
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
        className="flex flex-col gap-3 rounded-lg border border-destructive/35 bg-destructive/12 p-3.5"
      >
        <p className="text-sm leading-relaxed text-destructive">
          {SAVE_FAILED_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={state.onRetry}>
            Retry save
          </Button>
          <Button variant="ghost" onClick={state.onDiscardAndReload}>
            Discard and reload anyway
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "save-refused") {
    return (
      <div
        data-recovery-state="save-refused"
        className="flex flex-col gap-3 rounded-lg border border-destructive/35 bg-destructive/12 p-3.5"
      >
        <p className="text-sm leading-relaxed text-destructive">
          {SAVE_REFUSED_TEXT}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={state.onDiscardAndReload}>
            Discard and reload anyway
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      data-recovery-state="restored"
      className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-accent p-3.5"
    >
      <p className="text-sm leading-relaxed text-foreground">{RESTORED_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={state.onDiscard}>
          Discard instead
        </Button>
      </div>
    </div>
  );
}
