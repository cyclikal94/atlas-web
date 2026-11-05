import { useId, useState } from "react";
import * as copy from "../copy";
import { type FieldValue, formatValue, parseFieldValue } from "../model/values";

/**
 * A field's value in the table (§4.3): text line-clamped with "Show more"; an amount "{amount} {unit}"; a date "3 March" or "3 March 2027";
 * a link (new tab, said so); "Yes"/"No"; the selected choices "of {n}"; a checklist "{checked} of {n} done" with its items in a disclosure.
 * A value that does not parse strictly is "This value can't be shown on this device", never guessed.
 */
export function FieldValueView({
  raw,
  anywhere = false,
}: {
  raw: unknown;
  /**
   * WEB-11b revision 1 (R5): the text may break at any point. `break-words` keeps a whole unbroken word as the text's MINIMUM width, which
   * widens an automatic layout (the merge comparison); set inline, so it adds nothing to the stylesheet.
   */
  anywhere?: boolean;
}) {
  const value = parseFieldValue(raw);
  if (value === null)
    return (
      <span data-unreadable-value="" className="text-[13px] text-ink-2">
        {copy.UNREADABLE_VALUE}
      </span>
    );
  return <Known value={value} anywhere={anywhere} />;
}

function Known({ value, anywhere }: { value: FieldValue; anywhere: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  switch (value.kind) {
    case "text": {
      const long = value.text.length > 140 || value.text.includes("\n");
      return (
        <span className="flex flex-col items-start gap-1">
          <span
            id={id}
            className={`whitespace-pre-wrap break-words text-[13.5px] text-ink-1 ${!open && long ? "line-clamp-2" : ""}`}
            style={anywhere ? { overflowWrap: "anywhere" } : undefined}
          >
            {value.text}
          </span>
          {long ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen(!open)}
              className="min-h-11 text-[12.5px] text-action-ink underline"
            >
              {open ? copy.SHOW_LESS : copy.SHOW_MORE}
            </button>
          ) : null}
        </span>
      );
    }
    case "url":
      return (
        <a
          href={value.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-[13.5px] text-action-ink underline"
        >
          {value.url}
          <span className="sr-only"> {copy.OPENS_NEW_TAB}</span>
        </a>
      );
    case "choices":
      return (
        <span className="text-[13.5px] text-ink-1">
          {value.selected.length === 0 ? "—" : value.selected.join(", ")}{" "}
          <span className="text-ink-2">
            {copy.OF_TOTAL(value.options.length)}
          </span>
        </span>
      );
    case "checklist":
      return (
        <span className="flex flex-col items-start gap-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            className="min-h-11 text-left text-[13.5px] text-ink-1 underline"
          >
            {formatValue(value)}
          </button>
          {open ? (
            <ul id={id} className="m-0 flex list-none flex-col gap-1 p-0">
              {value.items.map((item) => (
                <li key={item.id} className="text-[13px] text-ink-1">
                  <span aria-hidden="true">
                    {value.checked.includes(item.id) ? "✓ " : "○ "}
                  </span>
                  <span className="sr-only">
                    {value.checked.includes(item.id) ? `${copy.DONE}: ` : ""}
                  </span>
                  {item.label}
                </li>
              ))}
            </ul>
          ) : null}
        </span>
      );
    default:
      return (
        <span className="text-[13.5px] text-ink-1">{formatValue(value)}</span>
      );
  }
}
