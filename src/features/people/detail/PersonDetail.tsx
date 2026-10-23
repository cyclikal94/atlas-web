import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import {
  useCachedResource,
  useConflictInbox,
  useSharingDefaults,
} from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import {
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  primaryHousehold,
} from "../model/audience";
import { archiveRequest } from "../model/commands";
import {
  type Change,
  changesById,
  changesOfAll,
  foldOne,
  foldRows,
  projectedRows,
  type ShownRow,
} from "../model/project";
import {
  audienceText,
  effectiveText,
  type FieldAudience,
  policyShownFor,
  summaryCurrentFor,
} from "../model/summary";
import { Banner, PendingBadge, useOutboxSave } from "../parts";
import { OutstandingChain, ResourceScan, type ScanResult } from "../reads";
import {
  type SummaryView,
  shownOf,
  useSummary,
  type WalkedPages,
  walkPages,
} from "../summaries";
import { SummaryNotes, timeOf } from "../summary-notes";
import { FieldValueView } from "./FieldValueView";
import { HeldChanges } from "./HeldChanges";
import { IdentityHeader } from "./IdentityHeader";
import { SharedWithSection } from "./SharedWith";

/**
 * WF-PEOPLE-02, the person detail (§4.3): the identity header, the fields table ("Field | Value | Who can see it"), "Add a field", the
 * "Shared with" rail, the "New fields start as" panel, the archived fields and the held audience changes. Everything shown comes from the
 * cache with this device's outstanding saves folded over it. A person the cache does not hold (and no save of this device creates) is "not
 * on this device", and NOTHING of theirs stays on screen (PPL-5: a field is shown only under its visible person). Who can see the person
 * and each field comes from the viewer-safe summaries while online (finding 8, `summaries.tsx`), never from owner-only policy reads.
 */
export interface PersonDetailSlots {
  /** WEB-11b: "Ask to link…" beside the header actions. */
  headerActions?: (personId: string) => ReactNode;
  /** WEB-11b: "Compare & merge" on each duplicate hint. */
  duplicateActions?: (personId: string, otherId: string) => ReactNode;
}

/** One step of the person's fields: at most 100 kept, from at most 10 pages; "Next fields" continues (Q9, finding 7). */
const FIELD_STEP = 100;
const FIELD_STEP_PAGES = 10;
const keepAll = () => true;

export function PersonDetail({
  personId,
  asPage,
  slots = {},
  children,
}: {
  personId: string;
  asPage: boolean;
  slots?: PersonDetailSlots;
  /** The field editor's route, rendered over the detail. */
  children?: ReactNode;
}) {
  const cached = useCachedResource(personId);
  return (
    <CacheGate>
      <OutstandingChain>
        {(outstanding) => {
          if (cached.status === "loading" || outstanding.status === "loading")
            return <DetailSkeleton />;
          const base =
            cached.status === "ready" &&
            cached.value.merged !== null &&
            cached.value.merged.kind === "person"
              ? [cached.value.merged]
              : [];
          const changes = changesOfAll(outstanding.rows);
          const shown = foldRows(base, changes, "person").find(
            (row) => row.row.id === personId,
          );
          if (shown === undefined) return <NotOnDevice />;
          return (
            <div
              className="flex min-w-0 flex-col gap-6"
              data-person-detail={personId}
            >
              <IdentityHeader
                shown={shown}
                asPage={asPage}
                drafts={outstanding.rows}
                {...(slots.headerActions
                  ? { headerActions: slots.headerActions }
                  : {})}
              />
              <Conflicts ids={[personId]} />
              <FieldsSection person={shown} changes={changes} />
              {shown.projected ? null : (
                <SharedWithSection personId={personId} />
              )}
              <DefaultsPanel />
              {children}
            </div>
          );
        }}
      </OutstandingChain>
    </CacheGate>
  );
}

function DetailSkeleton() {
  return (
    <div
      aria-busy="true"
      data-people-state="loading"
      className="flex flex-col gap-3"
    >
      <div className="min-h-12 w-48 rounded-row bg-panel" />
      {[0, 1, 2].map((n) => (
        <div
          key={n}
          className="min-h-12 rounded-row border border-hairline bg-panel"
        />
      ))}
    </div>
  );
}

