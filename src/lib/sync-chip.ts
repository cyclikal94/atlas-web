/**
 * Presentation contract for the persistent sync/offline status control. WEB-09 owns the logic that derives
 * SyncStatusModel from the sync engine; WEB-07 owns how it reads. Two independent axes, never collapsed:
 * the inbound cache phase and the outbound counts (ia.md 1.3.1). Wording is the accepted design copy deck.
 *
 * Phase priority is Offline, then Resyncing, then Sync interrupted, then Synced. The destination is
 * Conflicts whenever any conflict is open, otherwise the queue, whatever the phase. Q24: recovery starts
 * automatically and reads "Resyncing", so this module has no unacknowledged-recovery state.
 */

export type SyncPhase = "offline" | "resyncing" | "interrupted" | "synced";
export interface SyncStatusModel {
  phase: SyncPhase;
  pendingCount: number;
  conflictCount: number;
  /** ISO 8601 instant of the last completed catch-up. Absent or invalid means "not known". */
  lastSyncedAt?: string;
}
export type ChipDestination = "conflicts" | "queue";
export type ChipTone = "ok" | "busy" | "warn" | "error" | "muted";
export type ChipVariant = "rail" | "rail-collapsed" | "topbar" | "dialog";

export interface SyncChipView {
  destination: ChipDestination;
  tone: ChipTone;
  /** The inbound axis alone, for the queue and conflict screens: "Receiving updates: up to date". */
  phaseLabel: string;
  /** Primary line: counts win over the phase headline. */
  label: string;
  /** Secondary line, when there is something further to say. */
  detail?: string;
  /** One-line form for the top bar and the in-dialog chip. */
  compactLabel: string;
  /** Accessible name of the full (rail) form: states both status and action. */
  accessibleName: string;
  conflictCountText?: string;
  pendingCountText?: string;
}

const HEADLINE: Record<SyncPhase, string> = {
  synced: "Up to date",
  resyncing: "Catching up",
  interrupted: "Updates stopped",
  offline: "Offline",
};
const PHASE_LABEL: Record<SyncPhase, string> = {
  synced: "Receiving updates: up to date",
  resyncing: "Receiving updates: catching up",
  interrupted: "Receiving updates: stopped",
  offline: "Receiving updates: offline",
};

/** Counts can be large; the accepted copy says "N needs a decision" and "N waiting to send". */
function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function formatSyncedAgo(
  lastSyncedAt: string | undefined,
  now: Date,
): string | undefined {
  if (!lastSyncedAt) return undefined;
  const then = Date.parse(lastSyncedAt);
  if (Number.isNaN(then)) return undefined;
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 0) return undefined;
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.floor(hours / 24)}d ago`;
}

export function describeSyncChip(
  model: SyncStatusModel,
  now: Date = new Date(),
): SyncChipView {
  const conflicts = count(model.conflictCount);
  const pending = count(model.pendingCount);
  const destination: ChipDestination = conflicts > 0 ? "conflicts" : "queue";

  let tone: ChipTone;
  if (conflicts > 0) tone = "error";
  else if (model.phase === "interrupted") tone = "warn";
  else if (model.phase === "resyncing") tone = "busy";
  else if (model.phase === "offline") tone = "muted";
  else tone = pending > 0 ? "busy" : "ok";

  const conflictCountText =
    conflicts > 0 ? `${conflicts} needs a decision` : undefined;
  const pendingCountText =
    pending > 0 ? `${pending} waiting to send` : undefined;
  const headline = HEADLINE[model.phase];
  const phaseLabel = PHASE_LABEL[model.phase];

  const label = conflictCountText ?? pendingCountText ?? headline;
  let detail: string | undefined;
  if (conflictCountText || pendingCountText) {
    // A second count, when both exist, then the inbound axis so neither is lost.
    detail = [
      conflictCountText && pendingCountText ? pendingCountText : undefined,
      phaseLabel,
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (model.phase === "synced") {
    detail = formatSyncedAgo(model.lastSyncedAt, now);
  }

  const compactParts = [
    model.phase === "synced" ? undefined : headline,
    conflictCountText ?? pendingCountText,
  ].filter((part): part is string => Boolean(part));
  const compactLabel =
    compactParts.length > 0 ? compactParts.join(" · ") : headline;

  const action =
    destination === "conflicts" ? "Open conflicts." : "Open sync queue.";
  const accessibleName = `${[label, detail].filter(Boolean).join(", ")}. ${action}`;

  return {
    destination,
    tone,
    phaseLabel,
    label,
    detail,
    compactLabel,
    accessibleName,
    conflictCountText,
    pendingCountText,
  };
}

/** Accessible name for a compact variant: it must contain exactly the text that is visible. */
export function accessibleNameFor(
  view: SyncChipView,
  variant: ChipVariant,
): string {
  if (variant === "rail" || variant === "rail-collapsed")
    return view.accessibleName;
  const action =
    view.destination === "conflicts" ? "Open conflicts." : "Open sync queue.";
  return `${view.compactLabel}. ${action}`;
}
