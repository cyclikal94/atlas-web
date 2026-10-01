import { judgeVersion, type VersionRange } from "../model/api-version";
import type { ApiCompatibility } from "../model/view";
import type { Kernel } from "./state";

/**
 * The API-version compatibility check (decision D-08, answer B2). `GET /health` is at the origin root and needs no
 * credentials. Returns `supported`, `unsupported` (out of range), `missing` (no usable `api_version`) or
 * `unreachable` (network failure or a non-Atlas answer). It never throws. The pause of queued submissions on
 * `unsupported` or `missing` is WEB-09a's; this only says which it is.
 */
export async function checkApiCompatibility(
  k: Kernel,
  range: VersionRange,
): Promise<ApiCompatibility> {
  try {
    const answer = await k.ports.unstamped.health(
      k.ports.clock.abortAfter(k.config.healthTimeoutMs),
    );
    if (answer.status !== 200) return { status: "unreachable" };
    const body = answer.json;
    if (typeof body !== "object" || body === null)
      return { status: "unreachable" };
    const verdict = judgeVersion(
      (body as { api_version?: unknown }).api_version,
      range,
    );
    return verdict;
  } catch {
    return { status: "unreachable" };
  }
}
