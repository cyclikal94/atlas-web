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
}): (ctx: ContinuationContext) => Promise<void>;
