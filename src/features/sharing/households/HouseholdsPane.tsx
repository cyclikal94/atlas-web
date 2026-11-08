import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import type { SnapshotHousehold } from "../../../data";
import * as base from "../copy";
import { Banner, formatWhen } from "../parts";
import * as copy from "./copy";
import { readHouseholds } from "./memory";
import { byName } from "./model";
import type { Ctx } from "./operations";
import { householdPath } from "./parts";

/**
 * WF-SHARING-01's households list. What is listed, with its scope and its own time (WEB-12a design assessment DA-M2):
 *  - the complete list this page read (`GET /households`), with that read's time when offline;
 *  - offline before it was read, the households the last B5 snapshot recorded: only the primary household and the households the
 *    defaults name, said to be only those (an empty one is NOT "you're not in a household");
 *  - offline with neither: "this device hasn't synced yet", distinct from the checked empty list.
 * Only the complete list can say "You're not in a household", and the capacity line counts only it (never B5's subset).
 */
export function HouseholdsPane({
  ctx,
  online,
  now,
  selectedId,
  primaryId,
  snapshot,
}: {
  ctx: Ctx;
  online: boolean;
  now: number;
  selectedId: string | null;
  primaryId: string | null;
  /** The B5 record's households and its time, if a record exists. */
  snapshot: { list: SnapshotHousehold[]; at: number } | null;
}) {
  const heading = useId();
  const { memory } = ctx;
  const read = memory.households;
  const complete = read.last;
  // The complete list read on this page, or, offline before it was read, B5's subset.
  const shown: {
    from: "complete" | "snapshot";
    list: SnapshotHousehold[];
    at: number;
  } | null =
    complete !== null
      ? { from: "complete", list: complete.value, at: complete.at }
      : !online && snapshot !== null
        ? { from: "snapshot", list: snapshot.list, at: snapshot.at }
        : null;
  return (
    <section
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3"
      data-households-pane=""
    >
      <h2 id={heading} className="text-[15px] font-medium text-foreground">
        {copy.PANE_HEADING}
      </h2>
      {read.status === "failed" && read.failure !== null ? (
        <Banner
          message={copy.FAILED}
          requestId={
            "requestId" in read.failure ? read.failure.requestId : undefined
          }
          action={
            <Button onClick={() => void readHouseholds(memory, ctx.api)}>
              {base.TRY_AGAIN}
            </Button>
          }
        />
      ) : null}
      {shown === null ? (
        read.status === "failed" ? null : (
          <p
            className="text-sm text-muted-foreground"
            data-households-state={online ? "loading" : "offline-never"}
          >
            {online ? copy.LOADING : copy.OFFLINE_NEVER}
          </p>
        )
      ) : shown.from === "snapshot" && shown.list.length === 0 ? (
        // B5 names no household: that is not "you're in none" (DA-M2).
        <div className="flex flex-col gap-1" data-households-from="snapshot">
          <p className="text-sm text-foreground">{copy.SNAPSHOT_NONE}</p>
          <p className="text-xs text-muted-foreground">
            {base.AS_OF(formatWhen(shown.at, now))}
          </p>
        </div>
      ) : (
        <>
          {!online ? (
            <p
              className="text-xs text-muted-foreground"
              data-households-from={shown.from}
            >
              {shown.from === "snapshot"
                ? `${copy.FROM_SNAPSHOT} ${base.AS_OF(formatWhen(shown.at, now))}`
                : copy.LAST_READ(formatWhen(shown.at, now))}
            </p>
          ) : null}
          {shown.list.length === 0 ? (
            // Only the complete list can say this (DA-M2).
            <div className="flex flex-col gap-1" data-households-state="empty">
              <p className="text-sm font-medium text-foreground">
                {copy.EMPTY}
              </p>
              <p className="text-xs text-muted-foreground">{copy.EMPTY_BODY}</p>
            </div>
          ) : (
            <List className="flex flex-col gap-1.5">
              {[...shown.list].sort(byName).map((household) => (
                <PaneRow
                  key={household.id}
                  household={household}
                  primary={household.id === primaryId}
                  selected={household.id === selectedId}
                  linked={shown.from === "complete"}
                />
              ))}
            </List>
          )}
          {shown.from === "complete" ? (
            <p
              className="text-xs text-muted-foreground"
              data-households-capacity=""
            >
              {copy.CAPACITY(shown.list.length)}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function PaneRow({
  household,
  primary,
  selected,
  linked,
}: {
  household: SnapshotHousehold;
  primary: boolean;
  selected: boolean;
  linked: boolean;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-foreground">
          {household.name}
        </span>
        {primary ? (
          <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {copy.MAIN_BADGE}
          </span>
        ) : null}
      </span>
      <span className="text-xs text-muted-foreground">
        {copy.PEOPLE(household.members.length)} ·{" "}
        {household.role === "manager" ? copy.YOU_MANAGE : copy.MEMBER}
      </span>
    </>
  );
  const frame = `flex min-h-11 flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 ${selected ? "border-primary bg-accent" : "border-border bg-card"}`;
  return (
    <li className="list-none" data-household={household.id}>
      {linked ? (
        <Link
          to={householdPath(household.id) as never}
          aria-current={selected ? "page" : undefined}
          className={`atlas-transition ${frame} hover:bg-accent`}
        >
          {body}
        </Link>
      ) : (
        <div className={frame}>{body}</div>
      )}
    </li>
  );
}
