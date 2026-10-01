import type { IsoInstant } from "../model/types";

/** Wall-clock values are timestamps and display only; nothing is ordered by them (D-09, EC-47). */
export interface Clock {
  now(): number;
  iso(): IsoInstant;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** `AbortSignal.timeout` in production; driven by fake time in tests. */
  abortAfter(ms: number): AbortSignal;
}

export interface Ids {
  /** `crypto.randomUUID()`: canonical lower-case. */
  uuid(): string;
  /** 32 random octets, base64url (43 characters). */
  verifier(): string;
  /** base64url(SHA-256(ASCII(verifier))), RFC 7636 4.2. */
  challenge(verifier: string): Promise<string>;
}
