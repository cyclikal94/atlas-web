import { Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { PageHeading } from "../../components/ui/page-heading";
import * as copy from "./copy";
import { PersonDetail } from "./detail/PersonDetail";
import { DuplicatesView } from "./duplicates/DuplicatesView";
import { PeopleBoundary } from "./env";
import { FieldEditorDialog } from "./field/FieldEditorDialog";
import { PeopleList } from "./list/PeopleList";
import { peopleSlots } from "./slots";

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

function ListHeader() {
  return (
    <div className="flex flex-col gap-1">
      <PageHeading>{copy.PAGE_TITLE}</PageHeading>
      <p className="text-[13.5px] text-ink-2">{copy.PAGE_SUBHEAD}</p>
    </div>
  );
}

function PeopleLayout() {
  const mode = useLayoutMode();
  const matches = useMatches();
  const leaf = matches.at(-1);
  const personId =
    (leaf?.params as { personId?: string } | undefined)?.personId ?? null;
  if (leaf?.staticData?.peopleFullPage) return <Outlet />;
  if (mode === "desktop")
    return (
      <div className="flex flex-col gap-5">
        <ListHeader />
        <div className="grid grid-cols-[380px_minmax(0,1fr)] gap-6">
          <PeopleList selectedId={personId} />
          <div className="min-w-0">
            {personId === null ? (
              <p
                className="text-[13.5px] text-ink-2"
                data-people-state="select"
              >
                {copy.SELECT_PERSON}
              </p>
            ) : (
              <Outlet />
            )}
          </div>
        </div>
      </div>
    );
  if (personId !== null)
    return (
      <div className="flex flex-col gap-3">
        <Link
          to="/people"
          className="atlas-transition inline-flex min-h-11 w-fit items-center gap-1.5 text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          {copy.BACK_TO_PEOPLE}
        </Link>
        <Outlet />
      </div>
    );
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
  const mode = useLayoutMode();
  return (
    // Keyed: everything on a person's screen (an open rename and its typed name, the fields' step, the held changes' runs) belongs to
    // ONE person; another person's route mounts a new screen (finding 4 of the review of 13 October).
    <PersonDetail
      key={personId}
      personId={personId}
      asPage={mode !== "desktop"}
      slots={peopleSlots}
    >
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
    // Keyed: a duplicates view's pages, its first-page flag and its reads belong to ONE person (finding 4).
    <DuplicatesView
      key={personId}
      personId={personId}
      {...(peopleSlots.duplicateActions
        ? { duplicateActions: peopleSlots.duplicateActions }
        : {})}
    />
  );
}

// Settings → "Archived items" (`archived/section.tsx`) is served from this chunk too.
export { ArchivedItems } from "./archived/ArchivedItems";
