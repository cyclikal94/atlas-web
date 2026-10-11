import { List } from "../../../components/ui/list";
import type { DeviceRow, LocalWorkSummary } from "../../../session";
import {
  actuallyLine,
  changesLine,
  deleteLine,
  NO_UNSYNCED_LINE,
  RETIRE_NOW_LINE,
  summaryLines,
  type WipeKind,
} from "./wipe-copy";

/** What the confirmation says: the unsynced changes (or that there are none), the device summary, and any refusal. */
export function WipeConfirmBody({
  kind,
  summary,
  corrected,
  device,
  refusal,
  identity,
}: {
  kind: WipeKind;
  summary: LocalWorkSummary | null;
  /** The count changed between the warning and the confirmation: show the corrected re-confirmation. */
  corrected: boolean;
  device?: DeviceRow;
  refusal: string | null;
  /** WEB-08d (D-8d-12): one line naming what is being signed out or retired, above the WEB-04 words (which stay verbatim). */
  identity?: { line: string; named?: string } | null;
}) {
  const unsynced = summary !== null && summary.count > 0;
  return (
    <div className="flex flex-col gap-3 text-[14px] leading-[1.6] text-ink-1">
      {identity ? (
        <p data-identity="" className="text-ink-2 [overflow-wrap:anywhere]">
          {identity.line}
          {identity.named !== undefined ? <bdi>{identity.named}</bdi> : null}
        </p>
      ) : null}
      {corrected && summary ? (
        <p>{actuallyLine(summary.count, kind)}</p>
      ) : unsynced ? (
        <>
          <p>{changesLine(summary.count)}</p>
          {summary.items.length > 0 ? (
            <List className="flex flex-col gap-1 text-ink-2">
              {summary.items.map((item) => (
                <li key={item} className="ml-5 list-disc">
                  {item}
                </li>
              ))}
            </List>
          ) : null}
          <p>{deleteLine(kind)}</p>
        </>
      ) : (
        <p>{NO_UNSYNCED_LINE}</p>
      )}
      {kind === "retire" && device ? (
        <>
          <List className="flex flex-col gap-1 text-ink-2">
            {summaryLines(device.summary).map((line) => (
              <li key={line} className="ml-5 list-disc">
                {line}
              </li>
            ))}
          </List>
          <p>{RETIRE_NOW_LINE}</p>
        </>
      ) : null}
      {refusal ? (
        <p data-refusal="" className="text-ink-2">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
