import { useId } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import {
  ownerName,
  type PersonSummaryDetail,
  type SharedHousehold,
} from "../model/summary";
import { Avatar } from "../parts";
import { readOne, shownOf, useSummary } from "../summaries";
import { SummaryNotes } from "../summary-notes";

/**
 * WF-PEOPLE-02's "Shared with" (finding 8), from `GET /people/{id}/summary` while online (`summaries.tsx`): the owner, then each account
 * and household the person is shared with, with its role.
 *
 *  - The OWNER's rail is complete: every direct grant, every household (its members listed, excluded ones marked, for a household the
 *    owner belongs to), and the excluded accounts.
 *  - Anyone else's rail is PARTIAL, always: the owner, the reader's own direct grant and the households the reader belongs to, with the
 *    explanation that the owner may have shared it more widely (product decision 2). Nothing is said about other access.
 *  - A household's size is said as its size, never as how many can see the person. Offline it is unavailable, never an old answer.
 */
export function SharedWithSection({ personId }: { personId: string }) {
  const env = usePeopleEnv();
  const heading = useId();
  const view = useSummary<PersonSummaryDetail>(
    `person:${personId}`,
    (current) =>
      readOne(
        () => env.api.readPersonSummary(personId),
        (detail) => [detail.summary],
        current,
      ),
  );
  const shown = shownOf(view);
  const rail = shown?.value.shared_with ?? null;
  return (
    <section
      aria-labelledby={heading}
      data-shared-with={rail?.disclosure ?? view.status}
      className="flex max-w-[620px] flex-col gap-2 rounded-row border border-hairline bg-panel p-3.5"
    >
      <h3 id={heading} className="text-[13px] font-medium text-ink-1">
        {copy.SHARED_WITH}
      </h3>
      {view.status === "failed" && view.reason === "not_found" ? (
        <p className="text-[13px] text-ink-2">{copy.RAIL_NOT_FOUND}</p>
      ) : rail === null && view.status === "failed" ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          {copy.RAIL_FAILED}
          <Button variant="quiet" onClick={view.retry}>
            {copy.TRY_AGAIN}
          </Button>
        </p>
      ) : rail === null ? (
        <p className="text-[13px] text-ink-2">
          {view.status === "offline" ? copy.RAIL_OFFLINE : copy.RAIL_CHECKING}
        </p>
      ) : (
        <>
          <List className="flex flex-col gap-1.5">
            <Entry
              name={rail.owner.you ? copy.YOU : ownerName(rail.owner)}
              role={copy.OWNER_ROLE}
              entry="owner"
            />
            {rail.accounts.map((grant) => (
              <Entry
                key={grant.account_id}
                name={
                  grant.account_id === env.accountId ? copy.YOU : grant.username
                }
                role={grant.can_edit ? copy.CAN_EDIT : copy.CAN_VIEW}
                entry="account"
              />
            ))}
            {rail.households.map((household) => (
              <HouseholdEntry key={household.id} household={household} />
            ))}
          </List>
          {rail.excluded_accounts !== null &&
          rail.excluded_accounts.length > 0 ? (
            <p className="text-[12.5px] text-ink-2" data-rail-excluded="">
              {copy.EXCLUDED_ACCOUNTS(
                rail.excluded_accounts.map((a) => a.username).join(", "),
              )}
            </p>
          ) : null}
          {rail.disclosure === "complete" &&
          rail.accounts.length === 0 &&
          rail.households.length === 0 ? (
            <p className="text-[12.5px] text-ink-2">{copy.ONLY_YOU_RAIL}</p>
          ) : null}
          {rail.disclosure === "partial" ? (
            <p className="text-[12.5px] text-ink-2" data-rail-partial="">
              {copy.RAIL_PARTIAL(ownerName(rail.owner))}
            </p>
          ) : null}
        </>
      )}
      {rail !== null ? <SummaryNotes view={view} partial={false} /> : null}
    </section>
  );
}

function Entry({
  name,
  role,
  entry,
  detail,
}: {
  name: string;
  role: string;
  entry: string;
  detail?: string;
}) {
  return (
    <li className="flex list-none items-center gap-3" data-rail-entry={entry}>
      <Avatar name={name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] text-ink-1">{name}</span>
        {detail !== undefined ? (
          <span className="text-[12px] text-ink-2">{detail}</span>
        ) : null}
      </span>
      <span className="flex-none text-[12.5px] text-ink-2">{role}</span>
    </li>
  );
}

function HouseholdEntry({ household }: { household: SharedHousehold }) {
  const members =
    household.members === null
      ? null
      : household.members
          .map((member) =>
            member.excluded
              ? `${member.username} (${copy.EXCLUDED_MEMBER})`
              : member.username,
          )
          .join(", ");
  const size =
    household.member_count === null
      ? null
      : copy.HOUSEHOLD_SIZE(household.member_count);
  const detail = [size, members].filter((part) => part !== null).join(" · ");
  return (
    <Entry
      name={household.name ?? copy.HOUSEHOLD_LEFT}
      role={household.can_edit ? copy.CAN_EDIT : copy.CAN_VIEW}
      entry="household"
      {...(detail === "" ? {} : { detail })}
    />
  );
}
