import type { DraftRow } from "../model/types";
import { readDraftHeader } from "../plans/draft-header";
import type { DataEnv } from "./env";
import type { Stage } from "./scan";

/**
 * The draft stored under `localId` NOW (its header), or null when none is (WEB-10b revision 2, R2): exact evidence that a save made under
 * that id was stored, for a caller whose answer was lost. Null is not proof that none ever was (see `readDraftHeader`); a failed read, or
 * a database that changed under it, is no answer at all.
 */
export async function readDraftNow(
  env: Pick<DataEnv, "service">,
  localId: string,
): Promise<Stage<DraftRow | null>> {
  const service = env.service();
  if (service === null) return { ok: false, why: "closed" };
  try {
    const draft = await service.store.run(readDraftHeader, {
      incarnationId: service.incarnationId,
      localId,
    });
    if (env.service() !== service) return { ok: false, why: "closed" };
    return { ok: true, value: draft };
  } catch {
    return { ok: false, why: env.service() === service ? "failed" : "closed" };
  }
}
