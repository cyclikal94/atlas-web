import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import {
  attributionOf,
  audienceText,
  type PersonSummaryDetail,
} from "../model/summary";
import { readOne, shownOf, useSummary } from "../summaries";

/**
 * The person's facts strip (the Final design, 8 November 2026): who the profile is linked to, who can see the person, how many fields
 * and who added them, as the task page's strip says a task's day and cadence. From the viewer-safe summary (`GET /people/{id}/summary`,
 * the read "Shared with" makes too), so it appears once that read has answered and says nothing before; an unsent person has none.
 */
export function PersonFacts({
  personId,
  projected,
}: {
  personId: string;
  projected: boolean;
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
  const cells: Array<{ key: string; label: string; value: string }> = [
    {
      key: "linked",
      label: copy.FACTS.linked,
      value:
        summary.linkage === "you"
          ? copy.FACT_LINK_SELF
          : summary.linkage === "other"
            ? copy.FACT_LINK_OTHER
            : copy.FACT_LINK_NONE,
    },
    {
      key: "visible",
      label: copy.FACTS.visibleTo,
      value: audienceText(summary.audience),
    },
    {
      key: "fields",
      label: copy.FACTS.fields,
      value: String(summary.field_count),
    },
    ...(added === null
      ? []
      : [{ key: "added", label: copy.FACTS.added, value: added }]),
  ];
  return (
    <dl
      className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border bg-border tablet:grid-cols-4"
      data-person-facts=""
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="flex min-h-[72px] flex-col justify-center gap-1 bg-card px-4 py-3"
          data-fact={cell.key}
        >
          <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {cell.label}
          </dt>
          <dd className="m-0 text-sm font-medium text-foreground">
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
