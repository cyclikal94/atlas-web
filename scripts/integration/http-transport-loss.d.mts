export interface TransportRoute {
  name: string;
  /** The path prefix (`/api/`, `/__transport/`, `/`). */
  prefix: string;
  /** The loopback origin that receives the request. */
  target: string;
  /** Released-backend lane: the public origin presented in place of the front's own `Origin` header. */
  presentOrigin?: string;
}
export interface TransportStamp {
  generation: number;
  phase: "online" | "loss";
  nonce: string | null;
}
export interface TransportAttempt extends TransportStamp {
  seq: number;
  method: string | undefined;
  url: string | undefined;
  at: number;
  outcome:
    | "pending"
    | "malformed"
    | "lost"
    | "refused"
    | "forwarded"
    | "connect_refused"
    | "closed";
  route?: string;
  status?: number;
  completed?: boolean;
  upstreamError?: string;
  clientClosed?: boolean;
  interruptedAtLoss?: number;
  originPresented?: string;
}
export interface LossRecord {
  to: "loss";
  generation: number;
  nonce: string;
  enforce: boolean;
  at: number;
  interrupted: TransportAttempt[];
}
export interface RestoreRecord {
  to: "online";
  generation: number;
  at: number;
}
export interface Transport {
  start(): Promise<string>;
  readonly url: string | null;
  /** What the front still owns (revision 19): client sockets, forwarded requests not yet closed with their sockets, listening. */
  owned(): { clientSockets: number; upstreams: number; listening: boolean };
  stamp(): TransportStamp;
  readonly phase: "online" | "loss";
  readonly generation: number;
  attempts: TransportAttempt[];
  transitions: Array<LossRecord | RestoreRecord>;
  interrupted: TransportAttempt[];
  inFlight(): number;
  lose(options?: { enforce?: boolean }): Promise<LossRecord>;
  restore(): Promise<RestoreRecord>;
  close(): Promise<Error | null>;
}
export function createTransport(options: {
  routes: TransportRoute[];
  /** Called synchronously as each attempt is recorded (the lane's journal ordering); never changes an outcome. */
  observe?: (attempt: TransportAttempt) => void;
  /** Harness bound on joining owned sockets/requests at a loss entry or close (default 10,000 ms). */
  joinBoundMs?: number;
}): Transport;

/** An outgoing request this process owns, tracked until the request and its socket have closed (revision 19). */
export interface OwnedUpstream {
  request: import("node:http").ClientRequest;
  socket: import("node:net").Socket | null;
  requestClosed: boolean;
  socketClosed: boolean;
  requestDone: Promise<void>;
  socketDone: Promise<void> | null;
  done(): Promise<unknown>;
  readonly open: boolean;
}
export function ownUpstream(
  request: import("node:http").ClientRequest,
): OwnedUpstream;
export function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean>;

export interface WitnessReceipt extends Partial<TransportStamp> {
  method: string | undefined;
  path: string;
  nonce: string | null;
  at: number;
}
export interface WitnessOrigin {
  start(): Promise<string>;
  readonly url: string | null;
  receipts: WitnessReceipt[];
  options: {
    answer: ((nonce: string) => { status: number; body: string } | null) | null;
  };
  /** What it still owns (revision 20): its lifecycle state, listener and connections. */
  owned(): {
    state: "new" | "starting" | "listening" | "closing" | "closed";
    listening: boolean;
    connections: number;
  };
  /** Idempotent; joins a start in progress and every connection; resolves null or an Error naming what stayed open (revision 20). */
  close(): Promise<Error | null>;
}
export function createWitnessOrigin(options?: {
  stamp?: () => TransportStamp;
  /** Harness bound on joining its connections and closing its listener (default 10,000 ms). */
  closeBoundMs?: number;
}): WitnessOrigin;
