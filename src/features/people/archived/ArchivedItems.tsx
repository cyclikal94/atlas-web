import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import {
  type CacheRow,
  useCachedResource,
  useOptionalDataEnv,
} from "../../../data";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { archiveRequest } from "../model/commands";
import {
  type Change,
  changesById,
  changesOfAll,
  foldOne,
  type ShownRow,
} from "../model/project";
import { PendingBadge, useOutboxSave } from "../parts";
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
  return (
    <div className="flex max-w-[700px] flex-col gap-5" data-archived-items="">
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
        <CacheGate>
          <Ledger headingId={heading} />
        </CacheGate>
      )}
    </div>
  );
}

/**
 * The ledger: every registered kind's rows, and what their REPORTS say together (review 4, finding 5). "Nothing archived" only when every
 * kind of THIS reading reported `complete` with nothing shown; a kind that failed says so, with "Try again", which mounts every kind afresh
 * (new reads, not a cleared message); a report of an earlier reading is ignored.
 */
function Ledger({ headingId }: { headingId: string }) {
  const kinds = archivedLedgerKinds.list();
  const [reading, setReading] = useState(0);
  const current = useRef(reading);
  current.current = reading;
  const [reports, setReports] = useState<Record<string, LedgerReport>>({});
  // One STABLE reporter per kind and reading (a kind reports again whenever its reporter changes, and withdraws the old one).
  const reporters = useRef(
    new Map<string, (report: LedgerReport | null) => void>(),
  );
  const reportFor = (id: string, of: number) => {
    const name = `${id}:${of}`;
    let reporter = reporters.current.get(name);
    if (reporter === undefined) {
      reporter = (report) => {
        if (of !== current.current) return;
        setReports((previous) => {
          const known = previous[id];
          if (report === null) {
            if (known === undefined) return previous;
            const { [id]: _gone, ...rest } = previous;
            return rest;
          }
          return known?.count === report.count && known.state === report.state
            ? previous
            : { ...previous, [id]: report };
        });
      };
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
            onClick={() => {
              setReports({});
              setReading((n) => n + 1);
            }}
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
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const [message, setMessage] = useState<string | null>(null);
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
        {message ? (
          <span className="text-[12px] text-conflict-text">{message}</span>
        ) : null}
      </span>
      {shown.row.can_edit && !shown.projected ? (
        <Button
          variant="quiet"
          aria-describedby={nameId}
          data-people-action="ledger-restore"
          onClick={async () => {
            const outcome = await save((outbox) =>
              outbox.enqueue(
                archiveRequest({ id: shown.row.id, archived: false }),
              ),
            );
            if (outcome.ok) {
              setMessage(null);
              announcer.announce(copy.SAVED_NOT_SENT, "polite");
            } else if (outcome.message !== null) setMessage(outcome.message);
          }}
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

/** Whether a field's person is on this device and visible: `failed` when that could not be read (never "not visible"). */
type ParentState = "shown" | "hidden" | "failed";

function ArchivedFields({
  report,
}: {
  report(report: LedgerReport | null): void;
}) {
  const [visible, setVisible] = useState<Record<string, ParentState>>({});
  const onVisible = useCallback(
    (id: string, shown: ParentState) =>
      setVisible((previous) =>
        previous[id] === shown ? previous : { ...previous, [id]: shown },
      ),
    [],
  );
  return (
    <ArchivedSteps kind="field">
      {(rows, state, more) => {
        const parents = rows.map((row) => visible[row.row.id]);
        const count =
          parents.filter((parent) => parent === "shown").length +
          (more ? 1 : 0);
        const known: StepState = parents.includes("failed")
          ? "failed"
          : parents.includes(undefined)
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
                onVisible={onVisible}
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
  onVisible,
}: {
  shown: ShownRow;
  onVisible(id: string, shown: ParentState): void;
}) {
  const parentId = shown.row.parent_id ?? "";
  const parent = useCachedResource(parentId);
  const person: CacheRow | null =
    parent.status === "ready" && parent.value.merged?.kind === "person"
      ? parent.value.merged
      : null;
  // A person that could not be read hides the field's details all the same, but the inventory is then not complete.
  const state: ParentState | null =
    parent.status === "loading"
      ? null
      : parent.status === "unavailable"
        ? "failed"
        : person !== null
          ? "shown"
          : "hidden";
  useEffect(() => {
    if (state !== null) onVisible(shown.row.id, state);
  }, [state, shown.row.id, onVisible]);
  if (person === null) return null;
  return (
    <LedgerRow
      kindLabel={copy.KIND_FIELD}
      name={copy.FIELD_OF(shown.row.label, person.label)}
      shown={shown}
    />
  );
}

/** Reports a kind's state on every change, and withdraws it when the kind unmounts (no earlier count outlives its reading). */
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
  useEffect(() => {
    report({ count, state });
  }, [count, state, report]);
  useEffect(() => () => report(null), [report]);
  return <>{children}</>;
}

archivedLedgerKinds.register({ id: "person", order: 10, Rows: ArchivedPeople });
archivedLedgerKinds.register({ id: "field", order: 20, Rows: ArchivedFields });
