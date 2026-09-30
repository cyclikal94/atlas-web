import { useEffect } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";

export const UPDATE_TEXT =
  "A new version of Atlas is ready. Reload to update — we'll save your unfinished form first.";

/**
 * State 1: an update is ready. The user chooses when to reload (Q4); nothing happens automatically.
 * WEB-14a supplies the update event and the reload, and wires these two callbacks.
 */
export function UpdatePrompt({
  onSaveAndReload,
  onNotNow,
}: {
  onSaveAndReload(): void;
  onNotNow(): void;
}) {
  const { announce } = useAnnouncer();
  useEffect(() => {
    announce(UPDATE_TEXT);
  }, [announce]);
  return (
    <div
      data-recovery-state="update-available"
      className="flex flex-col gap-3 rounded-row border border-action-tint-edge bg-action-tint p-3.5"
    >
      <p className="text-[13.5px] leading-[1.6] text-ink-1">{UPDATE_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSaveAndReload}>
          Save and reload
        </Button>
        <Button variant="quiet" onClick={onNotNow}>
          Not now
        </Button>
      </div>
    </div>
  );
}
