import type { RefObject } from "react";
import { Button } from "../../components/ui/button";
import { isHandoff } from "./look";
import type { RecoveryControls } from "./model";
import { RecoveryBanner, UNAVAILABLE_WHILE_RELOADING } from "./RecoveryBanner";

/** PROPOSED copy, not accepted (WEB-14a revision 37). */
export const OTHER_COPIES = "Other saved copies of this form:";
const when = (savedAt: string): string => {
  const at = new Date(savedAt);
  return Number.isNaN(at.getTime()) ? savedAt : at.toLocaleString();
};
export const RESTORE_COPY = (savedAt: string) =>
  `Restore the copy saved ${when(savedAt)}`;
export const DISCARD_COPY = (savedAt: string) =>
  `Discard the copy saved ${when(savedAt)}`;

/**
 * What a product editor shows of its recovery around an app-update reload (WEB-14a revision 37, R40; Q4): WEB-07's `RecoveryBanner`
 * "unavailable" (the look could not read the store: Try again) and "restored" (Discard instead, unavailable while an update reload is
 * prepared), and the other copies left to the form, each restorable (and a hand-off whose page never came back discardable), never
 * submitted. `firstFieldRef`: the editor's first field, focused on restore (`RecoveryBanner`).
 */
export function RecoveryNotice({
  recovery,
  firstFieldRef,
}: {
  recovery: RecoveryControls;
  firstFieldRef?: RefObject<HTMLElement | null>;
}) {
  const { view, locked } = recovery;
  return (
    <>
      {view.unavailable ? (
        <RecoveryBanner
          state={{ kind: "unavailable", onRetry: () => void recovery.retry() }}
        />
      ) : null}
      {view.restored ? (
        <RecoveryBanner
          state={{
            kind: "restored",
            onDiscard: () => void recovery.discard(),
            disabled: locked,
          }}
          {...(firstFieldRef ? { firstFieldRef } : {})}
        />
      ) : null}
      {view.alternatives.length > 0 ? (
        <div
          data-recovery-alternatives={view.alternatives.length}
          className="flex flex-col gap-2 text-[13px] text-ink-2"
        >
          <p>{OTHER_COPIES}</p>
          <div className="flex flex-wrap gap-2">
            {view.alternatives.map((copy) =>
              locked ? (
                <Button
                  key={copy.tabInstanceId}
                  disabled
                  reason={UNAVAILABLE_WHILE_RELOADING}
                >
                  {RESTORE_COPY(copy.savedAt)}
                </Button>
              ) : (
                <span key={copy.tabInstanceId} className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => void recovery.restoreAlternative(copy)}
                  >
                    {RESTORE_COPY(copy.savedAt)}
                  </Button>
                  {isHandoff(copy) ? (
                    <Button
                      variant="quiet"
                      onClick={() => void recovery.discardAlternative(copy)}
                    >
                      {DISCARD_COPY(copy.savedAt)}
                    </Button>
                  ) : null}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