function NotOnDevice() {
  return (
    <div
      data-people-state="not-on-device"
      className="flex max-w-[620px] flex-col items-start gap-3 rounded-row border border-hairline-strong bg-panel p-4"
    >
      <p className="text-[13.5px] leading-[1.55] text-ink-1">
        {copy.NOT_ON_DEVICE}
      </p>
      <Link
        to="/people"
        className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
      >
        {copy.BACK_TO_PEOPLE}
      </Link>
    </div>
  );
}

/** A write conflict of one of `ids` (a version conflict in the queue), shown in place, with the way to it. */
function Conflicts({ ids }: { ids: readonly string[] }) {
  const inbox = useConflictInbox();
  if (inbox.status !== "ready") return null;
  const mine = inbox.value.filter(
    (row) =>
      row.kind === "version_conflict" &&
      row.draft.index_targets.some((id) => ids.includes(id)),
  );
  if (mine.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {mine.map((row) => (
        <Banner
          key={row.draft.local_id}
          announce={false}
          message={
            row.draft.kind === "archive"
              ? copy.ARCHIVE_CONFLICT
              : row.draft.kind === "put_field"
                ? copy.FIELD_CONFLICT
                : copy.CONFLICT
          }
          action={
            <Link
              to="/sync"
              search={{ tab: "conflicts" }}
              className="min-h-11 text-[13px] text-action-ink underline"
            >
              {copy.RELOAD}
            </Link>
          }
        />
      ))}
    </div>
  );
}

function FieldsSection({
  person,
  changes,
}: {
  person: ShownRow;
  changes: Change[];
}) {
  const heading = useId();
  const personId = person.row.id;
  const reviewing = person.projected && person.pending === "reviewing";
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={heading} className="text-[17px] font-medium text-ink-1">
          {copy.FIELDS}
        </h3>
        <span className="ml-auto">
          {reviewing ? (
            <Button disabled reason={copy.CREATE_BLOCKED_REVIEW}>
              {copy.ADD_FIELD}
            </Button>
          ) : (
            <Link
              to="/people/$personId/fields/new"
              params={{ personId }}
              data-people-action="add-field"
              className="atlas-transition inline-flex min-h-11 items-center rounded-control bg-action-fill px-4 text-[13.5px] font-medium text-action-on hover:bg-action-hover"
            >
              {copy.ADD_FIELD}
            </Link>
          )}
        </span>
      </div>
      <FieldSteps person={person} changes={changes} />
      <HeldChanges personId={personId} />
    </section>
  );
}

