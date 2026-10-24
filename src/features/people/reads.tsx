import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type CacheRow,
  type DraftWithCommand,
  type Loadable,
  type OutstandingCreatesPage,
  type ResourceKind,
  type ResourcePage,
  useInventory,
  useOutstandingCreates,
  useResourceList,
} from "../../data";
import { usePeopleEnv } from "./env";
import { isCurrentMemory, useMemoryRevision } from "./memory";
import { type LinkageState, linkageOf, unknownLinkage } from "./model/linkage";

/**
 * The people screens' READS (D-11a-4, D-11a-2). PAGE CHAINS: `useResourceList` gives one live page of at most 100 rows; a chain renders one
 * subscribed reader per page, following `next` until the end or a cap, and reports the union. Every page stays live, nothing is read
 * past the cap, and the data layer is not changed. The same for the outstanding drafts (`useOutstandingCreates`, 100 per window).
 */
/** `absent`: the database does not exist (nothing is in it); `failed`: a read failed, or the database is closed. */
export type ChainStatus = "loading" | "ready" | "absent" | "failed";

export interface ChainResult<Row> {
  status: ChainStatus;
  /** The rows of the pages that have reported, in order: READABLE, never an inventory unless `complete`. */
  rows: Row[];
  /** The cap was reached while more pages followed: the view says it shows the first n. */
  capped: boolean;
  /**
   * Every page from the first to the last (`next: null`) has reported ready: only then is a row's ABSENCE from `rows` evidence that it
   * is not there. A later page still loading, absent or failed, or the cap, is not complete (finding 5 of the review of 13 October).
   */
  complete: boolean;
}

export interface Report<Row, Cursor> {
  status: ChainStatus;
  rows: Row[];
  next: Cursor | null;
}

/**
 * A page's read as the chains count it. `absent` is ONLY a database known not to exist (it holds nothing); a CLOSED one (latched,
 * ended, being wiped) is not evidence of anything, and counts as a read that failed (review 7's design assessment: closed was taken as
 * absent, and the detail then took every unsent change as read).
 */
export function statusOf(loadable: Loadable<unknown>): ChainStatus {
  if (loadable.status === "ready") return "ready";
  if (loadable.status === "loading") return "loading";
  return loadable.reason === "absent" ? "absent" : "failed";
}

/** The reports of the pages of a walk, by index, each with the cursor it was read after. */
function useReports<Row, Cursor>() {
  const [reports, setReports] = useState<
    ReadonlyMap<number, { after: Cursor | null; report: Report<Row, Cursor> }>
  >(() => new Map());
  const report = useCallback(
    (index: number, after: Cursor | null, next: Report<Row, Cursor> | null) =>
      setReports((previous) => {
        const known = previous.get(index);
        if (next === null) {
          if (known === undefined) return previous;
          const out = new Map(previous);
          out.delete(index);
          return out;
        }
        if (
          known !== undefined &&
          known.after === after &&
          known.report.status === next.status &&
          known.report.rows === next.rows &&
          known.report.next === next.next
        )
          return previous;
        const out = new Map(previous);
        out.set(index, { after, report: next });
        return out;
      }),
    [],
  );
  return { reports, report };
}

/** What the reports of a chain say, followed from page 0 through each page's `next` (a stale later report is never counted). PURE. */
export function chainResult<Row, Cursor>(
  reports: ReadonlyMap<
    number,
    { after: Cursor | null; report: Report<Row, Cursor> }
  >,
  cap: number,
): ChainResult<Row> {
  const rows: Row[] = [];
  let after: Cursor | null = null;
  for (let index = 0; index < cap; index += 1) {
    const entry = reports.get(index);
    if (entry === undefined || entry.after !== after)
      return {
        status: index === 0 ? "loading" : "ready",
        rows,
        capped: false,
        complete: false,
      };
    const { status, next } = entry.report;
    if (status !== "ready")
      return {
        status: index === 0 || status === "failed" ? status : "ready",
        rows,
        capped: false,
        complete: false,
      };
    rows.push(...entry.report.rows);
    if (next === null)
      return { status: "ready", rows, capped: false, complete: true };
    after = next;
  }
  return { status: "ready", rows, capped: true, complete: false };
}

