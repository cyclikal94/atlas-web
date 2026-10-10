import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import {
  type CacheRow,
  type DraftWithCommand,
  type ListedResource,
  useDataActions,
  useOutstanding,
} from "../../data";
import type { Dialog } from "./CalendarSources";
import {
  CAUSE_CONNECTION,
  CAUSE_FETCH,
  CAUSE_LEASE,
  CAUSE_SUPERSEDED,
  CAUSE_TURNED_OFF,
  CAUSE_UNAVAILABLE,
  CAUSE_UNCONFIGURED,
  CHECK_AGAIN,
  DISCARD,
  DISCARD_FAILED,
  DISCARDED,
  DISMISS,
  FEED_REASONS,
  feedUnreadable,
  HEALTH_WORDS,
  MANAGE,
  NEEDS_CONNECTION,
  REFRESH,
  REFRESH_TRANSIENT,
  REFRESH_UNCONFIRMED,
  REFRESHED,
  REFRESHING,
  REVIEW,
  STILL_REFRESHING,
  SUCCESSOR_HEALTHY,
  successorFinished,
  TURN_ON,
  UPDATE_CONNECTION,
} from "./copy";
import { CONFIGURE_SOURCE } from "./model/commands";
import type { RefreshView } from "./model/refresh";
import {
  type Enablement,
  type Environment,
  type OutstandingCounts,
  pendingStatus,
  sourceStatus,
} from "./model/status";
import type { RefreshController } from "./refresh-controller";
import { type CalendarSourceView, calendarRowActions } from "./row-actions";

/** The registered row actions (WEB-13b's "Import events"), after Manage. */
function RowActions({ source }: { source: CalendarSourceView }) {
  return (
    <>
      {calendarRowActions().map(({ id, Render }) => (
        <Render key={id} source={source} />
      ))}
    </>
  );
}

/** The words a refresh outcome is shown with (`copy.ts`). */
export function refreshMessage(view: RefreshView): string {
  switch (view.kind) {
    case "refreshing":
      return REFRESHING;
    case "succeeded":
      return REFRESHED;
    case "still_refreshing":
      return STILL_REFRESHING;
    case "needs_connection":
      return NEEDS_CONNECTION;
    case "successor_finished":
      return successorFinished(
        view.health === "healthy"
          ? SUCCESSOR_HEALTHY
          : `${HEALTH_WORDS[view.health ?? "pending"] ?? REFRESH_TRANSIENT}.`,
      );
    case "failed":
      switch (view.cause) {
        case "connection_unavailable":
          return CAUSE_CONNECTION;
        case "fetch_failed":
          return CAUSE_FETCH;
        case "unconfigured":
          return CAUSE_UNCONFIGURED;
        case "superseded":
          return CAUSE_SUPERSEDED;
        case "lease_expired":
          return CAUSE_LEASE;
        case "turned_off":
          return CAUSE_TURNED_OFF;
        case "unavailable":
          return CAUSE_UNAVAILABLE;
        case "feed_unreadable":
          return feedUnreadable(
            FEED_REASONS[view.code ?? ""] ?? FEED_REASONS.invalid_ics ?? "",
          );
        case "unconfirmed":
          return REFRESH_UNCONFIRMED;
        default:
          return REFRESH_TRANSIENT;
      }
  }
}

function Action({
  enablement,
  onClick,
  label,
  name,
}: {
  enablement: Enablement;
  onClick(): void;
  label: string;
  /** The accessible name, when the visible label is shared by every row. */
  name: string;
}) {
  return enablement.enabled ? (
    <Button aria-label={name} onClick={onClick}>
      {label}
    </Button>
  ) : (
    <Button aria-label={name} disabled reason={enablement.reason ?? ""}>
      {label}
    </Button>
  );
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <>
      {lines.map((line) => (
        <span
          key={line}
          data-status-line=""
          className="text-[12.5px] text-ink-2"
        >
          {line}
        </span>
      ))}
    </>
  );
}

/** "Discard" for a refused save, or the way to the queue when the refused draft is not the newest one. */
function DraftAction({
  latest,
  state,
  onReview,
}: {
  latest: OutstandingCounts["latest"];
  state: ReturnType<typeof sourceStatus>["outstanding"];
  onReview?(localId: string): void;
}) {
  const actions = useDataActions();
  const announcer = useAnnouncer();
  if (state !== "decision" && state !== "rejected") return null;
  if (
    state === "decision" &&
    onReview !== undefined &&
    latest?.status === "version_conflict"
  )
    return <Button onClick={() => onReview(latest.local_id)}>{REVIEW}</Button>;
  if (
    state === "rejected" &&
    latest !== null &&
    (latest.status === "rejected" || latest.status === "blocked")
  )
    return (
      <Button
        onClick={() =>
          void actions.discard(latest.local_id).then(
            (outcome) =>
              announcer.announce(
                outcome.kind === "discarded" ? DISCARDED : DISCARD_FAILED,
              ),
            () => announcer.announce(DISCARD_FAILED),
          )
        }
      >
        {DISCARD}
      </Button>
    );
  return (
    <Link
      to="/sync"
      search={{ tab: "conflicts" }}
      className="atlas-transition inline-flex min-h-11 items-center text-[13.5px] text-ink-2 underline hover:text-ink-1"
    >
      {REVIEW}
    </Link>
  );
}

