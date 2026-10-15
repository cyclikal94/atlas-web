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
  fixOffline: "This fix can be saved once you're online again.",
  fixWaits: "This fix can be saved once the full history is up to date.",
  fixUnchecked:
    "Check whether this entry was corrected since, then save the fix.",
  recheck: "Check again",
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
  /** Its place in the journal (an entry read from the full history), or null: a correction of it comes after it. */
  sequence: number | null;
}

/** One page of the journal: the entries after `start` (by `sequence`), and where the next page begins. */
interface Page {
  start: number;
  entries: JournalEntry[];
  next: number | null;
}

/** What a check of the rest of the journal found for an entry, at the stream's committed version it was asked at. */
interface Check {
  found: "current" | "replaced" | "failed";
  version: number | null;
}

/**
 * The open full history of one stream (revisions 4 and 5: R10, R12, R13, R14; design assessments C3 of revision 4 and C1–C3 of
 * revision 5), owned by `(identity, progress id)` and by the AUTHORITY it was read under (`life`):
 * - At most `MAX_PAGES` pages are retained (`pages`, contiguous, the first being page `first` of the journal). Only the page-start cursors
 *   visited are kept besides (`starts`: numbers, as the day picker keeps its cursors): an earlier page is read again from its own start
 *   (entries are append-only, so `sequence > start` is the same page), so every page stays reachable without being retained.
 * - `version` is the committed version of the stream the whole window was read at (null while a refresh has replaced only some of its
 *   pages); a newer one makes them stale and they are read again (`tried` is the version last asked at, so a failure is not retried in a
 *   loop: Try again, a newer version or the connection returning).
 * - A refusal of ANY read under this authority (a page or a check) ends it: the pages, cursors and check facts are dropped and another
 *   authority begins only with a new explicit open. A failure keeps the pages, marked stale, with Try again.
 */
interface Journal {
  owner: string;
  life: number;
  starts: number[];
  first: number;
  pages: Page[];
  version: number | null;
  tried: number | null;
  error: "failed" | "refused" | null;
  /** What a check of the rest of the journal found for an entry outside a window that reaches its end. */
  checks: Record<string, Check>;
}

/** The answer to one journal request, after the refusal transition: a page, a failure that certifies nothing, an abandoned request, or nothing to do (obsolete, or refused and applied). */
type Got =
  | { kind: "page"; page: Page }
  | { kind: "failed" }
  | { kind: "closed" }
  | { kind: "stop" };

/** Who asked: the owner and the authority a request belongs to. */
interface Asker {
  owner: string;
  life: number;
}

/**
 * What was typed for the fix of one entry (revision 6, R16): owned by the DRAFT, not by the editor showing it, so closing the full history
 * and opening the fix again moves it, unsaved or not, into the new editor. Memory only: never persisted, never sent, never an authority.
 */
interface Draft {
  owner: string;
  entryId: string;
  /** Never reused. */
  id: number;
  /** The raw value, as typed (empty or not a number included). */
  amount: string;
  /** Edits made to this draft, in every editor that showed it: a success acknowledges only the revision it submitted (R3, revision 1). */
  rev: number;
  /** Typed and not acknowledged since: kept through a closure of the full history until Cancel, its save, or the view's end. */
  unsaved: boolean;
  /** The revision a pending save of this draft submitted (one attempt at a time, whichever editor shows it), or null. */
  saving: number | null;
}

/** The open fix of one entry, held here (not by the page it is shown in): moving, evicting or refreshing a page never erases it. */
interface OpenFix {
  entry: Shown;
  /** Never reused (R3, revision 2): a save made in an earlier editor closes no newer one. */
  session: number;
  draft: Draft;
  error: string | null;
}

/** What the save decision reads: the CURRENT journal, version, connection, write permission, local read and recent tail. */
interface SaveFacts {
  journal: Journal | null;
  version: number | null;
  online: boolean;
  writable: boolean;
  /** The detail shown is the last complete read of this device's data: no later read is due, running or failed. */
  current: boolean;
  recent: ReadonlySet<string>;
}

const holds = (pages: Page[], test: (e: JournalEntry) => boolean) =>
  pages.some((p) => p.entries.some(test));

