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
    | "connect_refused";
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
}): Transport;

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
  close(): Promise<Error | null>;
}
export function createWitnessOrigin(options?: {
  stamp?: () => TransportStamp;
}): WitnessOrigin;
