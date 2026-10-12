import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
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
import { type PeopleEnv, usePeopleEnv } from "../env";
import { runHeldChange } from "../field/held";
import { type HeldChange, isCurrentMemory, useMemoryRevision } from "../memory";
import {
  audienceLabel,
  classify,
  fieldDefaultsLabel,
  primaryHousehold,
} from "../model/audience";
import { archiveRequest } from "../model/commands";
import {
  type Change,
  changesOfAll,
  foldRows,
  type ShownRow,
} from "../model/project";
import { Banner, PendingBadge, useOutboxSave } from "../parts";
import { OutstandingChain, ResourceChain } from "../reads";
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

const FIELD_PAGES = 10;

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
      <div className="h-14 w-64 rounded-row bg-panel" />
      {[0, 1, 2].map((n) => (
        <div
          key={n}
          className="h-12 rounded-row border border-hairline bg-panel"
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
      <ResourceChain kind="field" parentId={personId} cap={FIELD_PAGES}>
        {(chain) => {
          const rows = foldRows(chain.rows, changes, "field", personId);
          const active = rows.filter((row) => !row.row.archived);
          const archived = rows.filter((row) => row.row.archived);
          return (
            <>
              <FieldRows rows={active} person={person} />
              {chain.capped ? (
                <p className="text-[12.5px] text-ink-2">
                  {copy.CAPPED(FIELD_PAGES * 100)}
                </p>
              ) : null}
              <HeldChanges
                personId={personId}
                fields={rows}
                ready={chain.status === "ready" && !chain.capped}
              />
              <ArchivedFields rows={archived} />
            </>
          );
        }}
      </ResourceChain>
    </section>
  );
}

function FieldRows({ rows, person }: { rows: ShownRow[]; person: ShownRow }) {
  if (rows.length === 0)
    return <p className="text-[13px] text-ink-2">{copy.NO_FIELDS}</p>;
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-hidden="true"
        className="hidden grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)_auto] gap-3 px-3 text-[12px] text-ink-2 tablet:grid"
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
        className="min-h-11 self-start text-[13px] text-ink-1 underline decoration-hairline-strong"
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
 * The audience changes held for this person's fields (D-11a-12), with their state and "Try again" / "Discard". While the page is open,
 * online and writable, waiting ones run one at a time (`runHeldChange`): the audience first, then the content.
 */
function HeldChanges({
  personId,
  fields,
  ready,
}: {
  personId: string;
  fields: ShownRow[];
  /** The person's fields have been read in full: only then does a missing or changed field mean anything. */
  ready: boolean;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const held = [...env.memory.held.values()].filter(
    (change) => change.personId === personId,
  );
  const running = useRef(false);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const waiting = held.find((change) => change.status.kind === "waiting");
  useEffect(() => {
    if (
      !ready ||
      !env.online ||
      !env.writable ||
      running.current ||
      waiting === undefined
    )
      return;
    running.current = true;
    const memory = env.memory;
    waiting.status = { kind: "running" };
    memory.touch();
    const current =
      fieldsRef.current.find(
        (row) => row.row.id === waiting.fieldId && !row.projected,
      )?.row ?? null;
    void runHeldChange(env, waiting, current, save).then((result) => {
      running.current = false;
      if (!isCurrentMemory(memory)) return;
      if (result.kind === "done") {
        memory.held.delete(waiting.fieldId);
        announcer.announce(copy.SAVED_NOT_SENT, "polite");
      } else waiting.status = result;
      memory.touch();
    });
  }, [env, waiting, save, announcer, ready]);
  if (held.length === 0) return null;
  return (
    <List className="flex flex-col gap-2">
      {held.map((change) => (
        <HeldRow key={change.fieldId} env={env} change={change} />
      ))}
    </List>
  );
}

function HeldRow({ env, change }: { env: PeopleEnv; change: HeldChange }) {
  const status = change.status;
  return (
    <li
      data-held-change={change.fieldId}
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">
        {status.kind === "running"
          ? copy.HELD_RUNNING(change.label)
          : copy.HELD_WAITING(change.label)}
      </p>
      {status.kind === "failed" ? (
        <p className="text-[12.5px] text-conflict-text">
          {copy.HELD_FAILED[status.reason]}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {status.kind === "failed" ? (
          <Button
            onClick={() => {
              change.status = { kind: "waiting" };
              env.memory.touch();
            }}
          >
            {copy.TRY_AGAIN}
          </Button>
        ) : null}
        <Button
          variant="quiet"
          onClick={() => {
            env.memory.held.delete(change.fieldId);
            env.memory.attempts.delete(`policy:${change.fieldId}`);
            env.memory.touch();
          }}
        >
          {copy.DISCARD}
        </Button>
      </div>
    </li>
  );
}
