import { Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Eyebrow, PageHeader } from "../../components/ui/page-header";
import { PageHeading } from "../../components/ui/page-heading";
import * as copy from "./copy";
import { PersonDetail } from "./detail/PersonDetail";
import { DuplicatesView } from "./duplicates/DuplicatesView";
import { PeopleBoundary } from "./env";
import { FieldEditorDialog } from "./field/FieldEditorDialog";
import { PeopleList } from "./list/PeopleList";
// WEB-11b: evaluating this module fills the detail's and the duplicates' slots (D-11b-2) before any people screen renders.
import { RequestsEntry } from "./requests/entries";
import { peopleSlots } from "./slots";
import { useSummaryFreshness } from "./summaries";

/**
 * The People screens, loaded LAZILY by their routes (`route.tsx`): one chunk, never part of an initial bundle (the fixture's entry includes
 * the protected tree statically, and its initial-chunk budget has no room for them).
 */

export function PeopleScreens() {
  return (
    <PeopleBoundary>
      <PeopleLayout />
    </PeopleBoundary>
  );
}

/** The page's header (the Final design): the eyebrow, the title, one summary line, and the way to the requests at the right. */
function ListHeader() {
  return (
    <PageHeader
      eyebrow={<Eyebrow>{copy.PAGE_TITLE}</Eyebrow>}
      title={<PageHeading>{copy.PAGE_TITLE}</PageHeading>}
      summary={copy.PAGE_SUBHEAD}
      // WEB-11b: "Requests" with the waiting count (every layout), and the "N requests waiting for you" banner (below 1280 px).
      actions={<RequestsEntry />}
    />
  );
}

function PeopleLayout() {
  // The viewer-safe summaries shown anywhere below are read again when anything they depend on may have changed (finding 8).
  useSummaryFreshness();
  const matches = useMatches();
  const leaf = matches.at(-1);
  const personId =
    (leaf?.params as { personId?: string } | undefined)?.personId ?? null;
  // A page of its own: the duplicates (and "Compare & merge" over them) and WEB-11b's Requests (and its dialogs).
  if (
    matches.some(
      (match) =>
        match.staticData?.peopleFullPage ||
        match.routeId === "/people/requests",
    )
  )
    return <Outlet />;
  // The Final design: the people take the page, and a person is a page of their own at every width (the detail draws its breadcrumb;
  // on the phone the shell's header carries the way back).
  if (personId !== null) return <Outlet />;
  return (
    <div className="flex flex-col gap-5">
      <ListHeader />
      <PeopleList selectedId={null} />
    </div>
  );
}

export function PersonScreen({
  personId,
  children,
}: {
  personId: string;
  children: ReactNode;
}) {
  return (
    // Keyed: everything on a person's screen (an open rename and its typed name, the fields' step, the held changes' runs) belongs to
    // ONE person; another person's route mounts a new screen (finding 4 of the review of 13 October).
    <PersonDetail key={personId} personId={personId} asPage slots={peopleSlots}>
      {children}
    </PersonDetail>
  );
}

export function FieldEditorScreen({
  personId,
  fieldId,
}: {
  personId: string;
  fieldId: string | null;
}) {
  const navigate = useNavigate();
  return (
    <FieldEditorDialog
      personId={personId}
      fieldId={fieldId}
      onClose={() =>
        void navigate({ to: "/people/$personId", params: { personId } })
      }
    />
  );
}

export function DuplicatesScreen({ personId }: { personId: string }) {
  return (
    <>
      {/* Keyed: a duplicates view's pages, its first-page flag and its reads belong to ONE person (finding 4). */}
      <DuplicatesView
        key={personId}
        personId={personId}
        {...(peopleSlots.duplicateActions
          ? { duplicateActions: peopleSlots.duplicateActions }
          : {})}
      />
      {/* WEB-11b's "Compare & merge" over the duplicates (`$personId/duplicates/$otherId`). */}
      <Outlet />
    </>
  );
}

// Settings → "Archived items" (`archived/section.tsx`) is served from this chunk too.
export { ArchivedItems } from "./archived/ArchivedItems";
/**
 * WEB-11b's screens (D-11b-1), served from THIS chunk. A chunk of their own was measured (2 November 2026): any module the two lazy chunks
 * share (the summaries, the env, the parts) made the bundler move ten shared modules (the button, dialog, input, list, router link, the
 * sharing editors…) out of the fixture entry into separate initial chunks, +5.3 KB of first-load gzip; served from here, the first load
 * carries only their route definitions.
 */
export { default as RequestsRoutes } from "./requests/screens";
