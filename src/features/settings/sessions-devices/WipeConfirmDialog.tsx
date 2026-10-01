import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import {
  type DeviceRow,
  type LocalWorkSummary,
  type OperationStart,
  useSession,
} from "../../../session";
import { WipeConfirmBody } from "./WipeConfirmBody";
import {
  confirmLabel,
  REFUSAL,
  STAY_LABEL,
  titleFor,
  type WipeKind,
} from "./wipe-copy";

/**
 * The warning before a wipe-producing action (WEB-04 wireframes section 4; answers Q20(a)); the words are in
 * `wipe-copy.ts`. A confirmation is ALWAYS shown (design gap G-12). It names the unsynced changes when there are any, states
 * that proceeding deletes them irrecoverably, is never shown for a bare 401, and has no timer auto-confirm. The count is
 * rechecked at confirmation: a changed recount shows the corrected re-confirmation instead of proceeding. The default focus
 * is "Stay logged in".
 */
export function WipeConfirmDialog({
  kind,
  device,
  onClose,
}: {
  kind: WipeKind;
  /** Retirement: the current-device row from the read the approved token belongs to. */
  device?: DeviceRow;
  onClose(): void;
}) {
  const session = useSession();
  const [summary, setSummary] = useState<LocalWorkSummary | null | "unknown">(
    "unknown",
  );
  const [corrected, setCorrected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    session.operations.summariseLocalWork().then(
      (value) => {
        if (!cancelled) setSummary(value);
      },
      () => {
        if (!cancelled) setSummary(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session]);

  const known = summary !== "unknown" && summary !== null;
  const unsynced = known && summary.count > 0;

  const confirm = async () => {
    if (!known) return;
    setBusy(true);
    setRefusal(null);
    let result: OperationStart;
    try {
      result =
        kind === "logout"
          ? await session.operations.logout({ unsynced: summary })
          : device
            ? await session.operations.retireThisDevice({
                read: device,
                unsynced: summary,
              })
            : { kind: "refused", reason: "no_current_device" };
    } catch {
      result = { kind: "refused", reason: "storage_unavailable" };
    }
    setBusy(false);
    if (result.kind === "started") {
      // The record now holds the fence: the session view switches to the neutral state and this tree is unmounted.
      onClose();
    } else if (result.kind === "reconfirm") {
      setSummary(result.unsynced);
      setCorrected(true);
    } else {
      setRefusal(REFUSAL[result.reason]);
    }
  };

  const waitingReason =
    summary === null
      ? "We couldn't check for unsynced changes, so we can't continue."
      : busy
        ? "Working…"
        : "Checking for unsynced changes…";

  return (
    <Dialog
      open
      onClose={onClose}
      title={titleFor(kind)}
      initialFocusSelector="[data-stay]"
      footer={
        <>
          <Button variant="secondary" data-stay="" onClick={onClose}>
            {STAY_LABEL}
          </Button>
          {known && !busy ? (
            <Button variant="primary" onClick={() => void confirm()}>
              {confirmLabel(kind, unsynced)}
            </Button>
          ) : (
            <Button variant="primary" disabled reason={waitingReason}>
              {confirmLabel(kind, unsynced)}
            </Button>
          )}
        </>
      }
    >
      <WipeConfirmBody
        kind={kind}
        summary={known ? summary : null}
        corrected={corrected}
        device={device}
        refusal={refusal}
      />
    </Dialog>
  );
}
