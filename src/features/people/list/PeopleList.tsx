import { ChevronRight, Search } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { PersonAvatar } from "../../../components/ui/avatar-stack";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import { ListRow, RowGroupHeading } from "../../../components/ui/row";
import {
  type CacheRow,
  type DraftWithCommand,
  useDataActions,
  useSharingDefaults,
  useStatusInputs,
  useVisibleChildren,
} from "../../../data";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { useSteadyWhilePressed } from "../detail/steady";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { usePeopleRecoveryHost } from "../form-recovery";
import { newPersonForm } from "../model/person-form";
import {
  byName,
  type Change,
  changesById,
  changesOfAll,
  foldOne,
  projectedRows,
  type ShownRow,
} from "../model/project";
import { personCodec } from "../model/recovery";
import {
  attributionOf,
  audienceText,
  type PersonSummary,
  type SummaryScope,
  summaryCurrentFor,
} from "../model/summary";
import { Banner, PendingBadge } from "../parts";
import {
  type ChainResult,
  ConfirmedAbsence,
  OutstandingChain,
  ResourceScan,
  type ScanResult,
} from "../reads";
import {
  type SummaryView,
  shownOf,
  useSummary,
  type WalkedPages,
  walkPages,
} from "../summaries";
import { SummaryNotes } from "../summary-notes";
import {
  holdsNewPerson,
  NewPersonDialog,
  parkNewPerson,
  RETAINED,
} from "./NewPersonDialog";

/**
 * WF-PEOPLE-01, the people list (§4.1). The list is read in BOUNDED STEPS (Q9; finding 7 of the review of 13 October 2026): a step keeps
 * at most 100 people that match the view and the search, reading at most 20 pages of 100 to find them, and "Next people" / "Keep
 * searching" continue from where it stopped ("Previous people" goes back), so every person stays reachable. A step is sorted by name within
 * itself. Search is over the names shown, which are only names the person can see.
 *
 * The views (finding 8; API 0.29's viewer-safe summaries, `summaries.tsx`):
 *  - "All" and "Archived" come from the CACHE, with this device's outstanding saves folded over it (a queued new person is shown, marked
 *    "Not sent yet"), and work offline. While online, each step's people are joined BY ID to `GET /people/summaries` read over the same id
 *    range (both are in ascending id order), for the "Account" and "Visible to" lines and who added them. Offline they say they are
 *    checked when online: never an old answer.
 *  - "In Home", "Shared with me" and "Not linked" are the SERVER's: `scope` is evaluated over the whole visible set before pagination, so
 *    each step walks the summary pages themselves and is complete at each read. They need a connection, and say so; nothing cached is
 *    filtered and called complete. In Home without a primary household is an explained empty state (product decision 3).
 *
 * States: Loading (five skeleton rows; header and controls paint at once), Empty (a completed sync with nobody), Offline-first-visit (no
 * sync yet: never shown as Empty), Error (the store failed: a banner with Try again), each with "New person" still offered.
 *
 * What the list shows is the cache AND this device's unsent changes (a queued new person exists only in the queue), so "No one here yet",
 * "Nobody is archived" and a final "No one matches" are said only when BOTH inventories were read to their end (review 7, finding 2):
 * while the unsent changes are still read, the list is loading; when they could not be read, it says so with Try again (a fresh read of
 * both), beside whatever could be read; when there are more than it reads, it says that, and claims no absence.
 */
const PEOPLE_STEP = 100;
const PEOPLE_STEP_PAGES = 20;
const SUMMARY_PAGE = 100;

type PeopleView = "all" | Exclude<SummaryScope, "all"> | "archived";
const VIEWS: readonly { view: PeopleView; label: string }[] = [
  { view: "all", label: copy.FILTER_ALL },
  { view: "in_home", label: copy.FILTER_IN_HOME },
  { view: "shared_with_me", label: copy.FILTER_SHARED_WITH_ME },
  { view: "not_linked", label: copy.FILTER_NOT_LINKED },
  { view: "archived", label: copy.FILTER_ARCHIVED },
];

const normalise = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();

