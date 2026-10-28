import { useEffect, useId, useRef, useSyncExternalStore } from "react";
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
import type { ImportEditor } from "./import-editor";
import {
  discardImport,
  expireImport,
  hideImport,
  importContinuity,
  importStatus,
  showImport,
  subscribeImports,
} from "./import-kept";
import {
  CONFIGURE_SOURCE,
  CREATE_SOURCE,
  importRequest,
} from "./model/commands";
import { checkWindow, envelopeBytes, IMPORT_LIMITS } from "./model/import";
import { displayedRow } from "./model/status";
import { projectSourceCreate } from "./register";
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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
          : state.kind === "waiting"
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

  const submit = () => {
    if (!enablement.enabled || source === null) return;
    // While the latest choice is still being read nothing is imported (nor said to be missing), whatever submitted the form; nor while
    // the session shown again is not verified (asked again at the press, R7a).
    if (editor.state().reading || importStatus(editor) !== "ready") return;
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
    // The cache's history it was verified against, as it is now (revision 9, C2): the enqueue's own transaction must read the same.
    const continuity = importContinuity(editor) ?? undefined;
    // One save at a time (the session's synchronous latch): a second press, or Enter, before the screen shows the first as busy stores
    // nothing more. What is saved is what was pressed, captured now; only this save settles the session, and only while it has not ended.
    editor.submit(
      { source: into, from, through, file: file.token },
      async (key) => {
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
      },
      () => announcer.announce(IMPORT_QUEUED),
    );
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
      footer={
        <>
          {busy ? (
            <Button variant="primary" disabled reason="Saving…">
              {IMPORT}
            </Button>
          ) : reading ? (
            <Button variant="primary" disabled reason={WAIT_FOR_FILE}>
              {IMPORT}
            </Button>
          ) : enablement.enabled ? (
            <Button variant="primary" type="submit" form={formId}>
              {IMPORT}
            </Button>
          ) : (
            <Button variant="primary" disabled reason={enablement.reason ?? ""}>
              {IMPORT}
            </Button>
          )}
          <Button
            variant="secondary"
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
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          {sourceId === null &&
          state.kind !== "waiting" &&
          (importable.rows.length > 0 || importable.page.partial) ? (
            <>
              <label
                htmlFor={`${formId}-source`}
                className="text-[13px] font-medium text-ink-1"
              >
                {SOURCE}
              </label>
              <select
                id={`${formId}-source`}
                data-field-edge=""
                value={selected ?? ""}
                onChange={(event) => editor.chooseSource(event.target.value)}
                className="atlas-transition box-border min-h-11 w-full rounded-control border border-field-edge bg-canvas px-3 py-2.5 text-[14px] text-ink-1"
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
              <span className="text-[13px] font-medium text-ink-1">
                {SOURCE}
              </span>
              <span data-import-source="" className="text-[14px] text-ink-1">
                {source?.label ?? "—"}
              </span>
              {state.kind === "waiting" ? (
                <span
                  data-import-waiting=""
                  className="text-[12.5px] text-ink-2"
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
            className="text-[13px] font-medium text-ink-1"
          >
            {FILE}
          </span>
          {file !== null ? (
            <span data-import-file="" className="text-[14px] text-ink-1">
              {file.check.ok
                ? fileSummary(file.name, file.check.bytes, file.check.events)
                : file.name}
            </span>
          ) : null}
          {reading ? (
            <span className="text-[12.5px] text-ink-2">{READING}</span>
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
            onChange={(event) => editor.choose(event.target.files?.[0])}
          />
          <span className="flex">
            <Button
              aria-describedby={`${fileInputId}-label`}
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
          {(errors.file ?? fileProblem) !== null ? (
            <p
              data-field-error=""
              className="text-[12.5px] leading-[1.5] text-ink-1"
            >
              {errors.file ?? fileProblem}
            </p>
          ) : null}
        </div>
        <Field
          label={FROM}
          name="from"
          type="date"
          value={window_.from}
          error={errors.from}
          onChange={(event) => editor.editWindow({ from: event.target.value })}
        />
        <Field
          label={THROUGH}
          name="through"
          type="date"
          value={window_.through}
          error={errors.through}
          onChange={(event) =>
            editor.editWindow({ through: event.target.value })
          }
        />
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {DIALOG_BOUNDS}
        </p>
        <FormMessage message={message} />
      </form>
    </Dialog>
  );
}
