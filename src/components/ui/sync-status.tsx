import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  accessibleNameFor,
  type ChipDestination,
  type ChipTone,
  type ChipVariant,
  describeSyncChip,
  type SyncStatusModel,
} from "../../lib/sync-chip";
import { useAnnouncer } from "./announcer";
import { Tooltip } from "./tooltip";

export interface SyncStatusValue {
  model: SyncStatusModel;
  /** Opens the queue or conflict destination. WEB-09 and WEB-11 supply the real navigation. */
  onOpen(destination: ChipDestination): void;
}

const SyncStatusContext = createContext<SyncStatusValue | null>(null);

export function SyncStatusProvider({
  value,
  children,
}: {
  value: SyncStatusValue;
  children: ReactNode;
}) {
  const memo = useMemo(() => value, [value]);
  return (
    <SyncStatusContext.Provider value={memo}>
      {children}
    </SyncStatusContext.Provider>
  );
}

export function useSyncStatus(): SyncStatusValue {
  const value = useContext(SyncStatusContext);
  if (!value)
    throw new Error(
      "Sync status is not provided: wrap the tree in SyncStatusProvider",
    );
  return value;
}

const DOT: Record<ChipTone, string> = {
  ok: "bg-done",
  busy: "bg-action-ink",
  warn: "bg-missed",
  error: "bg-conflict",
  muted: "bg-withheld",
};
/** A non-healthy state adds a state-coloured border. It is a supplementary cue: text and the dot carry the state. */
const BORDER: Record<ChipTone, string> = {
  ok: "border-chrome-inset-edge",
  busy: "border-action-tint-edge",
  warn: "border-missed-edge",
  error: "border-conflict-edge",
  muted: "border-chrome-inset-edge",
};

/** Re-renders each minute so "synced 2m ago" does not go stale. */
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface SyncStatusChipProps {
  variant: ChipVariant;
  /** The dialog variant hooks this to retain the draft before it navigates. */
  onBeforeOpen?: () => void;
}

/**
 * A real button whose accessible name states both the status and the action. It never announces: one
 * SyncAnnouncements instance in the shell reports changes, so several chips on screen do not repeat them.
 */
export function SyncStatusChip({ variant, onBeforeOpen }: SyncStatusChipProps) {
  const { model, onOpen } = useSyncStatus();
  const now = useNow();
  const view = describeSyncChip(model, now);
  const name = accessibleNameFor(view, variant);
  const activate = () => {
    onBeforeOpen?.();
    onOpen(view.destination);
  };
  const dot = (
    <span
      aria-hidden="true"
      className={`size-[7px] flex-none rounded-round ${DOT[view.tone]}`}
    />
  );

  if (variant === "rail-collapsed") {
    return (
      <Tooltip
        side="right"
        content={
          <>
            <span className="block font-medium">{view.label}</span>
            {view.detail ? (
              <span className="block text-ink-2">{view.detail}</span>
            ) : null}
          </>
        }
      >
        <button
          type="button"
          aria-label={name}
          data-sync-tone={view.tone}
          onClick={activate}
          className={`atlas-transition flex size-11 flex-col items-center justify-center gap-0.5 rounded-nav border bg-chrome-inset ${BORDER[view.tone]}`}
        >
          {dot}
          {view.conflictCountText || view.pendingCountText ? (
            <span className="font-num text-[11px] leading-none text-ink-1">
              {view.conflictCountText
                ? model.conflictCount
                : model.pendingCount}
            </span>
          ) : null}
        </button>
      </Tooltip>
    );
  }

  if (variant === "rail") {
    return (
      <button
        type="button"
        aria-label={name}
        data-sync-tone={view.tone}
        onClick={activate}
        className={`atlas-transition flex w-full items-center gap-[9px] rounded-nav border bg-chrome-inset px-2.5 py-2.5 text-left ${BORDER[view.tone]}`}
      >
        {dot}
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-[13px] font-medium text-ink-1">
            {view.label}
          </span>
          {view.detail ? (
            <span className="font-num text-[11px] text-ink-2">
              {view.detail}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  // Top bar and in-dialog: the compact, one-line pill.
  return (
    <button
      type="button"
      aria-label={name}
      data-sync-tone={view.tone}
      onClick={activate}
      className={`atlas-transition inline-flex min-h-11 min-w-0 items-center gap-[7px] rounded-nav border bg-raised px-2.5 py-1.5 text-left ${
        view.tone === "ok" || view.tone === "muted"
          ? "border-hairline-strong"
          : BORDER[view.tone]
      }`}
    >
      {dot}
      <span className="text-[12px] font-medium text-ink-1">
        {view.compactLabel}
      </span>
    </button>
  );
}

/**
 * Reports changes through the announcer, once per animation frame: polite on a phase or count change,
 * assertive only when the conflict count increases (accessibility.md 1.4). Never on first render.
 */
export function SyncAnnouncements({ model }: { model: SyncStatusModel }) {
  const { announce } = useAnnouncer();
  const announced = useRef<SyncStatusModel>(model);
  const latest = useRef<SyncStatusModel>(model);
  const frame = useRef<number | undefined>(undefined);
  latest.current = model;

  useEffect(() => {
    if (frame.current !== undefined) return;
    const prior = announced.current;
    if (
      prior.phase === model.phase &&
      prior.pendingCount === model.pendingCount &&
      prior.conflictCount === model.conflictCount
    ) {
      return;
    }
    frame.current = window.requestAnimationFrame(() => {
      frame.current = undefined;
      const next = latest.current;
      const before = announced.current;
      announced.current = next;
      const view = describeSyncChip(next);
      if (next.conflictCount > before.conflictCount) {
        announce(
          `${view.conflictCountText ?? ""}. ${view.phaseLabel}.`,
          "assertive",
        );
        return;
      }
      const parts: string[] = [];
      if (next.phase !== before.phase) parts.push(view.phaseLabel);
      if (
        next.pendingCount !== before.pendingCount ||
        next.conflictCount !== before.conflictCount
      ) {
        parts.push(
          view.pendingCountText ??
            view.conflictCountText ??
            "Nothing waiting to send",
        );
      }
      if (parts.length > 0) announce(`${parts.join(". ")}.`);
    });
  }, [model, announce]);

  useEffect(
    () => () => {
      if (frame.current !== undefined)
        window.cancelAnimationFrame(frame.current);
    },
    [],
  );
  return null;
}
