import type { GuardName } from "../model/guards";
import type { StoreName } from "../model/schema";
import type { Plan } from "../store/port";

/**
 * The plan registry (plan 5.2.4, lint rule R18). Every transaction plan of the data layer is registered here with its writer
 * number (W1 to W19), the guards it applies and whether the quota reserve applies. A boundary test enumerates the registry and
 * fails if any plan is absent from the plan's writer inventory or lists FEWER guards than the inventory does, so adding a
 * writer without a stated guard set fails the build.
 */
export type QuotaClass = "cache" | "input" | null;

export interface PlanMeta {
  /** `W1` ... `W19` of plan 5.2.4. */
  writer: string;
  guards: readonly GuardName[];
  /** `cache`: refuses first; `input`: refuses last; `null`: the quota reserve does not apply. */
  quota: QuotaClass;
}
export interface PlanEntry extends PlanMeta {
  name: string;
  scope: readonly StoreName[];
  mode: "readonly" | "readwrite";
  durability: "strict" | "default";
}

const entries = new Map<string, PlanEntry>();

/** Registers a plan and returns it unchanged. Two plans may not share a name. */
export function registerPlan<P extends Plan<never, never, unknown>>(
  plan: P,
  meta: PlanMeta,
): P {
  if (entries.has(plan.name))
    throw new Error(`the plan ${plan.name} is registered twice`);
  entries.set(plan.name, {
    name: plan.name,
    scope: plan.scope,
    mode: plan.mode,
    durability: plan.durability,
    ...meta,
  });
  return plan;
}

export const listPlans = (): readonly PlanEntry[] => [...entries.values()];

/**
 * Plans that only READ (a queue summary, a merged resource, the dispatcher's window). They are not writers, so they are not part
 * of the W1 to W19 inventory; they are listed here so a test can assert that each is `readonly`, declares its scope, and writes
 * nothing.
 */
const readEntries = new Map<
  string,
  Pick<PlanEntry, "name" | "scope" | "mode" | "durability">
>();

export function registerReadPlan<P extends Plan<never, never, unknown>>(
  plan: P,
): P {
  if (readEntries.has(plan.name) || entries.has(plan.name))
    throw new Error(`the plan ${plan.name} is registered twice`);
  readEntries.set(plan.name, {
    name: plan.name,
    scope: plan.scope,
    mode: plan.mode,
    durability: plan.durability,
  });
  return plan;
}

export const listReadPlans = (): ReadonlyArray<
  Pick<PlanEntry, "name" | "scope" | "mode" | "durability">
> => [...readEntries.values()];
