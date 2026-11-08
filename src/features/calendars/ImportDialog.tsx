import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type CacheRow,
  useCacheGate,
  useOptionalDataEnv,
  usePendingCreates,
  useResourceView,
  useStatusInputs,
} from "../../data";
import { UNAVAILABLE_WHILE_RELOADING } from "../../lib/form-recovery/RecoveryBanner";
import { RecoveryNotice } from "../../lib/form-recovery/RecoveryNotice";
import { refusalMessage } from "./AddSourceDialog";
import { CANCEL, NEEDS_DATABASE, NOT_SAVED } from "./copy";
import {
  CHANGE_FILE,
  CHOOSE_FILE,
  DIALOG_BOUNDS,
  FILE,
  FILE_PROBLEMS,
  FILE_REQUIRED,
  FROM,
  fileSummary,
  IMPORT,
  IMPORT_CHECKING,
  IMPORT_CLOSED_REFRESHING,
  IMPORT_QUEUED,
  IMPORT_TITLE,
  NO_SOURCES_TO_IMPORT,
  READING,
  SOURCE,
  SOURCE_GONE,
  THROUGH,
  VIEW_ONLY_IMPORT,
  WAIT_FOR_FILE,
  WINDOW_FORMAT,
  WINDOW_RANGE,
  WINDOW_SPAN,
} from "./copy-import";
import { Field, FormMessage } from "./fields";
import { importEnablement } from "./import-action";
import type {
  ImportEditor,
  ImportInput,
  ImportSaveOutcome,
} from "./import-editor";
import {
  discardImport,
  expireImport,
  hideImport,
  importAuthority,
  importStatus,
  showImport,
  subscribeImports,
} from "./import-kept";
import {
  decodeImportInput,
  encodeImportInput,
  importContext,
} from "./import-recovery";
import {
  CONFIGURE_SOURCE,
  CREATE_SOURCE,
  importRequest,
} from "./model/commands";
import { checkWindow, envelopeBytes, IMPORT_LIMITS } from "./model/import";
import { displayedRow } from "./model/status";
import { useCalendarRecoveryIdentity } from "./recovery";
import { projectSourceCreate } from "./register";
import { useSessionRecovery } from "./session-recovery";
import { type SourcePage, SourcePages, useSourcePage } from "./source-pages";

const VIEW_KINDS = { create: CREATE_SOURCE, settings: CONFIGURE_SOURCE };
/** The id a view is read for while no source is chosen: no resource has it. */
const NONE = "";

/** Today's date on this device (`YYYY-MM-DD`, the device's own zone): the start of the default window. */
export function deviceToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What the dialog may say of its source NOW (one read, `useResourceView`): the cached row (merged, with a waiting settings change shown),
 * this device's pending create of it, still reading, or gone. A source seen cached that the cache no longer holds is gone; it is never
 * shown from an earlier row.
 *
 * Revision 8 (R7a): a cache hidden only because it is not verified yet (a remount's first read, an unreadable marker) is no refresh: the
 * cached source is WAITED for (nothing of it shown, nothing saved), never closed over. A cache known to be invalid, or stopped at its
 * floor, is the E9 refresh.
 */
type SourceState =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "waiting" }
  | { kind: "shown"; row: CacheRow; cached: boolean }
  | { kind: "gone" };

function useSourceState(id: string | null): {
  state: SourceState;
  refreshing: boolean;
} {
  const view = useResourceView(id ?? NONE, VIEW_KINDS);
  const gate = useCacheGate();
  const inputs = useStatusInputs();
  const unverified =
    gate === "refreshing" &&
    inputs.cache === "unverified" &&
    inputs.engine?.invalidating !== true;
  const seenCached = useRef<string | null>(null);
  if (id === null) return { state: { kind: "none" }, refreshing: false };
  if (view.status === "loading")
    return { state: { kind: "reading" }, refreshing: false };
  if (view.status === "unavailable")
    return { state: { kind: "gone" }, refreshing: false };
  const { base, merged, create, outstanding } = view.value;
  if (base !== null && merged !== null) {
    seenCached.current = id;
    if (unverified) return { state: { kind: "waiting" }, refreshing: false };
    return {
      state: {
        kind: "shown",
        row: displayedRow(merged, outstanding.latestOfKind),
        cached: true,
      },
      refreshing: gate !== "open",
    };
  }
  if (seenCached.current === id)
    return { state: { kind: "gone" }, refreshing: false };
  const projected = create === null ? null : projectSourceCreate(create);
  return projected === null
    ? { state: { kind: "gone" }, refreshing: false }
    : {
        state: { kind: "shown", row: projected, cached: false },
        refreshing: false,
      };
}