function useChain<Row, Cursor>(cap: number) {
  const { reports, report } = useReports<Row, Cursor>();
  const result = useMemo(() => chainResult(reports, cap), [reports, cap]);
  return { result, report };
}

// ---- cached resources: a bounded scan with a continuation (Q9) ----------------------------------------------------------------------
/**
 * One STEP of a walk over the cached rows of `kind` (under `parentId`), from the cursor `start`: the live pages are read one after
 * another, each row is offered to `keep`, and the step ends as soon as `limit` rows were kept, `pages` pages were read, or the last page
 * was reached. Nothing past the step is read, and every row stays reachable: `next` is where the following step begins (Q9 "keep further
 * records accessible through pagination"; finding 7 of the review of 13 October: a fixed cap is not a continuation).
 */
export interface ScanResult {
  status: ChainStatus;
  /** The kept rows of this step, in cursor order, at most `limit`. Live while the step is mounted. */
  rows: CacheRow[];
  /** The step's walk is over (`limit` kept, `pages` read, or the end); before that `rows` is partial. */
  settled: boolean;
  /** Where the next step begins (pass it as `start`), or null: the step reached the last row (or has not settled). */
  next: string | null;
  /** The step reached the last row: nothing follows it. */
  end: boolean;
}

interface ScanPageProps {
  kind: ResourceKind;
  parentId: string | undefined;
  after: string | null;
  index: number;
  /** How many pages the step needs mounted now (the walk asks for one more only when the pages before it did not settle it). */
  depth: number;
  report(
    index: number,
    after: string | null,
    next: Report<CacheRow, string> | null,
  ): void;
}

function ScanPageReader(props: ScanPageProps) {
  const { kind, parentId, after, index, depth, report } = props;
  const page: Loadable<ResourcePage> = useResourceList({
    kind,
    ...(parentId === undefined ? {} : { parentId }),
    after,
  });
  const rows = useMemo(
    () =>
      page.status === "ready" ? page.value.rows.map((row) => row.merged) : [],
    [page],
  );
  const next = page.status === "ready" ? page.value.next : null;
  useEffect(() => {
    report(index, after, { status: statusOf(page), rows, next });
  }, [report, index, after, page, rows, next]);
  useEffect(() => () => report(index, after, null), [report, index, after]);
  if (next === null || index + 1 >= depth) return null;
  return <ScanPageReader {...props} after={next} index={index + 1} />;
}

/** The step a set of page reports describes (PURE; exported for its tests). */
export function scanStep(
  reports: ReadonlyMap<
    number,
    { after: string | null; report: Report<CacheRow, string> }
  >,
  start: string | null,
  keep: (row: CacheRow) => boolean,
  limit: number,
  pages: number,
): ScanResult & { depth: number } {
  const rows: CacheRow[] = [];
  let after = start;
  for (let index = 0; index < pages; index += 1) {
    const entry = reports.get(index);
    const partial = (status: ChainStatus) => ({
      status,
      rows,
      settled: false,
      next: null,
      end: false,
      depth: index + 1,
    });
    if (entry === undefined || entry.after !== after)
      return partial(index === 0 ? "loading" : "ready");
    const { status, next } = entry.report;
    if (status !== "ready")
      return partial(index === 0 || status === "failed" ? status : "ready");
    for (const row of entry.report.rows) {
      if (!keep(row)) continue;
      rows.push(row);
      if (rows.length >= limit)
        return {
          status: "ready",
          rows,
          settled: true,
          next: row.id,
          end: false,
          depth: index + 1,
        };
    }
    if (next === null)
      return {
        status: "ready",
        rows,
        settled: true,
        next: null,
        end: true,
        depth: index + 1,
      };
    after = next;
  }
  return {
    status: "ready",
    rows,
    settled: true,
    next: after,
    end: false,
    depth: pages,
  };
}

/**
 * One step of the walk (see `ScanResult`). `keep` must be stable while what it keeps is the same (a `useCallback`); a new `start` is a new step.
 */
