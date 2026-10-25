import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type CacheRow,
  useCacheGate,
  useOptionalDataEnv,
  usePendingCreates,
  useResourceView,
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
  IMPORT_CLOSED_REFRESHING,
  IMPORT_QUEUED,
  IMPORT_QUEUED_NEWER,
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
import {
  CONFIGURE_SOURCE,
  CREATE_SOURCE,
  importRequest,
} from "./model/commands";
import {
  checkWindow,
  defaultWindow,
  envelopeBytes,
  IMPORT_LIMITS,
  type ImportFileCheck,
  readImportFile,
} from "./model/import";
import { displayedRow } from "./model/status";
import { createSubmission } from "./model/submission";
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
 */
type SourceState =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "shown"; row: CacheRow; cached: boolean }
  | { kind: "gone" };

function useSourceState(id: string | null): {
  state: SourceState;
  refreshing: boolean;
} {
  const view = useResourceView(id ?? NONE, VIEW_KINDS);
  const gate = useCacheGate();
  const seenCached = useRef<string | null>(null);
  if (id === null) return { state: { kind: "none" }, refreshing: false };
  if (view.status === "loading")
    return { state: { kind: "reading" }, refreshing: false };
  if (view.status === "unavailable")
    return { state: { kind: "gone" }, refreshing: false };
  const { base, merged, create, outstanding } = view.value;
  if (base !== null && merged !== null) {
    seenCached.current = id;
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

interface ChosenFile {
  name: string;
  /** Mints a new submission for every file read (the text itself is never hashed). */
  token: number;
  check: ImportFileCheck;
}

/**
 * "Import events" (WEB-13b §4.2; Q22 "file imports"): an `.ics` file read and checked ON THIS DEVICE, a coverage window, and one queued
 * import. Nothing is sent from here: Import stores the draft (offline included) and the page's leader sends it, behind the source's own
 * pending create when there is one (case 2). The file's text lives in this dialog's memory only and leaves with it; it is never put in a
 * recovery copy, a trace or a log (E11).
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
 */
export function ImportDialog({
  sourceId,
  file: initialFile,
  onClose,
}: {
  /** The source, fixed (a row's "Import events"), or null: the person chooses (the drop zone). */
  sourceId: string | null;
  file?: File;
  onClose(): void;
}) {
  const env = useOptionalDataEnv();
  const announcer = useAnnouncer();
  const formId = useId();
  const fileInputId = useId();
  const [chosen, setChosen] = useState<string | null>(sourceId);
  const importable = useImportableSources();
  // The drop zone's dialog starts on the first source it may import into.
  const selected = sourceId ?? chosen ?? importable.rows[0]?.id ?? null;
  const { state, refreshing } = useSourceState(selected);
  const [window_, setWindow] = useState(() => defaultWindow(deviceToday()));
  const [errors, setErrors] = useState<{
    file: string | null;
    from: string | null;
    through: string | null;
  }>({ file: null, from: null, through: null });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const tokens = useRef(0);
  // The file being read now (its token), or null: while set, nothing can be imported (R1). A ref, so a submission in the same turn as the
  // choice is refused as well.
  const pendingRead = useRef<number | null>(null);
  // Every change of what would be imported (file, source, window) moves this: a save settles the dialog only at the revision it submitted.
  const revision = useRef(0);
  const submission = useRef(
    createSubmission<{
      source: string;
      from: string;
      through: string;
      file: number;
    }>(() => crypto.randomUUID()),
  );
  // A synchronous latch: a second press (or Enter) before the screen shows the first as busy stores nothing more.
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const choose = async (picked: File | undefined) => {
    if (picked === undefined) return;
    tokens.current += 1;
    const token = tokens.current;
    revision.current += 1;
    pendingRead.current = token;
    // The previous file is no longer the person's choice: it is forgotten now, not when the new one has been read.
    setFile(null);
    setReading(true);
    setErrors((e) => ({ ...e, file: null }));
    const check = await readImportFile(picked);
    // A later choice wins; a read that finishes after the dialog closed shows nothing.
    if (!mounted.current || token !== tokens.current) return;
    pendingRead.current = null;
    setReading(false);
    setFile({ name: picked.name, token, check });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the file the dialog was opened with is read once
  useEffect(() => {
    if (initialFile !== undefined) void choose(initialFile);
  }, []);

  // Closed once, with the reason announced, when the cache is being brought up to date under a cached source (the Manage rule, E9).
  const closed = useRef(false);
  useEffect(() => {
    if (!refreshing || closed.current) return;
    closed.current = true;
    announcer.announce(IMPORT_CLOSED_REFRESHING);
    onClose();
  }, [refreshing, announcer, onClose]);

  const source = state.kind === "shown" ? state.row : null;
  const enablement =
    state.kind === "gone"
      ? { enabled: false, reason: SOURCE_GONE }
      : state.kind === "none"
        ? { enabled: false, reason: NO_SOURCES_TO_IMPORT }
        : state.kind === "reading"
          ? { enabled: false, reason: READING }
          : importEnablement({
              database: env?.service() != null,
              canEdit: state.row.can_edit,
              turnedOff: state.row.archived,
            });
  const fileProblem =
    file !== null && !file.check.ok
      ? (FILE_PROBLEMS[file.check.reason] ?? null)
      : null;

  const submit = async () => {
    if (saving.current || !enablement.enabled || source === null) return;
    // While the latest choice is still being read nothing is imported (nor said to be missing), whatever submitted the form.
    if (pendingRead.current !== null) return;
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
    setErrors(next);
    if (
      next.file !== null ||
      next.from !== null ||
      next.through !== null ||
      file === null ||
      !file.check.ok
    )
      return;
    const outbox = env?.outbox() ?? null;
    if (outbox === null) {
      setMessage(NEEDS_DATABASE);
      return;
    }
    const pair = submission.current.attempt({
      source: source.id,
      from: window_.from,
      through: window_.through,
      file: file.token,
    });
    const submitted = revision.current;
    setBusy(true);
    setMessage(null);
    saving.current = true;
    try {
      const outcome = await outbox.enqueue(
        importRequest({
          sourceId: source.id,
          ics: file.check.ics,
          from: window_.from,
          through: window_.through,
          localId: pair.key,
        }),
      );
      if (outcome.kind === "queued") {
        // Its identity is spent: pressing Import again, even for the same choices, is a new import.
        submission.current.invalidate();
        announcer.announce(IMPORT_QUEUED);
        // A save that finished after the dialog closed closes nothing: another dialog may be open by then. One whose choices were changed
        // meanwhile keeps them (nothing newer is lost) and says what was queued.
        if (!mounted.current) return;
        if (revision.current === submitted) onClose();
        else setMessage(IMPORT_QUEUED_NEWER);
        return;
      }
      if (mounted.current)
        setMessage(
          outcome.reason === "denied"
            ? VIEW_ONLY_IMPORT
            : refusalMessage(outcome.reason),
        );
    } catch {
      // A request the facade refused as built wrongly, or a failure it did not classify: nothing was stored.
      if (mounted.current) setMessage(NOT_SAVED);
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
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
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          {sourceId === null &&
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
                onChange={(event) => {
                  revision.current += 1;
                  setChosen(event.target.value);
                }}
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
                  if (chosen === null && selected !== null) setChosen(selected);
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
            onChange={(event) => void choose(event.target.files?.[0])}
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
          onChange={(event) => {
            revision.current += 1;
            setWindow((w) => ({ ...w, from: event.target.value }));
          }}
        />
        <Field
          label={THROUGH}
          name="through"
          type="date"
          value={window_.through}
          error={errors.through}
          onChange={(event) => {
            revision.current += 1;
            setWindow((w) => ({ ...w, through: event.target.value }));
          }}
        />
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          {DIALOG_BOUNDS}
        </p>
        <FormMessage message={message} />
      </form>
    </Dialog>
  );
}
