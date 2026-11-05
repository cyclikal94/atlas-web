import { readPlan } from "./builders";

/**
 * The server revision the cache has applied (`sync_state.applied_revision`, WEB-11a finding 8): it moves exactly when a page of
 * synced changes for this account is committed (a page with no batch leaves it), from this page or another. The People screens re-read
 * their online summaries when it moves, because the contract asks for a re-read on ANY synced person or field change; a change of
 * another kind moves it too, which only re-reads more often than needed. READONLY; null before the first applied page.
 */
export const readAppliedRevision = readPlan<
  { incarnationId: string },
  null,
  number | null
>({
  name: "data.readAppliedRevision",
  scope: [],
  read: async () => null,
  decide: ({ sync }) => sync?.applied_revision ?? null,
});
