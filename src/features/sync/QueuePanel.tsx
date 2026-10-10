import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import {
  type DraftRow,
  useCommandDescription,
  useDataActions,
  useDataEnv,
  useDraftQueue,
  useQueueSummary,
  useStatusInputs,
  useSyncStatusModel,
} from "../../data";
import { describeSyncChip } from "../../lib/sync-chip";
import {
  ACTION_DISCARD,
  ACTION_DISMISS,
  ACTION_RETRY,
  ACTION_RETRY_BLOCKED,
  CANNOT_DISCARD,
  DETAIL_ACTION,
  DISCARD_CONFIRM,
  DISCARD_CONFIRM_NO,
  DISCARD_CONFIRM_YES,
  DISCARD_DEPENDANTS,
  DISCARD_FAILED,
  DISCARDED,
  EMPTY_DECISION,
  EMPTY_WAITING,
  FOOTER,
  LOAD_FAILED,
  LOAD_FAILED_ACTION,
  LOADING,
  PAGER_LABEL,
  PANEL_HEADING,
  PANEL_SUBTITLE,
  RESYNCING_BANNER_BODY,
  RESYNCING_BANNER_TITLE,
  ROW_FALLBACK_TITLE,
  SAVED_AT,
  SHOW_NEXT,
  SHOW_PREVIOUS,
  SHOWING_NEXT,
  SHOWING_PREVIOUS,
  TAB_DECISION,
  TAB_WAITING,
} from "./copy";
import { detailVariant, ItemDetailDialog } from "./ItemDetailDialog";
import { Banner, NoticeList } from "./NoticeBanners";
import {
  describeRow,
  formatSavedAt,
  type RowAction,
  rowsOf,
  type Tab,
} from "./rows";

/**
 * WF-QUEUE-01, desktop and mobile (plan 5.7, D-17): "Waiting to send" and "Needs a decision" over the durable queue. It states what
 * the store holds and offers only what the store can do (Discard, Retry now). The conflict kinds are shown READ-ONLY with a kind
 * badge: the screens that resolve them (WF-CONFLICT-01/02, WF-QUEUE-02) are unowned and not built here.
 *
 * The lists render a WINDOW of rows (Q9: 100, then the next window, which REPLACES it, so the screen never holds more than one
 * window whatever it has been through), read by index and without any draft's body; nothing is capped or dropped (the 200-entry
 * warning is informational and blocks nothing, and every record stays reachable through the windows), and the tab counts are the
 * exact counts of the whole queue. The status line carries the "Receiving updates:" prefix so it can never be mistaken for a
 * statement about the outgoing list.
 */
