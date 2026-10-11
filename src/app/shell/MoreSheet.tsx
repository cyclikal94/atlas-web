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
  const account = renderSlot(env.accountSlot, false);
  // Choosing a destination hands focus to that destination (the page heading), so it is not pulled back to More.
  const chose = useRef(false);
  const choose = () => {
    chose.current = true;
    onClose();
  };
  const row =
    "atlas-transition flex min-h-12 w-full items-center gap-3 rounded-row px-3 text-[15px] text-ink-1 hover:bg-row-hover data-[status=active]:bg-select-tint data-[status=active]:font-semibold";
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
      <List className="flex flex-col gap-1">
        {destinations
          .filter((destination) => destination.mobile === "more")
          .map((destination) => {
            const Icon = destination.icon;
            return (
              <li key={destination.id} className="list-none">
                <Link to={destination.to} className={row} onClick={choose}>
                  <Icon aria-hidden="true" size={18} className="text-ink-2" />
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
            <ListTodo aria-hidden="true" size={18} className="text-ink-2" />
            Offline queue
          </button>
        </li>
      </List>
      {account ? (
        // The account control opens the switcher (WEB-08c), which is a dialog of its own: More closes first, so two sheets are never
        // stacked. A keyboard activation of the button is a click too, so this covers it.
        // biome-ignore lint/a11y/useKeyWithClickEvents: only bubbles the account button's own activation
        // biome-ignore lint/a11y/noStaticElementInteractions: as above, the button inside is the interactive element
        <div className="mt-4 border-t border-hairline pt-4" onClick={choose}>
          {account}
        </div>
      ) : null}
    </Dialog>
  );
}
