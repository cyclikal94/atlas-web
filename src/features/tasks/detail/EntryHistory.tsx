import { useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import type { TaskActions } from "../actions";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel } from "../format";
import { forgetRefusal, noteRefusal, refusalOf } from "../memory";
import { pendingEvidenceOf } from "../model/commands";
import type { Evidence, Goal, JournalEntry } from "../model/contract";
import { parseDecimalInput } from "../model/decimal";
import { MESSAGES } from "../model/form";
import type { RowModel } from "../view";

export const HISTORY_COPY = {
  heading: "Recent entries",
  none: "Nothing recorded for this day yet.",
  byYou: "by you",
  byOther: "by another participant",
  corrected: "Corrected",
  correction: "Correction",
  full: "Full history",
  loadMore: "Load more",
  fullOffline: "The full history needs a connection.",
  failed: "Couldn't load the full history.",
  refused: "This history isn't available to you.",
  fix: "Fix this entry",
  fixSave: "Save the fix",
  cancel: "Cancel",
  fixed: "Fix saved on this device. Not sent yet.",
  newValue: "New value",
  done: "Done",
  notDone: "Not done",
  observed: "Checked on it",
  item: (label: string, complete: boolean) =>
    `${label}: ${complete ? "ticked" : "unticked"}`,
} as const;

export function describeEvidence(evidence: Evidence, goal: Goal): string {
  switch (evidence.kind) {
    case "checkbox":
      return evidence.complete ? HISTORY_COPY.done : HISTORY_COPY.notDone;
    case "quantity":
      return `${evidence.amount}${goal.kind === "numeric" ? ` ${goal.unit}` : ""}`;
    case "checklist": {
      const label =
        goal.kind === "checklist"
          ? (goal.items.find((i) => i.id === evidence.item_id)?.label ?? "?")
          : "?";
      return HISTORY_COPY.item(label, evidence.complete);
    }
    case "observe":
      return HISTORY_COPY.observed;
  }
}

interface Shown {
  id: string;
  evidence: Evidence;
  happenedAt: number;
  recordedBy: string;
  pending: boolean;
  replaced: boolean;
  replaces: string | null;
}

/**
 * History (WF-TASK-01): up to eight recent entries with my pending ones layered on and marked, then, online, the FULL history paged by
 * `sequence` (every entry once; survivors in `logical_order`; replaced ones marked "Corrected"). "Fix this entry" appends a `record` with
 * `replaces` and a value of the same kind: nothing is deleted. Offline a fix is offered only for an entry among the recent ones.
 */
