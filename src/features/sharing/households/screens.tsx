import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { Button } from "../../../components/ui/button";
import { useSharingDefaults } from "../../../data";
import * as copy from "./copy";
import { HouseholdsBoundary } from "./env";
import { HouseholdDetail } from "./HouseholdDetail";
import { HouseholdsPane } from "./HouseholdsPane";
import { InvitationsDialog } from "./InvitationsDialog";
import { listOf } from "./memory";
import { byName } from "./model";
import { NewHouseholdDialog, RenameDialog } from "./NameDialogs";
import {
  householdPath,
  invitationsPath,
  NEW_PATH,
  UnresolvedBanner,
  useAsk,
  useHouseholds,
} from "./parts";
import { SignupDialog } from "./SignupDialog";

/**
 * WEB-12b's household screens (D-12b-1), ONE lazy chunk loaded by the sharing routes (`../route.tsx`): the first load carries only their
 * route definitions (D-12b-11). Every dialog is route-addressed (a `403` remounts the protected tree and reopens it), and everything it
 * needs across that remount is in the households page memory (`memory.ts`).
 */

const ACTION =
  "atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover";

/** The selected household of a route (its `$householdId`), or null. */
export function useRouteHousehold(): string | null {
  const matches = useMatches();
  for (const match of matches) {
    const id = (match.params as { householdId?: string } | undefined)
      ?.householdId;
    if (id !== undefined) return id;
  }
  return null;
}

/** The page header's actions: Invitations (n) (works with zero households; disabled offline), Default sharing, New household. */
export function HouseholdsActions() {
  return (
    <HouseholdsBoundary>
      <Actions />
    </HouseholdsBoundary>
  );
}

function Actions() {
  const { env, memory, ctx } = useHouseholds();
  useAsk(ctx, env.online, ["invitations"]);
  const count =
    memory.invitations.last?.value.filter((i) => i.status === "pending")
      .length ?? null;
  return (
    <div className="flex flex-wrap items-start gap-2" data-sharing-actions="">
      {env.online ? (
        <Link
          to={invitationsPath() as never}
          className={ACTION}
          data-sharing-link="invitations"
        >
          {copy.INVITATIONS_ACTION(count)}
        </Link>
      ) : (
        <Button disabled reason={copy.NEEDS_CONNECTION}>
          {copy.INVITATIONS_ACTION(count)}
        </Button>
      )}
      <Link
        to="/sharing/defaults"
        search={{ kind: "person" }}
        className={ACTION}
        data-sharing-link="default-sharing"
      >
        {copy.DEFAULT_SHARING_ACTION}
      </Link>
      <Link
        to={NEW_PATH as never}
        className={`${ACTION} border-transparent bg-action-fill font-medium text-action-on hover:bg-action-hover`}
        data-sharing-link="new-household"
      >
        {copy.NEW_HOUSEHOLD_ACTION}
      </Link>
    </div>
  );
}

/**
 * The households pane and the detail. From 1280 px the pane (280 px) sits beside the detail of the selected household (the route's, else
 * the main household if listed, else the first by name); below 1280 px the pane alone, and a household's route shows its detail alone
 * with "‹ Households" (the WEB-10b D-10b-2 rule).
 */
export function HouseholdsRegion({ dialogOpen }: { dialogOpen: boolean }) {
  return (
    <HouseholdsBoundary>
      <Region dialogOpen={dialogOpen} />
    </HouseholdsBoundary>
  );
}

