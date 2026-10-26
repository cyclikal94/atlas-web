import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import {
  type DeviceRow,
  type LocalWorkSummary,
  type OperationStart,
  type SessionSummary,
  useSession,
} from "../../../session";
import { isOnlineNow, useOnline } from "../../authentication/use-online";
import {
  RETIRE_OFFLINE_REASON,
  thisBrowserLine,
  thisDeviceLine,
} from "./label-copy";
import { clientLabelText, decodeClientLabel, deviceDisplay } from "./labels";
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
 *
 * WEB-08d revision 26 (review r25 R25-N2): retiring this device is online-only (WF-SETTINGS-02; the kernel refuses an offline start too).
 * While the browser believes it is offline its confirmation is disabled with the reason, and a confirmation is not begun when the browser
 * already says so before the `offline` event has rendered. Logging out is deliberately possible offline, so none of this applies to it.
 * One confirmation at a time: a second click while one is being started does nothing. A started operation is the kernel's (its durable
 * consent survives reloads and connectivity changes); nothing here cancels it, and reconnecting confirms nothing by itself.
 */
/** D-8d-12: the line that names this browser or device, or null when it has only WEB-08a's fallback title (it would say nothing). */
export function identityLine(
  kind: WipeKind,
  device: DeviceRow | undefined,
  current: SessionSummary | undefined,
): { line: string; named?: string } | null {
  if (kind === "retire" && device) {
    const d = deviceDisplay(device);
    if (d.fallback) return null;
    return d.named
      ? { line: thisDeviceLine(""), named: d.title }
      : { line: thisDeviceLine(d.title) };
  }
  if (kind === "logout" && current) {
    const label = decodeClientLabel(current.client);
    return label ? { line: thisBrowserLine(clientLabelText(label)) } : null;
  }
  return null;
}

export function WipeConfirmDialog({
  kind,
  device,
  current,
  onClose,
}: {
  kind: WipeKind;
  /** Retirement: the current-device row from the read the approved token belongs to. */
  device?: DeviceRow;
  /** Logout: the current session's row, so the warning can name this browser. */
  current?: SessionSummary;
  onClose(): void;
}) {
  const session = useSession();
  const online = useOnline();
  const needsConnection = kind === "retire";
  const inflight = useRef(false);
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
    if (!known || inflight.current) return;
    if (needsConnection && !isOnlineNow()) return;
    inflight.current = true;
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
    inflight.current = false;
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

  const offline = needsConnection && !online;
  const waitingReason =
    summary === null
      ? "We couldn't check for unsynced changes, so we can't continue."
      : busy
        ? "Working…"
        : !known
          ? "Checking for unsynced changes…"
          : RETIRE_OFFLINE_REASON;

  return (
    <Dialog
      open
      onClose={onClose}
      title={titleFor(kind)}
      initialFocusSelector="[data-stay]"
      footer={
        <>
          <Button variant="outline" data-stay="" onClick={onClose}>
            {STAY_LABEL}
          </Button>
          {known && !busy && !offline ? (
            <Button variant="default" onClick={() => void confirm()}>
              {confirmLabel(kind, unsynced)}
            </Button>
          ) : (
            <Button variant="default" disabled reason={waitingReason}>
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
        identity={identityLine(kind, device, current)}
      />
    </Dialog>
  );
}
