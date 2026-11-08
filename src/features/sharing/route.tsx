import {
  type AnyRoute,
  createRoute,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import {
  TEMPLATE_KINDS,
  type TemplateKind,
  useOptionalDataEnv,
} from "../../data";
import { PAGE_TITLE } from "./copy";
import { DefaultsEditor } from "./DefaultsEditor";
import { SharingBoundary } from "./env";
import { ResourcePolicyEditor } from "./ResourcePolicyEditor";
import { SharingPage } from "./SharingPage";

/**
 * The Sharing routes (D-12a-7): `/sharing` (the page), `/sharing/defaults?kind=…` (WF-SHARING-03 as a dialog over it) and
 * `/sharing/items/<id>` (WF-SHARING-04 over it: a deep link WEB-10/11 may use instead of embedding the editor). The directory lookup is a
 * view inside those dialogs, not a route.
 *
 * WEB-12b (D-12b-1): `/sharing/households/$householdId` (a household's detail: beside the list from 1280 px, alone below it), and the
 * route-addressed household dialogs over the page: `/sharing/new`, `/sharing/invitations` (header-level, works with zero households),
 * `/sharing/households/$householdId/{rename,invitations,signup}`. A `403` remounts the protected tree; a route reopens its dialog with its
 * state from page memory. Their screens are ONE lazy chunk (`households/screens.tsx`): this module imports only what the router needs.
 */
export const sharingItemPath = (resourceId: string): string =>
  `/sharing/items/${encodeURIComponent(resourceId)}`;
export const householdPath = (id: string): string =>
  `/sharing/households/${encodeURIComponent(id)}`;
export const invitationsPath = (id?: string): string =>
  id === undefined
    ? "/sharing/invitations"
    : `${householdPath(id)}/invitations`;

const screens = () => import("./households/screens");
const NewHouseholdScreen = lazy(() =>
  screens().then((m) => ({ default: m.NewHouseholdScreen })),
);
const RenameScreen = lazy(() =>
  screens().then((m) => ({ default: m.RenameScreen })),
);
const InvitationsScreen = lazy(() =>
  screens().then((m) => ({ default: m.InvitationsScreen })),
);
const SignupScreen = lazy(() =>
  screens().then((m) => ({ default: m.SignupScreen })),
);
const dialog = { dialog: true };

const isKind = (value: unknown): value is TemplateKind =>
  typeof value === "string" &&
  (TEMPLATE_KINDS as readonly string[]).includes(value);

function SharingLayout() {
  // A shell rendered without the data layer (the shell's own tests) shows the destination's heading and no account data.
  if (useOptionalDataEnv() === null)
    return <PageHeading>{PAGE_TITLE}</PageHeading>;
  return (
    <SharingBoundary>
      <SharingPage />
      <Outlet />
    </SharingBoundary>
  );
}

export const sharingRoute = (parent: AnyRoute) => {
  const sharing = createRoute({
    getParentRoute: () => parent,
    path: "sharing",
    component: SharingLayout,
  });
  const index = createRoute({ getParentRoute: () => sharing, path: "/" });
  const defaults = createRoute({
    getParentRoute: () => sharing,
    path: "defaults",
    validateSearch: (
      search: Record<string, unknown>,
    ): { kind: TemplateKind } => ({
      kind: isKind(search.kind) ? search.kind : "person",
    }),
    component: function DefaultsRoute() {
      const navigate = useNavigate();
      const { kind } = defaults.useSearch();
      return (
        <DefaultsEditor
          kind={kind}
          onKindChange={(next) =>
            void navigate({
              to: "/sharing/defaults",
              search: { kind: next },
              replace: true,
            })
          }
          onClose={() => void navigate({ to: "/sharing" })}
        />
      );
    },
  });
  const item = createRoute({
    getParentRoute: () => sharing,
    path: "items/$resourceId",
    component: function ItemRoute() {
      const navigate = useNavigate();
      const { resourceId } = item.useParams();
      return (
        <ResourcePolicyEditor
          resourceId={resourceId}
          open
          onOpenChange={(open) => {
            if (!open) void navigate({ to: "/sharing" });
          }}
        />
      );
    },
  });
  const create = createRoute({
    getParentRoute: () => sharing,
    path: "new",
    staticData: dialog,
    component: () => (
      <Suspense fallback={null}>
        <NewHouseholdScreen />
      </Suspense>
    ),
  });
  const invitations = createRoute({
    getParentRoute: () => sharing,
    path: "invitations",
    staticData: dialog,
    component: () => (
      <Suspense fallback={null}>
        <InvitationsScreen householdId={null} />
      </Suspense>
    ),
  });
  // The detail itself is drawn by the page (it is beside the list from 1280 px); its route only addresses it and its dialogs.
  const household = createRoute({
    getParentRoute: () => sharing,
    path: "households/$householdId",
  });
  const householdIndex = createRoute({
    getParentRoute: () => household,
    path: "/",
  });
  const rename = createRoute({
    getParentRoute: () => household,
    path: "rename",
    staticData: dialog,
    component: function RenameRoute() {
      const { householdId } = rename.useParams();
      return (
        <Suspense fallback={null}>
          <RenameScreen householdId={householdId} />
        </Suspense>
      );
    },
  });
  const householdInvitations = createRoute({
    getParentRoute: () => household,
    path: "invitations",
    staticData: dialog,
    component: function HouseholdInvitationsRoute() {
      const { householdId } = householdInvitations.useParams();
      return (
        <Suspense fallback={null}>
          <InvitationsScreen householdId={householdId} />
        </Suspense>
      );
    },
  });
  const signup = createRoute({
    getParentRoute: () => household,
    path: "signup",
    staticData: dialog,
    component: function SignupRoute() {
      const { householdId } = signup.useParams();
      return (
        <Suspense fallback={null}>
          <SignupScreen householdId={householdId} />
        </Suspense>
      );
    },
  });
  return sharing.addChildren([
    index,
    defaults,
    item,
    create,
    invitations,
    household.addChildren([
      householdIndex,
      rename,
      householdInvitations,
      signup,
    ]),
  ]);
};
