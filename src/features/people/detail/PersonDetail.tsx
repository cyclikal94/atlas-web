import { Link } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import {
  type CacheRow,
  useCachedResource,
  useConflictInbox,
  useFormCopies,
  useSharingDefaults,
} from "../../../data";
import { ResourcePolicyEditor } from "../../sharing";
import { CacheGate } from "../../sync/CacheGate";
import * as copy from "../copy";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { runHeldChange } from "../field/held";
import {
  decodeHeld,
  type HeldChange,
  type HeldFailure,
  heldPrefixOf,
} from "../field/held-store";
import { type HeldRun, isCurrentMemory, useMemoryRevision } from "../memory";
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
import { Banner, PendingBadge, useOutboxSave } from "../parts";
import { OutstandingChain, ResourceScan } from "../reads";
import { FieldValueView } from "./FieldValueView";
import { IdentityHeader } from "./IdentityHeader";

/**
 * WF-PEOPLE-02, the person detail (§4.3): the identity header, the fields table ("Field | Value | Who can see it"), "Add a field", the
 * "New fields start as" panel, the archived fields and the held audience changes. Everything shown comes from the cache with this
 * device's outstanding saves folded over it. A person the cache does not hold (and no save of this device creates) is "not on this
 * device", and NOTHING of theirs stays on screen (PPL-5: a field is shown only under its visible person).
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
            <FieldRows
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

function FieldRows({
  rows,
  person,
  settled,
}: {
  rows: ShownRow[];
  person: ShownRow;
  /** The step's walk is over: only then does "no fields" mean anything (finding 5). */
  settled: boolean;
}) {
  if (rows.length === 0)
    return settled ? (
      <p className="text-[13px] text-ink-2">{copy.NO_FIELDS}</p>
    ) : null;
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-hidden="true"
        className="hidden gap-3 px-3 text-[12px] text-ink-2 tablet:grid tablet:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto]"
      >
        <span>{copy.COLUMN_FIELD}</span>
        <span>{copy.COLUMN_VALUE}</span>
        <span>{copy.COLUMN_AUDIENCE}</span>
        <span />
      </div>
      <List className="flex flex-col gap-1">
        {rows.map((row) => (
          <FieldRow key={row.row.id} field={row} person={person} />
        ))}
      </List>
    </div>
  );
}