/** A window that reaches the journal's end, read at `version`, knows every correction of its entries (a correction is appended after what it fixes). */
const coversToEnd = (j: Journal, id: string, version: number | null) =>
  j.error === null &&
  j.version === version &&
  j.pages[j.pages.length - 1]?.next === null &&
  holds(j.pages, (e) => e.id === id);

/**
 * Whether the full history is, right now, an authority to fix an entry known only from it (revisions 5 and 6): online, read without failure
 * at the stream's committed version, and the detail's local read current (a newer local change not yet read in certifies nothing).
 */
export function fullAuthority(f: SaveFacts): boolean {
  const j = f.journal;
  return (
    f.online &&
    f.current &&
    j !== null &&
    j.pages.length > 0 &&
    j.error === null &&
    j.version === f.version
  );
}

/**
 * Why the fix of `entryId` cannot be saved now, or null (revision 6, R17): ONE decision for the Save shown and the save admitted (read
 * synchronously when Save is pressed). A recent entry has its own authority (offline and while the history is read again, as approved); an
 * entry known only from the full history needs a current full history AND evidence that no later correction of THIS entry exists: a check of
 * the rest of the journal at the current version, or a window that reaches the end and holds it. A committed correction blocks for good.
 */
export function saveBlock(f: SaveFacts, entryId: string): string | null {
  if (!f.writable) return copy.NOT_WRITABLE;
  const j = f.journal;
  if (
    j !== null &&
    (j.checks[entryId]?.found === "replaced" ||
      holds(j.pages, (e) => e.replaces === entryId))
  )
    return HISTORY_COPY.correctedSince;
  if (f.recent.has(entryId)) return null;
  if (!f.online) return HISTORY_COPY.fixOffline;
  if (j === null || !fullAuthority(f)) return HISTORY_COPY.fixWaits;
  const check = j.checks[entryId];
  if (check?.found === "current" && check.version === f.version) return null;
  if (coversToEnd(j, entryId, f.version)) return null;
  return check?.found === "failed" && check.version === f.version
    ? HISTORY_COPY.checkFailed
    : HISTORY_COPY.fixUnchecked;
}

/** At most this many journal requests (pages or checks) are in flight per view (design assessment C3); a further one waits, holding numbers only, and is never sent if it is no longer wanted when its turn comes. */
export const IN_FLIGHT = 2;

/**
 * History (WF-TASK-01): up to eight recent entries with my pending ones layered on and marked, then, online, the FULL history paged by
 * `sequence` (survivors in `logical_order`; replaced ones marked "Corrected"), a bounded window of pages that follows the stream's
 * committed version. "Fix this entry" appends a `record` with `replaces` and a value of the same kind: nothing is deleted. Offline a fix is
 * offered only for an entry among the recent ones; an entry known only from the full history is fixable only while its window is current
 * (online, read at the committed version, not failed). Outside a window that reaches the journal's end, whether an entry was corrected later
 * is not known from the pages: Fix first checks the rest of the journal for that entry (keeping nothing but the answer).
 *
 * The journal's state has one owner (revision 5, R13/R14): every continuation reads the CURRENT journal from `jr`, never one captured
 * before an await, and checks what it was started under — the authority (`life`: open, Back to recent and refusal begin another; every
 * page request and check of an ended authority stops at its next answer), the correction selection (`sel`: taken synchronously at every
 * Fix and Cancel, so only the latest intent can open an editor), for a check the stream's committed version, and the mounted lifetime.
 * A refusal from any read of the current authority revokes it synchronously. Page requests of one authority never overlap (every page
 * control is disabled while one is loading, and the refresh on a newer version waits for it), so the latest of them is the only one.
 */
