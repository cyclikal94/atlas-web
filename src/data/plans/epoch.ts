import { publishEpoch as nextStamp } from "../model/guards";
import { singletonPlan } from "./builders";

/**
 * W15: publish the epoch mirror (`sync_state.stamp.epoch`, plan 5.2.2 G3-EPO). Monotone `max`, so whichever page FIRST learns of
 * a new epoch of the account protects every page's later commits: a response decoded under an older epoch is then dropped by
 * the guard of whichever page applies it. A tiny `strict` transaction; it is not response-derived, so it needs only the
 * incarnation of the handle it holds (a page of another incarnation must not write into a re-created database).
 */
export const publishEpochPlan = singletonPlan<
  { incarnationId: string; epoch: number },
  null,
  { published: boolean }
>({
  name: "data.publishEpoch",
  meta: { writer: "W15", guards: ["INC"], quota: null },
  scope: [],
  durability: "strict",
  read: async () => null,
  decide: ({ sync, input }) => {
    if (sync === undefined || sync.incarnation_id !== input.incarnationId)
      return { result: { published: false } };
    const stamp = nextStamp(sync, input.epoch);
    if (stamp === null) return { result: { published: false } };
    return { sync: { ...sync, stamp }, result: { published: true } };
  },
});
