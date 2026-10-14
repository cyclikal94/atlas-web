import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import type { TaskActions } from "../actions";
import type { TasksResult } from "../api";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import { momentLabel } from "../format";
import { forgetRefusal, noteIfRefused } from "../memory";
import { pendingEvidenceOf } from "../model/commands";
import type {
  Evidence,
  Goal,
  JournalEntry,
  ProgressJournal,
} from "../model/contract";
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
  earlier: "Earlier entries",
  refresh: "Refresh",
  recent: "Back to recent entries",
  fullOffline: "The full history needs a connection.",
  failed: "Couldn't load the full history.",
  stale: "Couldn't refresh the full history. Showing what was last loaded.",
  refused: "This history isn't available to you.",
  checking: "Checking whether this entry was corrected",
  checkFailed: "Couldn't check whether this entry was corrected since.",
  correctedSince:
    "This entry has been corrected since. Fix its correction instead.",
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

/** Q9 (approved answers): at most three history pages are retained per view; every other page stays reachable by paging. */
export const MAX_PAGES = 3;

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
  /** A saved entry the full history has not been re-read for yet (newer than the pages shown): nothing is known of its corrections. */
  unchecked: boolean;
}

/** One page of the journal: the entries after `start` (by `sequence`), and where the next page begins. */
interface Page {
  start: number;
  entries: JournalEntry[];
  next: number | null;
}

/**
 * The open full history of one stream (revision 4: R10, R12; design assessment C3), owned by `(identity, progress id)`:
 * - At most `MAX_PAGES` pages are retained (`pages`, contiguous, the first being page `first` of the journal). Only the page-start cursors
 *   visited are kept besides (`starts`: numbers, as the day picker keeps its cursors): an earlier page is read again from its own start
 *   (entries are append-only, so `sequence > start` is the same page), so every page stays reachable without being retained.
 * - `version` is the committed version of the stream the pages were asked at; a newer one makes them stale and they are read again
 *   (`tried` is the version last asked at, so a failure is not retried in a loop: Try again, a newer version or the connection returning).
 * - A refusal drops the pages (they are no longer an authorised answer); a failure keeps them, marked stale, with Try again.
 */
interface Journal {
  owner: string;
  starts: number[];
  first: number;
  pages: Page[];
  version: number | null;
  tried: number | null;
  error: "failed" | "refused" | null;
  /** What a check of the rest of the journal found for an entry outside a window that reaches its end. */
  checks: Record<string, "checking" | "current" | "replaced" | "failed">;
}

/** The open fix of one entry, held here (not by the page it is shown in): moving, evicting or refreshing a page never erases it. */
interface OpenFix {
  owner: string;
  entry: Shown;
  /** Never reused (R3, revision 2): a save made by an earlier fix of the same entry cannot close a newer one. */
  session: number;
  amount: string;
  /** Edits made in this session: a success closes the fix only if nothing was typed after it was submitted (R3, revision 1). */
  edits: number;
  busy: boolean;
  error: string | null;
}

