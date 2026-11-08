import { type AnyRoute, createRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { PAGE_TITLE } from "./titles";

/**
 * The People routes (§3.2): `/people` (the list), `/people/$personId` (the detail: beside the list from 1280 px, alone below it, D-11a-16),
 * `/people/$personId/duplicates` (a single column), and the field editor over the detail, `/people/$personId/fields/new` and
 * `/people/$personId/fields/$fieldId` (route-addressed, so a remount of the protected tree reopens it with its draft).
 *
 * The screens are one lazy chunk (`screens.tsx`): this module imports only what the router needs. WEB-11b fills the detail's slots
 * (`peopleSlots`) from that chunk; WEB-11a renders nothing in them.
 *
 * WEB-11b (D-11b-1): `/people/requests` (WF-PEOPLE-06, a page of its own) with two dialogs over it, the recipient's review of a merge
 * request (`requests/$requestId`) and a merge chosen in "Ask to merge" (`requests/merge/$sourceId/$targetId`), and "Compare & merge" over
 * the duplicates (`$personId/duplicates/$otherId`: the page's person is kept). Every one is route-addressed (a `403` remounts the tree and
 * reopens it with its state from page memory). Their screens are in the people chunk (`screens.tsx` says why not a chunk of their own).
 */
export { peopleSlots } from "./slots";

export const personPath = (id: string): string =>
  `/people/${encodeURIComponent(id)}`;
export const duplicatesPath = (id: string): string =>
  `${personPath(id)}/duplicates`;
export const requestsPath = (): string => "/people/requests";
/** "Compare & merge": `otherId` merged into `personId` (the person kept). */
export const mergePath = (personId: string, otherId: string): string =>
  `${duplicatesPath(personId)}/${encodeURIComponent(otherId)}`;

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A People route that is a page of its own: the list is not drawn beside it. */
    peopleFullPage?: boolean;
  }
}

const screens = () => import("./screens");
const PeopleScreens = lazy(() =>
  screens().then((m) => ({ default: m.PeopleScreens })),
);
const PersonScreen = lazy(() =>
  screens().then((m) => ({ default: m.PersonScreen })),
);
const FieldEditorScreen = lazy(() =>
  screens().then((m) => ({ default: m.FieldEditorScreen })),
);
const DuplicatesScreen = lazy(() =>
  screens().then((m) => ({ default: m.DuplicatesScreen })),
);
// WEB-11b's four routes share ONE lazy component from the people chunk (`requests/screens.tsx` picks the screen by its own match): the
// first load carries only their definitions.
const Requests = lazy(() =>
  screens().then((m) => ({ default: m.RequestsRoutes })),
);
const dialog = { dialog: true };

function PeopleLayout() {
  // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
  if (useOptionalDataEnv() === null)
    return <PageHeading>{PAGE_TITLE}</PageHeading>;
  return (
    <Suspense fallback={null}>
      <PeopleScreens />
    </Suspense>
  );
}

const PERSON_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const peopleRoute = (parent: AnyRoute) => {
  const people = createRoute({
    getParentRoute: () => parent,
    path: "people",
    // A person opened beside the people in the chosen container (Settings · Layout, "How things open"): `?person=<id>`.
    validateSearch: (search: Record<string, unknown>): { person?: string } => ({
      ...(typeof search.person === "string" && PERSON_ID.test(search.person)
        ? { person: search.person }
        : {}),
    }),
    component: PeopleLayout,
  });
  const index = createRoute({ getParentRoute: () => people, path: "/" });
  const person = createRoute({
    getParentRoute: () => people,
    path: "$personId",
    component: function PersonRoute() {
      const { personId } = person.useParams();
      return (
        <Suspense fallback={null}>
          <PersonScreen personId={personId}>
            <Outlet />
          </PersonScreen>
        </Suspense>
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
      return (
        <Suspense fallback={null}>
          <FieldEditorScreen personId={personId} fieldId={null} />
        </Suspense>
      );
    },
  });
  const editField = createRoute({
    getParentRoute: () => person,
    path: "fields/$fieldId",
    staticData: { dialog: true },
    component: function EditFieldRoute() {
      const { personId, fieldId } = editField.useParams();
      return (
        <Suspense fallback={null}>
          <FieldEditorScreen personId={personId} fieldId={fieldId} />
        </Suspense>
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
        <Suspense fallback={null}>
          <DuplicatesScreen personId={personId} />
        </Suspense>
      );
    },
  });
  const compare = createRoute({
    getParentRoute: () => duplicates,
    path: "$otherId",
    staticData: dialog,
    component: Requests,
    wrapInSuspense: true,
  });
  const requestsPage = createRoute({
    getParentRoute: () => people,
    path: "requests",
    component: Requests,
    wrapInSuspense: true,
  });
  const review = createRoute({
    getParentRoute: () => requestsPage,
    path: "$requestId",
    staticData: dialog,
    component: Requests,
    wrapInSuspense: true,
  });
  const merge = createRoute({
    getParentRoute: () => requestsPage,
    path: "merge/$sourceId/$targetId",
    staticData: dialog,
    component: Requests,
    wrapInSuspense: true,
  });
  return people.addChildren([
    index,
    requestsPage.addChildren([review, merge]),
    person.addChildren([personIndex, newField, editField]),
    duplicates.addChildren([compare]),
  ]);
};
