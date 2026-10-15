import type { RefreshRun } from "./model/refresh";

/**
 * WHO may say how a source's manual refresh ended, across the refresh controllers of one displayed identity (WEB-13a revision 6, R12;
 * design assessment C1).
 *
 * A refresh controller lives as long as one mounted screen, but its answers do not: an Atlas `403` remounts the protected tree, and the
 * person may leave the screen and press Refresh again on the next one while an earlier press is still out. Controllers cannot order
 * their runs among themselves (each counts its own), so the order is kept here, per source, by ADMISSION:
 *
 *  - Every admitted execution (a press of Refresh, and every "Check again", which reuses the run's `Idempotency-Key`) `claim`s the
 *    source with a NEW ticket before anything is sent. The ticket is local and opaque: it is never the wire key, which "Check again"
 *    deliberately repeats.
 *  - The latest ticket OWNS the source for as long as this registry lives. An older ticket can never publish again: not when the newer
 *    run ends, goes offline, is forgotten or loses its screen, and not when the person leaves the screen. Only the owner's ENDED run is
 *    remembered (`publish`), and only it is shown by a screen built later (`shown`).
 *  - The registry is the identity's (`memory.ts`): another account or a new epoch `revoke`s it, after which no ticket of it owns
 *    anything, so a late answer cannot be shown under the new identity.
 *
 * It holds no form, no secret and no row: only tickets (with the key they were admitted under) and ended runs. Memory only.
 */
export interface RefreshTicket {
  readonly source: string;
  /** The wire key the execution sends under (repeated by "Check again"): kept for the record, never compared for ownership. */
  readonly key: string;
}

export interface RefreshOwnership {
  /** Admits a new execution of `source`: it owns the source from now on, and what was shown for it is cleared. */
  claim(source: string, key: string): RefreshTicket;
  /** Whether `ticket` is still its source's latest admission (and the registry is not revoked). */
  owns(ticket: RefreshTicket): boolean;
  /**
   * Remembers `run` (ENDED, with something to show) as its source's outcome, if `ticket` still owns the source; then tells every
   * listener. Returns whether it was remembered. It performs nothing else: no send, no read, no wait.
   */
  publish(ticket: RefreshTicket, run: RefreshRun): boolean;
  /** The owner's remembered outcome of `source`, or null. */
  shown(source: string): { ticket: RefreshTicket; run: RefreshRun } | null;
  /** Every remembered outcome (a screen built later shows them). */
  outcomes(): ReadonlyArray<{ ticket: RefreshTicket; run: RefreshRun }>;
  /** Clears the owner's remembered outcome after it was seen; the ticket keeps owning the source. */
  clear(ticket: RefreshTicket): void;
  /** Told the source whose remembered outcome was just published. */
  subscribe(listener: (source: string) => void): () => void;
  /** The identity is gone: no ticket owns anything any more, and nothing is remembered or told. Idempotent. */
  revoke(): void;
}

interface Slot {
  owner: RefreshTicket;
  run: RefreshRun | null;
}

export function createRefreshOwnership(): RefreshOwnership {
  const slots = new Map<string, Slot>();
  const listeners = new Set<(source: string) => void>();
  let revoked = false;

  const owns = (ticket: RefreshTicket): boolean =>
    !revoked && slots.get(ticket.source)?.owner === ticket;

  return {
    claim(source, key) {
      const ticket: RefreshTicket = Object.freeze({ source, key });
      if (!revoked) slots.set(source, { owner: ticket, run: null });
      return ticket;
    },
    owns,
    publish(ticket, run) {
      if (!run.ended || run.view === null || !owns(ticket)) return false;
      const slot = slots.get(ticket.source);
      if (slot === undefined) return false;
      slot.run = run;
      for (const listener of [...listeners]) listener(ticket.source);
      return true;
    },
    shown(source) {
      const slot = slots.get(source);
      return revoked || slot === undefined || slot.run === null
        ? null
        : { ticket: slot.owner, run: slot.run };
    },
    outcomes() {
      if (revoked) return [];
      const all: Array<{ ticket: RefreshTicket; run: RefreshRun }> = [];
      for (const slot of slots.values())
        if (slot.run !== null) all.push({ ticket: slot.owner, run: slot.run });
      return all;
    },
    clear(ticket) {
      if (!owns(ticket)) return;
      const slot = slots.get(ticket.source);
      if (slot !== undefined) slot.run = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revoke() {
      revoked = true;
      slots.clear();
      listeners.clear();
    },
  };
}
