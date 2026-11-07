import { Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../../components/ui/button";
import { GroupedBox, GroupedSection } from "../../../components/ui/grouped";
import { List } from "../../../components/ui/list";
import {
  useCachedResource,
  useConflictInbox,
  useSharingDefaults,
} from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import { CacheGate } from "../../sync/CacheGate";
import { ActivitySection } from "../activity/ActivitySection";
import { useArchiveAction } from "../archive";
import * as copy from "../copy";
import { usePeopleEnv } from "../env";
import {
  doubtPolicy,
  isCurrentMemory,
  notePolicy,
  useMemoryRevision,
} from "../memory";
import {
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  primaryHousehold,
} from "../model/audience";
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
import { Banner, PendingBadge } from "../parts";
import {
  type Child,
  ChildScan,
  ConfirmedAbsence,
  OutstandingChain,
  type Step,
} from "../reads";
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
import { useSteadyWhilePressed } from "./steady";

/**
 * WF-PEOPLE-02, the person detail (§4.3): the identity header, the fields table ("Field | Value | Who can see it"), "Add a field", the
 * "Shared with" rail, WEB-19's "Recent changes" (`activity/ActivitySection.tsx`), the "New fields start as" panel, the archived fields and
 * the held audience changes. Everything shown comes from the
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
  // "Try again" after a failed read reads afresh: new watches (a live query ends at its first error), never the failed answer again.
  const [reading, setReading] = useState(0);
  return (
    <CacheGate>
      <PersonRead
        key={reading}
        personId={personId}
        asPage={asPage}
        slots={slots}
        retry={() => setReading((value) => value + 1)}
      >
        {children}
      </PersonRead>
    </CacheGate>
  );
}

/**
 * The person's reads and what they establish (review 6, finding 2): "not on this device" only when the person's read COMPLETED without
 * them and every unsent change of this device was read; a failed read (or one that could not be completed) says so, with "Try again".
 */
function PersonRead({
  personId,
  asPage,
  slots,
  retry,
  children,
}: {
  personId: string;
  asPage: boolean;
  slots: PersonDetailSlots;
  retry(): void;
  children?: ReactNode;
}) {
  const cached = useCachedResource(personId);
  // A read answering during a press never moves the pressed action (review 6, finding 3): `[data-steady]` boxes keep their height.
  const root = useRef<HTMLDivElement>(null);
  useSteadyWhilePressed(root);
  return (
    <OutstandingChain witness={personId}>
      {(outstanding) => {
        if (cached.status === "loading" || outstanding.status === "loading")
          return <DetailSkeleton />;
        // An absent database holds nobody; a failed or closed one is not evidence of anything.
        if (cached.status === "unavailable" && cached.reason !== "absent")
          return (
            <ReadFailed message={copy.PERSON_READ_FAILED} onRetry={retry} />
          );
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
        // Every unsent change was read (an absent database holds none): only then is a field's (or the person's) absence evidence that
        // it is not there.
        const changesKnown =
          outstanding.status === "absent" ||
          (outstanding.status === "ready" && outstanding.complete);
        if (shown === undefined) {
          if (outstanding.status === "failed")
            return (
              <ReadFailed message={copy.PERSON_READ_FAILED} onRetry={retry} />
            );
          if (outstanding.capped)
            return (
              <ReadFailed message={copy.PERSON_UNCONFIRMED} onRetry={retry} />
            );
          if (!changesKnown) return <DetailSkeleton />;
          // Said only once ONE read of the cache and the unsent changes together agrees (DA7-12: the queue's read can answer before the
          // cache's when the person is published).
          return (
            <ConfirmedAbsence
              id={personId}
              limit={1}
              pages={1}
              absent={({ resource, drafts }) =>
                (resource === null || resource.kind !== "person") &&
                foldRows([], changesOfAll(drafts), "person").every(
                  (row) => row.row.id !== personId,
                )
              }
            >
              {(confirmation) =>
                confirmation === "absent" ? (
                  <NotOnDevice />
                ) : confirmation === "failed" ? (
                  <ReadFailed
                    message={copy.PERSON_READ_FAILED}
                    onRetry={retry}
                  />
                ) : (
                  <DetailSkeleton />
                )
              }
            </ConfirmedAbsence>
          );
        }
        // The unsent changes folded over the person and shown under them were read from a state in which the cache did NOT hold the person,
        // and they do not create the person either (WEB-11a review 16, R16.1): a later commit removed them, and the person's read has not
        // answered for it yet. Nothing of theirs is shown until the reads agree (PPL-5); nothing typed is lost (it lives in the drafts).
        if (
          outstanding.witnessed === false &&
          projectedRows(new Set(), changes, "person").every(
            (row) => row.row.id !== personId,
          )
        )
          return <DetailSkeleton />;
        return (
          <div
            ref={root}
            className="flex min-w-0 flex-col gap-6"
            data-person-detail={personId}
          >
            {/* Everything above the fields whose height depends on a read: one steady box. */}
            <div data-steady="" className="flex flex-col gap-6">
              <IdentityHeader
                shown={shown}
                asPage={asPage}
                drafts={outstanding.rows}
                {...(slots.headerActions
                  ? { headerActions: slots.headerActions }
                  : {})}
              />
              {outstanding.status === "failed" ? (
                <Banner
                  message={copy.CHANGES_READ_FAILED}
                  action={<Button onClick={retry}>{copy.TRY_AGAIN}</Button>}
                />
              ) : null}
              <Conflicts ids={[personId]} />
            </div>
            <GroupedBox data-person-sections="">
              <FieldsSection
                person={shown}
                changes={changes}
                changesKnown={changesKnown}
              />
              {shown.projected ? null : (
                <SharedWithSection personId={personId} />
              )}
              {shown.projected ? null : <ActivitySection personId={personId} />}
              <DefaultsPanel />
            </GroupedBox>
            {children}
          </div>
        );
      }}
    </OutstandingChain>
  );
}

function DetailSkeleton() {
  return (
    <div
      aria-busy="true"
      data-people-state="loading"
      className="flex flex-col gap-3"
    >
      <div className="min-h-12 w-48 rounded-lg bg-card" />
      {[0, 1, 2].map((n) => (
        <div
          key={n}
          className="min-h-12 rounded-lg border border-border bg-card"
        />
      ))}
    </div>
  );
}

function ReadFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry(): void;
}) {
  return (
    <div
      data-people-state="read-failed"
      className="flex max-w-[620px] flex-col items-start gap-3 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm leading-[1.55] text-foreground">{message}</p>
      <Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>
    </div>
  );
}

