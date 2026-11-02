import { type RefObject, useEffect, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
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
 * PROPOSED copy (WEB-14a revision 38), not accepted: a copy chosen was not restored (gone, unreadable, or the form changed or is being saved
 * meanwhile), or a saved copy was not removed.
 */
export const NOT_RESTORED = "Couldn't restore that copy. Nothing was changed.";
export const NOT_REMOVED =
  "Couldn't remove a saved copy yet. It may be offered again.";

/**
 * What a product editor shows of its recovery around an app-update reload (WEB-14a revision 37, R40; Q4): WEB-07's `RecoveryBanner`
 * "unavailable" (the look could not read the store: Try again) and "restored" (Discard instead, unavailable while an update reload is
 * prepared), and the other copies left to the form, each restorable (and a hand-off whose page never came back discardable), never
 * submitted. `firstFieldRef`: the editor's first field, focused on restore (`RecoveryBanner`).
 *
 * Revision 38 (design assessment C3): what an action did is said, never assumed. A choice that was not applied (the copy gone, unreadable,
 * or refused because the form changed or is being saved meanwhile) and copies that could not be removed are reported, here and to the
 * announcer; a choice applied shows as the restored copy.
 */
export function RecoveryNotice({
  recovery,
  firstFieldRef,
}: {
  recovery: RecoveryControls;
  firstFieldRef?: RefObject<HTMLElement | null>;
}) {
  const { view, locked } = recovery;
  // Each report is a new one (the same words again are announced again); an action that did what it offered clears it.
  const [outcome, setOutcome] = useState<{ message: string } | null>(null);
  const after = (failed: string) => (result: string) =>
    setOutcome(
      result === "restored" || result === "discarded"
        ? null
        : { message: failed },
    );
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
            onDiscard: () => void recovery.discard().then(after(NOT_REMOVED)),
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
                    onClick={() =>
                      void recovery
                        .restoreAlternative(copy)
                        .then(after(NOT_RESTORED))
                    }
                  >
                    {RESTORE_COPY(copy.savedAt)}
                  </Button>
                  {isHandoff(copy) ? (
                    <Button
                      variant="quiet"
                      onClick={() =>
                        void recovery
                          .discardAlternative(copy)
                          .then(after(NOT_REMOVED))
                      }
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
      {outcome ? <Outcome report={outcome} /> : null}
    </>
  );
}

/** What a recovery action did not do, shown and announced once (like `RecoveryBanner`, only while there is something to say). */
function Outcome({ report }: { report: { message: string } }) {
  const { announce } = useAnnouncer();
  useEffect(() => {
    announce(report.message, "assertive");
  }, [report, announce]);
  return (
    <p data-recovery-outcome="" className="text-[13px] text-conflict-text">
      {report.message}
    </p>
  );
}
