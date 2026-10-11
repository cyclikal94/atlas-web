import { useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { List } from "../../../components/ui/list";
import { type DeviceRow, useSession } from "../../../session";
import { retireOtherTitle } from "./label-copy";
import { deviceInSentence } from "./labels";
import { outcomeUnknown } from "./outcome";
import { type Interaction, reconcileLists } from "./ownership";
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

/**
 * Review R3 (revision 2): this dialog is one `interaction`. "Keep this device", Escape or Close ends it at once: a retirement refused
 * before it was sent (`not_sent`) is not tried again, and one still waiting to be issued is withdrawn. A retirement already sent is not
 * undone by closing the dialog: when its answer shows it applied (or cannot show it did not), the lists are read again (R1) whoever
 * is looking, but only the dialog that is still current shows the outcome or closes itself, so a late answer never closes or changes
 * a newer dialog (this device's retirement included).
 */
export function RetireOtherDialog({
  device,
  interaction,
  onClose,
}: {
  device: DeviceRow;
  /** This opening of the dialog: begun by the opener, ended when the dialog is dismissed or replaced. */
  interaction: Interaction;
  onClose(): void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inflight = useRef(false);

  const confirm = async () => {
    if (inflight.current || !interaction.current()) return;
    inflight.current = true;
    setBusy(true);
    setMessage(null);
    const result = await untilSent(
      () =>
        session.operations.retireOtherDevice(device, {
          withdraw: interaction.withdraw,
        }),
      { isCurrent: interaction.current },
    ).catch(() => null);
    inflight.current = false;
    // Applied (or superseded: retired already), or an outcome nobody can confirm: retiring a device also ends its sessions, so both
    // lists are read again, even if the dialog was closed meanwhile. `rejected_stale` and a definite refusal changed nothing.
    if (result?.ok ? result.value !== "rejected_stale" : outcomeUnknown(result))
      reconcileLists(session, interaction.scope);
    if (!interaction.current()) return;
    setBusy(false);
    if (result?.ok) {
      if (result.value === "rejected_stale") {
        setMessage(RETIRE_OTHER_STALE);
        return;
      }
      onClose();
      return;
    }
    const requestId =
      result && !result.ok ? result.atlasError?.request_id : undefined;
    // When the device may have been retired anyway (an answer lost after sending, a server error), the lists behind the dialog have
    // been read again above, and the failure stays shown here.
    setMessage(
      requestId
        ? `${RETIRE_OTHER_FAILED} Request ID: ${requestId}`
        : RETIRE_OTHER_FAILED,
    );
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
