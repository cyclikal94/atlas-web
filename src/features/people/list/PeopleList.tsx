import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
  type Change,
  changesById,
  changesOfAll,
  foldOne,
  projectedRows,
  type ShownRow,
} from "../model/project";
import { Avatar, Banner, PendingBadge } from "../parts";
import {
  linkageIn,
  OutstandingChain,
  ResourceScan,
  readLinkage,
  type ScanResult,
} from "../reads";
import { NewPersonDialog } from "./NewPersonDialog";

/**
 * WF-PEOPLE-01, the people list (§4.1). Rows come from the cache with this device's outstanding saves folded over them (a queued new person
 * is shown, marked "Not sent yet"). The list is read in BOUNDED STEPS (Q9; finding 7 of the review of 13 October 2026): a step keeps at most
 * 100 people that match the view and the search, reading at most 20 pages of 100 to find them, and "Next people" / "Keep searching"
 * continue from where it stopped ("Previous people" goes back), so every person stays reachable and nothing past the step is read. The
 * cache lists people by id, so a step is sorted by name within itself. Search is over the names shown, which are only names the person can
 * see. "All" lists people that are not archived; "Archived" lists the archived ones. The "Account" text appears only for people whose
 * linkage this page has read (D-11a-3): while online, the first 25 rows shown are read, two at a time, once per identity.
 *
 * States: Loading (five skeleton rows; header and controls paint at once), Empty (a completed sync with nobody), Offline-first-visit (no
 * sync yet: never shown as Empty), Error (the store failed: a banner with Try again), each with "New person" still offered.
 */
const PEOPLE_STEP = 100;
const PEOPLE_STEP_PAGES = 20;

const normalise = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

