import type { EnqueueRequest } from "../model/outbox";
import { type DraftEvidence, readDraftEvidence } from "../plans/draft-header";
import type { DataEnv } from "./env";
import type { Stage } from "./scan";

export type { DraftEvidence };

/**
 * What is stored now under a save whose answer was lost (WEB-10b revision 3, D1; `readDraftEvidence`), read in the database the save was
 * issued to (`scope`, its incarnation): evidence from any other database (the account's data wiped and recreated, another service) is no
 * evidence, and neither is a read that failed or whose service changed under it. Read only: whatever it answers, nothing is written.
 */
export async function readSaveEvidence(
  env: Pick<DataEnv, "service">,
  save: { localId: string; request: EnqueueRequest; scope: string | null },
): Promise<Stage<DraftEvidence>> {
  const service = env.service();
  if (service === null || service.incarnationId !== save.scope)
    return { ok: false, why: "closed" };
  try {
    const evidence = await service.store.run(readDraftEvidence, {
      incarnationId: service.incarnationId,
      localId: save.localId,
      request: save.request,
    });
    if (env.service() !== service) return { ok: false, why: "closed" };
    return { ok: true, value: evidence };
  } catch {
    return { ok: false, why: env.service() === service ? "failed" : "closed" };
  }
}
