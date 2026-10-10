import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type CacheRow,
  useCachedResource,
  useCacheGate,
  useOptionalDataEnv,
  useOutstanding,
} from "../../data";
import { refusalMessage } from "./AddSourceDialog";
import type { CalendarApi } from "./api";
import type { AwaitingSync, Dialog as DialogState } from "./CalendarSources";
import {
  ACCESS_LOST_NOTICE,
  BEARER_LABEL,
  CANCEL,
  CLOSE_PANEL,
  CONFLICT,
  CONNECTION,
  CONNECTION_NOT_SHOWN,
  ENABLED,
  LABEL,
  LABEL_READ_ONLY,
  MANAGE_CLOSED_GONE,
  MANAGE_CLOSED_REFRESHING,
  MANAGE_HELP,
  manageTitle,
  NEEDS_DATABASE,
  NOT_SAVED,
  NOTHING_CHANGED,
  ONLINE_ONLY,
  REMOVE,
  REMOVE_CONFIRM,
  REMOVE_SUBMIT,
  REMOVED,
  REPLACE,
  REPLACE_KEEP_NOTE,
  REPLACE_ROTATE_NOTE,
  REPLACE_SUBMIT,
  REPLACED,
  RETRY,
  SAVE,
  SETTINGS_SAVED,
  TIMEZONE,
  URL_LABEL,
  URL_REQUIRED_FOR_REPLACE,
} from "./copy";
import { Field, FormMessage, TimezoneSuggestions } from "./fields";
import { submissionMessage } from "./LinkCalendarDialog";
import { useLive } from "./live";
import { identityMemory } from "./memory";
import {
  type Connection,
  type CurrentSettings,
  configureSourceRequest,
  currentSettings,
  type DirectCommand,
  removeCommand,
  replaceCommand,
  sourceValue,
} from "./model/commands";
import {
  displayedRow,
  type Enablement,
  type Environment,
  manageActions,
} from "./model/status";
import { classifySubmission, createSubmission } from "./model/submission";
import {
  bearerError,
  defaultTimezone,
  timezoneError,
  urlError,
} from "./model/validation";
import { shownSource } from "./model/visibility";

type Panel = "replace" | "remove" | null;

/**
 * "Manage — <label>" (WEB-13a; the wireframe's Manage source panel). Two kinds of change, kept apart:
 *
 *  - Timezone and Enabled are SAVED THROUGH THE OUTBOX, offline or online, and never touch the stored connection (BE-Q22). From a
 *    conflict, Save replaces the conflicted draft (`supersede`) instead of adding another (D-13a-12).
 *  - "Replace…" and "Remove…" change the connection DIRECTLY, online only, with the URL and token in this panel's memory alone.
 *    They restate the current timezone and enabled from the merged row, so they are unavailable while this source has changes
 *    waiting to send (D-13a-8): an online change would make every queued one conflict. After one succeeds, Save waits until the
 *    cache has caught up with it, so the next queued change is not built on a version the server has passed.
 *
 * The label is read-only: the contract has no way to rename a source.
 *
 * A cached source is shown here only while the list could show it (`shownSource`): when the cache is being brought up to date (its
 * content is hidden behind the gate) or the source leaves it, Manage closes and says why, and nothing it showed stays on screen. Its
 * fields start from the values the person last asked for (the newest waiting change over the cached row, as the row shows them), and
 * Save waits until those waiting changes have been read, so a second change never reverts a first that is still queued.
 */
