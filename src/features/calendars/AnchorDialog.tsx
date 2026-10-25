import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import type {
  AnchorEditor,
  AnchorEditorState,
  AnchorRefusal,
} from "./anchor-editor";
import { CANCEL } from "./copy";
import {
  ANCHOR_TITLE,
  CALENDAR_DAYS,
  CHANGE_EVENT,
  CHOOSE_FIELD,
  CLEAR_TIME,
  DAYS_LABEL,
  EVENT_SERIES,
  NEEDS_TIMED_EVENT,
  NO_EVENT,
  NO_FIELD,
  OFFSET,
  OR_SECONDS,
  PERSON_DATE,
  REFERENCE,
  REMOVE_ANCHOR,
  REMOVE_HELP,
  REPEATS_ANNUALLY,
  REPEATS_ITSELF,
  SAVE_ANCHOR,
  SECONDS_LABEL,
  SELECTED,
  TIME_LABEL,
  TITLE_CONTAINS,
  WEEKDAY_LETTERS,
  WEEKDAY_NAMES,
  WEEKDAYS,
} from "./copy-anchor";
import { Field, FormMessage } from "./fields";
import {
  type AnchorDraft,
  type AnchorErrors,
  type AnchorNames,
  annualForced,
  type CalendarAnchor,
  secondsAllowed,
  validateAnchor,
} from "./model/anchor";
import { EventPicker, FieldPicker } from "./pickers";

/**
 * The anchor-configuration panel (WEB-13b §4.3; the wireframe's "Anchor configuration"): a reference (an event series or a person's date
 * field), an offset (calendar days at an optional time, or seconds before or after a timed event), eligible weekdays and, for an event
 * series, a title filter. It offers only what the server accepts: seconds only for a timed event, "repeats annually" fixed for a date
 * without a year, and no Save at all while the task repeats on its own schedule.
 *
 * Every field keeps what was typed when it is hidden (the person-date variant hides Title contains; the other offset variant's fields are
 * not shown) and shows it again when it comes back; Save sends only what applies (PRODUCT-DECISIONS-20261011). Field messages are inline,
 * under their field, on an attempted save; nothing typed is cleared.
 *
 * The panel PRESENTS one editing session (`anchor-editor.ts`; revision 2, R3a/R3b): the input, the save being made and what it said are
 * the session's, so they outlive this mount. What Save and Remove DO is the caller's (`onSave`/`onRemove`): the new-task form keeps the
 * anchor for its create; a task's own section queues `set_anchor`. Each answers null when done or the words of why not (the panel stays,
 * with everything kept). Done settles only what was submitted (R3, PRODUCT-DECISIONS-20261011): a session consumed by its own save closes
 * the panel showing it; with newer input the panel stays and says the save was made as pressed.
 *
 * The in-dialog sync control is a deliberate check of sync state, not a discard (ia.md §1.3.3, task states I1; WEB-13b revision 1): with
 * `onRetain`, the caller keeps the session (or, the new-task form, its state) for the next panel it opens while the person's visit goes on.
 * Cancel, Escape and the close icon are the caller's `onClose` (it ends the session unless it was kept).
 */