/** A cached source: its merged row, its unsettled drafts, and the refresh it may run. */
export function SourceRow({
  row,
  environment,
  controller,
  notice,
  onDismissNotice,
  onDialog,
}: {
  row: ListedResource;
  environment: Environment;
  controller: RefreshController | null;
  /** A refusal kept across a remount (`memory.ts`), or undefined. */
  notice?: string;
  onDismissNotice?(): void;
  onDialog(dialog: Dialog): void;
}) {
  const id = row.base.id;
  // With the newest settings change that applies, so a later draft of another kind (an import) does not hide the values it shows.
  const outstanding = useOutstanding(id, CONFIGURE_SOURCE);
  const counts: OutstandingCounts | null =
    outstanding.status === "ready" ? outstanding.value : null;
  const view = controller?.view(id) ?? null;
  const refreshing = controller?.running(id) ?? false;
  const status = sourceStatus({
    merged: row.merged,
    outstanding: counts,
    env: environment,
    refreshing,
  });
  const announcer = useAnnouncer();
  const label = row.merged.label;
  const announced = useRef<RefreshView | null>(null);
  useEffect(() => {
    if (view === null || view === announced.current) return;
    announced.current = view;
    announcer.announce(`${label}: ${refreshMessage(view)}`);
  }, [view, label, announcer]);
  const manage = (extra: Partial<Extract<Dialog, { kind: "manage" }>> = {}) =>
    onDialog({ kind: "manage", row: row.merged, cached: true, ...extra });
  return (
    <li
      data-source-row={id}
      className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-[14px] text-ink-1">{label}</span>
          <Lines lines={status.lines} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Action
            enablement={status.refresh}
            label={REFRESH}
            name={`${REFRESH} ${label}`}
            onClick={() => controller?.refresh(id)}
          />
          <Action
            enablement={status.manage}
            label={MANAGE}
            name={`${MANAGE} ${label}`}
            onClick={() => manage()}
          />
          <RowActions source={{ id, label, row: row.merged, pending: false }} />
          <DraftAction
            latest={counts?.latest ?? null}
            state={status.outstanding}
            onReview={(localId) => manage({ supersede: localId })}
          />
        </div>
      </div>
      {notice !== undefined ? (
        <div
          data-row-notice=""
          className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] leading-[1.6] text-ink-1"
        >
          <span>{notice}</span>
          <Button variant="quiet" onClick={() => onDismissNotice?.()}>
            {DISMISS}
          </Button>
        </div>
      ) : null}
      {view !== null ? (
        <div
          data-refresh={view.kind}
          className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] leading-[1.6] text-ink-1"
        >
          <span>{refreshMessage(view)}</span>
          {view.kind === "still_refreshing" ? (
            // "Check again" starts a request as Refresh does, so it is offered exactly when Refresh would be (online, a supported
            // server, an editable source that is on), with the same reason beside it when it is not; it keeps the run's key.
            status.refresh.enabled ? (
              <Button
                variant="quiet"
                onClick={() => controller?.checkAgain(id)}
              >
                {CHECK_AGAIN}
              </Button>
            ) : (
              <Button
                variant="quiet"
                disabled
                reason={status.refresh.reason ?? ""}
              >
                {CHECK_AGAIN}
              </Button>
            )
          ) : null}
          {view.kind === "failed" && view.cause === "connection_unavailable" ? (
            <Button variant="quiet" onClick={() => manage({ replace: true })}>
              {UPDATE_CONNECTION}
            </Button>
          ) : null}
          {view.kind === "failed" && view.cause === "turned_off" ? (
            <Button variant="quiet" onClick={() => manage({ enable: true })}>
              {TURN_ON}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A create this device saved that the server has not confirmed yet. */
export function PendingRow({
  draft,
  row,
  environment,
  onDialog,
}: {
  draft: DraftWithCommand;
  row: CacheRow;
  environment: Environment;
  onDialog(dialog: Dialog): void;
}) {
  const status = pendingStatus({ draft, env: environment });
  return (
    <li
      data-pending-source={row.id}
      className="list-none rounded-row border border-dashed border-hairline-strong bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-[14px] text-ink-1">
            {row.label}
          </span>
          <Lines lines={status.lines} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Action
            enablement={status.refresh}
            label={REFRESH}
            name={`${REFRESH} ${row.label}`}
            onClick={() => undefined}
          />
          <Action
            enablement={status.manage}
            label={MANAGE}
            name={`${MANAGE} ${row.label}`}
            onClick={() => onDialog({ kind: "manage", row, cached: false })}
          />
          <RowActions
            source={{ id: row.id, label: row.label, row, pending: true }}
          />
          <DraftAction latest={draft} state={status.outstanding} />
        </div>
      </div>
    </li>
  );
}
