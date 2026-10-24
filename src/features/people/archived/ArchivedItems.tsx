import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type CacheRow,
  useCachedResource,
  useOptionalDataEnv,
} from "../../../data";
import { CacheGate } from "../../sync/CacheGate";
import { useArchiveAction } from "../archive";
import * as copy from "../copy";
import { useSteadyWhilePressed } from "../detail/steady";
import { PeopleBoundary } from "../env";
import {
  type Change,
  changesById,
  changesOfAll,
  foldOne,
  type ShownRow,
} from "../model/project";
import { PendingBadge } from "../parts";
import { OutstandingChain, ResourceScan } from "../reads";
import { archivedLedgerKinds, type LedgerReport } from "./ledger";

/** "Kind | Name | Restore" (inline: a one-off column template would add a rule to the shared production stylesheet). */
const ARCHIVED_COLUMNS = { gridTemplateColumns: "96px minmax(0, 1fr) auto" };

/**
 * Settings → "Archived items" (Q21 gap 9, `archive-restore.html`; D-11a-11): "Kind | Name" with "Restore" per row, no date column (the
 * projection has no `archived_at`). People and fields are WEB-11a's kinds; other slices add theirs through `archivedLedgerKinds`. A field
 * is listed only while its person is on this device and visible (PPL-5), named with its person ("Old emergency contact · Mo").
 */
const LEDGER_STEP = 100;
const LEDGER_STEP_PAGES = 50;

export function ArchivedItems() {
  const env = useOptionalDataEnv();
  const heading = useId();
  // A press on Restore (or a link) is not lost to a report that answers during it (review 7, finding 3): the pressed action keeps its place.
  const root = useRef<HTMLDivElement>(null);
  useSteadyWhilePressed(root);
  return (
    <div
      ref={root}
      className="flex max-w-[700px] flex-col gap-5"
      data-archived-items=""
    >
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-[13.5px] text-ink-2 hover:text-ink-1"
        >
          Settings
        </Link>
        <PageHeading>{copy.ARCHIVED_ITEMS}</PageHeading>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {copy.ARCHIVED_NOTE}
        </p>
      </div>
      {env === null ? null : (
        // The people env of the displayed identity, outside the cache gate: a restore's claim lives in its page memory (review 8,
        // finding 2), and no identity shown means no ledger.
        <PeopleBoundary>
          <CacheGate>
            <Ledger headingId={heading} />
          </CacheGate>
        </PeopleBoundary>
      )}
    </div>
  );
}

/**
 * The ledger: every registered kind's rows, and what their REPORTS say together (review 4, finding 5). "Nothing archived" only when every
 * kind of THIS reading reported `complete` with nothing shown; a kind that failed says so, with "Try again", which mounts every kind afresh
 * (new reads, not a cleared message). A report of an earlier reading is ignored when it is APPLIED, not only when it is made (review 5,
 * finding 2): the reading and its reports are one state.
 */
export interface LedgerState {
  reading: number;
  reports: Record<string, LedgerReport>;
}

/** A kind's report (or its withdrawal, null) of reading `of`, applied to the ledger now: nothing when the ledger reads afresh since. */
export function ledgerReported(
  previous: LedgerState,
  of: number,
  id: string,
  report: LedgerReport | null,
): LedgerState {
  if (previous.reading !== of) return previous;
  const known = previous.reports[id];
  if (report === null) {
    if (known === undefined) return previous;
    const { [id]: _gone, ...rest } = previous.reports;
    return { reading: of, reports: rest };
  }
  return known?.count === report.count && known.state === report.state
    ? previous
    : { reading: of, reports: { ...previous.reports, [id]: report } };
}

