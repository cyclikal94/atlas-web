/**
 * Wire details of a stamped request (plan section 7.10, decision SA-01). Pure: no network, no session state.
 * `X-CSRF-Token` rides on every cookie-authenticated request except the identity read, which sends
 * `X-Atlas-Session: 1` instead and no CSRF header.
 */
export const API_BASE = "/api/experimental/v1";
export const CSRF_HEADER = "X-CSRF-Token";
export const IDENTITY_HEADER = "X-Atlas-Session";

/** An absolute URL for an API path, so it is valid in a browser and in a test runtime alike. */
export function apiUrl(path: string, base: string = API_BASE): URL {
  const origin =
    typeof globalThis.location === "object" && globalThis.location?.origin
      ? globalThis.location.origin
      : "http://localhost";
  return new URL(`${base}${path}`, origin);
}

export interface Decoration {
  csrf: string | null;
  identityRead: boolean;
  signal: AbortSignal;
}

/** Returns a new Request carrying the stamp headers, the same-origin credentials and the request's own time-out. */
export function decorate(request: Request, options: Decoration): Request {
  const headers = new Headers(request.headers);
  if (options.identityRead) {
    headers.set(IDENTITY_HEADER, "1");
    headers.delete(CSRF_HEADER);
  } else if (options.csrf !== null) {
    headers.set(CSRF_HEADER, options.csrf);
  }
  return new Request(request, {
    headers,
    signal: options.signal,
    credentials: "same-origin",
  });
}
