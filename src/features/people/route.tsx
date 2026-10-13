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
 * (`peopleSlots`); WEB-11a renders nothing in them.
 */
export { peopleSlots } from "./slots";

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
  return people.addChildren([
    index,
    person.addChildren([personIndex, newField, editField]),
    duplicates,
  ]);
};
