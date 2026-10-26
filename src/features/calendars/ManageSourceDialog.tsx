import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type CacheRow,
  useCacheGate,
  useOptionalDataEnv,
  useResourceView,
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
  NEEDS_CONNECTION,
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
  CONFIGURE_SOURCE,
  type Connection,
  CREATE_SOURCE,
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
import { sourceAuthority } from "./model/visibility";
import { projectSourceCreate } from "./register";

type Panel = "replace" | "remove";

/** What Manage reads of its source: the create (a pending source's values) and the newest settings change that applies. */
const VIEW_KINDS = { create: CREATE_SOURCE, settings: CONFIGURE_SOURCE };

/**
 * "Manage — <label>" (WEB-13a; the wireframe's Manage source panel). Two kinds of change, kept apart:
 *
 *  - Timezone and Enabled are SAVED THROUGH THE OUTBOX, offline or online, and never touch the stored connection (BE-Q22). From a
 *    conflict, Save replaces the conflicted draft (`supersede`) instead of adding another (D-13a-12).
 *  - "Replace…" and "Remove…" change the connection DIRECTLY, online only, with the URL and token in this panel's memory alone.
 *    They restate the current timezone and enabled from the merged row, so they are unavailable while this source has changes
 *    waiting to send (D-13a-8): an online change would make every queued one conflict. While one is being sent, and after one succeeds
 *    until the cache has caught up with it, Save waits, so the next queued change is not built on a version the server has passed.
 *
 * The label is read-only: the contract has no way to rename a source.
 *
 * WHAT IT SHOWS AND ON WHAT AUTHORITY (revision 2, `sourceAuthority`): the source as ONE read sees it (`useResourceView`), never the row
 * the dialog was opened with. A pending source is shown from its create as it stands; when the create is published Manage stays open
 * and becomes the cached source's (its untouched fields follow the published values, its cached rules apply); a cached source is shown
 * only while the list could show it, and when the cache is being brought up to date or the source leaves it, Manage closes and says
 * why. A field the person has not edited follows the values they last asked for (the newest settings change that applies, over the
 * row); an edited one keeps what was typed.
 *
 * WHAT IT SAVES: both values, with the observation of the read they were shown from (`configureSourceRequest`'s `observed`). The outbox
 * writes the change only if its transaction still reads the same source and drafts; if anything changed in between (another tab's
 * save, a sync, a publication) nothing is stored and the person sees the new values before saving again.
 *
 * WHO MAY ACT: every route that saves or sends (the button, the Enter key's implicit submission of the form, Retry) is admitted by the
 * same rule that disables the control (`manageActions`), checked again when it acts, with a synchronous latch so a second press before
 * the screen has updated does nothing.
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
  const view = useResourceView(id, VIEW_KINDS);
  // Kept across renders: whether the source has been seen cached (never unset), whether its read has answered, and what was shown last.
  const seenCached = useRef(dialog.cached);
  const read = useRef(false);
  const last = useRef<{ row: CacheRow; asked: CacheRow }>({
    row: dialog.row,
    asked: dialog.row,
  });
  const authority = sourceAuthority({
    gate,
    view,
    last: last.current.row,
    seenCached: seenCached.current,
    read: read.current,
    project: projectSourceCreate,
  });
  if (view.status !== "loading") read.current = true;
  if (authority.kind === "cached") seenCached.current = true;
  const current: CacheRow =
    authority.kind === "gone" ? last.current.row : authority.row;
  const live =
    authority.kind === "cached" || authority.kind === "pending"
      ? authority.view
      : null;
  const baseVersion = live?.base?.version ?? null;
  // The values the person last asked for: the newest settings change that applies, over the row (`displayedRow`), as the row shows them.
  const asked =
    live === null
      ? last.current.asked
      : displayedRow(current, live.outstanding.latestOfKind);
  if (authority.kind !== "gone") last.current = { row: current, asked };
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
  const [panel, setPanel] = useState<{
    kind: Panel;
    generation: number;
  } | null>(
    dialog.replace === true ? { kind: "replace", generation: 1 } : null,
  );
  const generation = useRef(panel?.generation ?? 0);
  const openPanel = (kind: Panel | null) => {
    generation.current += 1;
    setPanel(kind === null ? null : { kind, generation: generation.current });
  };
  const saves = useRef(
    createSubmission<{ timezone: string; enabled: boolean }>(() =>
      crypto.randomUUID(),
    ),
  );
  // Synchronous latches: a Save under way, connection changes being sent, and the version a connection change of THIS dialog was built
  // on (the state that disables Save follows a render later; these close the gap before it).
  const saving = useRef(false);
  const sending = useRef(0);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const awaitedHere = useRef<number | null>(null);
  const recorded = awaiting.get(id);
  const awaited = Math.max(recorded ?? -1, awaitedHere.current ?? -1);
  const awaitingSync =
    awaited >= 0 && (baseVersion === null || baseVersion <= awaited);
  const actions = manageActions({
    env: environment,
    cached:
      authority.kind === "cached" ||
      (authority.kind === "resolving" && seenCached.current),
    outstandingTotal: live?.outstanding.total ?? null,
    awaitingSync,
    canEdit: current.can_edit,
    connectionBusy,
  });
  const latestActions = useRef(actions);
  latestActions.current = actions;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Closed once, with the reason announced, when the source can no longer be shown.
  const closed = useRef(false);
  const gone = authority.kind === "gone" ? authority.reason : null;
  useEffect(() => {
    if (gone === null || closed.current) return;
    closed.current = true;
    announcer.announce(
      gone === "refreshing" ? MANAGE_CLOSED_REFRESHING : MANAGE_CLOSED_GONE,
    );
    onClose();
  }, [gone, announcer, onClose]);

  /** Whether Save may act NOW: the rule that disables it, and the latches that run ahead of the next render. */
  const saveAdmitted = (): boolean => {
    if (saving.current || sending.current > 0) return false;
    const held = awaitedHere.current;
    if (held !== null && (baseVersion === null || baseVersion <= held))
      return false;
    return actions.save.enabled && !busy && live !== null;
  };

  const save = async () => {
    // Every route that submits the form (the button, Enter in a field) arrives here: nothing is validated, closed or saved unless Save
    // is admitted now.
    if (!saveAdmitted() || live === null) return;
    saving.current = true;
    try {
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
      const request = configureSourceRequest(
        current,
        settings,
        pair.key,
        live.observation,
      );
      setBusy(true);
      setMessage(null);
      try {
        const outcome =
          dialog.supersede === undefined
            ? await outbox.enqueue(request)
            : await outbox.supersede(dialog.supersede, request);
        if (outcome.kind === "queued" || outcome.kind === "superseded") {
          announcer.announce(SETTINGS_SAVED);
          // A save that finished after Manage closed closes nothing: another dialog may be open by now.
          if (mounted.current) onClose();
          return;
        }
        setMessage(refusalMessage(outcome.reason));
      } catch {
        setMessage(NOT_SAVED);
      } finally {
        setBusy(false);
      }
    } finally {
      saving.current = false;
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
            <Button variant="default" type="submit" form={formId}>
              {SAVE}
            </Button>
          </Gate>
          <Button variant="outline" onClick={onClose}>
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
          <span className="text-sm font-medium text-foreground">{LABEL}</span>
          <p className="text-sm text-foreground">
            {current.label}{" "}
            <span className="text-xs text-muted-foreground">
              {LABEL_READ_ONLY}
            </span>
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
        className="mt-4 flex flex-col gap-2 border-t border-border pt-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{CONNECTION}</h3>
          <span className="text-xs uppercase tracking-[0.06em] text-muted-foreground">
            {ONLINE_ONLY}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{CONNECTION_NOT_SHOWN}</p>
        <div className="flex flex-wrap items-start gap-2">
          <Gate enablement={actions.replace}>
            <Button onClick={() => openPanel("replace")}>{REPLACE}</Button>
          </Gate>
          <Gate enablement={actions.remove}>
            <Button onClick={() => openPanel("remove")}>{REMOVE}</Button>
          </Gate>
        </div>
        {panel !== null && api !== null ? (
          <ConnectionPanel
            key={panel.generation}
            api={api}
            panel={panel.kind}
            current={current}
            online={environment.online}
            available={
              panel.kind === "replace" ? actions.replace : actions.remove
            }
            admit={() => latestActions.current[panel.kind].enabled}
            onSending={(delta) => {
              sending.current += delta;
              setConnectionBusy(sending.current > 0);
            }}
            onDone={(version) => {
              // The change was made, whichever panel is open now: Save waits for the cache to pass the version it was built on.
              awaitedHere.current = Math.max(
                awaitedHere.current ?? -1,
                version,
              );
              onAwaiting(id, version);
              announcer.announce(panel.kind === "replace" ? REPLACED : REMOVED);
              // Only the panel that sent it closes: a late answer never closes a panel opened since.
              if (generation.current === panel.generation) openPanel(null);
            }}
            onClose={() => openPanel(null)}
          />
        ) : null}
      </section>
      <div className="mt-4 flex flex-col gap-3">
        <label className="flex min-h-11 items-center gap-3 text-sm text-foreground">
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          {MANAGE_HELP}
        </p>
        <FormMessage message={message} />
      </div>
    </Dialog>
  );
}