export function QueuePanel({
  tab,
  onTabChange,
  onClose,
}: {
  tab: Tab;
  onTabChange(tab: Tab): void;
  onClose?(): void;
}) {
  const queue = useDraftQueue();
  const summary = useQueueSummary();
  const model = useSyncStatusModel();
  const inputs = useStatusInputs();
  const describe = useCommandDescription();
  const dataActions = useDataActions();
  const announcer = useAnnouncer();
  const chip = describeSyncChip(model);
  const online = inputs.online;
  // The rows shown are one window (Q9: 100, then the next); the tab counts are EXACT, from the summary the store counts by index,
  // whatever number of rows have been loaded.
  const page = queue.status === "ready" ? queue.value : null;
  const drafts = page?.rows ?? [];
  const waiting = rowsOf(drafts, "waiting");
  const decision = rowsOf(drafts, "decision");
  const counts =
    summary.status === "ready"
      ? {
          waiting: summary.value.waiting + summary.value.held,
          decision: summary.value.needsDecision,
        }
      : { waiting: waiting.length, decision: decision.length };
  const rows = tab === "waiting" ? waiting : decision;
  const ids = { waiting: useId(), decision: useId() };
  const panel = useRef<HTMLDivElement>(null);

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <PageHeading>{PANEL_HEADING}</PageHeading>
          <p className="text-[13.5px] text-ink-2">{PANEL_SUBTITLE}</p>
          <p data-phase-label="" className="font-num text-[12px] text-ink-2">
            {chip.phaseLabel}
          </p>
        </div>
        {onClose ? <Button onClick={onClose}>Close</Button> : null}
      </header>

      <NoticeList />

      <Tabs tab={tab} onChange={onTabChange} counts={counts} ids={ids} />

      {tab === "decision" && inputs.recovery.active ? (
        // A recovery under way is never a decision (tablet amendment, Q24): a non-actionable status banner, never a row.
        <Banner kind="resyncing" tone="info" title={RESYNCING_BANNER_TITLE}>
          <p>{RESYNCING_BANNER_BODY}</p>
        </Banner>
      ) : null}

      <div
        ref={panel}
        role="tabpanel"
        id={`${ids[tab]}-panel`}
        aria-labelledby={`${ids[tab]}-tab`}
        tabIndex={-1}
        className="flex flex-col gap-2"
      >
        {queue.status === "loading" ? (
          <p aria-busy="true" className="text-[13px] text-ink-2">
            {LOADING}
          </p>
        ) : queue.status === "unavailable" && queue.reason !== "absent" ? (
          <div
            data-load-error=""
            className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
          >
            <p className="text-[13.5px] text-ink-1">{LOAD_FAILED}</p>
            <Button onClick={() => dataActions.retryLoad()}>
              {LOAD_FAILED_ACTION}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p data-empty="" className="text-[13px] text-ink-2">
            {tab === "waiting" ? EMPTY_WAITING : EMPTY_DECISION}
          </p>
        ) : (
          <List className="flex flex-col gap-2">
            {rows.map((draft) => (
              <QueueRow
                key={draft.local_id}
                draft={draft}
                title={describe(draft) ?? ROW_FALLBACK_TITLE}
                online={online}
                // A removed row takes focus with it: it moves to the panel, a stable place, never to <body>.
                onRemoved={() => panel.current?.focus()}
                dependants={page?.dependants[draft.local_id] ?? 0}
              />
            ))}
          </List>
        )}
        {page?.more || page?.previous ? (
          <nav aria-label={PAGER_LABEL} className="flex flex-wrap gap-2">
            {page.previous ? (
              <Button
                onClick={() => {
                  dataActions.showPreviousQueue();
                  // The rows are replaced: say so, and keep focus in a stable place rather than on a button that has gone.
                  announcer.announce(SHOWING_PREVIOUS);
                  panel.current?.focus();
                }}
              >
                {SHOW_PREVIOUS}
              </Button>
            ) : null}
            {page.more ? (
              <Button
                onClick={() => {
                  dataActions.showNextQueue();
                  announcer.announce(SHOWING_NEXT);
                  panel.current?.focus();
                }}
              >
                {SHOW_NEXT}
              </Button>
            ) : null}
          </nav>
        ) : null}
      </div>

      <p className="max-w-[620px] text-[12px] leading-[1.55] text-ink-2">
        {FOOTER}
      </p>
    </div>
  );
}