function Ledger({ headingId }: { headingId: string }) {
  const kinds = archivedLedgerKinds.list();
  const [ledger, setLedger] = useState<LedgerState>({
    reading: 0,
    reports: {},
  });
  const { reading, reports } = ledger;
  // One STABLE reporter per kind and reading (a kind reports again whenever its reporter changes, and withdraws the old one).
  const reporters = useRef(
    new Map<string, (report: LedgerReport | null) => void>(),
  );
  const reportFor = (id: string, of: number) => {
    const name = `${id}:${of}`;
    let reporter = reporters.current.get(name);
    if (reporter === undefined) {
      reporter = (report) =>
        setLedger((previous) => ledgerReported(previous, of, id, report));
      reporters.current.set(name, reporter);
    }
    return reporter;
  };
  const total = Object.values(reports).reduce(
    (sum, report) => sum + report.count,
    0,
  );
  const failed = Object.values(reports).some(
    (report) => report.state === "failed",
  );
  const complete = kinds.every(
    (kind) => reports[kind.id]?.state === "complete",
  );
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="sr-only">
        {copy.ARCHIVED_ITEMS}
      </h2>
      <div
        aria-hidden="true"
        className="grid gap-3 px-3 text-[12px] text-ink-2"
        style={ARCHIVED_COLUMNS}
      >
        <span>{copy.COLUMN_KIND}</span>
        <span>{copy.COLUMN_NAME}</span>
        <span />
      </div>
      <List className="flex flex-col gap-1">
        {kinds.map((kind) => (
          <kind.Rows
            key={`${kind.id}:${reading}`}
            report={reportFor(kind.id, reading)}
          />
        ))}
      </List>
      {failed ? (
        <div
          data-archived-state="failed"
          className="flex flex-col items-start gap-2"
        >
          <p className="text-[13px] leading-[1.6] text-ink-2">
            {copy.ARCHIVED_FAILED}
          </p>
          <Button
            onClick={() =>
              setLedger((previous) => ({
                reading: previous.reading + 1,
                reports: {},
              }))
            }
          >
            {copy.TRY_AGAIN}
          </Button>
        </div>
      ) : complete && total === 0 ? (
        <p
          data-archived-state="empty"
          className="text-[13px] leading-[1.6] text-ink-2"
        >
          {copy.ARCHIVED_EMPTY}
        </p>
      ) : null}
    </section>
  );
}