function FieldRow({ field, person }: { field: ShownRow; person: ShownRow }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const defaults = useSharingDefaults();
  const [sharing, setSharing] = useState(false);
  const row = field.row;
  const nameId = useId();
  const read = env.memory.policies.get(row.id);
  const home = primaryHousehold(defaults.record);
  const audience =
    read === undefined
      ? copy.AUDIENCE_UNKNOWN
      : audienceLabel(
          classify(read.policy, home?.id ?? null),
          home?.household?.name ?? null,
        );
  const editable =
    !field.projected ||
    (field.createDraft !== null && field.pending === "not_sent");
  return (
    <li
      className="list-none rounded-row border border-hairline bg-panel px-3 py-2.5"
      data-field-row={row.id}
    >
      <div className="grid grid-cols-1 gap-2 tablet:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto] tablet:items-center tablet:gap-3">
        <span className="flex flex-col gap-1">
          <span id={nameId} className="text-[13.5px] font-medium text-ink-1">
            {row.label}
          </span>
          <PendingBadge mark={field.pending} />
        </span>
        <FieldValueView raw={row.value} />
        <span>
          {field.projected ? (
            <span className="text-[12.5px] text-ink-2">
              {copy.WAIT_FOR_SYNC_FIELD}
            </span>
          ) : (
            <button
              type="button"
              data-people-action="field-audience"
              aria-describedby={nameId}
              onClick={() => setSharing(true)}
              className="atlas-transition min-h-11 rounded-control border border-hairline-strong px-3 text-left text-[12.5px] text-ink-1 hover:bg-row-hover"
            >
              {audience}
            </button>
          )}
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
          onOpenChange={setSharing}
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

/**
 * The audience changes held for this person's fields (D-11a-12), DURABLE in the account's database (`field/held-store.ts`, finding 6),
 * with their state and "Try again" / "Discard". While the page is open, online and writable, waiting ones run one at a time
 * (`runHeldChange`), by one page of the browser at a time (`exclusive`): the audience first, then the content. Each runs against a DIRECT
 * read of its own field (a complete answer for that one row), never against a list that may still be loading (finding 5).
 */
function HeldChanges({ personId }: { personId: string }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const copies = useFormCopies(heldPrefixOf(personId));
  if (copies.status !== "ready" || copies.value.copies.length === 0)
    return null;
  return (
    <List className="flex flex-col gap-2" data-held-changes="">
      {copies.value.copies.map((row) => {
        const change = decodeHeld(row);
        return change === null || change.personId !== personId ? (
          <UnreadableHeld
            key={row.tab_instance_id}
            formContext={row.form_context}
            holdId={row.tab_instance_id}
          />
        ) : (
          <HeldRow key={change.holdId} env={env} change={change} />
        );
      })}
    </List>
  );
}

function UnreadableHeld({
  formContext,
  holdId,
}: {
  formContext: string;
  holdId: string;
}) {
  const env = usePeopleEnv();
  const [, personId = "", fieldId = ""] = formContext.split(":");
  return (
    <li
      data-held-change={holdId}
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">{copy.HELD_UNREADABLE}</p>
      <Button
        variant="quiet"
        onClick={() => void env.held.discard({ personId, fieldId, holdId })}
      >
        {copy.DISCARD}
      </Button>
    </li>
  );
}

function HeldRow({ env, change }: { env: PeopleEnv; change: HeldChange }) {
  const memory = env.memory;
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const field = useCachedResource(change.fieldId);
  const current: CacheRow | null =
    field.status === "ready" &&
    field.value.merged?.kind === "field" &&
    field.value.merged.parent_id === change.personId
      ? field.value.merged
      : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  // Listed while this row is mounted: the hold was not finished or discarded by another page meanwhile (that removes it from the list).
  const listed = useRef(true);
  useEffect(() => {
    listed.current = true;
    return () => {
      listed.current = false;
    };
  }, []);
  // A run that came back `waiting` (not sent) runs again only when the env changes (online again, another identity): never in a loop.
  const [pausedFor, setPausedFor] = useState<PeopleEnv | null>(null);
  const [failure, setFailure] = useState<HeldFailure | null>(
    change.status.kind === "failed" ? change.status.reason : null,
  );
  const run = memory.heldRuns.get(change.holdId);
  const fieldSettled = field.status !== "loading";
  const start = useCallback(() => {
    if (memory.heldRuns.size > 0 || memory.heldEnded.has(change.holdId)) return;
    const mine: HeldRun = {
      holdId: change.holdId,
      cancelled: false,
      policyDone: false,
    };
    memory.heldRuns.set(change.holdId, mine);
    memory.touch();
    const held: HeldChange = { ...change, status: { kind: "waiting" } };
    const hold = {
      personId: change.personId,
      fieldId: change.fieldId,
      holdId: change.holdId,
    };
    const finish = async () => {
      const result = await env.exclusive(
        `atlas-people-held:${env.accountId}:${change.holdId}`,
        () =>
          runHeldChange(env, held, mine, {
            current: () => currentRef.current,
            listed: () => listed.current,
            persist: (next) => env.held.save(next),
            enqueue: save,
          }),
      );
      // What the run decided is made durable BEFORE the run lets go: until then no other run of this hold can start on this page.
      const current = isCurrentMemory(memory);
      let message: string | null = null;
      if (current && result !== null)
        switch (result.kind) {
          case "done":
            memory.heldEnded.add(change.holdId);
            await env.held.discard(hold);
            message = copy.SAVED_NOT_SENT;
            break;
          case "failed":
            // Written back only while the hold is still listed: a hold another page ended is never brought back.
            if (listed.current)
              await env.held.save({
                ...held,
                status: { kind: "failed", reason: result.reason },
              });
            break;
          case "cancelled":
            if (!mine.cancelled) break;
            // The person discarded it while it ran: it ends here, and what was already done is said truthfully.
            memory.heldEnded.add(change.holdId);
            await env.held.discard(hold);
            if (held.attempt !== null)
              memory.attempts.set(`policy:${change.fieldId}`, held.attempt);
            message = result.policyDone
              ? copy.HELD_POLICY_DONE(change.label)
              : held.attempt !== null
                ? copy.HELD_POLICY_UNCERTAIN(change.label)
                : copy.HELD_STOPPED(change.label);
            break;
          case "waiting":
            break;
        }
      if (memory.heldRuns.get(change.holdId) === mine)
        memory.heldRuns.delete(change.holdId);
      if (!current) return;
      // Another page runs it (no lock), or it was not sent: this page waits until the env changes.
      if (result === null || result.kind === "waiting") setPausedFor(env);
      else if (result.kind === "failed") setFailure(result.reason);
      if (message !== null) announcer.announce(message, "polite");
      memory.touch();
    };
    void finish();
  }, [env, memory, change, save, announcer]);
  const ended = memory.heldEnded.has(change.holdId);
  useEffect(() => {
    if (
      ended ||
      failure !== null ||
      run !== undefined ||
      !fieldSettled ||
      !env.online ||
      !env.writable ||
      pausedFor === env
    )
      return;
    start();
  }, [ended, failure, run, fieldSettled, env, pausedFor, start]);
  const stopping = run?.cancelled === true;
  if (ended && run === undefined) return null;
  return (
    <li
      data-held-change={change.holdId}
      data-held-field={change.fieldId}
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">
        {stopping
          ? copy.HELD_STOPPING(change.label)
          : run !== undefined
            ? copy.HELD_RUNNING(change.label)
            : copy.HELD_WAITING(change.label)}
      </p>
      {failure !== null && run === undefined ? (
        <p className="text-[12.5px] text-conflict-text">
          {copy.HELD_FAILED[failure]}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {failure !== null && run === undefined ? (
          <Button
            onClick={() => {
              setFailure(null);
              setPausedFor(null);
              void env.held.save({ ...change, status: { kind: "waiting" } });
            }}
          >
            {copy.TRY_AGAIN}
          </Button>
        ) : null}
        {stopping ? (
          <Button variant="quiet" disabled reason={copy.SAVING}>
            {copy.DISCARD}
          </Button>
        ) : (
          <Button
            variant="quiet"
            onClick={() => {
              if (run !== undefined) {
                // Running: the run stops at its next admission boundary and ends the hold itself (see `runHeldChange`).
                run.cancelled = true;
                memory.touch();
                return;
              }
              memory.heldEnded.add(change.holdId);
              memory.touch();
              // Its uncertain policy attempt outlives the hold: a later audience change of the field sends the same key and body.
              if (change.attempt !== null)
                memory.attempts.set(`policy:${change.fieldId}`, change.attempt);
              void env.held.discard({
                personId: change.personId,
                fieldId: change.fieldId,
                holdId: change.holdId,
              });
              announcer.announce(
                change.attempt !== null
                  ? copy.HELD_POLICY_UNCERTAIN(change.label)
                  : copy.HELD_STOPPED(change.label),
                "polite",
              );
            }}
          >
            {copy.DISCARD}
          </Button>
        )}
      </div>
    </li>
  );
}