export function ManageSourceDialog({
  api,
  dialog,
  environment,
  awaiting,
  onAwaiting,
  onClose,
}: {
  api: CalendarApi | null;
  dialog: Extract<DialogState, { kind: "manage" }>;
  environment: Environment;
  awaiting: AwaitingSync;
  onAwaiting(id: string, version: number): void;
  onClose(): void;
}) {
  const env = useOptionalDataEnv();
  const announcer = useAnnouncer();
  const formId = useId();
  const zonesId = useId();
  const id = dialog.row.id;
  const gate = useCacheGate();
  const resource = useCachedResource(id);
  const outstanding = useOutstanding(id);
  // The row as the cache and its overlay say it NOW (a conflict re-reads it), or why it can no longer be shown.
  const read = useRef(false);
  const shown = shownSource({
    dialog,
    gate,
    resource,
    read: read.current,
  });
  if (resource.status !== "loading") read.current = true;
  const current: CacheRow = shown.kind === "row" ? shown.row : dialog.row;
  const baseVersion =
    resource.status === "ready" ? (resource.value.base?.version ?? null) : null;
  // The values the person last asked for: the newest waiting settings change over the row (`displayedRow`), as the row shows them.
  const asked = displayedRow(
    current,
    outstanding.status === "ready" ? outstanding.value.latest : null,
  );
  // A field the person has not edited follows `asked`; an edited one keeps what was typed.
  const [editedTimezone, setTimezone] = useState<string | null>(null);
  const [editedEnabled, setEnabled] = useState<boolean | null>(
    dialog.enable === true ? true : null,
  );
  const timezone =
    editedTimezone ?? sourceValue(asked.value).timezone ?? defaultTimezone();
  const enabled = editedEnabled ?? !asked.archived;
  const [timezoneProblem, setTimezoneProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(
    dialog.replace === true ? "replace" : null,
  );
  const saves = useRef(
    createSubmission<{ timezone: string; enabled: boolean }>(() =>
      crypto.randomUUID(),
    ),
  );
  const recorded = awaiting.get(id);
  const awaitingSync =
    recorded !== undefined && (baseVersion === null || baseVersion <= recorded);
  const actions = manageActions({
    env: environment,
    cached: dialog.cached,
    outstandingTotal:
      outstanding.status === "ready" ? outstanding.value.total : null,
    awaitingSync,
  });

  // Closed once, with the reason announced, when the source can no longer be shown.
  const closed = useRef(false);
  const gone = shown.kind === "gone" ? shown.reason : null;
  useEffect(() => {
    if (gone === null || closed.current) return;
    closed.current = true;
    announcer.announce(
      gone === "refreshing" ? MANAGE_CLOSED_REFRESHING : MANAGE_CLOSED_GONE,
    );
    onClose();
  }, [gone, announcer, onClose]);

  const save = async () => {
    const problem = timezoneError(timezone);
    setTimezoneProblem(problem);
    if (problem !== null) return;
    const outbox = env?.outbox() ?? null;
    if (outbox === null) {
      setMessage(NEEDS_DATABASE);
      return;
    }
    const settings = { timezone: timezone.trim(), enabled };
    const before = sourceValue(asked.value).timezone;
    if (
      dialog.supersede === undefined &&
      settings.timezone === before &&
      settings.enabled === !asked.archived
    ) {
      announcer.announce(NOTHING_CHANGED);
      onClose();
      return;
    }
    const pair = saves.current.attempt(settings);
    const request = configureSourceRequest(current, settings, pair.key);
    setBusy(true);
    setMessage(null);
    try {
      const outcome =
        dialog.supersede === undefined
          ? await outbox.enqueue(request)
          : await outbox.supersede(dialog.supersede, request);
      if (outcome.kind === "queued" || outcome.kind === "superseded") {
        announcer.announce(SETTINGS_SAVED);
        onClose();
        return;
      }
      setMessage(refusalMessage(outcome.reason));
    } catch {
      setMessage(NOT_SAVED);
    } finally {
      setBusy(false);
    }
  };

  if (gone !== null) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={manageTitle(current.label)}
      footer={
        <>
          <Gate
            enablement={
              busy ? { enabled: false, reason: "Saving…" } : actions.save
            }
          >
            <Button variant="primary" type="submit" form={formId}>
              {SAVE}
            </Button>
          </Gate>
          <Button variant="secondary" onClick={onClose}>
            {CANCEL}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium text-ink-1">{LABEL}</span>
          <p className="text-[13.5px] text-ink-1">
            {current.label}{" "}
            <span className="text-[12px] text-ink-2">{LABEL_READ_ONLY}</span>
          </p>
        </div>
        <Field
          label={TIMEZONE}
          name="timezone"
          value={timezone}
          list={zonesId}
          autoComplete="off"
          error={timezoneProblem}
          onChange={(event) => {
            setTimezone(event.target.value);
            saves.current.invalidate();
          }}
        />
        <TimezoneSuggestions id={zonesId} />
      </form>
      <section
        aria-label={CONNECTION}
        className="mt-4 flex flex-col gap-2 border-t border-hairline pt-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-medium text-ink-1">{CONNECTION}</h3>
          <span className="text-[11.5px] uppercase tracking-[0.06em] text-ink-2">
            {ONLINE_ONLY}
          </span>
        </div>
        <p className="text-[12.5px] text-ink-2">{CONNECTION_NOT_SHOWN}</p>
        <div className="flex flex-wrap items-start gap-2">
          <Gate enablement={actions.replace}>
            <Button onClick={() => setPanel("replace")}>{REPLACE}</Button>
          </Gate>
          <Gate enablement={actions.remove}>
            <Button onClick={() => setPanel("remove")}>{REMOVE}</Button>
          </Gate>
        </div>
        {panel !== null && api !== null ? (
          <ConnectionPanel
            key={panel}
            api={api}
            panel={panel}
            current={current}
            online={environment.online}
            available={panel === "replace" ? actions.replace : actions.remove}
            onDone={(version) => {
              onAwaiting(id, version);
              announcer.announce(panel === "replace" ? REPLACED : REMOVED);
              setPanel(null);
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </section>
      <div className="mt-4 flex flex-col gap-3">
        <label className="flex min-h-11 items-center gap-3 text-[13.5px] text-ink-1">
          <input
            type="checkbox"
            name="enabled"
            form={formId}
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              saves.current.invalidate();
            }}
            className="size-5"
          />
          {ENABLED}
        </label>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">{MANAGE_HELP}</p>
        <FormMessage message={message} />
      </div>
    </Dialog>
  );
}

function Gate({
  enablement,
  children,
}: {
  enablement: Enablement;
  children: React.ReactElement<{ children: React.ReactNode }>;
}) {
  if (enablement.enabled) return children;
  return (
    <Button
      variant={
        (children.props as { variant?: "primary" | "secondary" }).variant ??
        "secondary"
      }
      disabled
      reason={enablement.reason ?? ""}
    >
      {children.props.children}
    </Button>
  );
}

/** One connection change as it is sent: the command, and the version it was built on (what the cache must pass before Save). */
interface ConnectionChange {
  command: DirectCommand;
  version: number;
}

/**
 * Replace… or Remove…, open inside Manage. The fields of Replace… start EMPTY (the stored URL is never shown again) and live in this
 * panel's state only; closing the panel keeps the stored connection exactly as it is.
 *
 * Once an attempt was uncertain, "Retry" resends THAT pair, byte for byte under its key, whatever the cache has learnt since (a newer
 * version, other settings): the server finds the receipt of an attempt that landed and does not apply the change twice. Only an edit
 * of a field, or a conflict, makes the next attempt a new operation built from the row as it is then. The request is admitted only
 * while the panel is open, under the client it was opened with, and online.
 */
function ConnectionPanel({
  api,
  panel,
  current,
  online,
  available,
  onDone,
  onClose,
}: {
  api: CalendarApi;
  panel: "replace" | "remove";
  current: CacheRow;
  online: boolean;
  available: Enablement;
  onDone(basedOn: number): void;
  onClose(): void;
}) {
  const [connection, setConnection] = useState<Connection>({
    url: "",
    bearer: "",
  });
  const [errors, setErrors] = useState<{
    url?: string | null;
    bearer?: string | null;
  }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submission = useRef(
    createSubmission<ConnectionChange>(() => crypto.randomUUID()),
  );
  const lifetime = useLive(api, online);

  const edit = (name: keyof Connection, value: string) => {
    setConnection((previous) => ({ ...previous, [name]: value }));
    submission.current.invalidate();
    setUncertain(false);
  };

  const submit = async () => {
    if (panel === "replace") {
      const next = {
        url: urlError(connection.url, "replace"),
        bearer: bearerError(connection.bearer),
      };
      setErrors(next);
      if (next.url !== null || next.bearer !== null) return;
    }
    if (!available.enabled) return;
    const afterUncertain = submission.current.uncertain;
    const pair =
      (afterUncertain ? submission.current.current() : null) ??
      submission.current.attempt(
        connectionChange(
          panel,
          currentSettings(current, defaultTimezone()),
          connection,
        ),
      );
    setBusy(true);
    setMessage(null);
    const answer = await api.command(
      pair.body.command,
      pair.key,
      lifetime.live,
    );
    setBusy(false);
    const outcome =
      !answer.ok && answer.kind === "closed" && !lifetime.online()
        ? ({ kind: "offline" } as const)
        : classifySubmission(answer, afterUncertain);
    if (outcome.kind === "succeeded") return onDone(pair.body.version);
    if (outcome.kind === "uncertain") {
      submission.current.markUncertain();
      setUncertain(true);
    }
    if (outcome.kind === "refused" && outcome.reason === "conflict") {
      // The source changed elsewhere: the next attempt is built from the row as it is now, never resent blind.
      submission.current.invalidate();
      setUncertain(false);
      setMessage(CONFLICT);
      return;
    }
    if (outcome.kind === "refused" && outcome.reason === "access")
      // The session re-checks a 403 by closing and reopening the display, which unmounts this panel: the words outlive it.
      identityMemory(api.identity.account, api.identity.epoch).notices.set(
        current.id,
        ACCESS_LOST_NOTICE,
      );
    const shown = submissionMessage(outcome);
    setMessage(shown.message);
    if (shown.field) setErrors((e) => ({ ...e, url: shown.field?.message }));
  };

  const submitLabel = uncertain
    ? RETRY
    : panel === "replace"
      ? REPLACE_SUBMIT
      : REMOVE_SUBMIT;
  const blocked: Enablement = busy
    ? { enabled: false, reason: "Working…" }
    : !available.enabled
      ? available
      : panel === "replace" && connection.url.trim() === ""
        ? { enabled: false, reason: URL_REQUIRED_FOR_REPLACE }
        : { enabled: true };
  return (
    <div
      data-connection-panel={panel}
      className="flex flex-col gap-3 rounded-row border border-hairline-strong bg-inset p-3"
    >
      {panel === "replace" ? (
        <>
          <Field
            label={URL_LABEL}
            name="url"
            type="url"
            secret
            error={errors.url}
            onChange={(event) => edit("url", event.target.value)}
          />
          <Field
            label={BEARER_LABEL}
            name="bearer"
            type="password"
            secret
            error={errors.bearer}
            onChange={(event) => edit("bearer", event.target.value)}
          />
          <p className="text-[12px] leading-[1.5] text-ink-2">
            {REPLACE_ROTATE_NOTE}
          </p>
          <p className="text-[12px] leading-[1.5] text-ink-2">
            {REPLACE_KEEP_NOTE}
          </p>
        </>
      ) : (
        <p className="text-[13px] leading-[1.6] text-ink-1">{REMOVE_CONFIRM}</p>
      )}
      <FormMessage message={message} />
      <div className="flex flex-wrap items-start gap-2">
        {blocked.enabled ? (
          <Button variant="primary" onClick={() => void submit()}>
            {submitLabel}
          </Button>
        ) : (
          <Button variant="primary" disabled reason={blocked.reason ?? ""}>
            {submitLabel}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {CLOSE_PANEL}
        </Button>
      </div>
    </div>
  );
}

function connectionChange(
  panel: "replace" | "remove",
  settings: CurrentSettings,
  connection: Connection,
): ConnectionChange {
  return {
    command:
      panel === "replace"
        ? replaceCommand(settings, {
            url: connection.url.trim(),
            bearer: connection.bearer,
          })
        : removeCommand(settings),
    version: settings.version,
  };
}