function NotOnDevice() {
  return (
    <div
      data-people-state="not-on-device"
      className="flex max-w-[620px] flex-col items-start gap-3 rounded-lg border border-border bg-card p-4"
    >
      <p className="text-sm leading-[1.55] text-foreground">
        {copy.NOT_ON_DEVICE}
      </p>
      <Link
        to="/people"
        className="atlas-transition inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm text-foreground hover:bg-accent"
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
              className="min-h-11 text-sm text-primary underline"
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
  changesKnown,
}: {
  person: ShownRow;
  changes: Change[];
  /** Every unsent change of this device was read (a field only a queued create projects may otherwise be missing). */
  changesKnown: boolean;
}) {
  const heading = useId();
  const personId = person.row.id;
  const reviewing = person.projected && person.pending === "reviewing";
  return (
    <GroupedSection
      aria-labelledby={heading}
      data-fields-section=""
      heading={<h3 id={heading}>{copy.FIELDS}</h3>}
    >
      <div className="flex flex-wrap items-center gap-3">
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
              className="atlas-transition inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {copy.ADD_FIELD}
            </Link>
          )}
        </span>
      </div>
      <FieldSteps
        person={person}
        changes={changes}
        changesKnown={changesKnown}
      />
      <HeldChanges personId={personId} />
    </GroupedSection>
  );
}

