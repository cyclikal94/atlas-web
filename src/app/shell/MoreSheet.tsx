import { Link } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { type RefObject, useRef } from "react";
import { Dialog } from "../../components/ui/dialog";
import { List } from "../../components/ui/list";
import { useSyncStatus } from "../../components/ui/sync-status";
import { destinations } from "./destinations";
import { renderSlot, useShellEnv } from "./env";

/**
 * The mobile More sheet: Sharing, Settings, the offline queue and the account entry, as one dialog
 * (trap, Escape, focus return), so it follows the same dialog pattern as every other sheet.
 */
export function MoreSheet({
  open,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  onClose(): void;
  /** The More button. Safari and iOS do not focus a button on tap, so focus is returned explicitly. */
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const env = useShellEnv();
  const sync = useSyncStatus();
  // The account control's dialog returns focus to More, not to the control, which closes with this sheet (R10).
  const account = renderSlot(env.accountSlot, false, returnFocusRef);
  // Choosing a destination hands focus to that destination (the page heading), so it is not pulled back to More.
  const chose = useRef(false);
  const choose = () => {
    chose.current = true;
    onClose();
  };
  const row =
    "atlas-transition group flex min-h-13 w-full items-center gap-3 rounded-lg px-2.5 text-base text-foreground hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-semibold data-[status=active]:text-accent-foreground";
  const tile =
    "flex size-9 flex-none items-center justify-center rounded-md border bg-card text-muted-foreground shadow-xs group-data-[status=active]:border-primary/25 group-data-[status=active]:bg-background group-data-[status=active]:text-primary";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="More"
      returnFocusRef={returnFocusRef}
      onCloseAutoFocus={(event) => {
        if (!chose.current) return;
        chose.current = false;
        event.preventDefault();
      }}
    >
      <List className="atlas-stagger flex flex-col gap-1">
        {destinations
          .filter((destination) => destination.mobile === "more")
          .map((destination) => {
            const Icon = destination.icon;
            return (
              <li key={destination.id} className="list-none">
                <Link to={destination.to} className={row} onClick={choose}>
                  <span aria-hidden="true" className={tile}>
                    <Icon className="size-[18px]" strokeWidth={1.9} />
                  </span>
                  {destination.label}
                </Link>
              </li>
            );
          })}
        <li className="list-none">
          <button
            type="button"
            className={row}
            onClick={() => {
              choose();
              sync.onOpen("queue");
            }}
          >
            <span aria-hidden="true" className={tile}>
              <ListTodo className="size-[18px]" strokeWidth={1.9} />
            </span>
            Offline queue
          </button>
        </li>
      </List>
      {account ? (
        // The account control opens the switcher (WEB-08c), which is a dialog of its own: More closes first, so two sheets are never
        // stacked. A keyboard activation of the button is a click too, so this covers it.
        // biome-ignore lint/a11y/useKeyWithClickEvents: only bubbles the account button's own activation
        // biome-ignore lint/a11y/noStaticElementInteractions: as above, the button inside is the interactive element
        <div className="mt-4 border-t pt-4" onClick={choose}>
          {account}
        </div>
      ) : null}
    </Dialog>
  );
}
