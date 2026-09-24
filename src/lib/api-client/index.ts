import createClient from "openapi-fetch";
import type { paths } from "../api-types";
// Factory only: no request is sent by the bootstrap. WEB-08a must supply the
// stamped, leased fetch boundary before any authenticated use of this client.
export function createApiClient(fetch: typeof globalThis.fetch) {
  return createClient<paths>({
    baseUrl: "/api/experimental/v1",
    credentials: "same-origin",
    fetch,
  });
}
