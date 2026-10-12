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
export type ChainStatus = "loading" | "ready" | "absent" | "failed";

export interface ChainResult<Row> {
  status: ChainStatus;
  rows: Row[];
  /** The cap was reached while more pages followed: the view says it shows the first n. */
  capped: boolean;
}

interface Report<Row, Cursor> {
  status: ChainStatus;
  rows: Row[];
  next: Cursor | null;
}

function statusOf(loadable: Loadable<unknown>): ChainStatus {
  if (loadable.status === "ready") return "ready";
  if (loadable.status === "loading") return "loading";
  return loadable.reason === "error" ? "failed" : "absent";
}

/** The reports of a chain, followed from page 0 through each page's `next` (a stale later report is never counted). */
function useChain<Row, Cursor>(cap: number) {
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
  const result = useMemo<ChainResult<Row>>(() => {
    const rows: Row[] = [];
    let after: Cursor | null = null;
    for (let index = 0; index < cap; index += 1) {
      const entry = reports.get(index);
      if (entry === undefined || entry.after !== after)
        return {
          status: index === 0 ? "loading" : "ready",
          rows,
          capped: false,
        };
      const { status, next } = entry.report;
      if (status !== "ready")
        return {
          status: index === 0 || status === "failed" ? status : "ready",
          rows,
          capped: false,
        };
      rows.push(...entry.report.rows);
      if (next === null) return { status: "ready", rows, capped: false };
      after = next;
    }
    return { status: "ready", rows, capped: true };
  }, [reports, cap]);
  return { result, report };
}

// ---- cached resources ---------------------------------------------------------------------------------------------------------------
interface ResourcePageProps {
  kind: ResourceKind;
  parentId: string | undefined;
  after: string | null;
  index: number;
  cap: number;
  report(
    index: number,
    after: string | null,
    next: Report<CacheRow, string> | null,
  ): void;
}

function ResourcePageReader(props: ResourcePageProps) {
  const { kind, parentId, after, index, cap, report } = props;
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
  if (next === null || index + 1 >= cap) return null;
  return <ResourcePageReader {...props} after={next} index={index + 1} />;
}

/** Every cached row of `kind` (under `parentId`), merged with its claimed overlay, at most `cap` pages of 100. */
export function ResourceChain({
  kind,
  parentId,
  cap,
  children,
}: {
  kind: ResourceKind;
  parentId?: string;
  cap: number;
  children(result: ChainResult<CacheRow>): ReactNode;
}) {
  const { result, report } = useChain<CacheRow, string>(cap);
  return (
    <>
      <ResourcePageReader
        kind={kind}
        parentId={parentId}
        after={null}
        index={0}
        cap={cap}
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
