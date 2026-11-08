import { Link, useMatches, useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { lazy, Suspense, useId } from "react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { buttonVariants } from "../../components/ui/button";
import { GroupedBox, GroupedSection } from "../../components/ui/grouped";
import { List } from "../../components/ui/list";
import { Eyebrow, PageHeader } from "../../components/ui/page-header";
import { PageHeading } from "../../components/ui/page-heading";
import { ListRow } from "../../components/ui/row";
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
 * The Sharing destination (`/sharing`) on the Final design's anatomy: the eyebrow heading, the large title, the summary line and WEB-12b's
 * household actions (Invitations, Default sharing, New household) at the right; WEB-12b's households (WF-SHARING-01); then one grouped box
 * of the resolved sharing defaults (each kind a row leading to the editor on that kind, from the B5 snapshot record, never combined with
 * other reads; offline the last snapshot with its time) and how a single item's sharing is reached. Below 1280 px a household's route
 * shows its detail alone (with "‹ Households"), so the rest of the page is not drawn under it.
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
    <div
      className="atlas-enter flex min-w-0 flex-col gap-6"
      data-sharing-page=""
    >
      {detailAlone ? (
        // The detail alone (below 1280 px) is still the Sharing page: its level-one heading stays (the household's name is its h2).
        <PageHeading eyebrow>{copy.PAGE_TITLE}</PageHeading>
      ) : (
        <PageHeader
          eyebrow={<Eyebrow>{copy.PAGE_TITLE}</Eyebrow>}
          title={<PageHeading>{copy.PAGE_TITLE}</PageHeading>}
          summary={SUBTITLE}
          actions={
            <Suspense fallback={null}>
              <HouseholdsActions />
            </Suspense>
          }
        />
      )}
      <Suspense fallback={null}>
        <HouseholdsRegion dialogOpen={dialogOpen} />
      </Suspense>
      {detailAlone ? null : (
        <GroupedBox data-sharing-box="">
          <GroupedSection
            aria-labelledby={heading}
            data-sharing-section="defaults"
            heading={<h2 id={heading}>{copy.DEFAULTS_HEADING}</h2>}
          >
            {record === null ? (
              <p
                className="text-sm text-muted-foreground"
                data-defaults-summary="none"
              >
                {defaults.status === "loading"
                  ? copy.DEFAULTS_LOADING
                  : copy.DEFAULTS_NONE_YET}
              </p>
            ) : (
              <List className="flex flex-col">
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
                      className="list-none"
                    >
                      <ListRow
                        to="/sharing/defaults"
                        search={{ kind }}
                        fact={described.summary}
                        trailing={
                          <ChevronRight
                            aria-hidden="true"
                            className="size-3.5 flex-none text-muted-foreground"
                          />
                        }
                      >
                        {KIND_LABEL[kind]}
                      </ListRow>
                    </li>
                  );
                })}
              </List>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link
                to="/sharing/defaults"
                search={{ kind: "person" }}
                data-sharing-link="defaults"
                className={buttonVariants({ variant: "outline" })}
              >
                {copy.DEFAULTS_EDIT}
              </Link>
              {record === null ? null : (
                <span className="text-xs text-muted-foreground">
                  {copy.AS_OF(formatWhen(record.fetched_at, env.now()))}
                </span>
              )}
            </div>
          </GroupedSection>
          <GroupedSection
            aria-labelledby={items}
            data-sharing-section="items"
            heading={<h2 id={items}>{copy.ITEM_SHARING_HEADING}</h2>}
          >
            <p className="text-sm leading-relaxed text-muted-foreground">
              {copy.ITEM_SHARING_BODY}
            </p>
          </GroupedSection>
        </GroupedBox>
      )}
    </div>
  );
}
