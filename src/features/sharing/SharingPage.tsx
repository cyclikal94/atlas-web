import { Link } from "@tanstack/react-router";
import { useId } from "react";
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
    <div className="flex max-w-[720px] flex-col gap-8" data-sharing-page="">
      <PageHeading>{copy.PAGE_TITLE}</PageHeading>
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
          <p className="text-[13px] text-ink-2" data-defaults-summary="none">
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
      <HouseholdsMinimal />
    </div>
  );
}