/**
 * The sources this account can import into, for the drop zone and its dialog: those of ONE page of cached sources (`source-pages.tsx`,
 * with "Show previous/next calendars", R4), then this device's pending ones. `page.partial`: other pages may hold more.
 */
export function useImportableSources(): { rows: CacheRow[]; page: SourcePage } {
  const page = useSourcePage();
  const pending = usePendingCreates(CREATE_SOURCE);
  const rows: CacheRow[] = [];
  for (const row of page.rows ?? [])
    if (row.can_edit && !row.archived) rows.push(row);
  if (pending.status === "ready")
    for (const draft of pending.value.drafts) {
      const row = projectSourceCreate(draft);
      if (row !== null) rows.push(row);
    }
  return { rows, page };
}

/**
 * "Import events" (WEB-13b §4.2; Q22 "file imports"): an `.ics` file read and checked ON THIS DEVICE, a coverage window, and one queued
 * import. Nothing is sent from here: Import stores the draft (offline included) and the page's leader sends it, behind the source's own
 * pending create when there is one (case 2). The file's text lives in page memory only, in the dialog's editing session; it is never put
 * in a recovery copy, a trace, a log, the address or another tab (E11).
 *
 * Explicit consent is the dialog itself: the file's name, size and event count, the source and the window are shown, and nothing is
 * stored until Import is pressed. A save the outbox refuses keeps the dialog open with what was chosen; pressing Import again for the
 * same file, source and window reuses the same save identity, so a save whose completion was lost is not made twice. A queued import's
 * identity is spent: a later Import is a new operation, whatever it holds.
 *
 * Only the file the person last chose can be imported (R1): choosing another forgets the previous file AT ONCE, and nothing can be
 * imported (the button, Enter or any other submission) until the new one has been read and checked. A save settles only what it
 * submitted (R3, PRODUCT-DECISIONS-20261011): when the file, source or window was changed while it was being stored, the dialog stays
 * open with the newer choices and says that the import was queued as it was pressed.
 *
 * Revision 6 (review 6 R7; ia.md §1.3.3, the J2 dialog rule): the dialog is a PRESENTATION of its editing session (`import-editor.ts`),
 * which the import's visit owns (`import-kept.ts`). The in-dialog sync control keeps the session, closes and navigates; Back and Import
 * events again show it, with a read or a save that went on meanwhile settled in it. Cancel, Escape and the close icon discard it. The
 * source's state is read afresh whenever it is shown: a kept choice is never kept permission.
 *
 * Revision 9 (review 9 R7c; design assessment C1/C2): a session shown again waits for a read made for that showing (`import-kept.ts`),
 * and Import states the cache's history the session was verified against (`EnqueueRequest.continuity`, captured at the press): the
 * enqueue's own transaction refuses it (`expired`) when the cache was invalidated in between, and the dialog then closes and says why.
 *
 * WEB-13b maintenance merge of accepted main, correction M-13b-1 G-3 (Kieran, 7 November 2026): the dialog is a recoverable editor
 * of WEB-14a's app-update recovery (Q4; `session-recovery.ts`, `import-recovery.ts`). Shown, it is in the page's form registry, so an
 * available update offers "Save and reload"; the source and the window as typed are what the update saves, and the entry's host (the
 * row's "Import events", the drop zone) reopens the dialog on the copy after the reload, with the restored notice and focus on From,
 * nothing queued. The FILE is never part of a copy: while one is chosen or being read the model cannot hold the input, so the update
 * stops (retry, or "Discard and reload anyway") instead of reloading over it. Every change is given to the model first and refused,
 * unchanged, while an update reload is prepared; Import takes the model's ticket in the same step as it reads what it stores.
 */
