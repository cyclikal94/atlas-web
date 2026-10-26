import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { completeKept, keptKey, useKeptInput } from "../kept-input";
import { parseDecimalInput } from "../model/decimal";
import { MESSAGES } from "../model/form";
import { recordBlock } from "../reasons";
import type { RowModel } from "../view";

export const RECORD_COPY = {
  heading: "Record progress",
  logAmount: "Log an amount",
  checkedOn: "Just checked on it",
  amount: "Amount",
  offline: "Saves offline and sends when you're back online.",
  progress: (amount: string, target: string | null, unit: string) =>
    target === null
      ? `${amount} ${unit} today`
      : `${amount} / ${target} ${unit} today`,
  item: (label: string) => label,
  recorded: "Recorded. Not sent yet.",
  checked: "Noted that you checked. Not sent yet.",
} as const;

/**
 * The Record progress card (WF-TASK-01), by the occurrence's FROZEN goal: a tick (Mark done / Mark not done), an amount or "Just checked on
 * it" (`observe`), or one checkbox per checklist item. Every act appends evidence; nothing is ever deleted. Disabled with its reason when
 * I cannot record now. A unit of seconds still records a quantity (the timer is WEB-10c's).
 */
export function RecordCard({
  row,
  actions,
  now,
  zone,
  writable,
  focus,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "record">;
  now: number;
  zone: string;
  writable: boolean;
  /** Arrived from Today's "Record": the card takes focus. */
  focus?: boolean;
}) {
  const env = useTasksEnv();
  const heading = useId();
  const section = useRef<HTMLElement>(null);
  // The amount being typed, and which of "Log an amount" / "Just checked on it" is chosen, belong to an editing session of my progress on
  // this day (revision 18, R33; `kept-input.ts`): a visit to the sync screens keeps them, raw, and coming back shows them again. Every edit
  // moves the session's revision: a save clears the amount only if nothing was typed after the amount it submitted (R3, revision 1;
  // PRODUCT-DECISIONS-20261011), whichever mount made it: a successful older save never consumes newer input.
  const input = useKeptInput<{ mode: "amount" | "observe"; amount: string }>(
    keptKey(env.identity, `record:${row.progressId}`),
    env.identity,
    () => ({ mode: "amount", amount: "" }),
    { consumed: (submitted) => ({ ...submitted, amount: "" }) },
  );
  const { mode, amount } = input.value;
  const [error, setError] = useState<string | null>(null);
  const [running, setBusy] = useState(false);
  const busy = running || input.busy;
  const reason = recordBlock(row, now, zone, writable);
  const goal = row.data.definition.goal;
  const done = row.outcome === "complete";
  useEffect(() => {
    if (focus) section.current?.focus();
  }, [focus]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const summary = row.personal.kind === "result" ? row.personal.action : null;
  const amountShown = summary?.amount ?? "0";
  const blocked = (label: string) => (
    <Button disabled reason={reason ?? copy.SAVING}>
      {label}
    </Button>
  );
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby={heading}
      data-record-card={goal.kind}
      className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm"
    >
      <h2
        id={heading}
        className="text-base font-semibold tracking-tight text-foreground"
      >
        {RECORD_COPY.heading}
      </h2>
      {goal.kind === "checkbox" ? (
        <span>
          {reason !== null || busy ? (
            blocked(done ? copy.MARK_NOT_DONE : copy.MARK_DONE)
          ) : (
            <Button
              variant={done ? "outline" : "default"}
              onClick={() =>
                void run(() =>
                  actions.record(
                    row,
                    { kind: "checkbox", complete: !done },
                    null,
                    done ? copy.ANNOUNCE_NOT_DONE : copy.ANNOUNCE_DONE,
                  ),
                )
              }
            >
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          )}
        </span>
      ) : goal.kind === "numeric" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground" data-record-progress="">
            {RECORD_COPY.progress(
              amountShown,
              goal.minimum ?? goal.maximum,
              goal.unit,
            )}
          </p>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="sr-only">{RECORD_COPY.heading}</legend>
            {(["amount", "observe"] as const).map((m) => (
              <label
                key={m}
                className="inline-flex min-h-11 items-center gap-2 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name={`${heading}-mode`}
                  checked={mode === m}
                  onChange={() => input.edit((v) => ({ ...v, mode: m }))}
                  className="size-4"
                />
                {m === "amount" ? RECORD_COPY.logAmount : RECORD_COPY.checkedOn}
              </label>
            ))}
          </fieldset>
          {mode === "amount" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32">
                <Input
                  label={`${RECORD_COPY.amount} (${goal.unit})`}
                  inputMode="decimal"
                  value={amount}
                  aria-invalid={error !== null}
                  aria-describedby={error ? `${heading}-error` : undefined}
                  onChange={(event) => {
                    const typed = event.target.value;
                    input.edit((v) => ({ ...v, amount: typed }));
                    setError(null);
                  }}
                />
              </div>
              {reason !== null || busy ? (
                blocked(copy.RECORD)
              ) : (
                <Button
                  variant="default"
                  onClick={() => {
                    const value = parseDecimalInput(amount);
                    if (value === null) {
                      setError(MESSAGES.amount);
                      return;
                    }
                    const ticket = input.submit();
                    if (ticket === null) return;
                    void (async () => {
                      let ok = false;
                      try {
                        ok = (
                          await actions.record(
                            row,
                            { kind: "quantity", amount: value },
                            null,
                            RECORD_COPY.recorded,
                          )
                        ).ok;
                      } finally {
                        completeKept(ticket, ok);
                      }
                    })();
                  }}
                >
                  {copy.RECORD}
                </Button>
              )}
            </div>
          ) : reason !== null || busy ? (
            <span>{blocked(copy.RECORD)}</span>
          ) : (
            <span>
              <Button
                variant="default"
                onClick={() =>
                  void run(() =>
                    actions.record(
                      row,
                      { kind: "observe" },
                      null,
                      RECORD_COPY.checked,
                    ),
                  )
                }
              >
                {copy.RECORD}
              </Button>
            </span>
          )}
          {error ? (
            <p id={`${heading}-error`} className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-1 p-0"
          data-record-checklist=""
        >
          {goal.items.map((item) => {
            const checked = summary?.checked.includes(item.id) ?? false;
            return (
              <li key={item.id}>
                <label className="inline-flex min-h-11 items-center gap-2.5 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={reason !== null || busy}
                    aria-describedby={
                      reason !== null ? `${heading}-reason` : undefined
                    }
                    onChange={() =>
                      void run(() =>
                        actions.record(
                          row,
                          {
                            kind: "checklist",
                            item_id: item.id,
                            complete: !checked,
                          },
                          null,
                          RECORD_COPY.recorded,
                        ),
                      )
                    }
                    className="size-4"
                  />
                  {item.label}
                </label>
              </li>
            );
          })}
          {reason !== null ? (
            <li
              id={`${heading}-reason`}
              className="text-xs text-muted-foreground"
            >
              {reason}
            </li>
          ) : null}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{RECORD_COPY.offline}</p>
    </section>
  );
}