export function ResourceScan({
  kind,
  parentId,
  start,
  keep,
  limit,
  pages,
  children,
}: {
  kind: ResourceKind;
  parentId?: string;
  start: string | null;
  keep(row: CacheRow): boolean;
  limit: number;
  pages: number;
  children(result: ScanResult): ReactNode;
}) {
  const { reports, report } = useReports<CacheRow, string>();
  const step = useMemo(
    () => scanStep(reports, start, keep, limit, pages),
    [reports, start, keep, limit, pages],
  );
  const { depth, ...result } = step;
  return (
    <>
      <ScanPageReader
        kind={kind}
        parentId={parentId}
        after={start}
        index={0}
        depth={depth}
        report={report}
      />
      {children(result)}
    </>
  );
}

// ---- outstanding drafts -----------------------------------------------------------------------------------------------------------
interface OutstandingPageProps {
  kinds: readonly string[];
  after: number | null;
  index: number;
  cap: number;
  report(
    index: number,
    after: number | null,
    next: Report<DraftWithCommand, number> | null,
  ): void;
}

function OutstandingPageReader(props: OutstandingPageProps) {
  const { kinds, after, index, cap, report } = props;
  const page: Loadable<OutstandingCreatesPage> = useOutstandingCreates(
    kinds,
    after,
  );
  const rows = useMemo(
    () => (page.status === "ready" ? page.value.drafts : []),
    [page],
  );
  const next = page.status === "ready" ? page.value.next : null;
  useEffect(() => {
    report(index, after, { status: statusOf(page), rows, next });
  }, [report, index, after, page, rows, next]);
  useEffect(() => () => report(index, after, null), [report, index, after]);
  if (next === null || index + 1 >= cap) return null;
  return <OutstandingPageReader {...props} after={next} index={index + 1} />;
}

/** The kinds the people screens fold over the cache (§3.2 `project.ts`). */
export const PEOPLE_KINDS: readonly string[] = [
  "create_person",
  "put_field",
  "edit",
  "archive",
];

/** This device's outstanding drafts of `kinds`, at most `cap` windows of 100. An absent database is no drafts. */
export function OutstandingChain({
  kinds = PEOPLE_KINDS,
  cap = 10,
  children,
}: {
  kinds?: readonly string[];
  cap?: number;
  children(result: ChainResult<DraftWithCommand>): ReactNode;
}) {
  const { result, report } = useChain<DraftWithCommand, number>(cap);
  return (
    <>
      <OutstandingPageReader
        kinds={kinds}
        after={null}
        index={0}
        cap={cap}
        report={report}
      />
      {children(result)}
    </>
  );
}

// ---- confirming an absence (review 7's design assessment, DA7-12) -------------------------------------------------------------------
/**
 * What ONE read of the cache and of this device's unsent changes, together (`readInventory`), says of an absence the separate reads
 * suggest: `absent` (confirmed), `present` (something is there after all: the separate reads have not caught up), `unknown` (still
 * reading, or more unsent changes than are read: never confirmed) or `failed`. The separate live reads of the cache and of the unsent
 * changes are delivered separately: when one commit moves a new person (or field) from the queue to the cache, the queue's read can
 * answer first, and for that moment neither shows it. A screen says "No one here yet", "No fields yet" or "isn't on this device" only on
 * `absent`; it shows what the separate reads give in every other case.
 */
export type Confirmation = "absent" | "present" | "unknown" | "failed";

/** What a confirming read found: the step it read again (a list) or the resource (by id), and every unsent change of the kinds asked. */
export interface Found {
  step: ScanResult | null;
  resource: CacheRow | null;
  drafts: readonly DraftWithCommand[];
}

