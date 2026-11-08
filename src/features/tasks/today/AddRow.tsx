import { useId, useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { useQuickAdd } from "./quick-add";
import { RAIL_INSET, RailLine, RailNode } from "./rail";

/**
 * The row at the end of the day that adds to it (the Final design): a dashed node on the rail and one line of text; Enter saves a
 * one-off tick for the day (`useQuickAdd`) and the row appears above at once, "Not sent yet". What was typed stays in the field until the
 * save is queued; a refusal is said beside it and keeps the text.
 */
export function AddRow({
  day,
  dayLabel,
  zone,
  writable,
}: {
  day: string;
  dayLabel: string;
  zone: string;
  writable: boolean;
}) {
  const env = useTasksEnv();
  const add = useQuickAdd(day, zone);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const submit = async () => {
    const title = text.trim();
    if (title === "" || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await add(title);
      if (outcome.ok) setText("");
      else setNote(outcome.message ?? copy.NOT_WRITABLE);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  if (!writable || !env.writable) return null;
  return (
    <form
      className={cn(
        "relative flex min-h-12 flex-col justify-center",
        RAIL_INSET,
      )}
      data-today-add=""
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <RailLine />
      <RailNode past={false} dashed />
      <label htmlFor={id} className="sr-only">
        {copy.QUICK_ADD.label}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        value={text}
        disabled={busy}
        placeholder={copy.QUICK_ADD.placeholder(dayLabel)}
        aria-describedby={note ? `${id}-note` : undefined}
        aria-invalid={note !== null ? true : undefined}
        onChange={(event) => {
          setText(event.target.value);
          if (note !== null) setNote(null);
        }}
        className="h-12 w-full min-w-0 border-0 bg-transparent pr-4 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
      />
      {note ? (
        <p id={`${id}-note`} className="pb-2 text-xs text-destructive">
          {note}
        </p>
      ) : null}
    </form>
  );
}
