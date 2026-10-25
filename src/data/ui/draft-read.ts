import type { EnqueueRequest } from "../model/outbox";
import type { ResourceId } from "../model/types";
import { type DraftEvidence, readDraftEvidence } from "../plans/draft-header";
import { type ResourceView, readResourceView } from "../plans/pending-reads";
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

/**
 * One resource as ONE read transaction of this page's database sees it NOW (`readResourceView`), with the incarnation it was read in
 * (WEB-10b revision 4, D1 / DA-N1): what a save that depends on the resource is admitted on. The view's `observation` goes with that save
 * (`EnqueueRequest.observed`), so the transaction that writes it refuses (`changed`) when anything it covers moved after this read. A read
 * that failed, or whose service changed under it, is no answer.
 */
export async function readResourceViewNow(
  env: Pick<DataEnv, "service">,
  id: ResourceId,
  kinds: { create?: string } = {},
): Promise<Stage<{ view: ResourceView; scope: string }>> {
  const service = env.service();
  if (service === null) return { ok: false, why: "closed" };
  try {
    const view = await service.store.run(readResourceView, {
      incarnationId: service.incarnationId,
      id,
      ...(kinds.create === undefined ? {} : { createKind: kinds.create }),
    });
    if (env.service() !== service) return { ok: false, why: "closed" };
    return { ok: true, value: { view, scope: service.incarnationId } };
  } catch {
    return { ok: false, why: env.service() === service ? "failed" : "closed" };
  }
}
