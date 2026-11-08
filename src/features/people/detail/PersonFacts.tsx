import { ChevronRight } from "lucide-react";
import { FactCell, FactsStrip } from "../../../components/ui/facts-strip";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import {
  attributionOf,
  audienceText,
  type PersonSummaryDetail,
} from "../model/summary";
import { readOne, shownOf, useSummary } from "../summaries";
import { useDuplicateCount } from "./duplicates-count";

/**
 * The person's facts strip (the Final design, 8 November 2026): who can see the person (the cell opens the sharing editor, as every
 * editor with consequences opens from the strip), who the profile is linked to, how many fields and who added them, and a possible
 * duplicate to compare when the server lists one. From the viewer-safe summary (`GET /people/{id}/summary`, the read "Shared with"
 * makes too), so it appears once that read has answered and says nothing before; an unsent person has none.
 */
export function PersonFacts({
  personId,
  projected,
  onSharing,
}: {
  personId: string;
  projected: boolean;
  /** Opens the sharing editor on the person (absent while it cannot be opened). */
  onSharing?: () => void;
}) {
  const env = usePeopleEnv();
  const view = useSummary<PersonSummaryDetail>(
    `person:${personId}`,
    (current) =>
      readOne(
        () => env.api.readPersonSummary(personId),
        (detail) => [detail.summary],
        current,
      ),
  );
  const duplicates = useDuplicateCount(personId, projected);
  if (projected) return null;
  const summary = shownOf(view)?.value.summary ?? null;
  if (summary === null) return null;
  const attribution = attributionOf(summary);
  const added =
    attribution.kind === "you"
      ? copy.YOU
      : attribution.kind === "added_by_you"
        ? copy.ADDED_BY_YOU
        : attribution.kind === "shared_by"
          ? copy.SHARED_BY(attribution.owner)
          : null;
  const seen = <span>{audienceText(summary.audience)}</span>;
  return (
    <FactsStrip columns={4} data-person-facts="">
      {onSharing ? (
        <FactCell
          as="button"
          label={copy.FACTS.visibleTo}
          data-fact="visible"
          data-people-action="manage-sharing-cell"
          onClick={onSharing}
        >
          {seen}
          <ChevronRight
            aria-hidden="true"
            className="size-4 flex-none text-muted-foreground"
          />
        </FactCell>
      ) : (
        <FactCell label={copy.FACTS.visibleTo} data-fact="visible">
          {seen}
        </FactCell>
      )}
      <FactCell label={copy.FACTS.linked} data-fact="linked">
        <span>
          {summary.linkage === "you"
            ? copy.FACT_LINK_SELF
            : summary.linkage === "other"
              ? copy.FACT_LINK_OTHER
              : copy.FACT_LINK_NONE}
        </span>
      </FactCell>
      <FactCell label={copy.FACTS.fields} data-fact="fields">
        <span className="font-num">{String(summary.field_count)}</span>
      </FactCell>
      {added === null ? null : (
        <FactCell label={copy.FACTS.added} data-fact="added">
          <span>{added}</span>
        </FactCell>
      )}
      {duplicates !== null && duplicates !== "0" ? (
        <FactCell
          as="link"
          label={copy.FACTS.duplicate}
          dot="primary"
          data-fact="duplicate"
          to="/people/$personId/duplicates"
          params={{ personId }}
        >
          <span className="font-num">{duplicates}</span>
          <span className="text-xs text-primary">{copy.FACT_COMPARE}</span>
        </FactCell>
      ) : null}
    </FactsStrip>
  );
}
