import { abortable, raceAbort } from "./abortable";
import type { FetchLike } from "./boundary";
import { recogniseAtlasError } from "./problem";
import type { RawAnswer, UnstampedApi } from "./transport";
import { apiUrl } from "./wire";

/**
 * The small unstamped surface (matrix 3.6.2 step 1): the login-family exchanges, `activate`, `activate/cancel` and
 * `/health`. They carry no credential of the settled account that the server uses, and none of their answers can
 * report on the settled session's validity; the attempt record is their durable cover.
 */
async function read(
  response: Response,
  signal: AbortSignal,
): Promise<RawAnswer> {
  const contentType = response.headers.get("content-type");
  let json: unknown;
  try {
    const text = await raceAbort(response.text(), signal);
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    contentType,
    json,
    atlasError: recogniseAtlasError(contentType, json),
  };
}

export function createUnstampedApi(
  fetch: FetchLike = abortable(globalThis.fetch.bind(globalThis)),
): UnstampedApi {
  const post = (path: string, body: unknown, signal: AbortSignal) =>
    fetch(
      new Request(apiUrl(path), {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        signal,
      }),
    ).then((response) => read(response, signal));
  return {
    exchange: (path, body, signal) => post(path, body, signal),
    activate: (body, signal) =>
      post("/browser-sessions/activate", body, signal),
    cancel: (body, signal) =>
      post("/browser-sessions/activate/cancel", body, signal),
    // /health is at the origin root, not under the API prefix.
    health: (signal) =>
      fetch(
        new Request(apiUrl("/health", ""), {
          method: "GET",
          credentials: "same-origin",
          signal,
        }),
      ).then((response) => read(response, signal)),
  };
}