/** The person's fields one bounded step at a time, with the way to the next and previous steps (every field stays reachable). */
function FieldSteps({
  person,
  changes,
}: {
  person: ShownRow;
  changes: Change[];
}) {
  const personId = person.row.id;
  // The cursors of the steps before this one (null: the first step), so "Previous fields" goes back without reading anything twice.
  const [starts, setStarts] = useState<(string | null)[]>([null]);
  const start = starts.at(-1) ?? null;
  const byId = changesById(changes);
  return (
    <ResourceScan
      kind="field"
      parentId={personId}
      start={start}
      keep={keepAll}
      limit={FIELD_STEP}
      pages={FIELD_STEP_PAGES}
    >
      {(step) => {
        const cached = step.rows.map((row) => foldOne(row, byId));
        // The fields only this device's queued creates project are shown once, with the first step.
        const rows =
          start === null
            ? [
                ...cached,
                ...projectedRows(
                  new Set(step.rows.map((row) => row.id)),
                  changes,
                  "field",
                  personId,
                ),
              ]
            : cached;
        const active = rows.filter((row) => !row.row.archived);
        const archived = rows.filter((row) => row.row.archived);
        return (
          <>
            <AudiencedRows
              step={step}
              start={start}
              rows={active}
              person={person}
              settled={step.settled || step.status !== "ready"}
            />
            {starts.length > 1 || (step.settled && step.next !== null) ? (
              <div className="flex flex-wrap gap-2" data-field-steps="">
                {starts.length > 1 ? (
                  <Button
                    data-people-action="previous-fields"
                    onClick={() => setStarts(starts.slice(0, -1))}
                  >
                    {copy.PREVIOUS_FIELDS}
                  </Button>
                ) : null}
                {step.settled && step.next !== null ? (
                  <Button
                    data-people-action="next-fields"
                    onClick={() => setStarts([...starts, step.next])}
                  >
                    {copy.NEXT_FIELDS}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <ArchivedFields rows={archived} />
          </>
        );
      }}
    </ResourceScan>
  );
}

/**
 * The fields of one step with who can see each: `GET /people/{id}/field-audiences` from the step's own start, page after page, until every
 * active field of the step was seen, a page passed the step's last id (both are in ascending id order), the end, or the step's page bound.
 * Read once the step has settled, and only for fields this device has synced.
 */
function AudiencedRows({
  step,
  start,
  rows,
  person,
  settled,
}: {
  step: ScanResult;
  start: string | null;
  rows: ShownRow[];
  person: ShownRow;
  settled: boolean;
}) {
  const env = usePeopleEnv();
  const personId = person.row.id;
  const ids = step.settled
    ? rows.filter((row) => !row.projected).map((row) => row.row.id)
    : [];
  const key =
    ids.length === 0 || person.projected
      ? null
      : `fields:${personId}:${start ?? ""}:${ids.join(",")}`;
  const view = useSummary<WalkedPages<FieldAudience>>(key, (current) => {
    const last = ids.reduce((a, b) => (b > a ? b : a), "");
    return walkPages(
      (after) =>
        env.api.readFieldAudiences(personId, {
          after,
          limit: FIELD_STEP,
          archived: false,
        }),
      {
        start,
        keep: () => false,
        limit: 1,
        pages: FIELD_STEP_PAGES,
        covered: (read, lastRead) =>
          ids.every((id) => read.has(id)) ||
          (lastRead !== null && lastRead >= last),
      },
      current,
    );
  });
  return (
    <FieldRows
      rows={rows}
      person={person}
      settled={settled}
      audiences={key === null ? null : view}
    />
  );
}

/** "Field | Value | Who can see it | actions" from tablet width: the template is a variable, so its rule in the shared stylesheet is short. */
const FIELD_COLUMNS = {
  "--field-columns": "minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) auto",
} as CSSProperties;

function FieldRows({
  rows,
  person,
  settled,
  audiences,
}: {
  rows: ShownRow[];
  person: ShownRow;
  /** The step's walk is over: only then does "no fields" mean anything (finding 5). */
  settled: boolean;
  /** Who can see each field (null: nothing to read). */
  audiences: SummaryView<WalkedPages<FieldAudience>> | null;
}) {
  if (rows.length === 0)
    return settled ? (
      <p className="text-[13px] text-ink-2">{copy.NO_FIELDS}</p>
    ) : null;
  const read =
    audiences === null ? null : (shownOf(audiences)?.value.read ?? null);
  // Shown beside a cached field only when it is not older than what this device shows.
  const audienceOf = (row: ShownRow): FieldAudience | null => {
    if (row.projected || read === null) return null;
    const summary = read.get(row.row.id) ?? null;
    return summary !== null && summaryCurrentFor(summary, row.row)
      ? summary
      : null;
  };
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-hidden="true"
        className="hidden gap-3 px-3 text-[12px] text-ink-2 tablet:grid tablet:grid-cols-(--field-columns)"
        style={FIELD_COLUMNS}
      >
        <span>{copy.COLUMN_FIELD}</span>
        <span>{copy.COLUMN_VALUE}</span>
        <span>{copy.COLUMN_AUDIENCE}</span>
        <span />
      </div>
      <List className="flex flex-col gap-1">
        {rows.map((row) => (
          <FieldRow
            key={row.row.id}
            field={row}
            person={person}
            summary={audienceOf(row)}
          />
        ))}
      </List>
      {audiences !== null ? (
        <SummaryNotes
          view={audiences}
          partial={rows.some(
            (row) => audienceOf(row)?.audience.disclosure === "partial",
          )}
          words={{
            offline: copy.FIELDS_SUMMARY_OFFLINE,
            failed: copy.FIELDS_SUMMARY_FAILED,
            checking: copy.FIELDS_SUMMARY_CHECKING,
          }}
          partialNote={copy.FIELDS_PARTIAL_NOTE}
        />
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  person,
  summary,
}: {
  field: ShownRow;
  person: ShownRow;
  /** Who can see it, from the field audiences (null: not known here now). */
  summary: FieldAudience | null;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const defaults = useSharingDefaults();
  const [sharing, setSharing] = useState(false);
  const row = field.row;
  const nameId = useId();
  const known = env.memory.policies.get(row.id);
  // What this page's policy read said, only while no later policy version of the field is known (review 3, finding 3: never an audience
  // the device already knows is old), and said with the time it was read (C6: never presented as live).
  const read =
    known !== undefined &&
    policyShownFor(known, row, env.memory.summaryFloors.get(row.id))
      ? known
      : undefined;
  const home = primaryHousehold(defaults.record);
  // The field audiences' own sharing first; else what this page's policy read said (D-11a-13); else the question.
  const audience =
    summary !== null
      ? audienceText(summary.audience)
      : read === undefined
        ? copy.AUDIENCE_UNKNOWN
        : audienceLabel(
            classify(read.policy, home?.id ?? null),
            home?.household?.name ?? null,
          );
  // A field's own sharing is an upper bound: who can actually see it is counted only when the summary may count it.
  const reach =
    summary === null
      ? null
      : (effectiveText(summary.effective, person.row.label) ??
        copy.FIELD_AUDIENCE_UPPER(person.row.label));
  const editable =
    !field.projected ||
    (field.createDraft !== null && field.pending === "not_sent");
  return (
    <li
      className="list-none rounded-row border border-hairline bg-panel px-3 py-2.5"
      data-field-row={row.id}
    >
      <div
        className="grid grid-cols-1 gap-2 tablet:grid-cols-(--field-columns) tablet:items-center tablet:gap-3"
        style={FIELD_COLUMNS}
      >
        <span className="flex flex-col gap-1">
          <span id={nameId} className="text-[13.5px] font-medium text-ink-1">
            {row.label}
          </span>
          <PendingBadge mark={field.pending} />
        </span>
        <FieldValueView raw={row.value} />
        <span className="flex flex-col items-start gap-1">
          {field.projected ? (
            <span className="text-[12.5px] text-ink-2">
              {copy.WAIT_FOR_SYNC_FIELD}
            </span>
          ) : (
            <button
              type="button"
              data-people-action="field-audience"
              data-field-audience={summary?.audience.disclosure ?? "unknown"}
              aria-describedby={nameId}
              onClick={() => setSharing(true)}
              className="atlas-transition min-h-11 rounded-control border border-hairline-strong px-3 text-left text-[12.5px] text-ink-1 hover:bg-row-hover"
            >
              {audience}
            </button>
          )}
          {summary === null && read !== undefined && !field.projected ? (
            <span className="text-[12px] text-ink-2" data-field-checked="">
              {copy.AUDIENCE_CHECKED_AT(timeOf(read.checkedAt))}
            </span>
          ) : null}
          {reach !== null ? (
            <span className="text-[12px] text-ink-2" data-field-reach="">
              {reach}
              {summary?.audience.disclosure === "partial"
                ? ` ${copy.FIELD_AUDIENCE_PARTIAL}`
                : ""}
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-start gap-1.5">
          {!row.can_edit ? (
            <Button disabled reason={copy.CANNOT_EDIT_FIELD}>
              {copy.EDIT}
            </Button>
          ) : !editable ? (
            <Button disabled reason={copy.WAIT_FOR_SYNC_FIELD}>
              {copy.EDIT}
            </Button>
          ) : (
            <Link
              to="/people/$personId/fields/$fieldId"
              params={{ personId: person.row.id, fieldId: row.id }}
              data-people-action="edit-field"
              aria-describedby={nameId}
              className="atlas-transition inline-flex min-h-11 items-center rounded-control border border-hairline-strong bg-raised px-4 text-[13.5px] text-ink-1 hover:bg-row-hover"
            >
              {copy.EDIT}
            </Link>
          )}
          {field.projected || !row.can_edit ? null : (
            <ArchiveFieldButton id={row.id} archived={false} nameId={nameId} />
          )}
        </span>
      </div>
      <Conflicts ids={[row.id]} />
      {field.projected ? null : (
        <ResourcePolicyEditor
          resourceId={row.id}
          open={sharing}
          onOpenChange={(open) => {
            setSharing(open);
            // What the editor sent (its commands are online, outside the queue) changes the summaries shown, and this page's own read of
            // the field's policy may be old now (C6): neither is shown again until read again.
            if (!open) {
              env.memory.policies.delete(row.id);
              env.memory.invalidateSummaries();
            }
          }}
        />
      )}
    </li>
  );
}

function ArchiveFieldButton({
  id,
  archived,
  nameId,
}: {
  id: string;
  archived: boolean;
  nameId: string;
}) {
  const env = usePeopleEnv();
  const announcer = useAnnouncer();
  const save = useOutboxSave();
  const [message, setMessage] = useState<string | null>(null);
  const label = archived ? copy.RESTORE : copy.ARCHIVE;
  if (!env.writable)
    return (
      <Button variant="quiet" disabled reason={copy.READ_ONLY_COMPAT}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="quiet"
        aria-describedby={nameId}
        data-people-action={archived ? "restore-field" : "archive-field"}
        onClick={async () => {
          const outcome = await save((outbox) =>
            outbox.enqueue(archiveRequest({ id, archived: !archived })),
          );
          if (outcome.ok) {
            setMessage(null);
            announcer.announce(copy.SAVED_NOT_SENT, "polite");
          } else if (outcome.message !== null) setMessage(outcome.message);
        }}
      >
        {label}
      </Button>
      {message ? (
        <span className="text-[12px] text-conflict-text">{message}</span>
      ) : null}
    </span>
  );
}

function ArchivedFields({ rows }: { rows: ShownRow[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-archived-fields="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="min-h-11 self-start text-[13px] text-ink-1 underline"
      >
        {copy.ARCHIVED_FIELDS(rows.length)}
      </button>
      <div id={id} hidden={!open}>
        {open ? (
          <List className="flex flex-col gap-1">
            {rows.map((row) => (
              <ArchivedFieldRow key={row.row.id} field={row} />
            ))}
          </List>
        ) : null}
      </div>
    </div>
  );
}

function ArchivedFieldRow({ field }: { field: ShownRow }) {
  const nameId = useId();
  return (
    <li className="flex list-none flex-wrap items-center gap-3 rounded-row border border-hairline px-3 py-2">
      <span id={nameId} className="text-[13px] text-ink-1">
        {field.row.label}
      </span>
      <PendingBadge mark={field.pending} />
      {field.row.can_edit && !field.projected ? (
        <span className="ml-auto">
          <ArchiveFieldButton id={field.row.id} archived nameId={nameId} />
        </span>
      ) : null}
    </li>
  );
}

/** "New fields start as" (§4.3): the resolved `field` template from the B5 record; unknown is never "Only you" (D-12a-16). */
function DefaultsPanel() {
  const defaults = useSharingDefaults();
  const label = fieldDefaultsLabel(defaults.record);
  const home = primaryHousehold(defaults.record);
  return (
    <section
      data-defaults-panel=""
      className="flex max-w-[620px] flex-col gap-1 rounded-row border border-hairline bg-panel p-3.5"
    >
      <h3 className="text-[13px] font-medium text-ink-1">
        {copy.NEW_FIELDS_START_AS}
      </h3>
      {label === null ? (
        <p className="text-[13px] text-ink-2">{copy.DEFAULTS_UNKNOWN}</p>
      ) : (
        <>
          <p className="text-[13.5px] text-ink-1">{label}</p>
          <p className="text-[12.5px] leading-[1.55] text-ink-2">
            {copy.DEFAULTS_EXPLAIN(home?.household?.name ?? "Home")}
          </p>
        </>
      )}
    </section>
  );
}
