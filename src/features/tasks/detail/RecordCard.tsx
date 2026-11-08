import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { pillClass } from "../../../components/ui/chip";
import { Input } from "../../../components/ui/input";
import { RecoveryNotice } from "../../../lib/form-recovery/RecoveryNotice";
import { cn } from "../../../lib/utils";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import {
  completeKept,
  type KeptRecovery,
  type KeptTicket,
  keptKey,
  useKeptInput,
} from "../kept-input";
import type { Evidence } from "../model/contract";
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
type RecordInput = { mode: "amount" | "observe"; amount: string };

const recordRecovery = (progressId: string): KeptRecovery<RecordInput> => ({
  context: `record:${progressId}`,
  encode: (input) =>
    JSON.stringify({ v: 1, mode: input.mode, amount: input.amount }),
  decode: (text) => {
    try {
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      return raw !== null &&
        typeof raw === "object" &&
        raw.v === 1 &&
        (raw.mode === "amount" || raw.mode === "observe") &&
        typeof raw.amount === "string"
        ? { mode: raw.mode, amount: raw.amount }
        : null;
    } catch {
      return null;
    }
  },
});

export function RecordCard({
  row,
  actions,
  now,
  zone,
  writable,
  focus,
  gate,
  extra,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "record">;
  now: number;
  zone: string;
  writable: boolean;
  /** Arrived from Today's "Record": the card takes focus. */
  focus?: boolean;
  /**
   * WEB-10c: evidence that would complete a day still waiting for something opens the preview instead of a plain record (`true`: it
   * did, and owns the ticket from then on). Absent: every record is queued as before.
   */
  gate?: (evidence: Evidence, ticket: KeptTicket | null) => boolean;
  /** The day's other acts, drawn in the same row (the Final design): the correction, the timer. */
  extra?: ReactNode;
}) {
  const env = useTasksEnv();
  const heading = useId();
  const section = useRef<HTMLElement>(null);
  // The amount being typed, and which of "Log an amount" / "Just checked on it" is chosen, belong to an editing session of my progress on
  // this day (revision 18, R33; `kept-input.ts`): a visit to the sync screens keeps them, raw, and coming back shows them again. Every edit
  // moves the session's revision: a save clears the amount only if nothing was typed after the amount it submitted (R3, revision 1;
  // PRODUCT-DECISIONS-20261011), whichever mount made it: a successful older save never consumes newer input.
  // Revision 37 (WEB-14a R40): recoverable around an app-update reload (Q4), for exactly this progress stream (the day's occurrence and me):
  // a copy is restored only into this card, never into another day's.
  const input = useKeptInput<RecordInput>(
    keptKey(env.identity, `record:${row.progressId}`),
    env.identity,
    () => ({ mode: "amount", amount: "" }),
    {
      consumed: (submitted) => ({ ...submitted, amount: "" }),
      recover: recordRecovery(row.progressId),
    },
  );
  const { mode, amount } = input.value;
  const amountRef = useRef<HTMLInputElement>(null);
  // WEB-14a revision 51 (DA-N1, F-R51-1): the restored card's first field is the amount when "Log an amount" is chosen, else the chosen
  // mode itself ("Just checked on it" has no amount field), read from the committed DOM at each attempt, so "Discard instead" from the
  // observe mode focuses the amount field its reset brings back. A goal with neither (nothing of it is kept) falls back to the card.
  const modeRef = useRef<HTMLInputElement>(null);
  const restoredFocus = () =>
    amountRef.current ?? modeRef.current ?? section.current;
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
  // The day's action row (the Final design): the record control and the day's other acts in one line under the facts; on the phone it
  // stays in reach at the bottom of the viewport. The heading is for assistive technology only.
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby={heading}
      data-record-card={goal.kind}
      className={cn(
        "flex flex-col gap-3",
        "max-tablet:sticky max-tablet:bottom-0 max-tablet:z-20 max-tablet:-mx-4 max-tablet:border-t max-tablet:border-border/70 max-tablet:bg-background/95 max-tablet:px-4 max-tablet:py-3 max-tablet:backdrop-blur",
      )}
    >
      <h2 id={heading} className="sr-only">
        {RECORD_COPY.heading}
      </h2>
      {input.recovery ? (
        <RecoveryNotice
          recovery={input.recovery}
          firstFieldRef={restoredFocus}
        />
      ) : null}
      {goal.kind === "checkbox" ? (
        <div
          className="flex flex-wrap items-start gap-2"
          data-record-actions=""
        >
          {reason !== null || busy ? (
            blocked(done ? copy.MARK_NOT_DONE : copy.MARK_DONE)
          ) : (
            <Button
              variant={done ? "outline" : "default"}
              className="px-5"
              onClick={() => {
                const evidence: Evidence = {
                  kind: "checkbox",
                  complete: !done,
                };
                if (gate?.(evidence, null)) return;
                void run(() =>
                  actions.record(
                    row,
                    evidence,
                    null,
                    done ? copy.ANNOUNCE_NOT_DONE : copy.ANNOUNCE_DONE,
                  ),
                );
              }}
            >
              {done ? null : (
                <Check
                  aria-hidden="true"
                  className="size-4"
                  strokeWidth={2.6}
                />
              )}
              {done ? copy.MARK_NOT_DONE : copy.MARK_DONE}
            </Button>
          )}
          {extra}
        </div>
      ) : goal.kind === "numeric" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground" data-record-progress="">
            {RECORD_COPY.progress(
              amountShown,
              goal.minimum ?? goal.maximum,
              goal.unit,
            )}
          </p>
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">{RECORD_COPY.heading}</legend>
            {(["amount", "observe"] as const).map((m) => (
              <label
                key={m}
                className={cn(
                  pillClass(mode === m),
                  "cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                )}
              >
                <input
                  ref={mode === m ? modeRef : undefined}
                  type="radio"
                  name={`${heading}-mode`}
                  checked={mode === m}
                  onChange={() => input.edit((v) => ({ ...v, mode: m }))}
                  className="sr-only"
                />
                {m === "amount" ? RECORD_COPY.logAmount : RECORD_COPY.checkedOn}
              </label>
            ))}
          </fieldset>
          {mode === "amount" ? (
            <div
              className="flex flex-wrap items-end gap-2"
              data-record-actions=""
            >
              <div className="w-32">
                <Input
                  ref={amountRef}
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
                    if (gate?.({ kind: "quantity", amount: value }, ticket))
                      return;
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
              {extra}
            </div>
          ) : (
            <div
              className="flex flex-wrap items-start gap-2"
              data-record-actions=""
            >
              {reason !== null || busy ? (
                blocked(copy.RECORD)
              ) : (
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
              )}
              {extra}
            </div>
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
                    onChange={() => {
                      const evidence: Evidence = {
                        kind: "checklist",
                        item_id: item.id,
                        complete: !checked,
                      };
                      if (gate?.(evidence, null)) return;
                      void run(() =>
                        actions.record(
                          row,
                          evidence,
                          null,
                          RECORD_COPY.recorded,
                        ),
                      );
                    }}
                    className="size-[15px]"
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
      {goal.kind === "checklist" && extra ? (
        <div
          className="flex flex-wrap items-start gap-2"
          data-record-actions=""
        >
          {extra}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{RECORD_COPY.offline}</p>
    </section>
  );
}
