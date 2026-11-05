import {
  Outlet,
  useMatch,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { RecipientReview, SenderMerge } from "./MergeDialog";
import { RequestsScreen } from "./RequestsScreen";

/**
 * WEB-11b's screens (in the people chunk, `../screens.tsx`), behind ONE lazy component shared by its four routes (D-11b-1, `route.tsx`): each route renders this
 * component, which picks its screen by the route it is rendered for. Each dialog is keyed by what it shows, so another request or pair is
 * another dialog with its own state (kept in page memory: a `403` remount reopens it as it was).
 */
export default function RequestsRoutes() {
  const match = useMatch({ strict: false });
  const params = useParams({ strict: false }) as Record<
    string,
    string | undefined
  >;
  const navigate = useNavigate();
  const toRequests = () => void navigate({ to: "/people/requests" });
  switch (match.routeId) {
    case "/people/requests":
      return (
        <>
          <RequestsScreen />
          <Outlet />
        </>
      );
    case "/people/requests/$requestId": {
      const requestId = params.requestId as string;
      return (
        <RecipientReview
          key={requestId}
          requestId={requestId}
          onClose={toRequests}
        />
      );
    }
    case "/people/requests/merge/$sourceId/$targetId": {
      const sourceId = params.sourceId as string;
      const targetId = params.targetId as string;
      return (
        <SenderMerge
          key={`${sourceId}:${targetId}`}
          sourceId={sourceId}
          targetId={targetId}
          onClose={toRequests}
        />
      );
    }
    case "/people/$personId/duplicates/$otherId": {
      // "Compare & merge" from a duplicate hint: the page's person is kept (the target), the hint merged into it.
      const personId = params.personId as string;
      const otherId = params.otherId as string;
      return (
        <SenderMerge
          key={`${otherId}:${personId}`}
          sourceId={otherId}
          targetId={personId}
          onClose={() =>
            void navigate({
              to: "/people/$personId/duplicates",
              params: { personId },
            })
          }
        />
      );
    }
    default:
      return null;
  }
}
