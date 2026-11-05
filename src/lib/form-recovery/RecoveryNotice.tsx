import { useEffect, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { type FocusTarget, useChoiceFocus, useDiscardFocus } from "./focus";
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
 * PROPOSED copy (WEB-14a revision 53, D-R53-1), not accepted: a copy was not offered because another page seemed to hold it, and the
 * person's explicit repeat of the look; then what that check found (announced politely).
 */
export const WITHHELD =
  "A saved copy of this form may still be open in another tab.";
export const CHECK_AGAIN = "Check saved copies again";
export const CHECKED_FOUND =
  "Checked again: saved copies you can restore are listed.";
export const CHECKED_NONE =
  "Checked again: no other saved copy can be restored now.";

/**
 * What a product editor shows of its recovery around an app-update reload (WEB-14a revision 37, R40; Q4): WEB-07's `RecoveryBanner`
 * "unavailable" (the look could not read the store: Try again) and "restored" (Discard instead, unavailable while an update reload is
 * prepared), and the other copies left to the form, each restorable (and a hand-off whose page never came back discardable), never
 * submitted. `firstFieldRef`: the editor's first field, focused on restore (`RecoveryBanner`).
 *
 * Revision 51 (F-R51-1; design assessment of 3 November 2026, C2/C3; form-recovery-reload.html "Focus order"): every product editor
 * NAMES where focus goes, so `firstFieldRef` is required, a ref to the control itself (never a wrapper) or a resolver answered from the
 * committed DOM. A focused "Discard instead" returns focus to `discardFocus` (by default the same target) after the owner's reset: the
 * request is held here, by the owner, since the banner goes with the copy (`useDiscardFocus`). Where no field exists (a parked fix, a picker
 * with no choices), the owner's surviving control, else its heading, is the destination (decision D1, Kieran, 3 November 2026).
 *
 * Revision 38 (design assessment C3): what an action did is said, never assumed. A choice that was not applied (the copy gone, unreadable,
 * or refused because the form changed or is being saved meanwhile) and copies that could not be removed are reported, here and to the
 * announcer; a choice applied shows as the restored copy.
 *
 * Revision 53 (Kieran, 3 November 2026). D-R53-1: when the look withheld a copy another page seemed to hold (a genuine open tab, or an
 * older build's brief probe of its lock), "Check saved copies again" repeats the look on the person's request only (`checkAgain`: nothing
 * looks again by itself); what it finds is offered, never restored. Once used, the action stays (focus stays on it) and what the check
 * found is said. D-R53-2: a copy chosen while the restored banner stays shown focuses `firstFieldRef` once it is applied
 * (`useChoiceFocus`), never the removed button.
 */
export function RecoveryNotice({
  recovery,
  firstFieldRef,
  discardFocus,
}: {
  recovery: RecoveryControls;
  firstFieldRef: FocusTarget;
  /** Where a focused "Discard instead" leaves focus, when that is not `firstFieldRef` (an editor the discard removes). */
  discardFocus?: FocusTarget;
}) {
  const { view, locked } = recovery;
  const returnFocus = useDiscardFocus(discardFocus ?? firstFieldRef);
  const choiceFocus = useChoiceFocus(firstFieldRef);
  // Revision 53: the action stays once used (from the click: focus stays on it while the check reads); each finished check is said.
  const [used, setUsed] = useState(false);
  const [checks, setChecks] = useState(0);
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
          firstFieldRef={firstFieldRef}
          onFocusedDiscard={returnFocus}
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
                    onClick={(event) => {
                      // D-R53-2: only a choice made while a restored copy is shown (otherwise the banner's arrival focuses the field).
                      const focus = view.restored
                        ? choiceFocus(event.currentTarget)
                        : null;
                      void recovery.restoreAlternative(copy).then((result) => {
                        if (result === "restored") focus?.();
                        after(NOT_RESTORED)(result);
                      });
                    }}
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
      {view.withheld || used ? (
        <div
          data-recovery-check=""
          className="flex flex-col items-start gap-2 text-[13px] text-ink-2"
        >
          <CheckReport
            report={
              view.withheld
                ? WITHHELD
                : view.alternatives.length > 0
                  ? CHECKED_FOUND
                  : CHECKED_NONE
            }
            checks={checks}
          />
          <Button
            variant="quiet"
            {...(locked
              ? { disabled: true, reason: UNAVAILABLE_WHILE_RELOADING }
              : {
                  onClick: () => {
                    setUsed(true);
                    void recovery
                      .checkAgain()
                      .then((read) => read && setChecks((n) => n + 1));
                  },
                })}
          >
            {CHECK_AGAIN}
          </Button>
        </div>
      ) : null}
      {outcome ? <Outcome report={outcome} /> : null}
    </>
  );
}

/**
 * Revision 53 (D-R53-1): what the check says, shown while the action is; each finished check (`checks`) is announced politely, with
 * what it found then. Like `Outcome`, only rendered while there is something to say (the announcer is needed only then).
 */
function CheckReport({ report, checks }: { report: string; checks: number }) {
  const { announce } = useAnnouncer();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a finished check is what is said, with what it found then
  useEffect(() => {
    if (checks > 0) announce(report, "polite");
  }, [checks]);
  return <p>{report}</p>;
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
