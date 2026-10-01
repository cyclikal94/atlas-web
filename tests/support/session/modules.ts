import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as boundary from "../../../src/lib/api-client/boundary";
import * as unstamped from "../../../src/lib/api-client/unstamped";
import * as ledger from "../../../src/session/adapters/deletion-ledger";
import * as webLocks from "../../../src/session/adapters/web-locks";
import * as closing from "../../../src/session/kernel/closing";
import * as expose from "../../../src/session/kernel/expose";
import * as identity from "../../../src/session/kernel/identity";
import * as operations from "../../../src/session/kernel/operations";
import * as send from "../../../src/session/kernel/send";
import * as attemptReducers from "../../../src/session/model/reducers/attempt";
import * as operationReducers from "../../../src/session/model/reducers/operation";
import * as session from "../../../src/session/session";

/**
 * The production modules the fake world runs. The default is `src/`; the mutation tests load a PATCHED COPY of the
 * tree (tests/support/session/mutants.ts) so a deliberately broken protocol can be run through the same scenarios.
 */
export const srcModules = {
  session,
  send,
  identity,
  operations,
  boundary,
  unstamped,
  webLocks,
  ledger,
  closing,
  expose,
  attemptReducers,
  operationReducers,
};
export type Modules = typeof srcModules;

export async function loadModules(root: string): Promise<Modules> {
  const load = async <T>(relative: string): Promise<T> =>
    (await import(
      /* @vite-ignore */ pathToFileURL(join(root, relative)).href
    )) as T;
  return {
    session: await load("src/session/session.ts"),
    send: await load("src/session/kernel/send.ts"),
    identity: await load("src/session/kernel/identity.ts"),
    operations: await load("src/session/kernel/operations.ts"),
    boundary: await load("src/lib/api-client/boundary.ts"),
    unstamped: await load("src/lib/api-client/unstamped.ts"),
    webLocks: await load("src/session/adapters/web-locks.ts"),
    ledger: await load("src/session/adapters/deletion-ledger.ts"),
    closing: await load("src/session/kernel/closing.ts"),
    expose: await load("src/session/kernel/expose.ts"),
    attemptReducers: await load("src/session/model/reducers/attempt.ts"),
    operationReducers: await load("src/session/model/reducers/operation.ts"),
  };
}
