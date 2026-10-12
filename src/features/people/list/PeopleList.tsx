import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import {
  type CacheRow,
  useDataActions,
  useResourceList,
  useStatusInputs,
} from "../../../data";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import type { LinkageState } from "../model/linkage";
import {
  byName,
  changesOfAll,
  foldRows,
  type ShownRow,
} from "../model/project";
import { Avatar, Banner, PendingBadge } from "../parts";
import {
  linkageIn,
  OutstandingChain,
  ResourceChain,
  readLinkage,
} from "../reads";
import { NewPersonDialog } from "./NewPersonDialog";

/**
 * WF-PEOPLE-01, the people list (§4.1). Rows come from the cache (a bounded chain of live pages, D-11a-4) with this device's outstanding
 * saves folded over them (a queued new person is shown, marked "Not sent yet"). Search is over the names shown, which are only names the
 * person can see. "All" lists people that are not archived; "Archived" lists the archived ones. The "Account" text appears only for people
 * whose linkage this page has read (D-11a-3): while online, the first 25 rows shown are read, two at a time, once per identity.
 *
 * States: Loading (five skeleton rows; header and controls paint at once), Empty (a completed sync with nobody), Offline-first-visit (no
 * sync yet: never shown as Empty), Error (the store failed: a banner with Try again), each with "New person" still offered.
 */
const PEOPLE_PAGES = 20;
const SHOWN_STEP = 100;

const normalise = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

export function PeopleList({ selectedId }: { selectedId: string | null }) {
  const env = usePeopleEnv();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "archived">("all");
  const [creating, setCreating] = useState(false);
  const searchId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-4" data-people-list="">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          data-people-action="new-person"
          onClick={() => setCreating(true)}
        >
          {copy.NEW_PERSON}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Input
          id={searchId}
          type="search"
          aria-label={copy.SEARCH}
          placeholder={copy.SEARCH}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">{copy.FILTER_LABEL}</legend>
          {(["all", "archived"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              data-people-filter={value}
              onClick={() => setFilter(value)}
              className="atlas-transition min-h-11 rounded-control border border-hairline-strong px-3 text-[13px] text-ink-1 hover:bg-row-hover aria-pressed:border-action-fill aria-pressed:bg-select-tint"
            >
              {value === "all" ? copy.FILTER_ALL : copy.FILTER_ARCHIVED}
            </button>
          ))}
        </fieldset>
      </div>
      <CacheGate>
        <ResourceChain kind="person" cap={PEOPLE_PAGES}>
          {(cached) => (
            <OutstandingChain>
              {(outstanding) => (
                <Rows
                  env={env}
                  status={cached.status}
                  capped={cached.capped}
                  shown={foldRows(
                    cached.rows,
                    changesOfAll(outstanding.rows),
                    "person",
                  )}
                  query={query}
                  filter={filter}
                  selectedId={selectedId}
                  onNew={() => setCreating(true)}
                />
              )}
            </OutstandingChain>
          )}
        </ResourceChain>
      </CacheGate>
      <NewPersonDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Rows({
  env,
  status,
  capped,
  shown,
  query,
  filter,
  selectedId,
  onNew,
}: {
  env: PeopleEnv;
  status: "loading" | "ready" | "absent" | "failed";
  capped: boolean;
  shown: ShownRow[];
  query: string;
  filter: "all" | "archived";
  selectedId: string | null;
  onNew(): void;
}) {
  useMemoryRevision(env.memory);
  const inputs = useStatusInputs();
  const actions = useDataActions();
  const [limit, setLimit] = useState(SHOWN_STEP);
  const wanted = normalise(query);
  const rows = useMemo(
    () =>
      shown
        .filter((row) =>
          filter === "archived" ? row.row.archived : !row.row.archived,
        )
        .filter(
          (row) => wanted === "" || normalise(row.row.label).includes(wanted),
        )
        .sort(byName),
    [shown, filter, wanted],
  );
  const displayed = rows.slice(0, limit);
  usePrefetchLinkage(
    env,
    displayed.filter((row) => !row.projected).map((row) => row.row.id),
  );

  if (status === "failed")
    return (
      <Banner
        message={copy.LOAD_FAILED}
        action={
          <Button onClick={() => actions.retryLoad()}>{copy.TRY_AGAIN}</Button>
        }
      />
    );
  if (status === "loading" && shown.length === 0)
    return (
      <div
        aria-busy="true"
        data-people-state="loading"
        className="flex flex-col gap-1.5"
      >
        {[0, 1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className="h-14 rounded-row border border-hairline bg-panel"
          />
        ))}
      </div>
    );
  const neverSynced =
    status === "absent" ||
    inputs.cache === "empty" ||
    inputs.cache === "unknown";
  if (shown.length === 0)
    return (
      <div
        data-people-state={neverSynced ? "offline-first-visit" : "empty"}
        className="flex flex-col items-start gap-3 rounded-row border border-hairline-strong bg-panel p-4"
      >
        <p className="text-[13.5px] leading-[1.55] text-ink-1">
          {neverSynced
            ? inputs.online
              ? copy.NOT_SYNCED_YET
              : copy.OFFLINE_FIRST_VISIT
            : copy.EMPTY}
        </p>
        <Button onClick={onNew}>{copy.NEW_PERSON}</Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {neverSynced ? (
        <p className="text-[12.5px] text-ink-2">
          {inputs.online ? copy.NOT_SYNCED_YET : copy.OFFLINE_FIRST_VISIT}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p data-people-state="no-match" className="text-[13px] text-ink-2">
          {wanted !== ""
            ? copy.NO_MATCH(query.trim())
            : filter === "archived"
              ? copy.EMPTY_ARCHIVED
              : copy.EMPTY}
        </p>
      ) : (
        <List className="flex flex-col gap-1">
          {displayed.map((row) => (
            <PersonRow
              key={row.row.id}
              env={env}
              row={row}
              selected={row.row.id === selectedId}
            />
          ))}
        </List>
      )}
      {rows.length > limit ? (
        <Button onClick={() => setLimit(limit + SHOWN_STEP)}>
          {copy.SHOW_MORE}
        </Button>
      ) : null}
      {capped ? (
        <p className="text-[12.5px] text-ink-2">
          {copy.CAPPED(PEOPLE_PAGES * 100)}
        </p>
      ) : null}
    </div>
  );
}

