import { digestOf } from "./canonical";
import type {
  CacheRow,
  DraftRow,
  ResourceId,
  ResourceVersionRow,
} from "./types";

/**
 * What a caller SAW of one resource, as one token (WEB-13a revision 2, the design assessment's invariant 4): the database incarnation,
 * the cached row, the outbox's version record of the resource, and every draft that names it (`index_targets`) with its identity,
 * status, body digest, place and dependencies. A screen reads it in the SAME read transaction as the values it shows
 * (`readResourceView`), and a save that states it (`EnqueueRequest.observed`) is written only when the enqueue or supersede
 * transaction, reading the same facts, finds the same token: values captured from one state are never paired with a version, a base
 * or a dependency chain chosen from a later one. A body edited without a version change, a status change, another tab's save, a
 * publication or a removal all change it.
 *
 * It is CONSERVATIVE: a harmless change (a draft claimed for sending) also changes it, and the save is refused rather than judged.
 * It never accepts a change of anything it covers. The fold is a chain of SHA-256 digests, one per draft, so a population of any size
 * is reduced as it is walked and nothing is held but the chain.
 */
export interface Observation {
  resourceId: ResourceId;
  token: string;
}

/** JSON as it is stored and compared: `undefined` members dropped (a structured clone keeps them, canonical JSON has none). */
const plain = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

export class ObservationFold {
  private chain: string;
  private count = 0;

  constructor(
    incarnationId: string,
    id: ResourceId,
    base: CacheRow | undefined,
    version: ResourceVersionRow | undefined,
  ) {
    this.chain = digestOf([incarnationId, id, plain(base), plain(version)]);
  }

  /** One draft whose `index_targets` names the resource, in the order the index returns them (the same in every transaction). */
  add(row: DraftRow): void {
    this.count += 1;
    this.chain = digestOf([
      this.chain,
      row.local_id,
      row.status,
      row.command_digest,
      row.created_seq,
      row.depends_on,
      row.held_pending_cache,
      row.receipt_revision,
    ]);
  }

  token(): string {
    return `${this.count}:${this.chain}`;
  }
}
