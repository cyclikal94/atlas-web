import { Link, useNavigate } from "@tanstack/react-router";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { Button } from "../../../components/ui/button";
import { useCachedResource } from "../../../data";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import { isMergedAlias } from "../model/requests";
import { usePersonLinkage } from "../reads";
import { peopleSlots } from "../slots";
import * as copy from "./copy";
import { draftOf, NEW_REQUEST_KEY } from "./NewRequest";
import { currentOf, useIncoming, usePersonSummary } from "./reads";

/**
 * WEB-11b's entry points, in the people chunk (`screens.tsx` imports this module):
 *
 *  - `RequestsEntry`: People 01's header "Requests" with the waiting count (desktop), and the mobile "N requests waiting for you →"
 *    banner (drawn only when N ≥ 1). The count is the latest successful read of the incoming requests: "99+" above 99, and NOTHING while
 *    unknown, offline or failed ("0" is never claimed without a read).
 *  - `fillPeopleSlots()`: the detail's `headerActions` ("Ask to link…", only for a person known to be unlinked and known to be the reader's
 *    own; disabled with the reason while either is unknown; absent when linked; never inferred), the merged alias's note (D-11b-12), and
 *    the duplicates' `duplicateActions` ("Compare & merge"). Filled ONCE, when this module is evaluated: before any people screen renders
 *    (WEB-11a's contract), and without anything in the first load (D-11b-2).
 */
export function RequestsEntry() {
  const env = usePeopleEnv();
  const mode = useLayoutMode();
  const view = useIncoming(env);
  const shown =
    currentOf(view) ?? (view.status === "loading" ? view.previous : null);
  const count = shown?.value.ok ? shown.value.value.length : null;
  if (mode !== "desktop")
    return count === null || count < 1 ? null : (
      <Link
        to="/people/requests"
        data-requests-banner=""
        className="atlas-transition flex min-h-11 items-center justify-between gap-2 rounded-row border border-hairline-strong bg-panel px-3 text-[13.5px] text-ink-1 hover:bg-row-hover"
      >
        <span>{copy.REQUESTS_WAITING(count)}</span>
        <span aria-hidden="true">→</span>
      </Link>
    );
  return (
    <Link
      to="/people/requests"
      data-people-action="requests"
      className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
    >
      {copy.REQUESTS}
      {count === null ? null : (
        <span className="font-num text-ink-2" data-requests-count="">
          {copy.countText(count)}
        </span>
      )}
    </Link>
  );
}

/** "Ask to link…" on a person's detail (§4.5): opens the form with the person chosen. */
function LinkEntry({ env, personId }: { env: PeopleEnv; personId: string }) {
  const navigate = useNavigate();
  const { linkage } = usePersonLinkage(personId);
  const summary =
    currentOf(usePersonSummary(env, personId))?.value.summary ?? null;
  if (linkage.known && linkage.kind !== "unlinked") return null;
  if (summary !== null && (summary.your_access !== "owner" || summary.archived))
    return null;
  if (!linkage.known || summary === null)
    return (
      <Button disabled reason={copy.CHECK_LINK_FIRST}>
        {copy.ASK_TO_LINK_ENTRY}
      </Button>
    );
  return (
    <Button
      data-people-action="ask-to-link"
      onClick={() => {
        const draft = draftOf(env);
        env.memory.drafts.set(NEW_REQUEST_KEY, {
          ...draft,
          mode: "link",
          link: {
            ...draft.link,
            person: { id: personId, label: summary.label },
          },
          revision: draft.revision + 1,
        });
        env.memory.touch();
        void navigate({ to: "/people/requests" });
      }}
    >
      {copy.ASK_TO_LINK_ENTRY}
    </Button>
  );
}

/** A merged alias (D-11b-12): "Merged into {name}", linked to the canonical person when this device holds them. */
function MergedNote({ canonicalId }: { canonicalId: string }) {
  const canonical = useCachedResource(canonicalId);
  const row =
    canonical.status === "ready" && canonical.value.merged?.kind === "person"
      ? canonical.value.merged
      : null;
  if (row === null)
    return (
      <span className="text-[13px] text-ink-2" data-merged-alias={canonicalId}>
        {copy.MERGED_ALIAS(copy.ANOTHER_PERSON)}
      </span>
    );
  return (
    <Link
      to="/people/$personId"
      params={{ personId: canonicalId }}
      data-merged-alias={canonicalId}
      className="atlas-transition inline-flex min-h-11 items-center text-[13.5px] text-ink-1 underline hover:text-ink-2"
    >
      {copy.MERGED_ALIAS(row.label)}
    </Link>
  );
}

function PersonActions({ personId }: { personId: string }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const cached = useCachedResource(personId);
  const row = cached.status === "ready" ? cached.value.merged : null;
  if (row === null || row.kind !== "person") return null;
  const canonical = isMergedAlias(row);
  if (canonical !== null) return <MergedNote canonicalId={canonical} />;
  if (row.archived) return null;
  return <LinkEntry env={env} personId={personId} />;
}

function CompareEntry({
  personId,
  otherId,
}: {
  personId: string;
  otherId: string;
}) {
  return (
    <Link
      to="/people/$personId/duplicates/$otherId"
      params={{ personId, otherId }}
      data-people-action="compare-and-merge"
      className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-control bg-action-fill px-4 text-[13.5px] font-medium text-action-on hover:bg-action-hover"
    >
      {copy.COMPARE_AND_MERGE}
    </Link>
  );
}

/** Fills the detail's and the duplicates' slots (D-11b-2); called once, when this module is evaluated. */
export function fillPeopleSlots(): void {
  peopleSlots.headerActions = (personId) => (
    <PersonActions personId={personId} />
  );
  peopleSlots.duplicateActions = (personId, otherId) => (
    <CompareEntry personId={personId} otherId={otherId} />
  );
}
fillPeopleSlots();