function linkageText(linkage: LinkageState): string | null {
  if (!linkage.known) return null;
  return linkage.kind === "self"
    ? copy.ROW_LINK_SELF
    : linkage.kind === "other"
      ? copy.ROW_LINK_OTHER
      : copy.ROW_LINK_NONE;
}

function PersonRow({
  env,
  row,
  selected,
}: {
  env: PeopleEnv;
  row: ShownRow;
  selected: boolean;
}) {
  const person = row.row;
  const linkage = row.projected ? null : linkageText(linkageIn(env, person.id));
  return (
    <li className="list-none">
      <Link
        to="/people/$personId"
        params={{ personId: person.id }}
        aria-current={selected ? "page" : undefined}
        data-person-row={person.id}
        className="atlas-transition flex min-h-14 items-center gap-3 rounded-row border border-hairline px-3 py-2 hover:bg-row-hover aria-[current=page]:border-action-fill aria-[current=page]:bg-select-tint"
      >
        <Avatar name={person.label} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[14px] text-ink-1">
            {person.label}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
            {linkage ? <span data-person-linkage="">{linkage}</span> : null}
            {person.archived ? <span>{copy.ARCHIVED_TAG}</span> : null}
            <PendingBadge mark={row.pending} />
          </span>
        </span>
        {row.projected ? null : <FieldCount personId={person.id} />}
      </Link>
    </li>
  );
}

/** The cached, non-archived fields of one person, from one page (a person with more says "100+"). */
function FieldCount({ personId }: { personId: string }) {
  const page = useResourceList({ kind: "field", parentId: personId });
  if (page.status !== "ready") return null;
  const count = page.value.rows.filter(
    (row: { merged: CacheRow }) => !row.merged.archived,
  ).length;
  return (
    <span className="flex-none text-[12.5px] text-ink-2" data-field-count="">
      {page.value.next === null
        ? copy.FIELD_COUNT(count)
        : `${copy.FIELD_COUNT(count)}+`}
    </span>
  );
}

/**
 * D-11a-3: while online, reads the linkage of the first `env.prefetchLinkage` people shown, two at a time, once per identity per page
 * lifetime (never again for a person already asked, answered or refused).
 */
function usePrefetchLinkage(env: PeopleEnv, ids: readonly string[]) {
  const key = ids.slice(0, env.prefetchLinkage).join(",");
  useEffect(() => {
    if (!env.online || key === "") return;
    const memory = env.memory;
    const queue = key.split(",").filter((id) => !memory.prefetched.has(id));
    for (const id of queue) memory.prefetched.add(id);
    let cancelled = false;
    const worker = async () => {
      for (;;) {
        if (cancelled) return;
        const id = queue.shift();
        if (id === undefined) return;
        await readLinkage(env, id);
      }
    };
    void Promise.all([worker(), worker()]);
    return () => {
      cancelled = true;
      // What was not asked yet may be asked by the next run.
      for (const id of queue) memory.prefetched.delete(id);
    };
  }, [env, key]);
}