export function EntryHistory({
  row,
  actions,
  zone,
  writable,
  current = true,
}: {
  row: RowModel;
  actions: Pick<TaskActions, "record">;
  zone: string;
  writable: boolean;
  /** The detail's local read is current (revision 6, D6-5): while it is not, an entry known only from the full history cannot be saved. */
  current?: boolean;
}) {
  const env = useTasksEnv();
  const heading = useId();
  const goal = row.data.definition.goal;
  const owner = `${env.identity}\u0000${row.progressId}`;
  const readKey = `journal:${row.progressId}`;
  const [state, setJournal] = useState<Journal | null>(null);
  const journal = state?.owner === owner ? state : null;
  const [loading, setLoading] = useState(false);
  // The current journal, read by every continuation (the state above is its presentation).
  const jr = useRef<Journal | null>(null);
  // The authority generation and the correction selection (see above).
  const life = useRef(0);
  const sel = useRef(0);
  const mounted = useRef(true);
  const gate = useRef<{ busy: number; waiting: Array<() => void> }>({
    busy: 0,
    waiting: [],
  });
  // How many journal requests are in flight (shown as `data-journal-requests`: 0 once every answer has been taken in).
  const [requests, setRequests] = useState(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const versionRef = useRef(row.progressVersion);
  versionRef.current = row.progressVersion;
  // What the save decision reads when Save is pressed: this render's facts, current at the time of the press (revision 6, R17).
  const onlineRef = useRef(env.online);
  onlineRef.current = env.online;
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const currentRef = useRef(current);
  currentRef.current = current;
  const [openFix, setFix] = useState<OpenFix | null>(null);
  const fix = openFix?.draft.owner === owner ? openFix : null;
  const fixRef = useRef(fix);
  fixRef.current = fix;
  const sessions = useRef(0);
  const drafts = useRef(0);
  // A full-history fix closed by a refusal or Back to recent leaves its draft here (memory only), for the same owner and entry (D6-1).
  const parked = useRef<Draft | null>(null);
  const recentRef = useRef<ReadonlySet<string>>(new Set());
  const factsNow = (): SaveFacts => ({
    journal: journalNow(),
    version: versionRef.current,
    online: onlineRef.current,
    writable: writableRef.current,
    current: currentRef.current,
    recent: recentRef.current,
  });
  // The one check of the rest of the journal shown as running, by the selection that asked for it.
  const [scan, setScan] = useState<{ entryId: string; sel: number } | null>(
    null,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const journalNow = () => {
    const j = jr.current;
    return j !== null && j.owner === ownerRef.current ? j : null;
  };
  const put = (next: Journal | null) => {
    jr.current = next;
    setJournal(next);
  };
  /** Changes the current journal (every caller has just found its authority still current, with no await since). */
  const update = (change: (j: Journal) => Journal) => {
    const j = journalNow();
    if (j !== null) put(change(j));
  };
  const live = (by: Asker) =>
    mounted.current &&
    ownerRef.current === by.owner &&
    life.current === by.life;

  /**
   * A full-history fix has the journal's authority: it closes with it. Its draft is parked if it holds input not yet acknowledged — typed in
   * this editor or restored into it (R16) — or a pending save that must keep the entry's next editor waiting (never displacing an unsaved one).
   */
  const dropFullOnlyFix = () => {
    const held = fixRef.current;
    if (held === null || recentRef.current.has(held.entry.id)) return;
    const { draft } = held;
    if (
      draft.unsaved ||
      (draft.saving !== null && parked.current?.unsaved !== true)
    )
      parked.current = draft;
    fixRef.current = null;
    setFix(null);
  };
  /** A refusal of the current authority, whichever request met it: nothing read under it is shown or certifies anything any more. */
  const revoke = () => {
    life.current += 1;
    setLoading(false);
    setScan(null);
    dropFullOnlyFix();
    put({
      owner: ownerRef.current,
      life: life.current,
      starts: [0],
      first: 0,
      pages: [],
      version: null,
      tried: null,
      error: "refused",
      checks: {},
    });
  };

  /**
   * One journal request, within the view's bound. Refusals are remembered as they arrive (a refusal may remount the screen) and an
   * authoritative one of the current authority is applied HERE, whoever asked and whether or not its answer is still wanted.
   */
  const fetchPage = async (
    at: number,
    by: Asker,
    wanted: () => boolean,
  ): Promise<Got> => {
    const g = gate.current;
    while (g.busy >= IN_FLIGHT)
      await new Promise<void>((resolve) => g.waiting.push(resolve));
    if (!wanted()) {
      g.waiting.shift()?.();
      return { kind: "stop" };
    }
    g.busy += 1;
    setRequests(g.busy);
    let result: TasksResult<ProgressJournal>;
    try {
      result = await env.api.readJournal(row.progressId, at);
    } finally {
      g.busy -= 1;
      if (mounted.current) setRequests(g.busy);
      g.waiting.shift()?.();
    }
    noteIfRefused(env.identity, readKey, result);
    if (
      !result.ok &&
      (result.kind === "forbidden" || result.kind === "not_found")
    ) {
      if (live(by)) revoke();
      return { kind: "stop" };
    }
    if (!wanted()) return { kind: "stop" };
    if (!result.ok)
      return { kind: result.kind === "closed" ? "closed" : "failed" };
    const next = result.value.next_after;
    // A page that does not move past where it was asked from is not an answer (a walk over it would never end).
    if (next !== null && next <= at) return { kind: "failed" };
    return {
      kind: "page",
      page: { start: at, entries: result.value.entries, next },
    };
  };

  const open = async () => {
    forgetRefusal(env.identity, readKey);
    life.current += 1;
    const by = { owner, life: life.current };
    const version = row.progressVersion;
    setLoading(true);
    const got = await fetchPage(0, by, () => live(by));
    if (got.kind === "stop") return;
    setLoading(false);
    if (got.kind === "closed") return;
    if (got.kind === "failed") {
      put({
        owner,
        life: by.life,
        starts: [0],
        first: 0,
        pages: [],
        version: null,
        tried: version,
        error: "failed",
        checks: {},
      });
      return;
    }
    const { page } = got;
    put({
      owner,
      life: by.life,
      starts: page.next === null ? [0] : [0, page.next],
      first: 0,
      pages: [page],
      version,
      tried: version,
      error: null,
      checks: {},
    });
  };
  // Refresh: each page of the window read again from its start, REPLACING its old copy as it arrives (the window never holds more than
  // its own pages, C3); until the last arrives the window is mixed (`version: null`, nothing in it newly fixable).
  const refresh = async () => {
    const j = journalNow();
    if (j === null || j.pages.length === 0) return;
    const by = { owner, life: j.life };
    const version = row.progressVersion;
    const from = j.first;
    const count = j.pages.length;
    let at = j.starts[from] ?? 0;
    setLoading(true);
    for (let i = 0; i < count; i += 1) {
      const got = await fetchPage(at, by, () => live(by));
      if (got.kind === "stop") return;
      if (got.kind !== "page") {
        setLoading(false);
        if (got.kind === "failed")
          update((now) => ({
            ...now,
            tried: version,
            error: "failed",
          }));
        return;
      }
      const { page } = got;
      update((now) => {
        const pages = [...now.pages];
        pages[i] = page;
        const starts = now.starts.slice(0, from + i + 1);
        if (page.next !== null) starts.push(page.next);
        return {
          ...now,
          starts,
          pages: page.next === null ? pages.slice(0, i + 1) : pages,
          version: null,
        };
      });
      if (page.next === null) break;
      at = page.next;
    }
    setLoading(false);
    update((now) => ({
      ...now,
      version,
      tried: version,
      error: null,
    }));
  };
  // Load more: the next page; the window's first page is let go beyond `MAX_PAGES`.
  const more = async () => {
    const j = journalNow();
    if (j === null) return;
    const at = j.first + j.pages.length;
    const start = j.starts[at];
    if (start === undefined) return;
    const by = { owner, life: j.life };
    setLoading(true);
    const got = await fetchPage(start, by, () => live(by));
    if (got.kind === "stop") return;
    setLoading(false);
    if (got.kind === "failed") update((now) => ({ ...now, error: "failed" }));
    if (got.kind !== "page") return;
    const { page } = got;
    update((now) => {
      if (now.first + now.pages.length !== at) return now;
      const pages = [...now.pages, page];
      const starts = now.starts.slice(0, at + 1);
      if (page.next !== null) starts.push(page.next);
      const drop = Math.max(0, pages.length - MAX_PAGES);
      return {
        ...now,
        starts,
        first: now.first + drop,
        pages: pages.slice(drop),
        error: null,
      };
    });
  };
  // Earlier entries: the page before the window, read again from its start; the window's last page is let go beyond `MAX_PAGES`.
  const earlier = async () => {
    const j = journalNow();
    if (j === null) return;
    const at = j.first - 1;
    const start = j.starts[at];
    if (at < 0 || start === undefined) return;
    const by = { owner, life: j.life };
    setLoading(true);
    const got = await fetchPage(start, by, () => live(by));
    if (got.kind === "stop") return;
    setLoading(false);
    if (got.kind === "failed") update((now) => ({ ...now, error: "failed" }));
    if (got.kind !== "page") return;
    const { page } = got;
    update((now) =>
      now.first !== at + 1
        ? now
        : {
            ...now,
            first: at,
            pages: [page, ...now.pages].slice(0, MAX_PAGES),
            error: null,
          },
    );
  };
  // Back to recent entries: this authority ends (every request and check of it with it); a fix known only from it closes.
  const close = () => {
    life.current += 1;
    setLoading(false);
    setScan(null);
    dropFullOnlyFix();
    put(null);
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
    void refresh();
  }, [journal, loading, env.online, row.progressVersion]);
  // The connection came back after a change seen offline: ask once more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the connection's return is the reason
  useEffect(() => {
    if (
      env.online &&
      journal !== null &&
      journal.version !== row.progressVersion
    )
      update((now) => ({ ...now, tried: null }));
  }, [env.online]);

  /**
   * Opens the fix of `entry` for selection `mine` — only if no later Fix or Cancel has happened since (a check that Back to recent, a refusal
   * or a newer version ended never gets here), and only while the entry may be fixed NOW (revision 6, D6-4: a recent entry, or a current full
   * history; a check answered after the connection went opens nothing). The entry's open editor is kept as it is (Check again); a parked
   * draft of the entry moves into the new editor with everything it holds.
   */
  const openFixOf = (entry: Shown, mine: number) => {
    if (sel.current !== mine || !mounted.current) return;
    // Opening is not saving: a local read in progress does not hide a Fix (D6-5 applies to Save only).
    const facts = { ...factsNow(), current: true };
    if (
      !facts.writable ||
      (!facts.recent.has(entry.id) && !fullAuthority(facts))
    )
      return;
    const open = fixRef.current;
    if (open !== null && open.entry.id === entry.id) return;
    const held = parked.current;
    if (held !== null && held.owner !== owner) parked.current = null;
    const kept =
      held?.owner === owner && held.entryId === entry.id ? held : null;
    if (kept !== null) parked.current = null;
    sessions.current += 1;
    drafts.current += 1;
    const next: OpenFix = {
      entry,
      session: sessions.current,
      draft: kept ?? {
        owner,
        entryId: entry.id,
        id: drafts.current,
        amount: entry.evidence.kind === "quantity" ? entry.evidence.amount : "",
        rev: 0,
        unsaved: false,
        saving: null,
      },
      error: null,
    };
    fixRef.current = next;
    setFix(next);
  };
  /**
   * Whether `entry` was replaced after the window (a forward walk keeping one answer; each page read is let go at once), then its fix. The
   * walk stops at its next answer once its selection, authority, owner, mounted lifetime or the stream's committed version has moved.
   */
  const checkThenOpen = async (
    entry: Shown,
    mine: number,
    start: number,
    by: Asker,
  ) => {
    const version = versionRef.current;
    const asked = () =>
      live(by) && sel.current === mine && versionRef.current === version;
    const note = (found: Check["found"]) =>
      update((now) => ({
        ...now,
        checks: { ...now.checks, [entry.id]: { found, version } },
      }));
    setScan({ entryId: entry.id, sel: mine });
    try {
      let at: number | null = start;
      while (at !== null) {
        const got = await fetchPage(at, by, asked);
        if (got.kind === "stop" || got.kind === "closed") return;
        if (got.kind === "failed") {
          note("failed");
          return;
        }
        if (got.page.entries.some((e) => e.replaces === entry.id)) {
          note("replaced");
          return;
        }
        at = got.page.next;
      }
      note("current");
      openFixOf(entry, mine);
    } finally {
      if (mounted.current) setScan((s) => (s?.sel === mine ? null : s));
    }
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
    for (const [id, check] of Object.entries(journal.checks))
      if (check.found === "replaced") committedReplaced.add(id);
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
        sequence: e.sequence,
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
            sequence: null,
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
      sequence: null,
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
        sequence: null,
      });
    }
  const recentIds = new Set(recent.map((e) => e.id));
  recentRef.current = recentIds;
  // An entry known only from the full history is fixable only while that history is a current answer: online, not failed, and read at
  // the stream's committed version (an older or mixed window, or one kept from before the connection went, certifies nothing).
  const fullCurrent =
    full &&
    journal !== null &&
    journal.error === null &&
    journal.version === row.progressVersion &&
    env.online;
  const canFix = (entry: Shown) =>
    writable &&
    !entry.pending &&
    !entry.unchecked &&
    !entry.replaced &&
    entry.evidence.kind !== "observe" &&
    entry.recordedBy === env.accountId &&
    (recentIds.has(entry.id) || fullCurrent);
  const askFix = (entry: Shown) => {
    // Every Fix intent takes the selection FIRST, synchronously: a lookup asked before it can no longer open anything.
    const mine = ++sel.current;
    const j = journalNow();
    // A window that reaches the end answers for this entry: kept as its check at this version, so moving the window keeps it (D6-4).
    if (j !== null && coversToEnd(j, entry.id, row.progressVersion))
      update((now) => ({
        ...now,
        checks: {
          ...now.checks,
          [entry.id]: { found: "current", version: row.progressVersion },
        },
      }));
    // Outside a window that reaches the end, the entry may have been corrected on a later page: check that first.
    if (!full || toEnd || j === null) return openFixOf(entry, mine);
    const known = j.checks[entry.id];
    if (known?.found === "current" && known.version === row.progressVersion)
      return openFixOf(entry, mine);
    const start = j.pages[j.pages.length - 1]?.next;
    if (start === undefined || start === null) return openFixOf(entry, mine);
    void checkThenOpen(entry, mine, start, { owner, life: j.life });
  };
  /**
   * Check again (D6-3): the open fix's entry is checked from its own place in the journal (a correction of it comes after it), whichever
   * pages are shown, under the current authority and version; the open editor is kept as it is. A new selection: Cancel or another Fix ends it.
   */
  const recheck = (entry: Shown) => {
    const mine = ++sel.current;
    const j = journalNow();
    if (j === null) return;
    void checkThenOpen(entry, mine, entry.sequence ?? 0, {
      owner,
      life: j.life,
    });
  };
  // Why the open fix cannot be saved now (D6-3): the same decision `submit` takes when Save is pressed. A check of its entry running says so.
  const decided =
    fix === null
      ? null
      : saveBlock(
          {
            journal,
            version: row.progressVersion,
            online: env.online,
            writable,
            current,
            recent: recentIds,
          },
          fix.entry.id,
        );
  const unchecked =
    decided === HISTORY_COPY.fixUnchecked ||
    decided === HISTORY_COPY.checkFailed;
  const blocked =
    unchecked && scan?.entryId === fix?.entry.id
      ? HISTORY_COPY.checking
      : decided;
  /** A save's answer settles only the draft and revision it submitted (D6-2), wherever that draft is now: open, reopened, parked or gone. */
  const settle = (
    draftId: number,
    session: number,
    rev: number,
    ok: boolean,
  ) => {
    const p = parked.current;
    if (p !== null && p.id === draftId)
      parked.current = ok && p.rev === rev ? null : { ...p, saving: null };
    setFix((f) => {
      if (f === null || f.draft.id !== draftId) return f;
      if (ok && f.draft.rev === rev)
        return f.session === session
          ? null
          : { ...f, draft: { ...f.draft, unsaved: false, saving: null } };
      return { ...f, draft: { ...f.draft, saving: null } };
    });
  };
  const submit = async (evidence: Evidence) => {
    const open = fixRef.current;
    if (open === null || open.draft.saving !== null) return;
    // The linearisation point of a correction (R17): the decision is taken HERE, from what is current now, not from what was rendered.
    if (saveBlock(factsNow(), open.entry.id) !== null) return;
    const { session } = open;
    const { id, rev } = open.draft;
    const saving = { ...open, draft: { ...open.draft, saving: rev } };
    fixRef.current = saving;
    setFix((f) =>
      f !== null && f.session === session
        ? { ...f, draft: { ...f.draft, saving: rev } }
        : f,
    );
    let ok = false;
    try {
      ok = (
        await actions.record(row, evidence, open.entry.id, HISTORY_COPY.fixed)
      ).ok;
    } finally {
      settle(id, session, rev, ok);
    }
  };
  const fixForm =
    fix === null ? null : (
      <FixForm
        key={fix.session}
        fix={fix}
        goal={goal}
        blocked={blocked}
        onRecheck={
          unchecked && blocked !== HISTORY_COPY.checking
            ? () => recheck(fix.entry)
            : null
        }
        onAmount={(amount) =>
          setFix((f) =>
            f !== null && f.session === fix.session
              ? {
                  ...f,
                  draft: {
                    ...f.draft,
                    amount,
                    rev: f.draft.rev + 1,
                    unsaved: true,
                  },
                  error: null,
                }
              : f,
          )
        }
        onError={(error) =>
          setFix((f) =>
            f !== null && f.session === fix.session ? { ...f, error } : f,
          )
        }
        onSave={(evidence) => void submit(evidence)}
        onCancel={() => {
          sel.current += 1;
          fixRef.current = null;
          setFix(null);
        }}
      />
    );
  const fixShown = fix !== null && shown.some((s) => s.id === fix.entry.id);
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2"
      data-entry-history=""
      data-journal-requests={requests}
      // Native barriers (revision 6, R18): the stream's committed version this history renders, and the version its window was read at.
      data-stream-version={row.progressVersion ?? ""}
      data-journal-version={journal?.version ?? ""}
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
            const checking = scan?.entryId === entry.id;
            const checkFailed =
              !checking && journal?.checks[entry.id]?.found === "failed";
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
                    {checking ? (
                      <Button disabled reason={HISTORY_COPY.checking}>
                        {HISTORY_COPY.fix}
                      </Button>
                    ) : (
                      <Button variant="quiet" onClick={() => askFix(entry)}>
                        {HISTORY_COPY.fix}
                      </Button>
                    )}
                    {checkFailed ? (
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
          // After a refusal too: only a new explicit read begins another authority (revision 5, R14).
          loading ? (
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
              <Button onClick={() => void earlier()}>
                {HISTORY_COPY.earlier}
              </Button>
            ) : null}
            {last?.next !== null && last?.next !== undefined ? (
              <Button onClick={() => void more()}>
                {HISTORY_COPY.loadMore}
              </Button>
            ) : null}
            <Button variant="quiet" onClick={() => void refresh()}>
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
  onRecheck,
  onAmount,
  onError,
  onSave,
  onCancel,
}: {
  fix: OpenFix;
  goal: Goal;
  /** Why the fix cannot be saved now (the parent's one save decision), or null. */
  blocked: string | null;
  /** Checks the rest of the journal for this entry again, keeping the fix open (when that is what Save waits for), or null. */
  onRecheck: (() => void) | null;
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
    const value = parseDecimalInput(fix.draft.amount);
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
            value={fix.draft.amount}
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
      ) : fix.draft.saving !== null ? (
        <Button disabled reason={copy.SAVING}>
          {HISTORY_COPY.fixSave}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => save()}>
          {HISTORY_COPY.fixSave}
        </Button>
      )}
      {onRecheck !== null ? (
        <Button variant="quiet" onClick={onRecheck}>
          {HISTORY_COPY.recheck}
        </Button>
      ) : null}
      <Button variant="quiet" onClick={onCancel}>
        {HISTORY_COPY.cancel}
      </Button>
      {fix.error ? (
        <p className="w-full text-[12.5px] text-conflict-text">{fix.error}</p>
      ) : null}
    </div>
  );
}
