import {
  type AnyRoute,
  createRoute,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
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
 */
export const sharingItemPath = (resourceId: string): string =>
  `/sharing/items/${encodeURIComponent(resourceId)}`;

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
  return sharing.addChildren([index, defaults, item]);
};