export function EntryHistory({
  row,
  actions,
  zone,
  writable,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "record">;
  zone: string;
  writable: boolean;
}) {
  const env = useTasksEnv();
  const heading = useId();
  const goal = row.data.definition.goal;
  const [journal, setJournal] = useState<{
    entries: JournalEntry[];
    next: number | null;
    error: "failed" | "refused" | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const readKey = `journal:${row.progressId}`;
  const load = async (after: number) => {
    if (refusalOf(env.identity, readKey) !== null && after === 0) {
      setJournal({ entries: [], next: null, error: "refused" });
      return;
    }
    setLoading(true);
    const result = await env.api.readJournal(row.progressId, after);
    setLoading(false);
    if (!result.ok) {
      if (result.kind === "forbidden" || result.kind === "not_found") {
        noteRefusal(env.identity, readKey, result.kind);
        setJournal((j) => ({
          entries: j?.entries ?? [],
          next: null,
          error: "refused",
        }));
      } else if (result.kind !== "closed")
        setJournal((j) => ({
          entries: j?.entries ?? [],
          next: j?.next ?? null,
          error: "failed",
        }));
      return;
    }
    setJournal((j) => {
      const seen = new Map((j?.entries ?? []).map((e) => [e.id, e]));
      for (const e of result.value.entries) seen.set(e.id, e);
      return {
        entries: [...seen.values()],
        next: result.value.next_after,
        error: null,
      };
    });
  };
  const pending = row.drafts
    .map((d) => pendingEvidenceOf(d, env.accountId))
    .filter((p) => p !== null && p.occurrenceId === row.id);
  let shown: Shown[];
  if (journal !== null && journal.error === null) {
    const replacedIds = new Set(
      journal.entries.map((e) => e.replaces).filter((r) => r !== null),
    );
    shown = [...journal.entries]
      .sort(
        (a, b) => a.logical_order - b.logical_order || a.sequence - b.sequence,
      )
      .map((e) => ({
        id: e.id,
        evidence: e.evidence,
        happenedAt: e.happened_at,
        recordedBy: e.recorded_by,
        pending: false,
        replaced: replacedIds.has(e.id),
        replaces: e.replaces,
      }));
  } else {
    shown = (row.progress?.recent_entries ?? []).map((e) => ({
      id: e.id,
      evidence: e.evidence,
      happenedAt: e.happened_at,
      recordedBy: e.recorded_by,
      pending: false,
      replaced: false,
      replaces: null,
    }));
  }
  for (const p of pending)
    if (p !== null && !shown.some((s) => s.id === p.entryId)) {
      if (p.replaces !== null)
        for (const s of shown) if (s.id === p.replaces) s.replaced = true;
      shown.push({
        id: p.entryId,
        evidence: p.evidence,
        happenedAt: p.happenedAt,
        recordedBy: env.accountId,
        pending: true,
        replaced: false,
        replaces: p.replaces,
      });
    }
  const recentIds = new Set(
    (row.progress?.recent_entries ?? []).map((e) => e.id),
  );
  const canFix = (entry: Shown) =>
    writable &&
    !entry.pending &&
    !entry.replaced &&
    entry.evidence.kind !== "observe" &&
    entry.recordedBy === env.accountId &&
    (journal !== null || recentIds.has(entry.id));
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2"
      data-entry-history=""
    >
      <h2 id={heading} className="text-[15px] font-medium text-ink-1">
        {journal !== null && journal.error === null
          ? HISTORY_COPY.full
          : HISTORY_COPY.heading}
      </h2>
      {shown.length === 0 ? (
        <p className="text-[13px] text-ink-2">{HISTORY_COPY.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((entry) => (
            <li
              key={entry.id}
              data-entry={entry.id}
              data-entry-pending={entry.pending ? "" : undefined}
              className="flex flex-col gap-1 rounded-row border border-hairline px-3 py-2"
            >
              <span className="flex flex-wrap items-baseline gap-2 text-[13px] text-ink-1">
                <span className={entry.replaced ? "text-ink-2" : ""}>
                  {describeEvidence(entry.evidence, goal)}
                </span>
                <span className="text-ink-2">
                  {entry.recordedBy === env.accountId
                    ? HISTORY_COPY.byYou
                    : HISTORY_COPY.byOther}
                  {" · "}
                  {momentLabel(entry.happenedAt * 1000, env.now(), zone)}
                </span>
                {entry.replaced ? (
                  <span className="text-[12px] text-ink-2">
                    {HISTORY_COPY.corrected}
                  </span>
                ) : null}
                {entry.replaces !== null ? (
                  <span className="text-[12px] text-ink-2">
                    {HISTORY_COPY.correction}
                  </span>
                ) : null}
                {entry.pending ? (
                  <span className="text-[12px] text-ink-2">
                    {copy.PENDING.queued}
                  </span>
                ) : null}
              </span>
              {fixing === entry.id ? (
                <FixForm
                  entry={entry}
                  goal={goal}
                  onCancel={() => setFixing(null)}
                  onSave={async (evidence) => {
                    const saved = await actions.record(
                      row,
                      evidence,
                      entry.id,
                      HISTORY_COPY.fixed,
                    );
                    if (saved.ok) setFixing(null);
                  }}
                />
              ) : canFix(entry) ? (
                <span>
                  <Button variant="quiet" onClick={() => setFixing(entry.id)}>
                    {HISTORY_COPY.fix}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {journal?.error === "refused" ? (
        <p className="text-[12.5px] text-ink-2">{HISTORY_COPY.refused}</p>
      ) : journal?.error === "failed" ? (
        <p className="text-[12.5px] text-ink-2">{HISTORY_COPY.failed}</p>
      ) : null}
      <span className="flex flex-wrap gap-2">
        {!env.online ? (
          <span className="text-[12.5px] text-ink-2">
            {HISTORY_COPY.fullOffline}
          </span>
        ) : journal === null || journal.error === "failed" ? (
          loading ? (
            <Button disabled reason={copy.LOADING}>
              {HISTORY_COPY.full}
            </Button>
          ) : (
            <Button
              onClick={() => {
                forgetRefusal(env.identity, readKey);
                void load(0);
              }}
            >
              {HISTORY_COPY.full}
            </Button>
          )
        ) : journal.next !== null ? (
          <Button onClick={() => void load(journal.next as number)}>
            {HISTORY_COPY.loadMore}
          </Button>
        ) : null}
      </span>
    </section>
  );
}

function FixForm({
  entry,
  goal,
  onSave,
  onCancel,
}: {
  entry: Shown;
  goal: Goal;
  onSave(evidence: Evidence): Promise<void>;
  onCancel(): void;
}) {
  const [amount, setAmount] = useState(
    entry.evidence.kind === "quantity" ? entry.evidence.amount : "",
  );
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const ev = entry.evidence;
    if (ev.kind === "checkbox")
      return onSave({ kind: "checkbox", complete: !ev.complete });
    if (ev.kind === "checklist")
      return onSave({
        kind: "checklist",
        item_id: ev.item_id,
        complete: !ev.complete,
      });
    const value = parseDecimalInput(amount);
    if (value === null) {
      setError(MESSAGES.amount);
      return;
    }
    return onSave({ kind: "quantity", amount: value });
  };
  return (
    <div className="flex flex-wrap items-end gap-2" data-fix-form="">
      {entry.evidence.kind === "quantity" ? (
        <div className="w-32">
          <Input
            label={`${HISTORY_COPY.newValue}${goal.kind === "numeric" ? ` (${goal.unit})` : ""}`}
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setError(null);
            }}
          />
        </div>
      ) : (
        <span className="text-[13px] text-ink-1">
          {HISTORY_COPY.newValue}:{" "}
          {entry.evidence.kind === "checkbox"
            ? entry.evidence.complete
              ? HISTORY_COPY.notDone
              : HISTORY_COPY.done
            : entry.evidence.kind === "checklist"
              ? entry.evidence.complete
                ? "unticked"
                : "ticked"
              : ""}
        </span>
      )}
      <Button variant="primary" onClick={() => void save()}>
        {HISTORY_COPY.fixSave}
      </Button>
      <Button variant="quiet" onClick={onCancel}>
        {HISTORY_COPY.cancel}
      </Button>
      {error ? (
        <p className="w-full text-[12.5px] text-conflict-text">{error}</p>
      ) : null}
    </div>
  );
}