/** The person's fields one bounded step at a time, with the way to the next and previous steps (every field stays reachable). */
function FieldSteps({
  person,
  changes,
  changesKnown,
}: {
  person: ShownRow;
  changes: Change[];
  changesKnown: boolean;
}) {
  const personId = person.row.id;
  // The cursors of the steps before this one (null: the first step), so "Previous fields" goes back without reading anything twice.
  const [starts, setStarts] = useState<(string | null)[]>([null]);
  // "Try again" after a failed page reads the step afresh (new watches), from the same cursor.
  const [scan, setScan] = useState(0);
  const start = starts.at(-1) ?? null;
  const steps = {
    starts,
    onPrevious: () => setStarts(starts.slice(0, -1)),
    onNext: (next: string) => setStarts([...starts, next]),
    onRetry: () => setScan((value) => value + 1),
  };
  // A person only this device creates has no server fields: its fields are its own unsent creates. A projected person is never a permit
  // for a cached child (R16.1), so the cache is not read under them.
  if (person.projected)
    return (
      <FieldStep
        person={person}
        changes={changes}
        changesKnown={changesKnown}
        start={null}
        step={UNSENT_ONLY}
        steps={steps}
      />
    );
  return (
    <ChildScan
      key={scan}
      kind="field"
      parentKind="person"
      parentId={personId}
      start={start}
      keep={keepAll}
      limit={FIELD_STEP}
      pages={FIELD_STEP_PAGES}
    >
      {(step) => (
        <FieldStep
          person={person}
          changes={changes}
          changesKnown={changesKnown}
          start={start}
          step={step}
          steps={steps}
        />
      )}
    </ChildScan>
  );
}

/** The step of a person who exists only on this device: nothing cached, read to its end. */
const UNSENT_ONLY: Step<Child> = {
  status: "ready",
  rows: [],
  settled: true,
  next: null,
  end: true,
};

/**
 * One step of the person's fields. Each cached field is shown from what ONE read gave with it (`Child`: the row, the person held by that same
 * read, and the unsent changes over it), so a field changed or added by the commit that removed the person is never shown under the person
 * read before it (WEB-11a review 16, R16.1; PPL-5). A step whose read no longer holds the person shows nothing at all: not the fields an
 * earlier page kept, not this device's creates, not "No fields yet".
 */
