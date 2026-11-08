import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import {
  type DraftRow,
  useCachedResources,
  useDataActions,
  useDraftHeaders,
  usePendingCreates,
} from "../../data";
import { formatSavedAt } from "../sync/rows";
import { DISCARD_FAILED, DISCARDED } from "./copy";
import {
  DISMISS_IMPORT,
  IMPORT_CAPACITY,
  IMPORT_REASONS,
  IMPORTS_HEADING,
  OPEN_QUEUE,
  queuedAt,
  rejectedImport,
  SHOW_NEXT_IMPORTS,
  SHOW_PREVIOUS_IMPORTS,
  STATUS_ACCEPTED,
  STATUS_PAUSED,
  STATUS_QUEUED,
  STATUS_RETRYING,
  STATUS_SENT,
  STATUS_SYNCING,
  UNKNOWN_SOURCE,
} from "./copy-import";
import { CREATE_SOURCE, IMPORT_ENDPOINT } from "./model/commands";
import { projectSourceCreate } from "./register";

/** What one import draft's HEADER says to the person (§4.2 of the plan): never its body. */
export type ImportStatus =
  | { kind: "queued"; lines: string[] }
  | { kind: "sent"; lines: string[] }
  | { kind: "paused"; lines: string[] }
  | { kind: "accepted"; lines: string[] }
  | { kind: "rejected"; lines: string[] }
  | { kind: "blocked"; lines: string[] };

/** The reason a refused import is shown with (`IMPORT_REASONS`): a rejection of an earlier change it depended on, the server's code, else its status. */
export function importReason(draft: Pick<DraftRow, "last_error">): string {
  const error = draft.last_error;
  if (error?.stage === "dependency_rejected")
    return IMPORT_REASONS.dependency_rejected ?? "";
  const byCode =
    error?.code === undefined ? undefined : IMPORT_REASONS[error.code];
  if (byCode !== undefined) return byCode;
  if (error?.status === 403) return IMPORT_REASONS.forbidden ?? "";
  if (error?.status === 404) return IMPORT_REASONS.not_found ?? "";
  return IMPORT_REASONS.other ?? "";
}

export function importStatus(
  draft: Pick<DraftRow, "status" | "attempts" | "retry_state" | "last_error">,
): ImportStatus {
  switch (draft.status) {
    case "queued":
      return { kind: "queued", lines: [STATUS_QUEUED] };
    case "in_flight":
      if (draft.attempts === 0)
        return { kind: "queued", lines: [STATUS_QUEUED] };
      return draft.retry_state?.state === "paused"
        ? { kind: "paused", lines: [STATUS_PAUSED] }
        : { kind: "sent", lines: [STATUS_SENT, STATUS_RETRYING] };
    case "acknowledged":
      return { kind: "accepted", lines: [STATUS_ACCEPTED, STATUS_SYNCING] };
    case "blocked":
      return { kind: "blocked", lines: [IMPORT_CAPACITY] };
    default:
      // A rejection; a conflict cannot happen for a body stored once (a different body under the same key), and is shown as refused.
      return { kind: "rejected", lines: [rejectedImport(importReason(draft))] };
  }
}

/**
 * The Imports panel (WEB-13b §4.2, the wireframe's status sequence and result panels): this device's outstanding imports, oldest first,
 * a window of 100 at a time, read from draft HEADERS only (`useDraftHeaders`), so a list never loads a file's text. An accepted import
 * leaves when its draft leaves the outbox; no count of imported events is ever claimed (the server's receipt is a bare revision).
 */
export function ImportsPanel() {
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const after = cursors[cursors.length - 1] ?? null;
  const page = useDraftHeaders(IMPORT_ENDPOINT, after);
  const drafts = page.status === "ready" ? page.value.drafts : [];
  const ids = useMemo(
    () => [
      ...new Set(
        drafts
          .map((draft) => draft.target_id ?? draft.target_resource_ids[0])
          .filter((id): id is string => id !== undefined && id !== null),
      ),
    ],
    [drafts],
  );
  const cached = useCachedResources(ids);
  const pending = usePendingCreates(CREATE_SOURCE);
  const label = (id: string | null | undefined): string => {
    if (id === null || id === undefined) return UNKNOWN_SOURCE;
    if (cached.status === "ready") {
      const row = cached.value[id];
      if (row) return row.merged.label;
    }
    if (pending.status === "ready")
      for (const draft of pending.value.drafts) {
        const row = projectSourceCreate(draft);
        if (row?.id === id) return row.label;
      }
    return UNKNOWN_SOURCE;
  };
  if (page.status !== "ready" || page.value.total === 0) return null;
  const next = page.value.next;
  return (
    <section aria-labelledby="imports-heading" className="flex flex-col gap-2">
      <h2 id="imports-heading" className="text-sm font-medium text-foreground">
        {IMPORTS_HEADING}
      </h2>
      <List className="flex flex-col gap-2">
        {drafts.map((draft) => (
          <ImportEntry
            key={draft.local_id}
            draft={draft}
            source={label(draft.target_id ?? draft.target_resource_ids[0])}
          />
        ))}
      </List>
      {cursors.length > 1 || next !== null ? (
        <div className="flex flex-wrap gap-2">
          {cursors.length > 1 ? (
            <Button
              variant="ghost"
              onClick={() => setCursors((list) => list.slice(0, -1))}
            >
              {SHOW_PREVIOUS_IMPORTS}
            </Button>
          ) : null}
          {next !== null ? (
            <Button
              variant="ghost"
              onClick={() => setCursors((list) => [...list, next])}
            >
              {SHOW_NEXT_IMPORTS}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ImportEntry({ draft, source }: { draft: DraftRow; source: string }) {
  const actions = useDataActions();
  const announcer = useAnnouncer();
  const status = importStatus(draft);
  const when = formatSavedAt(draft.created_at, new Date());
  return (
    <li
      data-import-draft={draft.local_id}
      data-import-status={status.kind}
      className="list-none rounded-lg border border-border bg-card p-3.5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-sm text-foreground">{source}</span>
          {when === "" ? null : (
            <span className="text-xs text-muted-foreground">
              {queuedAt(when)}
            </span>
          )}
          {status.lines.map((line) => (
            <span
              key={line}
              data-status-line=""
              className="text-xs text-muted-foreground"
            >
              {line}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {status.kind === "rejected" ? (
            <Button
              onClick={() =>
                void actions.discard(draft.local_id).then(
                  (outcome) =>
                    announcer.announce(
                      outcome.kind === "discarded" ? DISCARDED : DISCARD_FAILED,
                    ),
                  () => announcer.announce(DISCARD_FAILED),
                )
              }
            >
              {DISMISS_IMPORT}
            </Button>
          ) : null}
          {status.kind === "paused" || status.kind === "blocked" ? (
            <Link
              to="/sync"
              search={{ tab: "queue" }}
              className="atlas-transition inline-flex min-h-11 items-center text-sm text-muted-foreground underline hover:text-foreground"
            >
              {OPEN_QUEUE}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}
