import createClient from "openapi-fetch";
import type { paths } from "../api-types";
import { API_BASE } from "./wire";

export { API_BASE } from "./wire";

/** A stamped request function: a Request in, a Response out, or a protocol error (see `StampedRequestError`). */
export type StampedFetch = (request: Request) => Promise<Response>;

/**
 * Factory only: no request is sent by the bootstrap. The function it is given is a stamped one
 * (`session.api.client(...)`), so every request crosses the write-ahead lease and the send boundary
 * (matrix 3.6.2 step 1). `baseUrl` is absolute only in tests that run outside a browser.
 */
export function createApiClient(
  stamped: StampedFetch,
  baseUrl: string = API_BASE,
) {
  return createClient<paths>({
    baseUrl,
    credentials: "same-origin",
    // biome-ignore lint/plugin: openapi-fetch's option is named fetch; the value is the stamped function
    fetch: stamped,
  });
}
