import {
  type AnyRoute,
  createRoute,
  Link,
  Outlet,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import * as copy from "./copy";
import { PersonDetail, type PersonDetailSlots } from "./detail/PersonDetail";
import { DuplicatesView } from "./duplicates/DuplicatesView";
import { PeopleBoundary } from "./env";
import { FieldEditorDialog } from "./field/FieldEditorDialog";
import { PeopleList } from "./list/PeopleList";

/**
 * The People routes (§3.2): `/people` (the list), `/people/$personId` (the detail: beside the list from 1280 px, alone below it, D-11a-16),
 * `/people/$personId/duplicates` (a single column), and the field editor over the detail, `/people/$personId/fields/new` and
 * `/people/$personId/fields/$fieldId` (route-addressed, so a remount of the protected tree reopens it with its draft).
 *
 * WEB-11b fills the detail's slots (`peopleSlots`); WEB-11a renders nothing in them.
 */
export const peopleSlots: PersonDetailSlots = {};

export const personPath = (id: string): string =>
  `/people/${encodeURIComponent(id)}`;
export const duplicatesPath = (id: string): string =>
  `${personPath(id)}/duplicates`;

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A People route that is a page of its own: the list is not drawn beside it. */
    peopleFullPage?: boolean;
  }
}

function PeopleLayout() {
  // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
  if (useOptionalDataEnv() === null)
    return <PageHeading>{copy.PAGE_TITLE}</PageHeading>;
  return (
    <PeopleBoundary>
      <PeopleScreens />
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

function PeopleScreens() {
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

export const peopleRoute = (parent: AnyRoute) => {
  const people = createRoute({
    getParentRoute: () => parent,
    path: "people",
    component: PeopleLayout,
  });
  const index = createRoute({ getParentRoute: () => people, path: "/" });
  const person = createRoute({
    getParentRoute: () => people,
    path: "$personId",
    component: function PersonRoute() {
      const { personId } = person.useParams();
      const mode = useLayoutMode();
      return (
        <PersonDetail
          personId={personId}
          asPage={mode !== "desktop"}
          slots={peopleSlots}
        >
          <Outlet />
        </PersonDetail>
      );
    },
  });
  const personIndex = createRoute({ getParentRoute: () => person, path: "/" });
  const newField = createRoute({
    getParentRoute: () => person,
    path: "fields/new",
    staticData: { dialog: true },
    component: function NewFieldRoute() {
      const { personId } = newField.useParams();
      const navigate = useNavigate();
      return (
        <FieldEditorDialog
          personId={personId}
          fieldId={null}
          onClose={() =>
            void navigate({ to: "/people/$personId", params: { personId } })
          }
        />
      );
    },
  });
  const editField = createRoute({
    getParentRoute: () => person,
    path: "fields/$fieldId",
    staticData: { dialog: true },
    component: function EditFieldRoute() {
      const { personId, fieldId } = editField.useParams();
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
    },
  });
  const duplicates = createRoute({
    getParentRoute: () => people,
    path: "$personId/duplicates",
    staticData: { peopleFullPage: true },
    component: function DuplicatesRoute() {
      const { personId } = duplicates.useParams();
      return (
        <DuplicatesView
          personId={personId}
          {...(peopleSlots.duplicateActions
            ? { duplicateActions: peopleSlots.duplicateActions }
            : {})}
        />
      );
    },
  });
  return people.addChildren([
    index,
    person.addChildren([personIndex, newField, editField]),
    duplicates,
  ]);
};