export function ConfirmedAbsence({
  kind,
  parentId,
  id,
  start = null,
  limit,
  pages,
  kinds = PEOPLE_KINDS,
  keepWith,
  absent,
  children,
}: {
  kind?: ResourceKind;
  parentId?: string;
  id?: string;
  start?: string | null;
  limit: number;
  pages: number;
  kinds?: readonly string[];
  /** What the step keeps, given the unsent changes read with it. */
  keepWith?(drafts: readonly DraftWithCommand[]): (row: CacheRow) => boolean;
  absent(found: Found): boolean;
  children(confirmation: Confirmation): ReactNode;
}) {
  const read = useInventory({
    ...(id === undefined
      ? {
          kind,
          ...(parentId === undefined ? {} : { parentId }),
          after: start,
          pages,
        }
      : { id }),
    kinds,
  });
  if (read.status === "loading") return children("unknown");
  // An absent database holds nothing; a closed or failed one is not evidence of anything.
  if (read.status === "unavailable")
    return children(read.reason === "absent" ? "absent" : "failed");
  const inventory = read.value;
  const chain = chainResult(
    new Map(
      inventory.outstanding.map((window, index) => [
        index,
        {
          after: window.after,
          report: {
            status: "ready" as const,
            rows: window.page.drafts,
            next: window.page.next,
          },
        },
      ]),
    ),
    10,
  );
  if (!chain.complete) return children("unknown");
  let step: ScanResult | null = null;
  if (id === undefined) {
    const { depth: _depth, ...walked } = scanStep(
      new Map(
        inventory.pages.map((entry, index) => [
          index,
          {
            after: entry.after,
            report: {
              status: "ready" as const,
              rows: entry.page.rows.map((row) => row.merged),
              next: entry.page.next,
            },
          },
        ]),
      ),
      start,
      keepWith ? keepWith(chain.rows) : () => true,
      limit,
      pages,
    );
    if (!walked.settled) return children("unknown");
    step = walked;
  }
  return children(
    absent({ step, resource: inventory.resource, drafts: chain.rows })
      ? "absent"
      : "present",
  );
}

// ---- linkage (D-11a-2) --------------------------------------------------------------------------------------------------------------
/**
 * Reads `GET /people/{id}` for the displayed identity, once per page lifetime unless asked again, and answers what this page knows. The
 * answer lives in the identity's page memory, so a remount of the tree keeps it; a read still on its way is shared, never made twice. A
 * `403`/`404` is remembered until an explicit "Try again" (D-12a-13). Nothing is ever inferred from `can_edit`.
 */
export function readLinkage(
  env: ReturnType<typeof usePeopleEnv>,
  personId: string,
  options: { force?: boolean } = {},
): Promise<unknown> | null {
  const memory = env.memory;
  if (!options.force) {
    if (memory.linkage.has(personId) || memory.refused.has(personId))
      return null;
    const inflight = memory.linkageReads.get(personId);
    if (inflight !== undefined) return inflight;
  } else {
    memory.refused.delete(personId);
  }
  if (!env.online) return null;
  const reading = env.api.readPerson(personId).then((result) => {
    if (!isCurrentMemory(memory)) return;
    memory.linkageReads.delete(personId);
    if (result.ok) {
      memory.linkage.set(personId, {
        state: linkageOf(result.value, env.accountId, env.now()),
        person: {
          id: result.value.person.id,
          label: result.value.person.label,
          version: result.value.person.version,
        },
      });
      memory.refused.delete(personId);
    } else if (result.kind === "forbidden" || result.kind === "not_found") {
      memory.refused.set(personId, result.kind);
      memory.linkage.delete(personId);
    } else {
      memory.failed.add(personId);
    }
    memory.touch();
  });
  memory.failed.delete(personId);
  memory.linkageReads.set(personId, reading);
  memory.touch();
  return reading;
}

export function linkageIn(
  env: ReturnType<typeof usePeopleEnv>,
  personId: string,
): LinkageState {
  const memory = env.memory;
  const known = memory.linkage.get(personId);
  if (known !== undefined) return known.state;
  if (memory.refused.has(personId)) return unknownLinkage("refused");
  if (memory.linkageReads.has(personId)) return unknownLinkage("loading");
  if (memory.failed.has(personId)) return unknownLinkage("failed");
  return unknownLinkage(env.online ? "loading" : "offline");
}

/** The linkage of one person: read when online and not yet known; `retry` asks again (after a failure or a refusal). */
export function usePersonLinkage(personId: string): {
  linkage: LinkageState;
  retry(): void;
} {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  useEffect(() => {
    if (env.online) readLinkage(env, personId);
  }, [env, personId]);
  const retry = useCallback(() => {
    readLinkage(env, personId, { force: true });
  }, [env, personId]);
  return { linkage: linkageIn(env, personId), retry };
}
