import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { List } from "../../../components/ui/list";
import { type DeviceRow, useSession } from "../../../session";
import { retireOtherTitle } from "./label-copy";
import { deviceInSentence } from "./labels";
import { outcomeUnknown } from "./outcome";
import { untilSent } from "./until-sent";
import { summaryLines } from "./wipe-copy";

/**
 * Retiring ANOTHER device (SA-10). It touches nothing on this browser, so there is no unsynced-work warning. The call
 * carries the approved-state token of the read that supplied this row; a device that changed since answers
 * `rejected_stale`, which is never retried against changed state. PROPOSED copy (gap G-5). WEB-08d (D-8d-12): the title names the
 * device ("Retire Firefox on Windows?", a name isolated); the token sent is still the one from the read that supplied the row, and a
 * name is not part of it, so a rename in between cannot stale the retirement.
 */
export const retireOtherDialogTitle = (device: DeviceRow): string =>
  retireOtherTitle(deviceInSentence(device));
export const RETIRE_OTHER_BODY =
  "Retiring a device signs it out and frees its place for syncing. It can sign in again later.";
export const RETIRE_OTHER_STALE =
  "Something about that device changed before your request was processed, so nothing was removed. Check the device and try again if you still want to retire it.";
export const RETIRE_OTHER_FAILED =
  "Couldn't retire this device — please try again.";

export function RetireOtherDialog({
  device,
  onChanged,
  onClose,
}: {
  device: DeviceRow;
  /**
   * Called after a confirmed retirement, or one whose outcome is unknown, so the lists are read again: retiring a device also ends
   * its sessions.
   */
  onChanged(): void;
  onClose(): void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setMessage(null);
    const result = await untilSent(() =>
      session.operations.retireOtherDevice(device),
    ).catch(() => null);
    setBusy(false);
    if (result?.ok) {
      if (result.value === "rejected_stale") {
        setMessage(RETIRE_OTHER_STALE);
        return;
      }
      onChanged();
      onClose();
      return;
    }
    const requestId =
      result && !result.ok ? result.atlasError?.request_id : undefined;
    setMessage(
      requestId
        ? `${RETIRE_OTHER_FAILED} Request ID: ${requestId}`
        : RETIRE_OTHER_FAILED,
    );
    // The device may have been retired anyway (an answer lost after sending, a server error): the lists behind the dialog are read
    // again, and the failure stays shown here.
    if (outcomeUnknown(result)) onChanged();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={retireOtherDialogTitle(device)}
      initialFocusSelector="[data-keep]"
      footer={
        <>
          <Button variant="secondary" data-keep="" onClick={onClose}>
            Keep this device
          </Button>
          {busy ? (
            <Button variant="primary" disabled reason="Working…">
              Retire device
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void confirm()}>
              Retire device
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[14px] leading-[1.6] text-ink-1">
        <p>{RETIRE_OTHER_BODY}</p>
        <List className="flex flex-col gap-1 text-ink-2">
          {summaryLines(device.summary).map((line) => (
            <li key={line} className="ml-5 list-disc">
              {line}
            </li>
          ))}
        </List>
        {message ? (
          <p data-refusal="" className="text-ink-2">
            {message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
