import type {
  AccountId,
  Epoch,
  LeaseId,
  ObservationKind,
} from "../model/types";

/** A hint, never evidence: a receiver ignores the payload's authority and re-reads `auth_state` (matrix 3.3). */
export type Hint =
  | { type: "auth_state_changed" }
  | {
      type: "observation";
      obs_id: string;
      lease_id: LeaseId;
      account_id: AccountId;
      stamp_epoch: Epoch;
      kind: ObservationKind;
    }
  | { type: "lease"; lease_id: LeaseId; account_id: AccountId };

export interface HintChannel {
  post(hint: Hint): void;
  subscribe(listener: (hint: Hint) => void): () => void;
}
