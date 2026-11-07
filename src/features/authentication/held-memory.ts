import { holdUnrestorable } from "../../lib/form-recovery/activity";
import { invitationMemory } from "./handoff";
import { signInRequest } from "./sign-in-request";

/**
 * PAGE MEMORY AN UPDATE RELOAD MUST NOT OVERTAKE (WEB-14a revision 39, R40-COMPOSITION; revision 40, review of revision 39, R40-GATE; design
 * assessment ae2a506e… C2). What the page knows after a Join submission (spent, unusable after submitting, an earlier link's outcome) and
 * a username carried into sign-in from Join live in page memory only (`invitationMemory`, `signInRequest`): no reload brings them back, so
 * an app update does not reload over them while they last (`holdUnrestorable`).
 *
 * Revision 39 held them from the surfaces' effects, so the gate that unmounts the join page between the redemption and the activation
 * released the guidance while it was still needed, and a passive effect left a moment with nothing held. The holds now follow the memory
 * itself, for the page's life: each is taken or released inside the memory's own change (a listener of the store, called synchronously as
 * it publishes), whichever surface is mounted. The guidance hands its username to the sign-in request with no moment unheld. Loaded with the
 * authentication surfaces (the only code that changes this memory), never in the first load's chunk where the stores themselves live.
 */
function follow(
  name: string,
  needed: () => boolean,
  subscribe: (listener: () => void) => () => void,
): void {
  let release: (() => void) | null = null;
  const sync = (): void => {
    if (needed()) release ??= holdUnrestorable(name);
    else if (release) {
      const go = release;
      release = null;
      go();
    }
  };
  subscribe(sync);
  sync();
}

follow(
  "join-outcome",
  () =>
    invitationMemory.get().kind === "spent" ||
    invitationMemory.unusable() !== null ||
    invitationMemory.earlier() !== null,
  invitationMemory.subscribe,
);
follow(
  "sign-in-request",
  () => {
    const request = signInRequest.get();
    return request.requested && request.username !== "";
  },
  signInRequest.subscribe,
);