export function PeopleList({ selectedId }: { selectedId: string | null }) {
  const env = usePeopleEnv();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "archived">("all");
  const [creating, setCreating] = useState(false);
  // The start of each step walked so far (null: the first); a new search or view begins again from the first.
  const [starts, setStarts] = useState<(string | null)[]>([null]);
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
          onChange={(event) => {
            setQuery(event.target.value);
            setStarts([null]);
          }}
        />
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">{copy.FILTER_LABEL}</legend>
          {(["all", "archived"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              data-people-filter={value}
              data-status={view === value ? "active" : undefined}
              onClick={() => {
                setView(value);
                setStarts([null]);
              }}
              className={`atlas-transition min-h-11 rounded-control border px-3 text-[13px] text-ink-1 hover:bg-row-hover data-[status=active]:bg-select-tint ${view === value ? "border-action-fill" : "border-hairline-strong"}`}
            >
              {value === "all" ? copy.FILTER_ALL : copy.FILTER_ARCHIVED}
            </button>
          ))}
        </fieldset>
      </div>
      <CacheGate>
        <OutstandingChain>
          {(outstanding) => (
            <PeopleSteps
              env={env}
              changes={changesOfAll(outstanding.rows)}
              outstandingCapped={outstanding.capped}
              query={query}
              view={view}
              starts={starts}
              onStarts={setStarts}
              selectedId={selectedId}
              onNew={() => setCreating(true)}
            />
          )}
        </OutstandingChain>
      </CacheGate>
      <NewPersonDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function PeopleSteps({
  env,
  changes,
  outstandingCapped,
  query,
  view,
  starts,
  onStarts,
  selectedId,
  onNew,
}: {
  env: PeopleEnv;
  changes: Change[];
  outstandingCapped: boolean;
  query: string;
  view: "all" | "archived";
  starts: (string | null)[];
  onStarts(starts: (string | null)[]): void;
  selectedId: string | null;
  onNew(): void;
}) {
  const wanted = normalise(query);
  const byId = useMemo(() => changesById(changes), [changes]);
  const shows = useCallback(
    (row: CacheRow) =>
      (view === "archived" ? row.archived : !row.archived) &&
      (wanted === "" || normalise(row.label).includes(wanted)),
    [view, wanted],
  );
  const keep = useCallback(
    (row: CacheRow) => shows(foldOne(row, byId).row),
    [shows, byId],
  );
  const start = starts.at(-1) ?? null;
  return (
    <ResourceScan
      kind="person"
      start={start}
      keep={keep}
      limit={PEOPLE_STEP}
      pages={PEOPLE_STEP_PAGES}
    >
      {(step) => (
        <Rows
          env={env}
          step={step}
          first={start === null}
          shown={[
            ...step.rows.map((row) => foldOne(row, byId)),
            // This device's queued new people are shown once, with the first step.
            ...(start === null
              ? projectedRows(
                  new Set(step.rows.map((row) => row.id)),
                  changes,
                  "person",
                ).filter((row) => shows(row.row))
              : []),
          ].sort(byName)}
          outstandingCapped={outstandingCapped}
          query={query}
          view={view}
          selectedId={selectedId}
          onNew={onNew}
          onPrevious={
            starts.length > 1 ? () => onStarts(starts.slice(0, -1)) : null
          }
          onNext={
            step.settled && step.next !== null
              ? () => onStarts([...starts, step.next])
              : null
          }
        />
      )}
    </ResourceScan>
  );
}

function Rows({
  env,
  step,
  first,
  shown,
  outstandingCapped,
  query,
  view,
  selectedId,
  onNew,
  onPrevious,
  onNext,
}: {
  env: PeopleEnv;
  step: ScanResult;
  first: boolean;
  shown: ShownRow[];
  outstandingCapped: boolean;
  query: string;
  view: "all" | "archived";
  selectedId: string | null;
  onNew(): void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  useMemoryRevision(env.memory);
  const inputs = useStatusInputs();
  const actions = useDataActions();
  const wanted = normalise(query);
  usePrefetchLinkage(
    env,
    shown.filter((row) => !row.projected).map((row) => row.row.id),
  );
  const status = step.status;

  if (status === "failed")
    return (
      <Banner
        message={copy.LOAD_FAILED}
        action={
          <Button onClick={() => actions.retryLoad()}>{copy.TRY_AGAIN}</Button>
        }
      />
    );
  if ((status === "loading" || !step.settled) && shown.length === 0)
    return (
      <div
        aria-busy="true"
        data-people-state="loading"
        className="flex flex-col gap-1.5"
      >
        {[0, 1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className="min-h-12 rounded-row border border-hairline bg-panel"
          />
        ))}
      </div>
    );
  const neverSynced =
    status === "absent" ||
    inputs.cache === "empty" ||
    inputs.cache === "unknown";
  // Nobody at all: the whole walk from the first person found none to show in "All", and nothing is searched for.
  const nobody =
    first && step.end && shown.length === 0 && wanted === "" && view === "all";
  if (nobody || (neverSynced && shown.length === 0))
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
  // The step stopped at its page bound before it found a full step: more people may match further on.
  const partial = step.settled && !step.end && shown.length < PEOPLE_STEP;
  return (
    <div className="flex flex-col gap-2">
      {neverSynced ? (
        <p className="text-[12.5px] text-ink-2">
          {inputs.online ? copy.NOT_SYNCED_YET : copy.OFFLINE_FIRST_VISIT}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p data-people-state="no-match" className="text-[13px] text-ink-2">
          {wanted !== ""
            ? step.end
              ? copy.NO_MATCH(query.trim())
              : copy.NO_MATCH_YET(query.trim())
            : view === "archived"
              ? copy.EMPTY_ARCHIVED
              : copy.EMPTY}
        </p>
      ) : (
        <List className="flex flex-col gap-1">
          {shown.map((row) => (
            <PersonRow
              key={row.row.id}
              env={env}
              row={row}
              selected={row.row.id === selectedId}
            />
          ))}
        </List>
      )}
      {partial && shown.length > 0 ? (
        <p className="text-[12.5px] text-ink-2" data-people-state="partial">
          {copy.SEARCH_PARTIAL(shown.length)}
        </p>
      ) : null}
      {onPrevious !== null || onNext !== null ? (
        <div className="flex flex-wrap gap-2" data-people-steps="">
          {onPrevious !== null ? (
            <Button data-people-action="previous-people" onClick={onPrevious}>
              {copy.PREVIOUS_PEOPLE}
            </Button>
          ) : null}
          {onNext !== null ? (
            <Button data-people-action="next-people" onClick={onNext}>
              {partial ? copy.KEEP_SEARCHING : copy.NEXT_PEOPLE}
            </Button>
          ) : null}
        </div>
      ) : null}
      {outstandingCapped ? (
        <p
          className="text-[12.5px] text-ink-2"
          data-people-state="outstanding-capped"
        >
          {copy.OUTSTANDING_CAPPED}
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
        data-status={selected ? "active" : undefined}
        className={`atlas-transition flex min-h-12 items-center gap-3 rounded-row border px-3 py-2 hover:bg-row-hover data-[status=active]:bg-select-tint ${selected ? "border-action-fill" : "border-hairline"}`}
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
