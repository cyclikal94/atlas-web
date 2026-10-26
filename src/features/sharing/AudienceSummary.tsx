import { useId } from "react";
import * as copy from "./copy";
import type { Audience, Person } from "./model/audience";

/**
 * The effective visibility of the policy being edited (WF-SHARING-04's "Effective visibility once saved"), computed from the in-progress
 * edits, never only the saved state. A display: it names its read time and says that the server checks membership live.
 */
export function AudienceSummary({
  audience,
  membersAsOf,
  parentLabel,
}: {
  audience: Audience;
  /** "at 12:04", when the household member lists were read; null when they were not. */
  membersAsOf: string | null;
  parentLabel: string | null;
}) {
  const heading = useId();
  const names = (people: Person[]) => people.map((p) => p.label).join(", ");
  const nobody =
    audience.readers.length === 0 &&
    audience.editors.length === 0 &&
    audience.unknownHouseholds.length === 0 &&
    audience.uncheckedHouseholds.length === 0;
  return (
    <section
      aria-labelledby={heading}
      data-audience=""
      className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3.5 text-sm leading-relaxed text-foreground"
    >
      <h3 id={heading} className="text-sm font-medium">
        {copy.EFFECTIVE_HEADING}
      </h3>
      <p data-audience-owner="">{copy.OWNER(audience.owner.label)}</p>
      {nobody ? <p data-audience-nobody="">{copy.NOBODY_ELSE}</p> : null}
      {audience.editors.length > 0 ? (
        <p data-audience-editors="">
          {copy.EDITORS}: {names(audience.editors)}
        </p>
      ) : null}
      {audience.readers.length > 0 ? (
        <p data-audience-readers="">
          {copy.READERS}: {names(audience.readers)}
        </p>
      ) : null}
      {audience.unknownHouseholds.length > 0 ? (
        <p data-audience-unknown="">
          {copy.UNKNOWN_HOUSEHOLDS(audience.unknownHouseholds.length)}
        </p>
      ) : null}
      {audience.uncheckedHouseholds.length > 0 ? (
        <p data-audience-unchecked="">
          {copy.UNCHECKED_HOUSEHOLDS(audience.uncheckedHouseholds.length)}
        </p>
      ) : null}
      {audience.excluded.length > 0 ? (
        <p data-audience-excluded="">
          {copy.EXCLUDED_PEOPLE}: {names(audience.excluded)}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{copy.OWNER_KEEPS}</p>
      {audience.parentLimited ? (
        <p className="text-xs text-muted-foreground" data-audience-parent="">
          {copy.PARENT_LIMITED(parentLabel ?? copy.PARENT_UNNAMED)}
        </p>
      ) : null}
      {membersAsOf ? (
        <p className="text-xs text-muted-foreground">
          {copy.MEMBERS_AS_OF(membersAsOf)}
        </p>
      ) : null}
    </section>
  );
}