export function PeopleList({
  selectedId,
  openPerson,
}: {
  selectedId: string | null;
  /** Where a row leads when the person opens beside the people (Settings · Layout, "How things open"). */
  openPerson?: (personId: string) => {
    to: "/people";
    search: { person: string };
  };
}) {
  const env = usePeopleEnv();
  const [query, setQuery] = useState("");
  const [view, setView] = useState<PeopleView>("all");
  const [creating, setCreating] = useState(false);
  // WEB-14a (F-INT-PEOPLE-Q4): the "New person" form left by the page before an update reload opens again on its copy (never saved).
  usePeopleRecoveryHost({
    memory: env.memory,
    key: RETAINED,
    codec: personCodec,
    start: newPersonForm,
    holds: () => holdsNewPerson(env.memory),
    park: (form) => parkNewPerson(env.memory, form, env.newId),
    open: () => setCreating(true),
  });
  const actions = useDataActions();
  // "Try again" reads afresh: new watches of the cache and the unsent changes (a live query ends at its first error), and the data
  // layer's own retry of an unavailable database.
  const [reading, setReading] = useState(0);
  const retry = useCallback(() => {
    actions.retryLoad();
    setReading((value) => value + 1);
  }, [actions]);
  // The start of each step walked so far (null: the first); a new search or view begins again from the first.
  const [starts, setStarts] = useState<(string | null)[]>([null]);
  const searchId = useId();
  // A press on a row or a control is not lost to a summary that answers during it (review 7, finding 3): the pressed action keeps its
  // place while the rows above it grow.
  const root = useRef<HTMLDivElement>(null);
  useSteadyWhilePressed(root);
  // The Final design (8 November 2026): the search pill and "New person" on one line, the views under them, the rows at reading width.
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-4" data-people-list="">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
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
              className="rounded-full border-border bg-card pl-10 text-[13px]"
            />
          </div>
          <Button
            variant="default"
            data-people-action="new-person"
            onClick={() => setCreating(true)}
          >
            {copy.NEW_PERSON}
          </Button>
        </div>
        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">{copy.FILTER_LABEL}</legend>
          {VIEWS.map(({ view: value, label }) => (
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
              className={`atlas-transition inline-flex h-9 items-center rounded-full border px-3 text-xs text-foreground hover:bg-accent hover:text-accent-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground ${view === value ? "border-primary/40" : "border-border bg-card"}`}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <CacheGate>
        <OutstandingChain key={reading}>
          {(outstanding) =>
            view === "all" || view === "archived" ? (
              <PeopleSteps
                env={env}
                changes={changesOfAll(outstanding.rows)}
                outstanding={outstanding}
                onRetry={retry}
                query={query}
                view={view}
                {...(openPerson ? { openPerson } : {})}
                starts={starts}
                onStarts={setStarts}
                selectedId={selectedId}
                onNew={() => setCreating(true)}
              />
            ) : (
              <ScopeSteps
                env={env}
                scope={view}
                changes={changesOfAll(outstanding.rows)}
                outstanding={outstanding}
                onRetry={retry}
                query={query}
                starts={starts}
                onStarts={setStarts}
                {...(openPerson ? { openPerson } : {})}
                selectedId={selectedId}
              />
            )
          }
        </OutstandingChain>
      </CacheGate>
      <NewPersonDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

// ---- All / Archived: the cache, joined by id to the summaries ------------------------------------------------------------------------
function PeopleSteps({
  env,
  changes,
  outstanding,
  onRetry,
  query,
  view,
  starts,
  onStarts,
  selectedId,
  onNew,
  openPerson,
}: {
  env: PeopleEnv;
  changes: Change[];
  outstanding: ChainResult<DraftWithCommand>;
  /** Where a row leads when the person opens beside the people (Settings · Layout, "How things open"). */
  openPerson?: (personId: string) => {
    to: "/people";
    search: { person: string };
  };
  onRetry(): void;
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
        <CachedRows
          env={env}
          step={step}
          start={start}
          {...(openPerson ? { openPerson } : {})}
          archived={view === "archived"}
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
          shows={shows}
          outstanding={outstanding}
          onRetry={onRetry}
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

/**
 * The summaries of one cached step's people: `GET /people/summaries` from the step's own start, page after page, until every person of the
 * step was seen, a page passed the step's last id (the order is the same), the end, or the step's page bound. Nothing is read before
 * the step has settled, or for a step with nobody synced in it.
 */
function useStepSummaries(
  env: PeopleEnv,
  step: ScanResult,
  start: string | null,
  archived: boolean,
): SummaryView<WalkedPages<PersonSummary>> {
  const ids = step.settled ? step.rows.map((row) => row.id) : [];
  const key =
    ids.length === 0
      ? null
      : `people-join:${archived}:${start ?? ""}:${ids.join(",")}`;
  return useSummary(key, (current) => {
    const last = ids.reduce((a, b) => (b > a ? b : a), "");
    return walkPages(
      (after) =>
        env.api.readSummaries("all", { after, limit: SUMMARY_PAGE, archived }),
      {
        start,
        keep: () => false,
        limit: 1,
        pages: PEOPLE_STEP_PAGES,
        covered: (read, lastRead) =>
          ids.every((id) => read.has(id)) ||
          (lastRead !== null && lastRead >= last),
      },
      current,
    );
  });
}

/**
 * Every unsent change of this device was read (an absent database holds none): only then is a person's absence from what is shown
 * evidence that nobody (or nobody matching) is there (review 7, finding 2). Loading, failed and capped reads are not.
 */
export const changesKnown = (outstanding: ChainResult<unknown>): boolean =>
  outstanding.status === "absent" ||
  (outstanding.status === "ready" && outstanding.complete);

/** What the list says about the unsent changes it could not read in full, beside whatever it shows. */
function ChangesNotice({
  outstanding,
  onRetry,
}: {
  outstanding: ChainResult<unknown>;
  onRetry(): void;
}) {
  if (outstanding.status === "failed")
    return (
      <div data-people-state="changes-failed">
        <Banner
          message={copy.CHANGES_READ_FAILED}
          action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
        />
      </div>
    );
  return null;
}

function CachedRows({
  env,
  step,
  start,
  archived,
  shown,
  shows,
  outstanding,
  onRetry,
  query,
  view,
  selectedId,
  onNew,
  onPrevious,
  onNext,
  openPerson,
}: {
  env: PeopleEnv;
  step: ScanResult;
  start: string | null;
  archived: boolean;
  shown: ShownRow[];
  /** Where a row leads when the person opens beside the people (Settings · Layout, "How things open"). */
  openPerson?: (personId: string) => {
    to: "/people";
    search: { person: string };
  };
  /** Whether a person (as shown, unsent changes folded) belongs to this view and search. */
  shows(row: CacheRow): boolean;
  outstanding: ChainResult<DraftWithCommand>;
  onRetry(): void;
  query: string;
  view: "all" | "archived";
  selectedId: string | null;
  onNew(): void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}) {
  // The household you are in, named (the primary household of this device's sharing defaults), for the first group's heading.
  const defaults = useSharingDefaults().record;
  const home =
    defaults?.snapshot.households.find(
      (h: { id: string; name: string | null }) =>
        h.id === defaults.snapshot.defaults.primary_household_id,
    )?.name ?? null;
  const inputs = useStatusInputs();
  const summaries = useStepSummaries(env, step, start, archived);
  const read = shownOf(summaries)?.value.read ?? null;
  const wanted = normalise(query);
  const status = step.status;
  const first = start === null;
  // Both inventories the list shows were read to their end: only then is an absence a claim it can make.
  const known = changesKnown(outstanding);

  // The cache could not be read: said, with a fresh read, above whatever of it (and of the unsent changes) could be.
  const cacheFailed =
    status === "failed" ? (
      <Banner
        message={copy.LOAD_FAILED}
        action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
      />
    ) : null;
  const notice = <ChangesNotice outstanding={outstanding} onRetry={onRetry} />;
  /**
   * An absence the separate reads suggest is said only once ONE read of the cache and the unsent changes together agrees (DA7-12: the
   * queue's read can answer before the cache's when a new person is published); meanwhile the list is loading.
   */
  const confirmed = (claim: ReactNode) => (
    <ConfirmedAbsence
      kind="person"
      start={start}
      limit={PEOPLE_STEP}
      pages={PEOPLE_STEP_PAGES}
      keepWith={(drafts) => {
        const by = changesById(changesOfAll(drafts));
        return (row) => shows(foldOne(row, by).row);
      }}
      absent={({ step: found, drafts }) =>
        found !== null &&
        (!step.end || found.end) &&
        found.rows.length === 0 &&
        (start !== null ||
          projectedRows(new Set(), changesOfAll(drafts), "person").every(
            (row) => !shows(row.row),
          ))
      }
    >
      {(confirmation) =>
        confirmation === "absent" ? (
          claim
        ) : confirmation === "failed" ? (
          <Banner
            message={copy.LOAD_FAILED}
            action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
          />
        ) : (
          <Skeleton />
        )
      }
    </ConfirmedAbsence>
  );
  if (
    (status === "loading" ||
      (!step.settled && status !== "failed") ||
      outstanding.status === "loading") &&
    shown.length === 0
  )
    return <Skeleton />;
  if (status === "failed" && shown.length === 0)
    return (
      <div className="flex flex-col gap-2">
        {cacheFailed}
        {notice}
      </div>
    );
  const neverSynced =
    status === "absent" ||
    inputs.cache === "empty" ||
    inputs.cache === "unknown";
  // Nobody at all: the whole walk from the first person found none to show in "All", nothing is searched for, and every unsent change
  // was read (a queued new person is in the queue only).
  const nobody =
    first &&
    step.end &&
    shown.length === 0 &&
    wanted === "" &&
    view === "all" &&
    known;
  if (nobody || (neverSynced && shown.length === 0)) {
    const panel = (
      <div
        data-people-state={neverSynced ? "offline-first-visit" : "empty"}
        className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4"
      >
        <p className="text-sm leading-[1.55] text-foreground">
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
        {notice}
        {neverSynced ? panel : confirmed(panel)}
      </div>
    );
  }
  // The step stopped at its page bound before it found a full step: more people may match further on.
  const partial = step.settled && !step.end && shown.length < PEOPLE_STEP;
  // A summary is shown beside a cached person only when it is not older than what this device shows.
  const summaryOf = (row: ShownRow): PersonSummary | null => {
    if (row.projected || read === null) return null;
    const summary = read.get(row.row.id) ?? null;
    return summary !== null && summaryCurrentFor(summary, row.row)
      ? summary
      : null;
  };
  return (
    <div className="flex flex-col gap-2">
      {cacheFailed}
      {notice}
      {neverSynced ? (
        <p className="text-xs text-muted-foreground">
          {inputs.online ? copy.NOT_SYNCED_YET : copy.OFFLINE_FIRST_VISIT}
        </p>
      ) : null}
      {shown.length === 0 ? (
        // Nobody (matching) is claimed only from complete inventories; otherwise the notices above say what could not be read.
        known && status !== "failed" ? (
          confirmed(
            <p
              data-people-state="no-match"
              className="text-sm text-muted-foreground"
            >
              {wanted !== ""
                ? step.end
                  ? copy.NO_MATCH(query.trim())
                  : copy.NO_MATCH_YET(query.trim())
                : view === "archived"
                  ? copy.EMPTY_ARCHIVED
                  : copy.EMPTY}
            </p>,
          )
        ) : null
      ) : (
        <GroupedRows
          groups={groupRows(
            shown,
            summaryOf,
            view === "all" && wanted === "",
            home,
          )}
          summaryOf={summaryOf}
          count={(row) =>
            row.projected ? null : <FieldCount personId={row.row.id} />
          }
          selectedId={selectedId}
          {...(openPerson ? { openPerson } : {})}
        />
      )}
      {partial && shown.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-people-state="partial"
        >
          {copy.SEARCH_PARTIAL(shown.length)}
        </p>
      ) : null}
      <Steps onPrevious={onPrevious} onNext={onNext} partial={partial} />
      {outstanding.capped ? (
        <p
          className="text-xs text-muted-foreground"
          data-people-state="outstanding-capped"
        >
          {copy.OUTSTANDING_CAPPED}
        </p>
      ) : null}
      {shown.some((row) => !row.projected) ? (
        <SummaryNotes
          view={summaries}
          partial={shown.some(
            (row) => summaryOf(row)?.audience.disclosure === "partial",
          )}
        />
      ) : null}
    </div>
  );
}

// ---- In Home / Shared with me / Not linked: the server's scopes --------------------------------------------------------------------
/** A summary as a person row, so this device's outstanding saves fold over it as over a cached one. */
const rowOf = (summary: PersonSummary): CacheRow => ({
  id: summary.id,
  kind: "person",
  parent_id: null,
  label: summary.label,
  value: null,
  version: summary.version,
  policy_version: summary.policy_version,
  can_edit: summary.your_access !== "view",
  archived: summary.archived,
  kind_date: null,
});

function ScopeSteps({
  env,
  scope,
  changes,
  outstanding,
  onRetry,
  query,
  starts,
  onStarts,
  selectedId,
  openPerson,
}: {
  env: PeopleEnv;
  /** Where a row leads when the person opens beside the people (Settings · Layout, "How things open"). */
  openPerson?: (personId: string) => {
    to: "/people";
    search: { person: string };
  };

  scope: Exclude<SummaryScope, "all">;
  changes: Change[];
  outstanding: ChainResult<DraftWithCommand>;
  onRetry(): void;
  query: string;
  starts: (string | null)[];
  onStarts(starts: (string | null)[]): void;
  selectedId: string | null;
}) {
  const wanted = normalise(query);
  const start = starts.at(-1) ?? null;
  const byId = useMemo(() => changesById(changes), [changes]);
  // A search is over the names SHOWN (this device's unsent renames over the server's): the walk is asked again when they change.
  const shownName = (summary: PersonSummary) =>
    normalise(foldOne(rowOf(summary), byId).row.label);
  const renamed =
    wanted === ""
      ? ""
      : changes
          .filter(
            (change) => change.kind === "edit" && change.label !== undefined,
          )
          .map((change) => `${change.id}=${change.label}`)
          .sort()
          .join("\u0000");
  const view = useSummary<WalkedPages<PersonSummary>>(
    `people:${scope}:${start ?? ""}:${wanted}:${renamed}`,
    (current) =>
      walkPages(
        (after) =>
          env.api.readSummaries(scope, {
            after,
            limit: SUMMARY_PAGE,
            archived: false,
          }),
        {
          start,
          keep: (item) => wanted === "" || shownName(item).includes(wanted),
          limit: PEOPLE_STEP,
          pages: PEOPLE_STEP_PAGES,
        },
        current,
      ),
  );
  if (view.status === "offline")
    return <StatePanel state="view-offline" message={copy.VIEW_OFFLINE} />;
  if (view.status === "failed")
    return (
      <Banner
        message={copy.VIEW_FAILED}
        action={<Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>}
      />
    );
  const shown = shownOf(view);
  if (shown === null) return <Skeleton />;
  const { kept, next, end, home } = shown.value;
  if (scope === "in_home" && home === null)
    return <StatePanel state="no-home" message={copy.IN_HOME_NO_HOME} />;
  const rows = kept
    .map((summary) => ({ summary, row: foldOne(rowOf(summary), byId) }))
    .sort((a, b) => byName(a.row, b.row));
  const partial = !end && kept.length < PEOPLE_STEP;
  // Who is in a scope is the server's; whether nobody MATCHES a search also rests on this device's unsent renames being read.
  const claimable = wanted === "" || changesKnown(outstanding);
  return (
    <div className="flex flex-col gap-2" data-people-scope={scope}>
      <ChangesNotice outstanding={outstanding} onRetry={onRetry} />
      {rows.length === 0 && !claimable ? null : rows.length === 0 ? (
        <p
          data-people-state="no-match"
          className="text-sm text-muted-foreground"
        >
          {wanted !== ""
            ? end
              ? copy.NO_MATCH(query.trim())
              : copy.NO_MATCH_YET(query.trim())
            : scope === "in_home"
              ? copy.IN_HOME_EMPTY(home?.name ?? copy.FILTER_IN_HOME)
              : scope === "shared_with_me"
                ? copy.SHARED_WITH_ME_EMPTY
                : copy.NOT_LINKED_EMPTY}
        </p>
      ) : (
        <List className="flex flex-col">
          {rows.map(({ summary, row }) => (
            <PersonRow
              key={summary.id}
              row={row}
              summary={summary}
              count={
                <span
                  className="flex-none font-num text-xs text-muted-foreground"
                  data-field-count=""
                >
                  {copy.FIELD_COUNT(summary.field_count)}
                </span>
              }
              selected={summary.id === selectedId}
              {...(openPerson ? { open: openPerson } : {})}
            />
          ))}
        </List>
      )}
      {partial && rows.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-people-state="partial"
        >
          {copy.SEARCH_PARTIAL(rows.length)}
        </p>
      ) : null}
      <Steps
        onPrevious={
          starts.length > 1 ? () => onStarts(starts.slice(0, -1)) : null
        }
        onNext={
          !end && next !== null ? () => onStarts([...starts, next]) : null
        }
        partial={partial}
      />
      <SummaryNotes
        view={view}
        partial={kept.some((s) => s.audience.disclosure === "partial")}
      />
    </div>
  );
}

// ---- shared parts ---------------------------------------------------------------------------------------------------------------------
function Skeleton() {
  return (
    <div
      aria-busy="true"
      data-people-state="loading"
      className="flex flex-col gap-1.5"
    >
      {[0, 1, 2, 3, 4].map((n) => (
        <div
          key={n}
          className="min-h-[52px] rounded-[10px] border border-border bg-card"
        />
      ))}
    </div>
  );
}

/** The rows of a step in the Final design's groups: the people I added, then the people shared with me, then the rest. */
interface RowGroup {
  key: "home" | "yours" | "shared" | "rest";
  heading: string | null;
  rows: ShownRow[];
}

function groupRows(
  shown: ShownRow[],
  summaryOf: (row: ShownRow) => PersonSummary | null,
  grouped: boolean,
  home: string | null,
): RowGroup[] {
  if (!grouped) return [{ key: "rest", heading: null, rows: shown }];
  const inHome: ShownRow[] = [];
  const yours: ShownRow[] = [];
  const shared: ShownRow[] = [];
  const rest: ShownRow[] = [];
  for (const row of shown) {
    const summary = summaryOf(row);
    const attribution = summary === null ? null : attributionOf(summary);
    // The Final design's groups: the household you are in first (the people it can see), then just you, then shared with you.
    if (summary?.audience.in_home) inHome.push(row);
    else if (
      attribution?.kind === "you" ||
      attribution?.kind === "added_by_you"
    )
      yours.push(row);
    else if (attribution?.kind === "shared_by") shared.push(row);
    else rest.push(row);
  }
  const groups: RowGroup[] = [
    { key: "home", heading: copy.GROUP_HOME(home), rows: inHome },
    { key: "yours", heading: copy.GROUP_YOURS, rows: yours },
    { key: "shared", heading: copy.GROUP_SHARED, rows: shared },
    { key: "rest", heading: null, rows: rest },
  ].filter((group) => group.rows.length > 0) as RowGroup[];
  // Headings only once there is more than one group to tell apart.
  return groups.length > 1
    ? groups
    : groups.map((group) => ({ ...group, heading: null }));
}

function GroupedRows({
  groups,
  summaryOf,
  count,
  selectedId,
  openPerson,
}: {
  groups: RowGroup[];
  summaryOf: (row: ShownRow) => PersonSummary | null;
  count: (row: ShownRow) => ReactNode;
  selectedId: string | null;
  /** Where a row leads when the person opens beside the people (Settings · Layout, "How things open"). */
  openPerson?: (personId: string) => {
    to: "/people";
    search: { person: string };
  };
}) {
  const id = useId();
  return (
    <div className="flex flex-col" data-people-groups={String(groups.length)}>
      {groups.map((group) => (
        <section
          key={group.key}
          {...(group.heading === null
            ? {}
            : { "aria-labelledby": `${id}-${group.key}` })}
          data-people-group={group.key}
        >
          {group.heading === null ? null : (
            <RowGroupHeading id={`${id}-${group.key}`}>
              {group.heading}
            </RowGroupHeading>
          )}
          <List className="flex flex-col">
            {group.rows.map((row) => (
              <PersonRow
                key={row.row.id}
                row={row}
                summary={summaryOf(row)}
                count={count(row)}
                selected={row.row.id === selectedId}
                {...(openPerson ? { open: openPerson } : {})}
              />
            ))}
          </List>
        </section>
      ))}
    </div>
  );
}

function StatePanel({ state, message }: { state: string; message: string }) {
  return (
    <div
      data-people-state={state}
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm leading-[1.55] text-foreground">{message}</p>
    </div>
  );
}

function Steps({
  onPrevious,
  onNext,
  partial,
}: {
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  partial: boolean;
}) {
  if (onPrevious === null && onNext === null) return null;
  return (
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
  );
}

function linkageText(summary: PersonSummary): string {
  return summary.linkage === "you"
    ? copy.ROW_LINK_SELF
    : summary.linkage === "other"
      ? copy.ROW_LINK_OTHER
      : copy.ROW_LINK_NONE;
}

function attributionText(summary: PersonSummary): string | null {
  const attribution = attributionOf(summary);
  switch (attribution.kind) {
    case "you":
      return copy.YOU;
    case "added_by_you":
      return copy.ADDED_BY_YOU;
    case "shared_by":
      return copy.SHARED_BY(attribution.owner);
    case "none":
      return null;
  }
}

/**
 * One row (the Final design): the avatar, the name, one grey line of facts (who added them, their account, who can see them, as the
 * viewer-safe summary says), a badge only when something needs the reader (an unsent change), the field count and a chevron.
 */
function PersonRow({
  row,
  summary,
  count,
  selected,
  open,
}: {
  row: ShownRow;
  summary: PersonSummary | null;
  count: ReactNode;
  selected: boolean;
  open?: (personId: string) => { to: "/people"; search: { person: string } };
}) {
  const person = row.row;
  const attribution = summary === null ? null : attributionText(summary);
  return (
    <li className="list-none">
      <ListRow
        {...(open
          ? open(person.id)
          : { to: "/people/$personId", params: { personId: person.id } })}
        current={selected}
        data-person-row={person.id}
        data-status={selected ? "active" : undefined}
        className="py-1.5"
        leading={<PersonAvatar id={person.id} name={person.label} />}
        trailing={
          <>
            <PendingBadge mark={row.pending} />
            {count}
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 flex-none text-muted-foreground tablet:hidden"
            />
          </>
        }
      >
        <span className="block truncate leading-6" data-person-name="">
          {person.label}
        </span>
        {attribution !== null || summary !== null || person.archived ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs leading-5 text-muted-foreground">
            {/* The Final design (phase 13): the defaults ("Added by you", "Visible to: Only you") are said to screen readers alone;
                what the eye gets is the fact that differs. */}
            {attribution !== null ? (
              <span
                data-person-attribution=""
                className={attribution === copy.ADDED_BY_YOU ? "sr-only" : ""}
              >
                {attribution}
              </span>
            ) : null}
            {attribution !== null &&
            attribution !== copy.ADDED_BY_YOU &&
            summary !== null ? (
              <span aria-hidden="true">·</span>
            ) : null}
            {summary !== null ? (
              <span data-person-linkage="">
                <span className="sr-only">{copy.COLUMN_ACCOUNT}: </span>
                {linkageText(summary)}
              </span>
            ) : null}
            {summary !== null ? (
              <>
                {audienceText(summary.audience) === copy.ONLY_YOU ? null : (
                  <span aria-hidden="true">·</span>
                )}
                <span
                  data-person-audience={summary.audience.disclosure}
                  className={
                    audienceText(summary.audience) === copy.ONLY_YOU
                      ? "sr-only"
                      : ""
                  }
                >
                  {copy.VISIBLE_TO(audienceText(summary.audience))}
                </span>
              </>
            ) : null}
            {person.archived ? <span>{copy.ARCHIVED_TAG}</span> : null}
          </span>
        ) : null}
      </ListRow>
    </li>
  );
}

/**
 * The cached, non-archived fields of one person, from one page (a person with more says "100+"). Read with the person in ONE read
 * (PPL-5, review 15 R15.1): the row comes from the list's own read, which can answer a commit later than this one, so a person a newer
 * commit removed shows no count, never the fields that commit left or added.
 */
function FieldCount({ personId }: { personId: string }) {
  const read = useVisibleChildren({
    parentId: personId,
    parentKind: "person",
    kind: "field",
  });
  if (read.status !== "ready" || read.value === null) return null;
  const page = read.value;
  const count = page.rows.filter(
    (row: { merged: CacheRow }) => !row.merged.archived,
  ).length;
  return (
    <span
      className="flex-none font-num text-xs text-muted-foreground"
      data-field-count=""
    >
      {page.next === null
        ? copy.FIELD_COUNT(count)
        : `${copy.FIELD_COUNT(count)}+`}
    </span>
  );
}
