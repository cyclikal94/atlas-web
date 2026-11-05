import { Button } from "../../components/ui/button";
import * as copy from "./copy";
import { type SummaryView, shownOf } from "./summaries";

/** The words of one family of summaries (people, fields) for each state. */
export interface SummaryWords {
  offline: string;
  failed: string;
  checking: string;
}

export const PEOPLE_WORDS: SummaryWords = {
  offline: copy.SUMMARY_OFFLINE,
  failed: copy.SUMMARY_FAILED,
  checking: copy.SUMMARY_CHECKING,
};

export const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * When the summaries shown were checked (never presented as live), whether some are partial (the owner may have shared them more widely),
 * or why there are none: offline (never an old answer), failed (with Try again) or still checking.
 */
export function SummaryNotes({
  view,
  partial,
  words = PEOPLE_WORDS,
  partialNote = copy.PARTIAL_NOTE,
}: {
  view: SummaryView<unknown>;
  partial: boolean;
  words?: SummaryWords;
  partialNote?: string;
}) {
  const shown = shownOf(view);
  return (
    <div className="flex flex-col gap-1" data-people-summary={view.status}>
      {view.status === "offline" ? (
        <p className="text-xs text-muted-foreground">{words.offline}</p>
      ) : view.status === "failed" ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {words.failed}
          <Button variant="ghost" onClick={view.retry}>
            {copy.TRY_AGAIN}
          </Button>
        </p>
      ) : shown === null ? (
        <p className="text-xs text-muted-foreground">{words.checking}</p>
      ) : (
        <p className="text-xs text-muted-foreground" data-summary-checked="">
          {copy.SUMMARY_AS_OF(timeOf(shown.checkedAt))}
        </p>
      )}
      {partial && shown !== null ? (
        <p className="text-xs text-muted-foreground" data-people-partial="">
          {partialNote}
        </p>
      ) : null}
    </div>
  );
}