function LedgerRow({
  kindLabel,
  name,
  shown,
}: {
  kindLabel: string;
  name: string;
  shown: ShownRow;
}) {
  // One restore of the target at a time, whichever view asks (review 8, finding 2): the claim and what it said are the identity's page
  // memory's, not this row's, so a remounted row (another reading or page of the ledger, its parent read again, the tree remounted) still
  // shows it as saving, and the detail's buttons of the same target wait for it too.
  const action = useArchiveAction(shown.row.id);
  const nameId = useId();
  return (
    <li
      data-archived-row={shown.row.id}
      className="grid list-none items-center gap-3 rounded-row border border-hairline px-3 py-2"
      style={ARCHIVED_COLUMNS}
    >
      <span className="text-[12.5px] text-ink-2">{kindLabel}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span id={nameId} className="truncate text-[13.5px] text-ink-1">
          {name}
        </span>
        <PendingBadge mark={shown.pending} />
        {action.message ? (
          <span className="text-[12px] text-conflict-text">
            {action.message}
          </span>
        ) : null}
      </span>
      {shown.row.can_edit && !shown.projected && action.pending ? (
        <Button variant="quiet" disabled reason={copy.SAVING}>
          {copy.RESTORE}
        </Button>
      ) : shown.row.can_edit && !shown.projected ? (
        <Button
          variant="quiet"
          aria-describedby={nameId}
          data-people-action="ledger-restore"
          onClick={() => void action.run(false, shown.row.version)}
        >
          {copy.RESTORE}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

/** Archived rows of one kind, one bounded step at a time, with "Next items" / "Previous items" (Q9, finding 7): every one reachable. */
/** What one step knows: `complete` only when its rows AND the drafts folded over them were read whole. */
type StepState = LedgerReport["state"];

function ArchivedSteps({
  kind,
  children,
}: {
  kind: "person" | "field";
  /** `more`: there is a step to move to (a kind with one is never "empty"). */
  children(rows: ShownRow[], state: StepState, more: boolean): ReactNode;
}) {
  const [starts, setStarts] = useState<(string | null)[]>([null]);
  const start = starts.at(-1) ?? null;
  return (
    <OutstandingChain>
      {(outstanding) => (
        <ArchivedStep
          kind={kind}
          changes={changesOfAll(outstanding.rows)}
          drafts={
            outstanding.status === "failed" ||
            (outstanding.status === "ready" && !outstanding.complete)
              ? "failed"
              : outstanding.complete
                ? "complete"
                : "loading"
          }
          start={start}
          onPrevious={
            starts.length > 1 ? () => setStarts(starts.slice(0, -1)) : null
          }
          onNext={(next) => setStarts([...starts, next])}
        >
          {children}
        </ArchivedStep>
      )}
    </OutstandingChain>
  );
}

function ArchivedStep({
  kind,
  changes,
  drafts,
  start,
  onPrevious,
  onNext,
  children,
}: {
  kind: "person" | "field";
  changes: Change[];
  /** The outstanding drafts folded over the rows: read whole, still loading, or failed (or past their bound). */
  drafts: StepState;
  start: string | null;
  onPrevious: (() => void) | null;
  onNext(next: string): void;
  /** `more`: there is a step to move to (a kind with one is never "empty"). */
  children(rows: ShownRow[], state: StepState, more: boolean): ReactNode;
}) {
  const byId = useMemo(() => changesById(changes), [changes]);
  const keep = useCallback(
    (row: CacheRow) => foldOne(row, byId).row.archived,
    [byId],
  );
  return (
    <ResourceScan
      kind={kind}
      start={start}
      keep={keep}
      limit={LEDGER_STEP}
      pages={LEDGER_STEP_PAGES}
    >
      {(step) => {
        const rows = step.rows.map((row) => foldOne(row, byId));
        const next = step.settled ? step.next : null;
        // A failed read is never a settled inventory (review 4, finding 5): its rows so far are shown, and the step says it failed.
        const state: StepState =
          step.status === "failed" || drafts === "failed"
            ? "failed"
            : step.settled && drafts === "complete"
              ? "complete"
              : "loading";
        return (
          <>
            {children(rows, state, onPrevious !== null || next !== null)}
            {onPrevious !== null || next !== null ? (
              <li
                className="flex list-none flex-wrap gap-2"
                data-ledger-steps={kind}
              >
                {onPrevious !== null ? (
                  <Button onClick={onPrevious}>{copy.PREVIOUS_ITEMS}</Button>
                ) : null}
                {next !== null ? (
                  <Button onClick={() => onNext(next)}>
                    {copy.NEXT_ITEMS}
                  </Button>
                ) : null}
              </li>
            ) : null}
          </>
        );
      }}
    </ResourceScan>
  );
}

function ArchivedPeople({
  report,
}: {
  report(report: LedgerReport | null): void;
}) {
  return (
    <ArchivedSteps kind="person">
      {(rows, state, more) => (
        <Reported
          count={rows.length + (more ? 1 : 0)}
          state={state}
          report={report}
        >
          {rows.map((row) => (
            <LedgerRow
              key={row.row.id}
              kindLabel={copy.KIND_PERSON}
              name={row.row.label}
              shown={row}
            />
          ))}
        </Reported>
      )}
    </ArchivedSteps>
  );
}

/**
 * What a field's parent read says now (review 5, finding 2): `loading` until it answers, `shown` (a person this device holds and can
 * see), `hidden` (none: PPL-5) or `failed` (it could not be read: never "not visible").
 */
export type ParentState = "loading" | "shown" | "hidden" | "failed";

/**
 * One field row's report of its parent read, owned by that row's CURRENT read of THAT parent: `owner` is new for every mount and every
 * parent the row reads (a later owner of the field outranks an earlier one), and `parent` is the parent read. A report counts only while
 * its field is listed with that parent; anything else (no report, another parent, an earlier owner) is still loading.
 */
export interface ParentReport {
  owner: number;
  parent: string;
  state: ParentState;
}
let parentOwners = 0;

/**
 * Owner `owner`'s report of `field` (or its withdrawal, null), applied to the CURRENT reports: an earlier owner neither replaces a later
 * one's report nor withdraws it.
 */
export function parentReported(
  previous: ReadonlyMap<string, ParentReport>,
  field: string,
  owner: number,
  next: Omit<ParentReport, "owner"> | null,
): ReadonlyMap<string, ParentReport> {
  const known = previous.get(field);
  if (known !== undefined && known.owner > owner) return previous;
  if (next === null) {
    if (known?.owner !== owner) return previous;
    const rest = new Map(previous);
    rest.delete(field);
    return rest;
  }
  if (
    known?.owner === owner &&
    known.parent === next.parent &&
    known.state === next.state
  )
    return previous;
  return new Map(previous).set(field, { owner, ...next });
}

function ArchivedFields({
  report,
}: {
  report(report: LedgerReport | null): void;
}) {
  const [parents, setParents] = useState<ReadonlyMap<string, ParentReport>>(
    () => new Map(),
  );
  const onParent = useCallback(
    (field: string, owner: number, next: Omit<ParentReport, "owner"> | null) =>
      setParents((previous) => parentReported(previous, field, owner, next)),
    [],
  );
  return (
    <ArchivedSteps kind="field">
      {(rows, state, more) => {
        const states = rows.map((row) => {
          const known = parents.get(row.row.id);
          return known !== undefined &&
            known.parent === (row.row.parent_id ?? "")
            ? known.state
            : "loading";
        });
        const count =
          states.filter((parent) => parent === "shown").length + (more ? 1 : 0);
        const known: StepState = states.includes("failed")
          ? "failed"
          : states.includes("loading")
            ? "loading"
            : "complete";
        return (
          <Reported
            count={count}
            state={
              state === "failed" || known === "failed"
                ? "failed"
                : state === "complete" && known === "complete"
                  ? "complete"
                  : "loading"
            }
            report={report}
          >
            {rows.map((row) => (
              <FieldLedgerRow
                key={row.row.id}
                shown={row}
                onParent={onParent}
              />
            ))}
          </Reported>
        );
      }}
    </ArchivedSteps>
  );
}

/** PPL-5: a field is listed only under a person this device holds and can see. */
function FieldLedgerRow({
  shown,
  onParent,
}: {
  shown: ShownRow;
  onParent(
    field: string,
    owner: number,
    next: Omit<ParentReport, "owner"> | null,
  ): void;
}) {
  const field = shown.row.id;
  const parentId = shown.row.parent_id ?? "";
  const parent = useCachedResource(parentId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new owner for every parent this row reads (and every mount)
  const owner = useMemo(() => ++parentOwners, [parentId]);
  const person: CacheRow | null =
    parent.status === "ready" && parent.value.merged?.kind === "person"
      ? parent.value.merged
      : null;
  // The row and its report come from the SAME read: what is listed is what is counted. A person that could not be read hides the
  // field's details all the same, but the inventory is then not complete; one still on its way is not complete either.
  const state: ParentState =
    parent.status === "loading"
      ? "loading"
      : parent.status === "unavailable"
        ? "failed"
        : person !== null
          ? "shown"
          : "hidden";
  // Published (and withdrawn) before the browser paints: the ledger never shows an answer of an earlier read as the current one.
  useLayoutEffect(() => {
    onParent(field, owner, { parent: parentId, state });
  }, [onParent, field, owner, parentId, state]);
  useLayoutEffect(
    () => () => onParent(field, owner, null),
    [onParent, field, owner],
  );
  if (person === null) return null;
  return (
    <LedgerRow
      kindLabel={copy.KIND_FIELD}
      name={copy.FIELD_OF(shown.row.label, person.label)}
      shown={shown}
    />
  );
}

/**
 * Reports a kind's state on every change, and withdraws it when the kind unmounts (no earlier count outlives its reading). Both before the
 * browser paints (review 5, finding 2): an inner report that changed reaches the ledger in the same commit.
 */
function Reported({
  count,
  state,
  report,
  children,
}: {
  count: number;
  state: StepState;
  report(report: LedgerReport | null): void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    report({ count, state });
  }, [count, state, report]);
  useLayoutEffect(() => () => report(null), [report]);
  return <>{children}</>;
}

archivedLedgerKinds.register({ id: "person", order: 10, Rows: ArchivedPeople });
archivedLedgerKinds.register({ id: "field", order: 20, Rows: ArchivedFields });