/**
 * History (WF-TASK-01): up to eight recent entries with my pending ones layered on and marked, then, online, the FULL history paged by
 * `sequence` (survivors in `logical_order`; replaced ones marked "Corrected"), a bounded window of pages that follows the stream's
 * committed version. "Fix this entry" appends a `record` with `replaces` and a value of the same kind: nothing is deleted. Offline a fix is
 * offered only for an entry among the recent ones. Outside a window that reaches the journal's end, whether an entry was corrected later is
 * not known from the pages: Fix first checks the rest of the journal for that entry (keeping nothing but the answer).
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
  const owner = `${env.identity}\u0000${row.progressId}`;
  const readKey = `journal:${row.progressId}`;
  const [state, setJournal] = useState<Journal | null>(null);
  const journal = state?.owner === owner ? state : null;
  const [loading, setLoading] = useState(false);
  // Every request carries the number it was asked under: an older answer never overwrites a newer one (or a closed journal).
  const ask = useRef(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [openFix, setFix] = useState<OpenFix | null>(null);
  const fix = openFix?.owner === owner ? openFix : null;
  const fixRef = useRef(fix);
  fixRef.current = fix;
  const sessions = useRef(0);

  const read = (after: number) => env.api.readJournal(row.progressId, after);
  /** The answer, if it is still the current one; refusals are remembered as they arrive (a refusal may remount the screen). */
  const answered = (
    mine: number,
    result: TasksResult<ProgressJournal>,
  ): TasksResult<ProgressJournal> | null => {
    noteIfRefused(env.identity, readKey, result);
    return mine === ask.current && ownerRef.current === owner ? result : null;
  };
  const failedOrRefused = (
    kind: string,
    keep: Journal | null,
  ): Journal | null => {
    if (kind === "closed") return keep;
    if (kind === "forbidden" || kind === "not_found")
      return {
        owner,
        starts: [0],
        first: 0,
        pages: [],
        version: null,
        tried: null,
        error: "refused",
        checks: {},
      };
    return keep === null
      ? {
          owner,
          starts: [0],
          first: 0,
          pages: [],
          version: null,
          tried: null,
          error: "failed",
          checks: {},
        }
      : { ...keep, error: "failed" };
  };

  /** Reads the pages starting at `starts[from]` (`count` of them, or fewer at the journal's end) into a window beginning at `from`. */
  const load = async (
    base: Journal | null,
    from: number,
    count: number,
    shape: (
      pages: Page[],
      starts: number[],
    ) => { first: number; pages: Page[] },
  ) => {
    const mine = ++ask.current;
    const version = row.progressVersion;
    setLoading(true);
    const starts = [...(base?.starts ?? [0])].slice(0, from + 1);
    const pages: Page[] = [];
    let at = starts[from] ?? 0;
    for (let i = 0; i < count; i += 1) {
      const result = answered(mine, await read(at));
      if (result === null) return;
      if (!result.ok) {
        setLoading(false);
        const next = failedOrRefused(result.kind, base);
        setJournal(next === null ? null : { ...next, tried: version });
        return;
      }
      pages.push({
        start: at,
        entries: result.value.entries,
        next: result.value.next_after,
      });
      if (result.value.next_after === null) break;
      at = result.value.next_after;
      starts[from + i + 1] = at;
    }
    setLoading(false);
    const window = shape(pages, starts);
    setJournal({
      owner,
      starts,
      first: window.first,
      pages: window.pages,
      version,
      tried: version,
      error: null,
      checks: {},
    });
  };

  const open = () => {
    forgetRefusal(env.identity, readKey);
    return load(null, 0, 1, (pages) => ({ first: 0, pages }));
  };
  const refresh = (j: Journal) =>
    load(j, j.first, Math.max(1, j.pages.length), (pages) => ({
      first: j.first,
      pages,
    }));
  // Load more: the next page; the window's first page is let go beyond `MAX_PAGES`.
  const more = async (j: Journal) => {
    const at = j.first + j.pages.length;
    if (j.starts[at] === undefined) return;
    const mine = ++ask.current;
    setLoading(true);
    const result = answered(mine, await read(j.starts[at] as number));
    if (result === null) return;
    setLoading(false);
    if (!result.ok) {
      setJournal(failedOrRefused(result.kind, j));
      return;
    }
    const pages = [
      ...j.pages,
      {
        start: j.starts[at] as number,
        entries: result.value.entries,
        next: result.value.next_after,
      },
    ];
    const starts = j.starts.slice(0, at + 1);
    if (result.value.next_after !== null) starts.push(result.value.next_after);
    const drop = Math.max(0, pages.length - MAX_PAGES);
    setJournal({
      ...j,
      starts,
      first: j.first + drop,
      pages: pages.slice(drop),
      error: null,
    });
  };
  // Earlier entries: the page before the window, read again from its start; the window's last page is let go beyond `MAX_PAGES`.
  const earlier = async (j: Journal) => {
    const at = j.first - 1;
    if (at < 0) return;
    const mine = ++ask.current;
    setLoading(true);
    const result = answered(mine, await read(j.starts[at] as number));
    if (result === null) return;
    setLoading(false);
    if (!result.ok) {
      setJournal(failedOrRefused(result.kind, j));
      return;
    }
    setJournal({
      ...j,
      first: at,
      pages: [
        {
          start: j.starts[at] as number,
          entries: result.value.entries,
          next: result.value.next_after,
        },
        ...j.pages,
      ].slice(0, MAX_PAGES),
      error: null,
    });
  };
  const close = () => {
    ask.current += 1;
    setLoading(false);
    setJournal(null);
  };

  // A newer committed version of the stream (a new entry, a correction, a reconciled pending one) makes the open pages stale: they are read
  // again, once per version (a failure waits for Try again, a newer version or the connection), and only online.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` is this render's; the listed inputs are the reasons to refresh
  useEffect(() => {
    if (
      journal === null ||
      journal.pages.length === 0 ||
      journal.error === "refused" ||
      loading ||
      !env.online ||
      journal.version === row.progressVersion ||
      journal.tried === row.progressVersion
    )
      return;
    void refresh(journal);
  }, [journal, loading, env.online, row.progressVersion]);
  // The connection came back after a change seen offline: ask once more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the connection's return is the reason
  useEffect(() => {
    if (
      env.online &&
      journal !== null &&
      journal.version !== row.progressVersion
    )
      setJournal({ ...journal, tried: null });
  }, [env.online]);

  /** Whether `entryId` is replaced by an entry after the window (a forward walk keeping one answer; each page read is let go at once). */
  const check = async (
    j: Journal,
    entryId: string,
  ): Promise<"current" | "replaced" | "failed" | null> => {
    const last = j.pages[j.pages.length - 1];
    if (last === undefined) return null;
    const set = (value: "checking" | "current" | "replaced" | "failed") =>
      setJournal((now) =>
        now === null || now.owner !== j.owner || now.version !== j.version
          ? now
          : { ...now, checks: { ...now.checks, [entryId]: value } },
      );
    set("checking");
    let at = last.next;
    while (at !== null) {
      const result = await read(at);
      noteIfRefused(env.identity, readKey, result);
      if (!result.ok) {
        set("failed");
        return "failed";
      }
      if (result.value.entries.some((e) => e.replaces === entryId)) {
        set("replaced");
        return "replaced";
      }
      at = result.value.next_after;
    }
    set("current");
    return "current";
  };

  const pending = row.drafts
    .map((d) => pendingEvidenceOf(d, env.accountId))
    .filter((p) => p !== null && p.occurrenceId === row.id);
  const recent = row.progress?.recent_entries ?? [];
  const pages =
    journal !== null && journal.error !== "refused" ? journal.pages : [];
  const full = pages.length > 0;
  const last = pages[pages.length - 1];
  // A window whose last page is the journal's last knows every correction of its entries (a correction is appended after what it fixes).
  const toEnd = last !== undefined && last.next === null;
  const committedReplaced = new Set<string>();
  let shown: Shown[];
  if (full && journal !== null) {
    const entries = pages.flatMap((p) => p.entries);
    for (const e of entries)
      if (e.replaces !== null) committedReplaced.add(e.replaces);
    for (const [id, found] of Object.entries(journal.checks))
      if (found === "replaced") committedReplaced.add(id);
    shown = [...entries]
      .sort(
        (a, b) => a.logical_order - b.logical_order || a.sequence - b.sequence,
      )
      .map((e) => ({
        id: e.id,
        evidence: e.evidence,
        happenedAt: e.happened_at,
        recordedBy: e.recorded_by,
        pending: false,
        replaced: committedReplaced.has(e.id),
        replaces: e.replaces,
        unchecked: false,
      }));
    // Saved entries newer than the pages (the stream's own recent tail), until the journal is read again: shown, never as fixable.
    if (toEnd)
      for (const e of recent)
        if (!shown.some((s) => s.id === e.id))
          shown.push({
            id: e.id,
            evidence: e.evidence,
            happenedAt: e.happened_at,
            recordedBy: e.recorded_by,
            pending: false,
            replaced: false,
            replaces: null,
            unchecked: true,
          });
  } else {
    shown = recent.map((e) => ({
      id: e.id,
      evidence: e.evidence,
      happenedAt: e.happened_at,
      recordedBy: e.recorded_by,
      pending: false,
      replaced: false,
      replaces: null,
      unchecked: false,
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
        unchecked: false,
      });
    }
  const recentIds = new Set(recent.map((e) => e.id));
  const canFix = (entry: Shown) =>
    writable &&
    !entry.pending &&
    !entry.unchecked &&
    !entry.replaced &&
    entry.evidence.kind !== "observe" &&
    entry.recordedBy === env.accountId &&
    (full || recentIds.has(entry.id));
  const openFixOf = (entry: Shown) => {
    sessions.current += 1;
    setFix({
      owner,
      entry,
      session: sessions.current,
      amount: entry.evidence.kind === "quantity" ? entry.evidence.amount : "",
      edits: 0,
      busy: false,
      error: null,
    });
  };
  const askFix = (entry: Shown) => {
    // Outside a window that reaches the end, the entry may have been corrected on a later page: check that first.
    if (!full || toEnd || journal === null) return openFixOf(entry);
    if (journal.checks[entry.id] === "current") return openFixOf(entry);
    const j = journal;
    void check(j, entry.id).then((found) => {
      if (found === "current" && ownerRef.current === j.owner) openFixOf(entry);
    });
  };
  // The open fix's target is known to have been corrected (a saved correction, not this person's pending one): it cannot be saved.
  const blocked =
    fix !== null && committedReplaced.has(fix.entry.id)
      ? HISTORY_COPY.correctedSince
      : null;
  const submit = async (evidence: Evidence) => {
    const current = fixRef.current;
    if (current === null || current.busy) return;
    const { session } = current;
    const submitted = current.edits;
    fixRef.current = { ...current, busy: true };
    setFix((f) =>
      f !== null && f.session === session ? { ...f, busy: true } : f,
    );
    let ok = false;
    try {
      ok = (
        await actions.record(
          row,
          evidence,
          current.entry.id,
          HISTORY_COPY.fixed,
        )
      ).ok;
    } finally {
      setFix((f) =>
        f === null || f.session !== session
          ? f
          : ok && f.edits === submitted
            ? null
            : { ...f, busy: false },
      );
    }
  };
  const fixForm =
    fix === null ? null : (
      <FixForm
        key={fix.session}
        fix={fix}
        goal={goal}
        blocked={blocked}
        onAmount={(amount) =>
          setFix((f) =>
            f !== null && f.session === fix.session
              ? { ...f, amount, edits: f.edits + 1, error: null }
              : f,
          )
        }
        onError={(error) =>
          setFix((f) =>
            f !== null && f.session === fix.session ? { ...f, error } : f,
          )
        }
        onSave={(evidence) => void submit(evidence)}
        onCancel={() => setFix(null)}
      />
    );
  const fixShown = fix !== null && shown.some((s) => s.id === fix.entry.id);
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2"
      data-entry-history=""
    >
      <h2 id={heading} className="text-[15px] font-medium text-ink-1">
        {full ? HISTORY_COPY.full : HISTORY_COPY.heading}
      </h2>
      {fix !== null && !fixShown ? (
        // The entry being fixed is on a page not shown now: its fix stays open, with what was typed.
        <div
          className="flex flex-col gap-1 rounded-row border border-hairline px-3 py-2"
          data-fix-detached={fix.entry.id}
        >
          <span className="text-[13px] text-ink-1">
            {HISTORY_COPY.fix}: {describeEvidence(fix.entry.evidence, goal)}
          </span>
          {fixForm}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-[13px] text-ink-2">{HISTORY_COPY.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((entry) => {
            const checking = journal?.checks[entry.id];
            return (
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
                {fix?.entry.id === entry.id ? (
                  fixForm
                ) : canFix(entry) ? (
                  <span>
                    {checking === "checking" ? (
                      <Button disabled reason={HISTORY_COPY.checking}>
                        {HISTORY_COPY.fix}
                      </Button>
                    ) : (
                      <Button variant="quiet" onClick={() => askFix(entry)}>
                        {HISTORY_COPY.fix}
                      </Button>
                    )}
                    {checking === "failed" ? (
                      <span className="text-[12px] text-ink-2">
                        {HISTORY_COPY.checkFailed}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {journal?.error === "refused" ? (
        <p className="text-[12.5px] text-ink-2">{HISTORY_COPY.refused}</p>
      ) : journal?.error === "failed" ? (
        <p className="text-[12.5px] text-ink-2" data-history-stale="">
          {full ? HISTORY_COPY.stale : HISTORY_COPY.failed}
        </p>
      ) : null}
      <span className="flex flex-wrap gap-2">
        {!env.online ? (
          <span className="text-[12.5px] text-ink-2">
            {HISTORY_COPY.fullOffline}
          </span>
        ) : !full ? (
          journal?.error === "refused" ? null : loading ? (
            <Button disabled reason={copy.LOADING}>
              {HISTORY_COPY.full}
            </Button>
          ) : (
            <Button onClick={() => void open()}>{HISTORY_COPY.full}</Button>
          )
        ) : journal === null ? null : loading ? (
          <Button disabled reason={copy.LOADING}>
            {HISTORY_COPY.refresh}
          </Button>
        ) : (
          <>
            {journal.first > 0 ? (
              <Button onClick={() => void earlier(journal)}>
                {HISTORY_COPY.earlier}
              </Button>
            ) : null}
            {last?.next !== null && last?.next !== undefined ? (
              <Button onClick={() => void more(journal)}>
                {HISTORY_COPY.loadMore}
              </Button>
            ) : null}
            <Button variant="quiet" onClick={() => void refresh(journal)}>
              {journal.error === "failed"
                ? copy.TRY_AGAIN
                : HISTORY_COPY.refresh}
            </Button>
          </>
        )}
        {full ? (
          <Button variant="quiet" onClick={close}>
            {HISTORY_COPY.recent}
          </Button>
        ) : null}
      </span>
    </section>
  );
}

/**
 * The fix of one entry, shown from the parent's open fix (its value, edit count and pending save live there). A save is one attempt at a
 * time (Save waits while it is pending), and its success closes the form only if the value was not edited after it was submitted AND the
 * open fix is still this session: a newer value stays in the open form for another save, a newer fix of the same entry is never closed by
 * an older one's save, and a failed or uncertain save keeps the form as it is.
 */
function FixForm({
  fix,
  goal,
  blocked,
  onAmount,
  onError,
  onSave,
  onCancel,
}: {
  fix: OpenFix;
  goal: Goal;
  /** Why the fix cannot be saved (its entry was corrected since), or null. */
  blocked: string | null;
  onAmount(amount: string): void;
  onError(error: string): void;
  onSave(evidence: Evidence): void;
  onCancel(): void;
}) {
  const { entry } = fix;
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
    const value = parseDecimalInput(fix.amount);
    if (value === null) {
      onError(MESSAGES.amount);
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
            value={fix.amount}
            onChange={(event) => onAmount(event.target.value)}
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
      {blocked !== null ? (
        <Button disabled reason={blocked}>
          {HISTORY_COPY.fixSave}
        </Button>
      ) : fix.busy ? (
        <Button disabled reason={copy.SAVING}>
          {HISTORY_COPY.fixSave}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => save()}>
          {HISTORY_COPY.fixSave}
        </Button>
      )}
      <Button variant="quiet" onClick={onCancel}>
        {HISTORY_COPY.cancel}
      </Button>
      {fix.error ? (
        <p className="w-full text-[12.5px] text-conflict-text">{fix.error}</p>
      ) : null}
    </div>
  );
}
