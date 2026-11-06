import { Link, useMatches, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useId } from "react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import { TEMPLATE_KINDS, useSharingDefaults } from "../../data";
import * as copy from "./copy";
import { useSharingEnv } from "./env";
import { describeTemplate, KIND_LABEL } from "./model/templates";
import { formatWhen } from "./parts";

// WEB-12b: the household screens are one lazy chunk (D-12b-11), never part of the first load.
const screens = () => import("./households/screens");
const HouseholdsActions = lazy(() =>
  screens().then((m) => ({ default: m.HouseholdsActions })),
);
const HouseholdsRegion = lazy(() =>
  screens().then((m) => ({ default: m.HouseholdsRegion })),
);

const SUBTITLE = "Households, and what gets shared by default";

/**
 * The Sharing destination (`/sharing`): WEB-12b's households (WF-SHARING-01, with the header-level Invitations, Default sharing and New
 * household), then the resolved sharing defaults of each resource kind from the B5 snapshot record (one record, never combined with other
 * reads; offline it shows the last snapshot with its time), the entry to WF-SHARING-03, and how a single item's sharing is reached.
 * Below 1280 px a household's route shows its detail alone (with "‹ Households"), so the rest of the page is not drawn under it.
 */
export function SharingPage() {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const mode = useLayoutMode();
  const matches = useMatches();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const heading = useId();
  const items = useId();
  const record = defaults.record;
  const householdRoute = matches.some(
    (match) =>
      (match.params as { householdId?: string } | undefined)?.householdId !==
      undefined,
  );
  const dialogOpen =
    matches.some((match) => match.staticData?.dialog) ||
    /^\/sharing\/(defaults|items\/)/.test(pathname);
  const detailAlone = householdRoute && mode !== "desktop";
  return (
    <div className="flex flex-col gap-8" data-sharing-page="">
      {detailAlone ? (
        // The detail alone (below 1280 px) is still the Sharing page: its level-one heading stays (the household's name is its h2).
        <PageHeading>{copy.PAGE_TITLE}</PageHeading>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <PageHeading>{copy.PAGE_TITLE}</PageHeading>
            <p className="text-[13.5px] text-ink-2">{SUBTITLE}</p>
          </div>
          <Suspense fallback={null}>
            <HouseholdsActions />
          </Suspense>
        </div>
      )}
      <Suspense fallback={null}>
        <HouseholdsRegion dialogOpen={dialogOpen} />
      </Suspense>
      {detailAlone ? null : (
        <div className="flex max-w-[720px] flex-col gap-8">
          <section aria-labelledby={heading} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id={heading} className="text-[17px] font-medium text-ink-1">
                {copy.DEFAULTS_HEADING}
              </h2>
              <Link
                to="/sharing/defaults"
                search={{ kind: "person" }}
                data-sharing-link="defaults"
                className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
              >
                {copy.DEFAULTS_EDIT}
              </Link>
            </div>
            <p className="text-[13px] leading-[1.55] text-ink-2">
              {copy.DEFAULTS_INTRO}
            </p>
            {record === null ? (
              <p
                className="text-[13px] text-ink-2"
                data-defaults-summary="none"
              >
                {defaults.status === "loading"
                  ? copy.DEFAULTS_LOADING
                  : copy.DEFAULTS_NONE_YET}
              </p>
            ) : (
              <>
                <List className="flex flex-col gap-1.5">
                  {TEMPLATE_KINDS.map((kind) => {
                    const described = describeTemplate(
                      record.snapshot.defaults[kind],
                      record.snapshot.defaults.primary_household_id,
                      record.snapshot.households,
                    );
                    return (
                      <li
                        key={kind}
                        data-defaults-kind={kind}
                        className="flex list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-row border border-hairline-strong bg-panel px-3.5 py-2.5"
                      >
                        <span className="w-24 text-[13px] font-medium text-ink-1">
                          {KIND_LABEL[kind]}
                        </span>
                        <span className="min-w-0 flex-1 text-[13px] text-ink-1">
                          {described.summary}
                        </span>
                      </li>
                    );
                  })}
                </List>
                <p className="text-[12px] text-ink-2">
                  {copy.AS_OF(formatWhen(record.fetched_at, env.now()))}
                </p>
              </>
            )}
          </section>
          <section aria-labelledby={items} className="flex flex-col gap-1.5">
            <h2 id={items} className="text-[17px] font-medium text-ink-1">
              {copy.ITEM_SHARING_HEADING}
            </h2>
            <p className="text-[13px] leading-[1.55] text-ink-2">
              {copy.ITEM_SHARING_BODY}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
