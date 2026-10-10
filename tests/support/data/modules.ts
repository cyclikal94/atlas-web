import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as accountService from "../../../src/data/engine/account-service";
import * as guards from "../../../src/data/model/guards";
import * as epochPlans from "../../../src/data/plans/epoch";
import * as fencePlans from "../../../src/data/plans/fence";
import * as retryPlans from "../../../src/data/plans/retry-state";
import * as open from "../../../src/data/store/open";
import * as registry from "../../../src/data/store/registry";

/**
 * The production modules the data-layer fake world runs. The default is `src/`; the mutation harness loads a PATCHED COPY of
 * the tree (`tests/support/data/mutants.ts`) so that a deliberately broken guard can be run through the same scenarios, never
 * the original. Only the modules a scenario's decisions live in are listed: the double of IndexedDB and the world are test
 * support, shared by both.
 */
export const srcDataModules = {
  accountService,
  guards,
  epochPlans,
  fencePlans,
  retryPlans,
  open,
  registry,
};
export type DataModules = typeof srcDataModules;

export async function loadDataModules(root: string): Promise<DataModules> {
  const load = async <T>(relative: string): Promise<T> =>
    (await import(
      /* @vite-ignore */ pathToFileURL(join(root, relative)).href
    )) as T;
  return {
    accountService: await load("src/data/engine/account-service.ts"),
    guards: await load("src/data/model/guards.ts"),
    epochPlans: await load("src/data/plans/epoch.ts"),
    fencePlans: await load("src/data/plans/fence.ts"),
    retryPlans: await load("src/data/plans/retry-state.ts"),
    open: await load("src/data/store/open.ts"),
    registry: await load("src/data/store/registry.ts"),
  };
}