export function AnchorDialog<C>({
  editor,
  repeats,
  onSave,
  onRemove,
  onRetain,
  onClose,
}: {
  /** The editing session this panel shows. */
  editor: AnchorEditor<C>;
  /** The task repeats on its own schedule: no anchor can be saved (the server answers `422`). */
  repeats: boolean;
  /** `draft`: the panel's whole state when it was saved (every field, applicable or not), for a caller that opens it again. */
  onSave(
    anchor: CalendarAnchor,
    names: AnchorNames,
    draft: AnchorDraft,
    context: C,
  ): Promise<string | null | AnchorRefusal<C>>;
  onRemove?(context: C): Promise<string | null | AnchorRefusal<C>>;
  /** The in-dialog sync control: keep this session (or its state) for the next panel (the dialog closes, the sync screens open). */
  onRetain?(state: AnchorEditorState): void;
  onClose(): void;
}) {
  const formId = useId();
  const { draft, names, busy, note } = useSyncExternalStore(
    editor.subscribe,
    editor.state,
  );
  const [view, setView] = useState<"main" | "event" | "field">("main");
  const [errors, setErrors] = useState<AnchorErrors>({});
  const close = useRef(onClose);
  close.current = onClose;
  // The session consumed by its own save closes the panel showing it, whenever the save completes (before this panel was shown included).
  useEffect(() => {
    if (editor.ended()) {
      close.current();
      return;
    }
    return editor.subscribe((event) => {
      if (event === "consumed") close.current();
    });
  }, [editor]);
  const edit = (patch: Partial<AnchorDraft>, picked?: Partial<AnchorNames>) =>
    editor.edit(patch, picked);

  const save = () => {
    if (repeats) return;
    const now = editor.state();
    const out = validateAnchor(now.draft);
    if ("errors" in out) {
      setErrors(out.errors);
      return;
    }
    setErrors({});
    editor.submit((context) =>
      onSave(out.anchor, now.names, now.draft, context),
    );
  };

  const seconds = secondsAllowed(draft);
  const forced = annualForced(draft);
  const eventSummary =
    draft.event === null
      ? NO_EVENT
      : [names.source, names.event ? `“${names.event}”` : null]
          .filter(Boolean)
          .join(", ") || draft.event.uid;
  const fieldSummary = draft.field === null ? NO_FIELD : (names.field ?? "");

  return (
    <Dialog
      open
      onClose={onClose}
      {...(onRetain === undefined
        ? {}
        : {
            onRetainDraft: () => onRetain(editor.state()),
          })}
      title={ANCHOR_TITLE}
      footer={
        view === "main" ? (
          <>
            {busy ? (
              <Button variant="primary" disabled reason="Saving…">
                {SAVE_ANCHOR}
              </Button>
            ) : repeats ? (
              <Button variant="primary" disabled reason={REPEATS_ITSELF}>
                {SAVE_ANCHOR}
              </Button>
            ) : (
              <Button variant="primary" type="submit" form={formId}>
                {SAVE_ANCHOR}
              </Button>
            )}
            {onRemove !== undefined ? (
              busy ? (
                <Button disabled reason="Saving…">
                  {REMOVE_ANCHOR}
                </Button>
              ) : (
                <Button onClick={() => editor.submit(onRemove)}>
                  {REMOVE_ANCHOR}
                </Button>
              )
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              {CANCEL}
            </Button>
          </>
        ) : undefined
      }
    >
      {view === "event" ? (
        <EventPicker
          initialSource={draft.event?.sourceId ?? null}
          onBack={() => setView("main")}
          onPick={(event, picked) => {
            edit({ reference: "event_series", event }, picked);
            setView("main");
          }}
        />
      ) : view === "field" ? (
        <FieldPicker
          onBack={() => setView("main")}
          onPick={(field, picked) => {
            edit({ reference: "person_date", field }, picked);
            setView("main");
          }}
        />
      ) : (
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            // The panel may be opened from inside another form (the new-task form): its submission is its own, never that form's (React
            // events bubble through the portal).
            event.stopPropagation();
            save();
          }}
        >
          {repeats ? (
            <p
              data-anchor-repeats=""
              className="rounded-row border border-hairline-strong bg-panel p-3 text-[12.5px] leading-[1.6] text-ink-1"
            >
              {REPEATS_ITSELF}
            </p>
          ) : null}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-1">
              {REFERENCE}
            </legend>
            <div className="flex flex-col gap-2 tablet:flex-row">
              <div className="flex flex-1 flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3">
                <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-1">
                  <input
                    type="radio"
                    name={`${formId}-reference`}
                    checked={draft.reference === "event_series"}
                    onChange={() => edit({ reference: "event_series" })}
                  />
                  {EVENT_SERIES}
                </label>
                <span className="break-words text-[12.5px] text-ink-2">
                  {eventSummary}
                  {draft.reference === "event_series" && draft.event !== null
                    ? ` · ${SELECTED}`
                    : ""}
                </span>
                <Button onClick={() => setView("event")}>{CHANGE_EVENT}</Button>
              </div>
              <div className="flex flex-1 flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3">
                <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-1">
                  <input
                    type="radio"
                    name={`${formId}-reference`}
                    checked={draft.reference === "person_date"}
                    onChange={() => edit({ reference: "person_date" })}
                  />
                  {PERSON_DATE}
                </label>
                <span className="break-words text-[12.5px] text-ink-2">
                  {fieldSummary}
                  {draft.reference === "person_date" && draft.field !== null
                    ? ` · ${SELECTED}`
                    : ""}
                </span>
                <Button onClick={() => setView("field")}>{CHOOSE_FIELD}</Button>
                <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink-1">
                  <input
                    type="checkbox"
                    checked={forced || draft.annual}
                    disabled={forced || draft.reference !== "person_date"}
                    onChange={(event) => edit({ annual: event.target.checked })}
                  />
                  {REPEATS_ANNUALLY}
                </label>
              </div>
            </div>
            {errors.reference ? (
              <p
                data-field-error=""
                className="text-[12.5px] leading-[1.5] text-ink-1"
              >
                {errors.reference}
              </p>
            ) : null}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-1">
              {OFFSET}
            </legend>
            <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-1">
              <input
                type="radio"
                name={`${formId}-offset`}
                checked={draft.offset === "calendar_days"}
                onChange={() => edit({ offset: "calendar_days" })}
              />
              {CALENDAR_DAYS}
            </label>
            {draft.offset === "calendar_days" ? (
              <div className="flex flex-col gap-2">
                <Field
                  label={DAYS_LABEL}
                  name="days"
                  inputMode="numeric"
                  value={draft.days}
                  error={errors.days}
                  onChange={(event) => edit({ days: event.target.value })}
                />
                <Field
                  label={TIME_LABEL}
                  name="time"
                  placeholder="18:00"
                  autoComplete="off"
                  value={draft.time}
                  error={errors.time}
                  // Editing the time ends the anchor's own exact time (R5): what is typed is what is sent.
                  onChange={(event) =>
                    edit({ time: event.target.value, keptTime: null })
                  }
                />
                <span className="flex">
                  <Button
                    variant="quiet"
                    onClick={() => edit({ time: "", keptTime: null })}
                  >
                    {CLEAR_TIME}
                  </Button>
                </span>
              </div>
            ) : null}
            <label className="flex min-h-11 items-center gap-2 text-[14px] text-ink-1">
              <input
                type="radio"
                name={`${formId}-offset`}
                checked={draft.offset === "elapsed_seconds"}
                disabled={!seconds}
                aria-describedby={seconds ? undefined : `${formId}-seconds-why`}
                onChange={() => edit({ offset: "elapsed_seconds" })}
              />
              {OR_SECONDS}
            </label>
            {!seconds ? (
              <span
                id={`${formId}-seconds-why`}
                className="text-[12px] text-ink-2"
              >
                {NEEDS_TIMED_EVENT}
              </span>
            ) : null}
            {draft.offset === "elapsed_seconds" ? (
              <Field
                label={SECONDS_LABEL}
                name="seconds"
                inputMode="numeric"
                value={draft.seconds}
                error={errors.seconds}
                onChange={(event) => edit({ seconds: event.target.value })}
              />
            ) : null}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-[13px] font-medium text-ink-1">
              {WEEKDAYS}
            </legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_LETTERS.map((letter, index) => {
                const day = index + 1;
                const on = draft.weekdays.includes(day);
                return (
                  <button
                    key={WEEKDAY_NAMES[index]}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_NAMES[index]}
                    onClick={() =>
                      edit({
                        weekdays: on
                          ? draft.weekdays.filter((d) => d !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                    className={`atlas-transition inline-flex size-11 items-center justify-center rounded-control text-[13.5px] ${on ? "bg-action-fill text-action-on hover:bg-action-hover font-medium" : "bg-raised border border-hairline-strong text-ink-1 hover:bg-row-hover"}`}
                  >
                    {letter}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {draft.reference === "event_series" ? (
            <Field
              label={TITLE_CONTAINS}
              name="title-contains"
              autoComplete="off"
              value={draft.titleContains}
              error={errors.titleContains}
              onChange={(event) => edit({ titleContains: event.target.value })}
            />
          ) : null}
          {onRemove !== undefined ? (
            <p className="text-[12.5px] leading-[1.6] text-ink-2">
              {REMOVE_HELP}
            </p>
          ) : null}
          <FormMessage message={note} />
        </form>
      )}
    </Dialog>
  );
}