function FieldStep({
  person,
  changes,
  changesKnown,
  start,
  step,
  steps,
}: {
  person: ShownRow;
  changes: Change[];
  changesKnown: boolean;
  start: string | null;
  step: Step<Child>;
  steps: {
    starts: readonly (string | null)[];
    onPrevious(): void;
    onNext(next: string): void;
    onRetry(): void;
  };
}) {
  if (step.hidden) return null;
  const personId = person.row.id;
  const cached = step.rows.map((child) =>
    foldOne(child.row, changesById(changesOfAll(child.drafts))),
  );
  // The fields only this device's queued creates project are shown once, with the first step.
  const rows =
    start === null
      ? [
          ...cached,
          ...projectedRows(
            new Set(step.rows.map((child) => child.row.id)),
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
        settledStep={step.settled}
        start={start}
        rows={active}
        person={person}
        // "No fields yet" only after a COMPLETED step and every unsent change read (review 6, finding 2): a failed page, one still
        // loading or an unread change is not "none".
        settled={step.settled && changesKnown}
      />
      {step.status === "failed" ? (
        <Banner
          message={copy.FIELDS_READ_FAILED}
          action={<Button onClick={steps.onRetry}>{copy.TRY_AGAIN}</Button>}
        />
      ) : null}
      {steps.starts.length > 1 || (step.settled && step.next !== null) ? (
        <div className="flex flex-wrap gap-2" data-field-steps="">
          {steps.starts.length > 1 ? (
            <Button
              data-people-action="previous-fields"
              onClick={steps.onPrevious}
            >
              {copy.PREVIOUS_FIELDS}
            </Button>
          ) : null}
          {step.settled && step.next !== null ? (
            <Button
              data-people-action="next-fields"
              onClick={() => steps.onNext(step.next as string)}
            >
              {copy.NEXT_FIELDS}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ArchivedFields rows={archived} />
    </>
  );
}

/**
 * The fields of one step with who can see each: `GET /people/{id}/field-audiences` from the step's own start, page after page, until every
 * active field of the step was seen, a page passed the step's last id (both are in ascending id order), the end, or the step's page bound.
 * Read once the step has settled, and only for fields this device has synced.
 */
function AudiencedRows({
  settledStep,
  start,
  rows,
  person,
  settled,
}: {
  /** The step's walk is over (only then are its fields' audiences read). */
  settledStep: boolean;
  start: string | null;
  rows: ShownRow[];
  person: ShownRow;
  settled: boolean;
}) {
  const env = usePeopleEnv();
  const personId = person.row.id;
  const ids = settledStep
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
      start={start}
      person={person}
      settled={settled}
      audiences={key === null ? null : view}
    />
  );
}

/** "Field | Value | Who can see it | actions" from tablet width: the template is a variable, so its rule in the shared stylesheet is short. */
const FIELD_COLUMNS = {
  "--field-columns": "minmax(0, 1fr) minmax(0, 1.6fr) minmax(0, 1.2fr) auto",
} as CSSProperties;

function FieldRows({
  rows,
  start,
  person,
  settled,
  audiences,
}: {
  rows: ShownRow[];
  /** Where the step began (null: the first). */
  start: string | null;
  person: ShownRow;
  /** The step's walk is over: only then does "no fields" mean anything (finding 5). */
  settled: boolean;
  /** Who can see each field (null: nothing to read). */
  audiences: SummaryView<WalkedPages<FieldAudience>> | null;
}) {
  if (rows.length === 0)
    return settled ? (
      // Said only once ONE read of the person's fields and the unsent changes together agrees (DA7-12).
      <ConfirmedAbsence
        kind="field"
        parentId={person.row.id}
        start={start}
        limit={FIELD_STEP}
        pages={FIELD_STEP_PAGES}
        absent={({ step: found, drafts }) => {
          if (found === null) return false;
          const changes = changesOfAll(drafts);
          const by = changesById(changes);
          return [
            ...found.rows.map((row) => foldOne(row, by)),
            ...(start === null
              ? projectedRows(
                  new Set(found.rows.map((row) => row.id)),
                  changes,
                  "field",
                  person.row.id,
                )
              : []),
          ].every((row) => row.row.archived);
        }}
      >
        {(confirmation) =>
          confirmation === "absent" ? (
            <p className="text-sm text-muted-foreground">{copy.NO_FIELDS}</p>
          ) : null
        }
      </ConfirmedAbsence>
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
    <div data-steady="" className="flex flex-col gap-1">
      <div
        aria-hidden="true"
        className="hidden gap-3 px-3 text-xs text-muted-foreground tablet:grid tablet:grid-cols-(--field-columns)"
        style={FIELD_COLUMNS}
      >
        <span>{copy.COLUMN_FIELD}</span>
        <span>{copy.COLUMN_VALUE}</span>
        <span>{copy.COLUMN_AUDIENCE}</span>
        <span />
      </div>
      <List className="flex flex-col divide-y divide-border">
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
  // Never one that may be out of date since the sharing editor was open on the field (review 23, R23.1).
  const read =
    known !== undefined &&
    !env.memory.policyDoubts.has(row.id) &&
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
      className="list-none px-3 py-2.5"
      data-field-row={row.id}
      data-steady=""
    >
      <div
        className="grid grid-cols-1 gap-2 tablet:grid-cols-(--field-columns) tablet:items-center tablet:gap-3"
        style={FIELD_COLUMNS}
      >
        <span className="flex flex-col gap-1">
          <span id={nameId} className="text-sm font-medium text-foreground">
            {row.label}
          </span>
          <PendingBadge mark={field.pending} />
        </span>
        <FieldValueView raw={row.value} />
        <span className="flex flex-col items-stretch gap-1">
          {field.projected ? (
            <span className="text-xs text-muted-foreground">
              {copy.WAIT_FOR_SYNC_FIELD}
            </span>
          ) : (
            <button
              type="button"
              data-people-action="field-audience"
              data-field-audience={summary?.audience.disclosure ?? "unknown"}
              aria-describedby={nameId}
              onClick={() => setSharing(true)}
              className="atlas-transition min-h-11 w-full rounded-md border border-border px-3 text-left text-xs text-foreground hover:bg-accent"
            >
              {audience}
            </button>
          )}
          {summary === null && read !== undefined && !field.projected ? (
            <span
              className="text-xs text-muted-foreground"
              data-field-checked=""
            >
              {copy.AUDIENCE_CHECKED_AT(timeOf(read.checkedAt))}
            </span>
          ) : null}
          {reach !== null ? (
            <span className="text-xs text-muted-foreground" data-field-reach="">
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
              className="atlas-transition inline-flex min-h-11 items-center rounded-md border border-border bg-card px-4 text-sm text-foreground hover:bg-accent"
            >
              {copy.EDIT}
            </Link>
          )}
          {field.projected || !row.can_edit ? null : (
            <ArchiveFieldButton
              id={row.id}
              archived={false}
              version={row.version}
              nameId={nameId}
            />
          )}
        </span>
      </div>
      <Conflicts ids={[row.id]} />
      {field.projected ? null : (
        <ResourcePolicyEditor
          resourceId={row.id}
          open={sharing}
          onPolicyRead={(policy) => {
            // What the editor read is what the server holds: this page's read of the field's policy (review 23, R23.1).
            if (!isCurrentMemory(env.memory)) return;
            notePolicy(env.memory, row.id, { ...policy, checkedAt: env.now() });
            env.memory.touch();
          }}
          onOpenChange={(open) => {
            setSharing(open);
            // What the editor sent (its commands are online, outside the queue) changes the summaries shown, and this page's own read of
            // the field's policy may be old now (C6): neither is shown again until read again. The read's version stays as the floor
            // nothing lower replaces (review 23, R23.1).
            if (!open && isCurrentMemory(env.memory)) {
              doubtPolicy(env.memory, row.id);
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
  version,
  nameId,
}: {
  id: string;
  archived: boolean;
  version: number;
  nameId: string;
}) {
  const env = usePeopleEnv();
  const label = archived ? copy.RESTORE : copy.ARCHIVE;
  // One archive or restore of the field at a time, whichever view asks (review 7, finding 1; review 8, finding 2).
  const action = useArchiveAction(id);
  if (!env.writable)
    return (
      <Button variant="ghost" disabled reason={copy.READ_ONLY_COMPAT}>
        {label}
      </Button>
    );
  if (action.pending)
    return (
      <Button variant="ghost" disabled reason={copy.SAVING}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="ghost"
        aria-describedby={nameId}
        data-people-action={archived ? "restore-field" : "archive-field"}
        onClick={() => void action.run(!archived, version)}
      >
        {label}
      </Button>
      {action.message ? (
        <span className="text-xs text-destructive">{action.message}</span>
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
        className="min-h-11 self-start text-sm text-foreground underline"
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
    <li className="flex list-none flex-wrap items-center gap-3 border-t border-border px-3 py-2">
      <span id={nameId} className="text-sm text-foreground">
        {field.row.label}
      </span>
      <PendingBadge mark={field.pending} />
      {field.row.can_edit && !field.projected ? (
        <span className="ml-auto">
          <ArchiveFieldButton
            id={field.row.id}
            archived
            version={field.row.version}
            nameId={nameId}
          />
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
  const heading = useId();
  return (
    <GroupedSection
      data-defaults-panel=""
      aria-labelledby={heading}
      heading={<h3 id={heading}>{copy.NEW_FIELDS_START_AS}</h3>}
      summary={label}
    >
      {label === null ? (
        <p className="text-sm text-muted-foreground">{copy.DEFAULTS_UNKNOWN}</p>
      ) : (
        <>
          <p className="text-sm text-foreground">{label}</p>
          <p className="text-xs leading-[1.55] text-muted-foreground">
            {copy.DEFAULTS_EXPLAIN(home?.household?.name ?? "Home")}
          </p>
        </>
      )}
    </GroupedSection>
  );
}