/**
 * A control that is either the action or, when unavailable, the same control disabled with its reason. The disabled one keeps the
 * action's `type` and `form`: a form whose submit button is disabled is not submitted by the Enter key (implicit submission), as the
 * button says. The handler checks again in any case.
 */
function Gate({
  enablement,
  children,
}: {
  enablement: Enablement;
  children: React.ReactElement<{
    children: React.ReactNode;
    type?: "submit" | "button";
    form?: string;
  }>;
}) {
  if (enablement.enabled) return children;
  const { type, form } = children.props;
  return (
    <Button
      variant={
        (children.props as { variant?: "default" | "outline" }).variant ??
        "outline"
      }
      {...(type === undefined ? {} : { type })}
      {...(form === undefined ? {} : { form })}
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
 * while the panel is open, under the client it was opened with, online, and while Manage still allows the change (`admit`).
 *
 * ENTRY IS ONLINE ONLY TOO (Q22, revision 2): offline, the URL and token fields are disabled with the reason, and a change that arrives
 * anyway is put back; what was entered before stays in the open panel, for the person to send once back online.
 */
function ConnectionPanel({
  api,
  panel,
  current,
  online,
  available,
  admit,
  onSending,
  onDone,
  onClose,
}: {
  api: CalendarApi;
  panel: "replace" | "remove";
  current: CacheRow;
  online: boolean;
  available: Enablement;
  /** Whether Manage allows this change NOW (read at each admission of the request). */
  admit(): boolean;
  /** A request of this panel starts (+1) or ends (-1) being sent. */
  onSending(delta: 1 | -1): void;
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
  // A synchronous latch: a second press before the screen shows the first as busy sends nothing.
  const inFlight = useRef(false);
  const lifetime = useLive(api, online, admit);

  const edit = (
    name: keyof Connection,
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    // Offline the field is disabled; a change that arrives anyway is not taken, and the field shows what was entered before.
    if (!lifetime.online()) {
      event.target.value = connection[name];
      return;
    }
    const value = event.target.value;
    setConnection((previous) => ({ ...previous, [name]: value }));
    submission.current.invalidate();
    setUncertain(false);
  };

  const submit = async () => {
    if (inFlight.current) return;
    if (panel === "replace") {
      const next = {
        url: urlError(connection.url, "replace"),
        bearer: bearerError(connection.bearer),
      };
      setErrors(next);
      if (next.url !== null || next.bearer !== null) return;
    }
    if (!available.enabled || !admit()) return;
    inFlight.current = true;
    onSending(1);
    try {
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
    } finally {
      inFlight.current = false;
      onSending(-1);
    }
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
  const entry = online
    ? {}
    : ({ disabled: true, hint: NEEDS_CONNECTION } as const);
  return (
    <div
      data-connection-panel={panel}
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-3"
    >
      {panel === "replace" ? (
        <>
          <Field
            label={URL_LABEL}
            name="url"
            type="url"
            secret
            error={errors.url}
            {...entry}
            onChange={(event) => edit("url", event)}
          />
          <Field
            label={BEARER_LABEL}
            name="bearer"
            type="password"
            secret
            error={errors.bearer}
            {...entry}
            onChange={(event) => edit("bearer", event)}
          />
          <p className="text-xs leading-[1.5] text-muted-foreground">
            {REPLACE_ROTATE_NOTE}
          </p>
          <p className="text-xs leading-[1.5] text-muted-foreground">
            {REPLACE_KEEP_NOTE}
          </p>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-foreground">
          {REMOVE_CONFIRM}
        </p>
      )}
      <FormMessage message={message} />
      <div className="flex flex-wrap items-start gap-2">
        {blocked.enabled ? (
          <Button variant="default" onClick={() => void submit()}>
            {submitLabel}
          </Button>
        ) : (
          <Button variant="default" disabled reason={blocked.reason ?? ""}>
            {submitLabel}
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
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