export function ImportDialog({
  sourceId,
  editor,
  owned,
  onClose,
}: {
  /** The source, fixed (a row's "Import events"), or null: the person chooses (the drop zone). */
  sourceId: string | null;
  /** The editing session shown. */
  editor: ImportEditor;
  /** Whether the session may still be saved (its identity displayed, its database the displayed one), asked at the press. */
  owned(): boolean;
  onClose(): void;
}) {
  const env = useOptionalDataEnv();
  const announcer = useAnnouncer();
  const formId = useId();
  const fileInputId = useId();
  const editing = useSyncExternalStore(
    editor.subscribe,
    editor.state,
    editor.state,
  );
  const {
    chosen,
    window: window_,
    errors,
    message,
    busy,
    file,
    reading,
  } = editing;
  const importable = useImportableSources();
  // The drop zone's dialog starts on the first source it may import into.
  const selected = sourceId ?? chosen ?? importable.rows[0]?.id ?? null;
  const sourceState = useSourceState(selected);
  const refreshing = sourceState.refreshing;
  // The session's own state (R7a): shown again and not verified yet, nothing of its source is shown and nothing is saved.
  const status = useSyncExternalStore(
    subscribeImports,
    () => importStatus(editor),
    () => importStatus(editor),
  );
  const state: SourceState =
    status === "pending" ? { kind: "waiting" } : sourceState.state;
  const fileInput = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const fromRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const inputNow = (): ImportInput => {
    const now = editor.state();
    return {
      chosen: now.chosen,
      from: now.window.from,
      through: now.window.through,
    };
  };
  // M-13b-1 G-3: the session's source and window, as the update saves them and the next page restores them (never the file).
  const recovery = useSessionRecovery<ImportInput>({
    identity: useCalendarRecoveryIdentity() ?? "-",
    context: importContext(sourceId),
    owned: editor,
    opening: () => editor.opening(),
    current: inputNow,
    holdsInput: () => {
      const now = editor.state();
      return now.revision > 0 || now.file !== null || now.reading;
    },
    encode: encodeImportInput,
    decode: decodeImportInput,
    apply: (input) => editor.restoreChoice(input),
    // A file chosen or being read, or a date partly typed: input the model cannot hold (an update stops instead of reloading over it).
    unfinished: () => {
      const now = editor.state();
      return (
        now.file !== null ||
        now.reading ||
        Array.from(formRef.current?.querySelectorAll("input") ?? []).some(
          (input) => input.validity?.badInput === true,
        )
      );
    },
  });
  const locked = recovery.locked;
  // Opened on a restored copy: focus goes to From (a modal takes focus inside it; see `AnchorDialog`).
  const [restoredAtOpen] = useState(() => recovery.view.restored !== null);
  /** M-13b-1 G-3: the model takes the change first; refused while an update reload is prepared, the session does not change either. */
  const admit = (patch: Partial<ImportInput>): boolean =>
    recovery.edit({ ...inputNow(), ...patch });
  // This dialog shows the session until it unmounts; leaving without a discard keeps it (`import-kept.ts`). Its own save consuming it
  // closes this dialog, and only this one (the screen clears the dialog only while it still shows this session).
  useEffect(() => {
    showImport(editor);
    const off = editor.subscribe((event) => {
      if (event === "consumed") onCloseRef.current();
    });
    return () => {
      off();
      hideImport(editor);
    };
  }, [editor]);
  const discard = () => discardImport(editor);

  // Closed once, with the reason announced, when the cache is being brought up to date under a cached source (the Manage rule, E9),
  // and when the session shown again turns out to have been invalidated while it was kept (R7a/R7b: the owner ended it).
  const closed = useRef(false);
  useEffect(() => {
    if ((!refreshing && status !== "expired") || closed.current) return;
    closed.current = true;
    announcer.announce(IMPORT_CLOSED_REFRESHING);
    discardImport(editor);
    onClose();
  }, [refreshing, status, announcer, onClose, editor]);

  const source = state.kind === "shown" ? state.row : null;
  const enablement =
    state.kind === "gone"
      ? { enabled: false, reason: SOURCE_GONE }
      : state.kind === "none"
        ? { enabled: false, reason: NO_SOURCES_TO_IMPORT }
        : state.kind === "reading"
          ? { enabled: false, reason: READING }
          : state.kind === "waiting" || status === "acquiring"
            ? { enabled: false, reason: IMPORT_CHECKING }
            : importEnablement({
                database: env?.service() != null,
                canEdit: state.row.can_edit,
                turnedOff: state.row.archived,
              });
  const fileProblem =
    file !== null && !file.check.ok
      ? (FILE_PROBLEMS[file.check.reason] ?? null)
      : null;
  // F40-1 (review 40): the file's refusal is the control's own error, as `Field` wires a field's: the button the person operates names it
  // (after its label) and is invalid while it is shown.
  const fileError = errors.file ?? fileProblem;
  const fileErrorId = `${fileInputId}-error`;

  const submit = () => {
    if (!enablement.enabled || source === null || locked) return;
    // While the latest choice is still being read nothing is imported (nor said to be missing), whatever submitted the form; nor while
    // the session shown again is not verified (asked again at the press, R7a), nor while a new one does not know the cache's history yet
    // (revision 10, R7e). What is asked here is what is saved with.
    const authority = importAuthority(editor);
    if (editor.state().reading || authority.status !== "ready") return;
    const { file, window: window_ } = editor.state();
    const windowCheck = checkWindow(window_.from, window_.through);
    const windowError = windowCheck.ok
      ? null
      : windowCheck.reason === "format"
        ? WINDOW_FORMAT
        : windowCheck.reason === "range"
          ? WINDOW_RANGE
          : WINDOW_SPAN;
    const next = {
      file:
        file === null
          ? FILE_REQUIRED
          : file.check.ok
            ? null
            : (FILE_PROBLEMS[file.check.reason] ?? null),
      from:
        !windowCheck.ok && windowCheck.field === "from" ? windowError : null,
      through:
        !windowCheck.ok && windowCheck.field === "through" ? windowError : null,
    };
    if (
      next.file === null &&
      file?.check.ok === true &&
      envelopeBytes({ ics: file.check.ics, ...window_ }) >
        IMPORT_LIMITS.envelopeBytes
    )
      next.file = FILE_PROBLEMS.envelope ?? null;
    editor.setErrors(next);
    if (
      next.file !== null ||
      next.from !== null ||
      next.through !== null ||
      file === null ||
      !file.check.ok
    )
      return;
    // A session of an identity or a database no longer displayed is never saved: it ends, and the dialog closes.
    if (!owned()) {
      discardImport(editor);
      onClose();
      return;
    }
    const outbox = env?.outbox() ?? null;
    if (outbox === null) {
      editor.setMessage(NEEDS_DATABASE);
      return;
    }
    const ics = file.check.ics;
    const { from, through } = window_;
    const into = source.id;
    // The cache's history it was verified against, captured with the press (revision 9, C2): the enqueue's own transaction must read the
    // same. Never absent (revision 10, R7e).
    const { continuity } = authority;
    // What one press stores: the import, queued behind the source's own create when there is one, or the words of why not.
    const store = async (key: string): Promise<ImportSaveOutcome> => {
      try {
        const outcome = await outbox.enqueue(
          importRequest({
            sourceId: into,
            ics,
            from,
            through,
            localId: key,
            continuity,
          }),
        );
        if (outcome.kind === "queued") return { kind: "queued" };
        // Invalidated since it was verified: the session ends, and the dialog closes and says why (as when it is shown again).
        if (outcome.reason === "expired") expireImport(editor);
        return {
          kind: "refused",
          message:
            outcome.reason === "denied"
              ? VIEW_ONLY_IMPORT
              : refusalMessage(outcome.reason),
        };
      } catch {
        // A request the facade refused as built wrongly, or a failure it did not classify: nothing was stored.
        return { kind: "refused", message: NOT_SAVED };
      }
    };
    // M-13b-1 G-3: the model's ticket, taken with what is stored (none while an update reload is prepared: nothing is stored then).
    const ticket = recovery.submitting();
    if (ticket === null) return;
    // One save at a time (the session's synchronous latch): a second press, or Enter, before the screen shows the first as busy stores
    // nothing more. What is saved is what was pressed, captured now; only this save settles the session, and only while it has not ended.
    const started = editor.submit(
      { source: into, from, through, file: file.token },
      async (key) => {
        const answer = await store(key);
        // Only a queued import covers what it stored; a refusal covers nothing (the input stays the session's, and the model's).
        if (answer.kind === "queued") void ticket.succeeded();
        else ticket.failed();
        return answer;
      },
      () => announcer.announce(IMPORT_QUEUED),
    );
    if (!started) ticket.failed();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onDiscard={discard}
      // The chooser's source shown is kept as the session's, so the session comes back to it whatever the first page offers then.
      onRetainDraft={() => {
        if (sourceId === null && selected !== null) editor.pinSource(selected);
      }}
      title={IMPORT_TITLE}
      {...(restoredAtOpen
        ? { initialFocusSelector: "[data-import-first-field]" }
        : {})}
      footer={
        <>
          {busy ? (
            <Button variant="default" disabled reason="Saving…">
              {IMPORT}
            </Button>
          ) : locked ? (
            <Button
              variant="default"
              disabled
              reason={UNAVAILABLE_WHILE_RELOADING}
            >
              {IMPORT}
            </Button>
          ) : reading ? (
            <Button variant="default" disabled reason={WAIT_FOR_FILE}>
              {IMPORT}
            </Button>
          ) : enablement.enabled ? (
            <Button variant="default" type="submit" form={formId}>
              {IMPORT}
            </Button>
          ) : (
            <Button variant="default" disabled reason={enablement.reason ?? ""}>
              {IMPORT}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              discard();
              onClose();
            }}
          >
            {CANCEL}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <RecoveryNotice recovery={recovery} firstFieldRef={fromRef} />
        <div className="flex flex-col gap-1.5">
          {sourceId === null &&
          state.kind !== "waiting" &&
          (importable.rows.length > 0 || importable.page.partial) ? (
            <>
              <label
                htmlFor={`${formId}-source`}
                className="text-sm font-medium text-foreground"
              >
                {SOURCE}
              </label>
              <select
                id={`${formId}-source`}
                data-field-edge=""
                value={selected ?? ""}
                onChange={(event) => {
                  const id = event.target.value;
                  if (admit({ chosen: id })) editor.chooseSource(id);
                }}
                className="atlas-transition box-border min-h-11 w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground"
              >
                {/* The chosen source stays an option while another page of sources is shown. */}
                {source !== null &&
                !importable.rows.some((row) => row.id === source.id) ? (
                  <option value={source.id}>{source.label}</option>
                ) : null}
                {importable.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </select>
              <SourcePages
                page={importable.page}
                onPage={() => {
                  if (selected !== null) editor.pinSource(selected);
                }}
              />
            </>
          ) : (
            <>
              <span className="text-sm font-medium text-foreground">
                {SOURCE}
              </span>
              <span data-import-source="" className="text-sm text-foreground">
                {source?.label ?? "—"}
              </span>
              {state.kind === "waiting" ? (
                <span
                  data-import-waiting=""
                  className="text-xs text-muted-foreground"
                >
                  {IMPORT_CHECKING}
                </span>
              ) : null}
            </>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span
            id={`${fileInputId}-label`}
            className="text-sm font-medium text-foreground"
          >
            {FILE}
          </span>
          {file !== null ? (
            <span data-import-file="" className="text-sm text-foreground">
              {file.check.ok
                ? fileSummary(file.name, file.check.bytes, file.check.events)
                : file.name}
            </span>
          ) : null}
          {reading ? (
            <span className="text-xs text-muted-foreground">{READING}</span>
          ) : null}
          <input
            ref={fileInput}
            id={fileInputId}
            type="file"
            accept=".ics,text/calendar"
            // Not rendered (no 1 px target, nothing in the tab order): the button beside it opens it.
            hidden
            // The value is cleared just before the picker opens (so the same file can be chosen again), never right after a choice:
            // WebKit fails the read of a File whose input was cleared while it is still being read.
            onChange={(event) => {
              // A file is no input a copy can hold, but choosing one is a change: refused while an update reload is prepared.
              const chosenFile = event.target.files?.[0];
              if (chosenFile !== undefined && admit({}))
                editor.choose(chosenFile);
            }}
          />
          <span className="flex">
            <Button
              aria-describedby={
                fileError === null
                  ? `${fileInputId}-label`
                  : `${fileInputId}-label ${fileErrorId}`
              }
              aria-invalid={fileError === null ? undefined : true}
              onClick={() => {
                const input = fileInput.current;
                if (input === null) return;
                input.value = "";
                input.click();
              }}
            >
              {file === null ? CHOOSE_FILE : CHANGE_FILE}
            </Button>
          </span>
          {fileError !== null ? (
            <p
              id={fileErrorId}
              data-field-error=""
              className="text-xs leading-[1.5] text-foreground"
            >
              {fileError}
            </p>
          ) : null}
        </div>
        <Field
          ref={fromRef}
          data-import-first-field=""
          label={FROM}
          name="from"
          type="date"
          value={window_.from}
          error={errors.from}
          onChange={(event) => {
            const from = event.target.value;
            if (admit({ from })) editor.editWindow({ from });
          }}
        />
        <Field
          label={THROUGH}
          name="through"
          type="date"
          value={window_.through}
          error={errors.through}
          onChange={(event) => {
            const through = event.target.value;
            if (admit({ through })) editor.editWindow({ through });
          }}
        />
        <p className="text-xs leading-[1.6] text-muted-foreground">
          {DIALOG_BOUNDS}
        </p>
        <FormMessage message={message} />
      </form>
    </Dialog>
  );
}
