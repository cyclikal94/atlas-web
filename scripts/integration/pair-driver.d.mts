import type { Attempt, createLedger, Persisted } from "./pair-attempts.mjs";

export interface Milestone {
  revision: number;
  source: string;
}
export interface Target {
  revisions: number[];
  through: number | null;
  sources: Milestone[];
}
export function createTarget(first: Milestone): Target;
export function addMilestone(target: Target, milestone: Milestone): Target;
export type Role = "target" | "incidental" | "other" | "unrelated";
export function roleOf(
  record: {
    status: number | null;
    batches?: number | null;
    revision?: number | null;
    last_revision?: number | null;
  },
  target: Pick<Target, "revisions">,
): Role;
export interface ChainModel {
  cursor: string;
  boundary: string | null;
  stage: { revision: number; next_index: number } | null;
  activated: number | null;
  restarted: number;
  /** The client's W1 commits since the interval began. */
  pages?: number;
}
export function phaseOf(
  model: ChainModel,
  target: Target,
  activations: Array<{ revision: number; seq: number }>,
): "awaiting" | "receiving" | "between_milestones" | "after_activation";
export function advance<R>(model: ChainModel, r: R): ChainModel;

interface ProxyEntryLike {
  id: number;
  method: string;
  path: string;
  rule?: string;
  events: Array<{ event: string }>;
}
export interface OpeningIo<S> {
  addRule(): Promise<{ id: string }>;
  proxyLog(): Promise<ProxyEntryLike[]>;
  held(ruleId: string): Promise<number[]>;
  releaseOne(
    ruleId: string,
    id: number,
  ): Promise<{ outcomes?: Array<{ outcome: string | null }> }>;
  label(label: string | null): Promise<number>;
  tapRecords(): Promise<Array<{ seq: number; proxy_id?: number | null }>>;
  quietNow(): Promise<S | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface Opening<S> {
  ruleId: string;
  since: number;
  rounds: number;
  released: Array<{ round: number; proxy_id: number; outcome: string | null }>;
  quiet: S;
}
export function openHold<S>(
  io: OpeningIo<S>,
  options: { label: string; maxWaitMs?: number },
): Promise<Opening<S>>;

export interface StoredLike {
  cursor: string | null;
  applied_revision: number | null;
  page_seq: number | null;
  composition_seq: number;
  delta_stage: { next_index: number } | null;
  staged: number;
  drafts: number;
  cache_digest: string;
  cache_count: number;
}
export interface DriveIo<R, S extends StoredLike> {
  held(ruleId: string): Promise<number[]>;
  records(): Promise<R[]>;
  read(): Promise<S>;
  release(
    ruleId: string,
    proxyId: number,
  ): Promise<{
    released: number;
    outcomes?: Array<{ id: number; outcome: string | null }>;
  }>;
  nudge(): Promise<unknown>;
  waitFor(
    predicate: (s: S) => boolean,
    what: string,
    options?: { rows?: boolean },
  ): Promise<S>;
  barrier(name: string, detail?: unknown): Promise<void> | void;
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface Piece {
  revision: number;
  index: number;
  last: boolean;
  /** The valid next piece of the current chain (index 0 without a stage of this revision). */
  next: boolean;
}
export interface HeldStep<R, S> {
  record: R;
  model: ChainModel;
  before: S;
  /** The attempt's ordinal: never a piece's identity. */
  index: number;
  piece: Piece | null;
  role: Role;
  phase: string;
  target: { revisions: number[]; through: number | null };
  /** Releases the held answer NOW (a hook that navigates the page away first, so the answer reaches nobody). */
  release(): Promise<void>;
  /** A later milestone of the workload (A1's revocation receipt). */
  addMilestone(m: Milestone): void;
  /** Revision 27 (C4): the case's admitted local work (only when the drive was started with `localWork: true`). */
  declareLocalWork(work: {
    drafts: number;
    composition_seq: number;
    reason: string;
  }): void;
}
export interface HookAnswer {
  /** false: the held answer must not reach the client (the hook reloaded or closed the page); it is released to nobody. */
  delivered?: boolean;
  /** Stop driving: the case continues by itself (a 410 recovery, a replaced session). */
  stop?: boolean;
  reason?: string;
}
export interface Driven<R, S> {
  model: ChainModel;
  /** The answers the client RECEIVED, in order; `target` and `incidental` are their two views (every answer stays in `steps`). */
  steps: R[];
  target: R[];
  incidental: R[];
  attempts: Attempt[];
  goal: { revisions: number[]; through: number | null };
  sources: Milestone[];
  activations: Array<{ revision: number; seq: number }>;
  final: S | null;
  stoppedAt: R | null;
  handOff: { at_seq: number; reason: string } | null;
  terminal: { final_seq: number; activated_by_seq: number } | null;
}
/** Revision 39 (R39-DIAG): an identity-aware choice of the next held answer (pair-schedule.mjs `refusalPair`); default `pickHeld`. */
export interface HeldSelection<R> {
  pick(heldIds: number[], records: R[]): { record: R; proxyId: number } | null;
  waiting?(): string;
}
export function drive<R, S extends StoredLike>(
  io: DriveIo<R, S>,
  options: {
    ruleId: string;
    base: S;
    model: ChainModel;
    start: () => Promise<Milestone>;
    onHeld?: (step: HeldStep<R, S>) => Promise<HookAnswer | undefined>;
    ledger?: ReturnType<typeof createLedger>;
    maxSteps?: number;
    heldTimeoutMs?: number;
    localWork?: boolean;
    select?: HeldSelection<R>;
  },
): Promise<Driven<R, S>>;
export type { Attempt, Persisted };
