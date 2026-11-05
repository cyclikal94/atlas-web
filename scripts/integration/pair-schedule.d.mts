// Revision 28 (R28-DIAG.a): the shared schedule of the real-410 diagnostic cases (pair-schedule.mjs).
export interface ContinuationContext<H = Record<string, unknown>> {
  readonly token: string;
  readonly header: Readonly<H>;
}
export const UNCHANGED_BY_CLOCK: readonly string[];
export function continuationOf<H>(
  record: { seq?: number; next_cursor?: unknown } | null | undefined,
  headerOf: (token: string) => H,
): ContinuationContext<H>;
export function queueContinuation<H>(
  io: {
    headerOf(token: string): H;
    gate(open: boolean): Promise<unknown>;
    release(): Promise<void>;
    untilStored(ctx: ContinuationContext<H>): Promise<unknown>;
    untilGated(ctx: ContinuationContext<H>): Promise<unknown>;
    /** Revision 39: the gated request `untilGated` resolved with, before the control (XL0's departed request, `refusalPair`). */
    queued?(request: unknown, ctx: ContinuationContext<H>): unknown;
  },
  record: { seq?: number; next_cursor?: unknown },
  control: (ctx: ContinuationContext<H>) => Promise<void>,
): Promise<ContinuationContext<H>>;
export function expiryControl<H extends { expiry: number }>(
  io: {
    receipt: { sync_start: number; retention_seconds: number };
    diagnostic(
      op: string,
      args?: Record<string, unknown>,
    ): Promise<{ seq: number; result: Record<string, unknown> }>;
    probeAt(label: string, token: string): Promise<{ status: number }>;
    sessionLive(): Promise<{ status: number }>;
    controls: Record<string, number>;
    probes: Record<string, unknown>;
  },
  hooks?: {
    beforeInspect?: (ctx: ContinuationContext<H>) => Promise<void>;
    afterE?: (ctx: ContinuationContext<H>) => Promise<void>;
  },
): (ctx: ContinuationContext<H>) => Promise<void>;
export function reloadedRequest<
  R extends {
    label?: string | null;
    gated?: boolean | null;
    query?: { cursor?: string | null } | null;
    j_request?: number | null;
  },
>(records: R[], o: { label: string; token: string; begin: number }): R | null;
export function reloadHook<S extends { cursor: string | null }>(io: {
  mark(name: string): Promise<number>;
  beforeReload(): Promise<void>;
  reload(): Promise<void>;
  records(): Promise<
    Array<{
      label?: string | null;
      gated?: boolean | null;
      query?: { cursor?: string | null } | null;
      j_request?: number | null;
    }>
  >;
  stored(): Promise<S>;
  until(
    read: () => Promise<S | null>,
    accept: (s: S) => boolean,
    what: string,
  ): Promise<S>;
  label: string;
  after(s: S): Promise<void>;
  /** Revision 39: the reloaded page's own request, while the gate is still closed (XL0's live request, `refusalPair`). */
  reloaded?(
    request: unknown,
    at: { begin: number; ctx: ContinuationContext },
  ): unknown;
}): (ctx: ContinuationContext) => Promise<void>;

/** Revision 39 (R39-DIAG): one bound request of the pair. */
export interface BoundRequest {
  readonly seq: number;
  readonly proxy_id: number;
  readonly j_request: number;
}
export interface RefusalRecord {
  seq: number;
  proxy_id?: number | null;
  status?: number | null;
  code?: string | null;
  delivered?: unknown;
  dropped?: unknown;
}
/** Revision 39 (R39-DIAG): XL0's departed and live refusals, bound by identity and handled in that order (pair-schedule.mjs). */
export function refusalPair<R extends RefusalRecord>(o: {
  label: string;
}): {
  select: {
    pick(
      heldIds: number[],
      records: R[],
    ): { record: R; proxyId: number } | null;
    waiting(): string;
  };
  queued(request: unknown, ctx: ContinuationContext<unknown>): void;
  reloaded(
    request: unknown,
    at: { begin: number; ctx: ContinuationContext<unknown> },
  ): void;
  bound(): {
    readonly label: string;
    readonly departed: BoundRequest;
    readonly live: BoundRequest;
    readonly reload_begin: number;
  } | null;
  answer(
    step: { record: R; release(): Promise<void> },
    hooks: {
      lost?: (record: R) => unknown;
      live: (record: R) => Promise<unknown>;
    },
  ): Promise<{ delivered: false } | { stop: true; reason: string } | undefined>;
};
