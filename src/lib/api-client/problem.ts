/**
 * The Atlas error-body recogniser (pure). An "Atlas-formatted" refusal is a JSON content type and an object with
 * string `code`, `message` and `request_id` and an array `details`. A gateway `502`/`504` or an HTML body is not.
 * Only an Atlas-formatted 4xx, or a 503 `device_capacity`, is a definitive refusal of an activation (matrix 3.4
 * step 5).
 */
export interface AtlasError {
  code: string;
  message: string;
  request_id: string;
}

const JSON_TYPE = /^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;.*)?$/i;

export function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && JSON_TYPE.test(contentType.trim());
}

export function recogniseAtlasError(
  contentType: string | null,
  body: unknown,
): AtlasError | null {
  if (!isJsonContentType(contentType)) return null;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.request_id !== "string" ||
    !Array.isArray(candidate.details)
  )
    return null;
  return {
    code: candidate.code,
    message: candidate.message,
    request_id: candidate.request_id,
  };
}