function Tabs({
  tab,
  onChange,
  counts,
  ids,
}: {
  tab: Tab;
  onChange(tab: Tab): void;
  counts: Record<Tab, number>;
  ids: Record<Tab, string>;
}) {
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({
    waiting: null,
    decision: null,
  });
  const order: Tab[] = ["waiting", "decision"];
  const move = (event: KeyboardEvent, from: Tab) => {
    const index = order.indexOf(from);
    let next: Tab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = order[(index + 1) % order.length] as Tab;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = order[(index + order.length - 1) % order.length] as Tab;
    else if (event.key === "Home") next = "waiting";
    else if (event.key === "End") next = "decision";
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };
  const label: Record<Tab, string> = {
    waiting: TAB_WAITING,
    decision: TAB_DECISION,
  };
  return (
    <div
      role="tablist"
      aria-label="Sync queue"
      className="flex flex-wrap gap-1 border-b border-hairline"
    >
      {order.map((id) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[id] = el;
          }}
          type="button"
          role="tab"
          id={`${ids[id]}-tab`}
          aria-selected={tab === id}
          aria-controls={`${ids[id]}-panel`}
          tabIndex={tab === id ? 0 : -1}
          data-tab={id}
          onClick={() => onChange(id)}
          onKeyDown={(event) => move(event, id)}
          className={`atlas-transition min-h-11 border-b-2 px-3 text-[13.5px] ${
            tab === id
              ? "border-action-ink font-medium text-ink-1"
              : "border-transparent text-ink-2 hover:text-ink-1"
          }`}
        >
          {label[id]} · <span className="font-num">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

function QueueRow({
  draft,
  title,
  online,
  dependants,
  onRemoved,
}: {
  draft: DraftRow;
  title: string;
  online: boolean;
  dependants: number;
  onRemoved(): void;
}) {
  const view = describeRow(draft, online);
  const actions = useDataActions();
  const env = useDataEnv();
  const announcer = useAnnouncer();
  const [confirming, setConfirming] = useState(false);
  // WF-QUEUE-02: a failed row opens the generic item-detail dialog (its only drawn state is the error detail).
  const variant = detailVariant(draft, env.commands.onlineOnly(draft));
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (view === null) return null;

  const discard = async () => {
    setBusy(true);
    setFailed(false);
    const out = await actions.discard(draft.local_id).catch(() => null);
    setBusy(false);
    if (out !== null && out.kind === "discarded") {
      onRemoved();
      // The shell announces the changed counts on the next frame; this confirmation comes just after it so neither replaces the
      // other in the one polite region (and it is the only word when no count changed, as when a retained outcome is dismissed).
      window.setTimeout(() => announcer.announce(DISCARDED), 250);
      return;
    }
    setConfirming(false);
    setFailed(true);
    announcer.announce(DISCARD_FAILED, "assertive");
  };

  // Retry is immediate. Discarding or dismissing deletes what the person wrote, so it asks first.
  const run = (action: RowAction) => {
    if (action === "retry") return actions.retryChanges(draft.local_id);
    setConfirming(true);
  };
  const label: Record<RowAction, string> = {
    discard: ACTION_DISCARD,
    dismiss: ACTION_DISMISS,
    retry: draft.status === "blocked" ? ACTION_RETRY_BLOCKED : ACTION_RETRY,
  };

  return (
    <li
      data-draft-row={draft.status}
      data-draft-id={draft.local_id}
      className="list-none rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] text-ink-1">{title}</span>
            {view.badge ? (
              <span
                data-badge=""
                className="rounded-badge border border-conflict-edge bg-conflict-tint px-1.5 py-0.5 text-[11.5px] text-conflict-text"
              >
                {view.badge}
              </span>
            ) : null}
          </span>
          <span className="font-num text-[12px] text-ink-2">
            {SAVED_AT(formatSavedAt(draft.created_at, new Date()))}
          </span>
          <span className="text-[12.5px] text-ink-2">
            {view.status}
            {view.attempts ? ` · ${view.attempts}` : ""}
          </span>
          {view.body ? (
            <span className="max-w-[560px] text-[12.5px] leading-[1.55] text-ink-2">
              {view.body}
            </span>
          ) : null}
          {view.cannotDiscard ? (
            <span className="text-[12px] text-ink-2">{CANNOT_DISCARD}</span>
          ) : null}
          {failed ? (
            <span className="text-[12.5px] text-ink-1">{DISCARD_FAILED}</span>
          ) : null}
        </div>
        {confirming ? (
          <div className="flex flex-col items-end gap-2">
            <span className="text-[13px] text-ink-1">{DISCARD_CONFIRM}</span>
            {dependants > 0 ? (
              <span className="max-w-[260px] text-right text-[12px] text-ink-2">
                {DISCARD_DEPENDANTS(dependants)}
              </span>
            ) : null}
            <span className="flex gap-2">
              <Button onClick={() => setConfirming(false)}>
                {DISCARD_CONFIRM_NO}
              </Button>
              {busy ? (
                <Button disabled reason="Working…">
                  {DISCARD_CONFIRM_YES}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void discard()}>
                  {DISCARD_CONFIRM_YES}
                </Button>
              )}
            </span>
          </div>
        ) : view.actions.length > 0 || variant !== null ? (
          <div className="flex flex-wrap gap-2">
            {variant !== null ? (
              <Button
                aria-label={`${DETAIL_ACTION}: ${title}`}
                onClick={() => setDetail(true)}
              >
                {DETAIL_ACTION}
              </Button>
            ) : null}
            {view.actions.map((action) => (
              <Button
                key={action}
                variant={action === "retry" ? "primary" : "secondary"}
                aria-label={`${label[action]}: ${title}`}
                onClick={() => run(action)}
              >
                {label[action]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {variant !== null && detail ? (
        <ItemDetailDialog
          draft={draft}
          title={title}
          variant={variant}
          open={detail}
          onClose={() => setDetail(false)}
          onRemoved={onRemoved}
        />
      ) : null}
    </li>
  );
}