function Region({ dialogOpen }: { dialogOpen: boolean }) {
  const { env, memory, ctx } = useHouseholds();
  const defaults = useSharingDefaults();
  const mode = useLayoutMode();
  const routeId = useRouteHousehold();
  useAsk(ctx, env.online, ["households", "invitations"]);
  const record = defaults.record;
  const primaryId = record?.snapshot.defaults.primary_household_id ?? null;
  const now = env.now();
  const list = listOf(memory);
  const implicit =
    routeId ??
    (list === null
      ? null
      : (list.find((h) => h.id === primaryId)?.id ??
        [...list].sort(byName)[0]?.id ??
        null));
  const pane = (
    <HouseholdsPane
      ctx={ctx}
      online={env.online}
      now={now}
      selectedId={mode === "desktop" ? implicit : routeId}
      primaryId={primaryId}
      snapshot={
        record === null
          ? null
          : { list: record.snapshot.households, at: record.fetched_at }
      }
    />
  );
  const banner = dialogOpen ? null : <UnresolvedBanner ctx={ctx} />;
  const detail = (id: string) => (
    <HouseholdDetail
      key={id}
      ctx={ctx}
      householdId={id}
      online={env.online}
      now={now}
      record={record}
      withoutPane={mode !== "desktop"}
    />
  );
  if (mode === "desktop")
    return (
      <div className="flex flex-col gap-4" data-households-region="desktop">
        {banner}
        <div
          className="grid gap-6"
          style={{ gridTemplateColumns: "280px minmax(0, 1fr)" }}
        >
          {pane}
          <div className="min-w-0" data-households-detail-column="">
            {
              // No household to show (the list is loading, failed, empty, or only B5's unlinked subset is shown offline): nothing to
              // choose, so nothing is said here; the pane beside it says what the list is (review 1 F-R1-4).
              implicit === null ? null : detail(implicit)
            }
          </div>
        </div>
      </div>
    );
  if (routeId !== null)
    return (
      <div className="flex flex-col gap-3" data-households-region="detail">
        <Link
          to="/sharing"
          className="atlas-transition inline-flex min-h-11 w-fit items-center gap-1.5 text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          {copy.BACK_TO_HOUSEHOLDS}
        </Link>
        {banner}
        {detail(routeId)}
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-households-region="list">
      {banner}
      {pane}
    </div>
  );
}

// ---- the route-addressed dialogs ---------------------------------------------------------------------------------------------------
export function NewHouseholdScreen() {
  return (
    <HouseholdsBoundary>
      <NewScreen />
    </HouseholdsBoundary>
  );
}
function NewScreen() {
  const { env, ctx } = useHouseholds();
  const navigate = useNavigate();
  return (
    <NewHouseholdDialog
      ctx={ctx}
      online={env.online}
      onClose={() => void navigate({ to: "/sharing" })}
    />
  );
}

export function RenameScreen({ householdId }: { householdId: string }) {
  return (
    <HouseholdsBoundary>
      <Rename householdId={householdId} />
    </HouseholdsBoundary>
  );
}
function Rename({ householdId }: { householdId: string }) {
  const { env, ctx } = useHouseholds();
  const navigate = useNavigate();
  return (
    <RenameDialog
      ctx={ctx}
      householdId={householdId}
      online={env.online}
      onClose={() => void navigate({ to: householdPath(householdId) as never })}
    />
  );
}

export function InvitationsScreen({
  householdId,
}: {
  householdId: string | null;
}) {
  return (
    <HouseholdsBoundary>
      <Invitations householdId={householdId} />
    </HouseholdsBoundary>
  );
}
function Invitations({ householdId }: { householdId: string | null }) {
  const { env, ctx } = useHouseholds();
  const navigate = useNavigate();
  return (
    <InvitationsDialog
      ctx={ctx}
      householdId={householdId}
      online={env.online}
      now={env.now()}
      onClose={() =>
        void navigate({
          to: (householdId === null
            ? "/sharing"
            : householdPath(householdId)) as never,
        })
      }
    />
  );
}

export function SignupScreen({ householdId }: { householdId: string }) {
  return (
    <HouseholdsBoundary>
      <Signup householdId={householdId} />
    </HouseholdsBoundary>
  );
}
function Signup({ householdId }: { householdId: string }) {
  const { env, ctx } = useHouseholds();
  const navigate = useNavigate();
  return (
    <SignupDialog
      ctx={ctx}
      householdId={householdId}
      online={env.online}
      now={env.now()}
      onClose={() => void navigate({ to: householdPath(householdId) as never })}
    />
  );
}
