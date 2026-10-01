import type { CapabilityIssue } from "../../app/capabilities";
import type { NeutralStateId } from "./neutral-state";
import type { AccountId, Epoch, SessionId } from "./types";

/**
 * Names the renewed-consent prompt a person is looking at, so that their choice is applied to THAT prompt and to no other.
 * It is opaque: it carries no account identifier, and only the page that minted it can resolve it (a ticket that the page
 * no longer holds, because the prompt was resolved or replaced, refuses the choice and the prompt is re-derived).
 */
export type ConsentTicket = string & {
  readonly __consentTicket: unique symbol;
};

/** What to render. Carries no account data (a count of changes at most, and the opaque ticket of the prompt). */
export type SessionView =
  | { kind: "booting" }
  | {
      kind: "incompatible";
      issues: readonly CapabilityIssue[];
      api: ApiCompatibility;
    }
  | { kind: "signed_out"; state: NeutralStateId | null }
  | {
      kind: "neutral";
      state: NeutralStateId;
      consent?: { count: number; ticket: ConsentTicket };
    }
  | { kind: "displaying"; account_id: AccountId; epoch: Epoch };

export type ApiCompatibility =
  | { status: "unknown" }
  | { status: "supported"; version: string }
  | { status: "unsupported"; version: string; supported: string }
  | { status: "missing" }
  | { status: "unreachable" };

/**
 * The settled identity as a FACT for consumers (the drafts store keys its database by it). NOT a permission:
 * never decide to send, render or write on it (matrix G3, 3.6.2 "Nothing is cached").
 */
export interface Identity {
  account_id: AccountId;
  epoch: Epoch;
  session_id: SessionId;
}
