import type { ResourceId } from "../model/types";
import { type MergedUnder, readMergedUnder } from "../plans/merged-under";
import type { Loadable } from "../store/port";
import { useWatch } from "./react";

/** A resource and its parent (`parentId`, else the one it names) as ONE read saw them (`readMergedUnder`, WEB-11a review 16). */
export function useMergedUnder(
  id: ResourceId,
  parentId?: ResourceId,
): Loadable<MergedUnder> {
  return useWatch(
    (env) => {
      const service = env.service();
      return service
        ? service.store.watch(readMergedUnder, {
            incarnationId: service.incarnationId,
            id,
            ...(parentId === undefined ? {} : { parentId }),
          })
        : null;
    },
    [id, parentId],
  );
}
