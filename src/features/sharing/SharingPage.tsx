import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { buttonVariants } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import { TEMPLATE_KINDS, useSharingDefaults } from "../../data";
import * as copy from "./copy";
import { useSharingEnv } from "./env";
import { HouseholdsMinimal } from "./HouseholdsMinimal";
import { describeTemplate, KIND_LABEL } from "./model/templates";
import { formatWhen } from "./parts";

/**
 * The Sharing destination (`/sharing`): the resolved sharing defaults of each resource kind from the B5 snapshot record (one record, never
 * combined with other reads), the entry to WF-SHARING-03, how a single item's sharing is reached, and WEB-12a's household demonstration.
 * Offline it shows the last snapshot with its time.
 */
export function SharingPage() {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const heading = useId();
  const items = useId();
  const record = defaults.record;
  return (
    <div
      className="atlas-enter flex max-w-[720px] flex-col gap-8"
      data-sharing-page=""
    >
      <PageHeading>{copy.PAGE_TITLE}</PageHeading>
      <section aria-labelledby={heading} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={heading} className="text-lg font-medium text-foreground">
            {copy.DEFAULTS_HEADING}
          </h2>
          <Link
            to="/sharing/defaults"
            search={{ kind: "person" }}
            data-sharing-link="defaults"
            className={buttonVariants({ variant: "outline" })}
          >
            {copy.DEFAULTS_EDIT}
          </Link>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {copy.DEFAULTS_INTRO}
        </p>
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
                    className="flex list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-3 shadow-sm"
                  >
                    <span className="w-24 text-sm font-medium text-foreground">
                      {KIND_LABEL[kind]}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-foreground">
                      {described.summary}
                    </span>
                  </li>
                );
              })}
            </List>
            <p className="text-xs text-muted-foreground">
              {copy.AS_OF(formatWhen(record.fetched_at, env.now()))}
            </p>
          </>
        )}
      </section>
      <section aria-labelledby={items} className="flex flex-col gap-1.5">
        <h2 id={items} className="text-lg font-medium text-foreground">
          {copy.ITEM_SHARING_HEADING}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {copy.ITEM_SHARING_BODY}
        </p>
      </section>
      <HouseholdsMinimal />
    </div>
  );
}
