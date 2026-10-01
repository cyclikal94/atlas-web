import { createApiClient } from "../lib/api-client";
import { apiUrl } from "../lib/api-client/wire";
import { createStampedFetch, sealResult } from "./kernel/send";
import type { Kernel } from "./kernel/state";
import type { AccountId, Epoch } from "./model/types";

/** The calls of the openapi-fetch client that return a decoded result (`use` and `eject` do not). */
const CLIENT_CALLS = [
  "request",
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
] as const;

/**
 * The typed client of `session.api.client`. The library decodes the Response after the stamped `fetch` has returned it
 * (`await response.json()`, or `.text()` for an error), and that decode is asynchronous even for a body that is already in
 * memory, so a result is validated a second time, AFTER it: every call resolves through `sealResult` (the identity read at the
 * record after the decode, in the step that decides) or rejects with `stale`. The stamped `fetch` underneath it still checks
 * once, before the library decodes (`to: "library"`), which spares decoding an answer nobody will receive. A call that
 * rejects (a network error, a protocol error) is passed on untouched. A caller that asks for `parseAs: "stream"` receives the
 * Response's body to read itself, which is its own work after the call (docs/session.md).
 *
 * It lives here, outside the kernel, because the kernel does not import the client library (F-BND-4).
 */
export function createStampedClient(
  k: Kernel,
  klass: "ordinary" | "recovery",
  account: AccountId,
  epoch: Epoch,
): ReturnType<typeof createApiClient> {
  const client = createApiClient(
    createStampedFetch(k, klass, account, epoch, "library"),
    apiUrl("").href,
  );
  const sealed: Record<string, unknown> = { ...client };
  for (const name of CLIENT_CALLS) {
    const call = client[name] as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    sealed[name] = (...args: unknown[]) =>
      sealResult(k, account, epoch, call(...args));
  }
  return sealed as unknown as typeof client;
}
