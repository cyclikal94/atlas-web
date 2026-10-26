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
      className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-accent p-3.5"
    >
      <p className="text-sm leading-relaxed text-foreground">{UPDATE_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="default" onClick={onSaveAndReload}>
          Save and reload
        </Button>
        <Button variant="ghost" onClick={onNotNow}>
          Not now
        </Button>
      </div>
    </div>
  );
}
