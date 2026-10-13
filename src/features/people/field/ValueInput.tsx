import { useId } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import * as copy from "../copy";
import type {
  FieldFormAction,
  FieldInputProblem,
  ProblemSlot,
  ValueSlots,
} from "../model/field-form";
import { charCount, type FieldKind, LIMITS } from "../model/values";
import { Choices, FieldError } from "../parts";

/**
 * The value input of the active type (WF-PEOPLE-03 §4.4). Each type edits its OWN slot; the other slots are kept as they are (switching
 * back restores them). Validation messages sit under their input, linked by `aria-describedby`.
 */
export function ValueInput({
  kind,
  slots,
  dispatch,
  problems,
  newId,
  readOnly,
}: {
  kind: FieldKind;
  slots: ValueSlots;
  dispatch(action: FieldFormAction): void;
  problems: Partial<Record<ProblemSlot, FieldInputProblem>>;
  newId(): string;
  readOnly: boolean;
}) {
  const ids = {
    name: useId(),
    text: useId(),
    amount: useId(),
    unit: useId(),
    date: useId(),
    url: useId(),
    boolean: useId(),
    options: useId(),
    items: useId(),
    hint: useId(),
    count: useId(),
  };
  const message = (slot: ProblemSlot) => {
    const problem = problems[slot];
    return problem === undefined ? undefined : copy.PROBLEM[problem];
  };
  const described = (slot: ProblemSlot, ...extra: string[]) =>
    [problems[slot] === undefined ? null : ids[slot], ...extra]
      .filter(Boolean)
      .join(" ") || undefined;
  switch (kind) {
    case "text": {
      const text = slots.text.text;
      return (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`${ids.text}-input`}
            className="text-[13px] font-medium text-ink-1"
          >
            {copy.FIELD_VALUE}
          </label>
          <textarea
            id={`${ids.text}-input`}
            value={text}
            readOnly={readOnly}
            rows={4}
            aria-invalid={problems.text ? true : undefined}
            aria-describedby={described("text", ids.count)}
            onChange={(event) =>
              dispatch({
                type: "slot",
                kind: "text",
                value: { text: event.target.value },
              })
            }
            className="atlas-transition min-h-24 w-full rounded-control border border-field-edge bg-panel px-3 py-2.5 text-[14px] text-ink-1"
          />
          <span id={ids.count} className="text-[12px] text-ink-2">
            {copy.CHARACTERS(charCount(text), LIMITS.text)}
          </span>
          <FieldError id={ids.text} message={message("text")} />
        </div>
      );
    }
    case "quantity":
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label={copy.AMOUNT}
                inputMode="decimal"
                surface="panel"
                readOnly={readOnly}
                value={slots.quantity.amount}
                aria-invalid={problems.amount ? true : undefined}
                aria-describedby={described("amount")}
                onChange={(event) =>
                  dispatch({
                    type: "slot",
                    kind: "quantity",
                    value: { ...slots.quantity, amount: event.target.value },
                  })
                }
              />
            </div>
            <div className="min-w-0 flex-1">
              <Input
                label={copy.UNIT}
                surface="panel"
                readOnly={readOnly}
                value={slots.quantity.unit}
                aria-invalid={problems.unit ? true : undefined}
                aria-describedby={described("unit")}
                onChange={(event) =>
                  dispatch({
                    type: "slot",
                    kind: "quantity",
                    value: { ...slots.quantity, unit: event.target.value },
                  })
                }
              />
            </div>
          </div>
          <FieldError id={ids.amount} message={message("amount")} />
          <FieldError id={ids.unit} message={message("unit")} />
        </div>
      );
    case "date":
      return (
        <fieldset
          className="flex flex-col gap-1.5"
          aria-describedby={described("date", ids.hint)}
        >
          <legend className="mb-1.5 text-[13px] font-medium text-ink-1">
            {copy.FIELD_VALUE}
          </legend>
          <div className="flex gap-2">
            {(
              [
                ["day", copy.DAY],
                ["month", copy.MONTH],
                ["year", copy.YEAR],
              ] as const
            ).map(([part, label]) => (
              <div key={part} className="min-w-0 flex-1">
                <Input
                  label={label}
                  inputMode="numeric"
                  surface="panel"
                  readOnly={readOnly}
                  value={slots.date[part]}
                  aria-invalid={problems.date ? true : undefined}
                  onChange={(event) =>
                    dispatch({
                      type: "slot",
                      kind: "date",
                      value: { ...slots.date, [part]: event.target.value },
                    })
                  }
                />
              </div>
            ))}
          </div>
          <span id={ids.hint} className="text-[12px] text-ink-2">
            {copy.YEAR_HINT}
          </span>
          <FieldError id={ids.date} message={message("date")} />
        </fieldset>
      );
    case "url":
      return (
        <div className="flex flex-col gap-1.5">
          <Input
            label={copy.LINK}
            type="url"
            surface="panel"
            readOnly={readOnly}
            value={slots.url.url}
            aria-invalid={problems.url ? true : undefined}
            aria-describedby={described("url")}
            onChange={(event) =>
              dispatch({
                type: "slot",
                kind: "url",
                value: { url: event.target.value },
              })
            }
          />
          <FieldError id={ids.url} message={message("url")} />
        </div>
      );
    case "boolean":
      return (
        <div
          className="flex flex-col gap-1.5"
          aria-describedby={described("boolean")}
        >
          <span className="text-[13px] font-medium text-ink-1">
            {copy.FIELD_VALUE}
          </span>
          <Choices<"yes" | "no">
            label={copy.FIELD_VALUE}
            value={
              slots.boolean.value === null
                ? null
                : slots.boolean.value
                  ? "yes"
                  : "no"
            }
            disabled={readOnly}
            onChange={(value) =>
              dispatch({
                type: "slot",
                kind: "boolean",
                value: { value: value === "yes" },
              })
            }
            choices={[
              { value: "yes", label: copy.YES },
              { value: "no", label: copy.NO },
            ]}
          />
          <FieldError id={ids.boolean} message={message("boolean")} />
        </div>
      );
    case "choices": {
      const options = slots.choices.options;
      const set = (next: typeof options) =>
        dispatch({ type: "slot", kind: "choices", value: { options: next } });
      return (
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={described("options")}
        >
          <legend className="mb-1.5 text-[13px] font-medium text-ink-1">
            {copy.OPTIONS}
          </legend>
          {options.map((option, index) => (
            <div key={option.key} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label={copy.OPTION_N(index + 1)}
                  surface="panel"
                  readOnly={readOnly}
                  value={option.label}
                  onChange={(event) =>
                    set(
                      options.map((o) =>
                        o.key === option.key
                          ? { ...o, label: event.target.value }
                          : o,
                      ),
                    )
                  }
                />
              </div>
              <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink-1">
                <input
                  type="checkbox"
                  checked={option.selected}
                  disabled={readOnly}
                  onChange={(event) =>
                    set(
                      options.map((o) =>
                        o.key === option.key
                          ? { ...o, selected: event.target.checked }
                          : o,
                      ),
                    )
                  }
                  className="size-4"
                />
                {copy.SELECTED}
              </label>
              {readOnly ? null : (
                <Button
                  variant="quiet"
                  aria-label={`${copy.REMOVE} ${copy.OPTION_N(index + 1)}`}
                  onClick={() =>
                    set(options.filter((o) => o.key !== option.key))
                  }
                >
                  {copy.REMOVE}
                </Button>
              )}
            </div>
          ))}
          {readOnly ? null : (
            <Button
              data-people-action="add-option"
              onClick={() =>
                set([...options, { key: newId(), label: "", selected: false }])
              }
            >
              {copy.ADD_OPTION}
            </Button>
          )}
          <FieldError id={ids.options} message={message("options")} />
        </fieldset>
      );
    }
    case "checklist": {
      const items = slots.checklist.items;
      const set = (next: typeof items) =>
        dispatch({ type: "slot", kind: "checklist", value: { items: next } });
      return (
        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={described("items")}
        >
          <legend className="mb-1.5 text-[13px] font-medium text-ink-1">
            {copy.ITEMS}
          </legend>
          {items.map((item, index) => (
            <div key={item.id} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label={copy.ITEM_N(index + 1)}
                  surface="panel"
                  readOnly={readOnly}
                  value={item.label}
                  onChange={(event) =>
                    set(
                      items.map((i) =>
                        i.id === item.id
                          ? { ...i, label: event.target.value }
                          : i,
                      ),
                    )
                  }
                />
              </div>
              <label className="flex min-h-11 items-center gap-2 text-[13px] text-ink-1">
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled={readOnly}
                  onChange={(event) =>
                    set(
                      items.map((i) =>
                        i.id === item.id
                          ? { ...i, checked: event.target.checked }
                          : i,
                      ),
                    )
                  }
                  className="size-4"
                />
                {copy.DONE}
              </label>
              {readOnly ? null : (
                <Button
                  variant="quiet"
                  aria-label={`${copy.REMOVE} ${copy.ITEM_N(index + 1)}`}
                  onClick={() => set(items.filter((i) => i.id !== item.id))}
                >
                  {copy.REMOVE}
                </Button>
              )}
            </div>
          ))}
          {readOnly ? null : (
            <Button
              data-people-action="add-item"
              // A new item gets a fresh UUID once; editing it later keeps it (a checked item stays the same item).
              onClick={() =>
                set([...items, { id: newId(), label: "", checked: false }])
              }
            >
              {copy.ADD_ITEM}
            </Button>
          )}
          <FieldError id={ids.items} message={message("items")} />
        </fieldset>
      );
    }
  }
}
