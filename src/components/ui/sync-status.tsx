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
  ok: "bg-success",
  busy: "bg-primary",
  warn: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground",
};
/** A non-healthy state adds a state-coloured border. It is a supplementary cue: text and the dot carry the state. */
const BORDER: Record<ChipTone, string> = {
  ok: "border-border",
  busy: "border-primary/40",
  warn: "border-warning/50",
  error: "border-destructive/50",
  muted: "border-border",
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
  // The dot pulses (motion-safe) only while something is happening: busy is the one tone that means activity.
  const dot = (
    <span
      aria-hidden="true"
      className={`size-[7px] flex-none rounded-full ${DOT[view.tone]} ${
        view.tone === "busy" ? "animate-pulse" : ""
      }`}
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
              <span className="block text-muted-foreground">{view.detail}</span>
            ) : null}
          </>
        }
      >
        <button
          type="button"
          aria-label={name}
          data-sync-tone={view.tone}
          onClick={activate}
          className={`atlas-transition flex size-11 flex-col items-center justify-center gap-0.5 rounded-md border bg-card shadow-xs hover:bg-accent ${BORDER[view.tone]}`}
        >
          {dot}
          {view.conflictCountText || view.pendingCountText ? (
            <span className="font-num text-xs leading-none text-foreground">
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
        className={`atlas-transition flex w-full items-center gap-2.5 rounded-md border bg-card px-3 py-2.5 text-left shadow-xs hover:bg-accent ${BORDER[view.tone]}`}
      >
        {dot}
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-sm font-medium text-foreground">
            {view.label}
          </span>
          {view.detail ? (
            <span className="font-num text-xs text-muted-foreground">
              {view.detail}
            </span>
          ) : null}
        </span>
      </button>
    );
  }

  // In a dialog, and in the phone's top bar, a control that is up to date is a quiet dot (its name still says so): the header is the
  // title's, and the pill grows its words only while it has something to say (offline, sending, waiting, a decision). The Final design,
  // 8 November 2026. The sidebar keeps the full chip.
  if ((variant === "dialog" || variant === "topbar") && view.tone === "ok")
    return (
      <button
        type="button"
        aria-label={name}
        data-sync-tone={view.tone}
        data-sync-quiet=""
        onClick={activate}
        className="atlas-transition flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        {dot}
      </button>
    );
  // Top bar and in-dialog: the compact, one-line pill.
  return (
    <button
      type="button"
      aria-label={name}
      data-sync-tone={view.tone}
      onClick={activate}
      className={`atlas-transition inline-flex min-h-11 min-w-0 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-left shadow-xs hover:bg-accent ${BORDER[view.tone]}`}
    >
      {dot}
      <span className="text-xs font-medium text-foreground">
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
