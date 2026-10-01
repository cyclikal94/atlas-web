/**
 * API compatibility (decision D-08, answer B2). Versions compare numerically as SemVer, never as text. Only a strict
 * `MAJOR.MINOR.PATCH` is a version: `0.27`, `0.27.0-rc.1` and an absent field are all "missing".
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const STRICT = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseSemVer(value: unknown): SemVer | null {
  if (typeof value !== "string") return null;
  const match = STRICT.exec(value);
  if (!match) return null;
  const [, major, minor, patch] = match;
  const parts = [Number(major), Number(minor), Number(patch)];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** `>= floor` and `< ceiling`. */
export interface VersionRange {
  floor: SemVer;
  ceiling: SemVer;
}

/**
 * The range the client supports, from the pinned contract version: `>=MAJOR.MINOR.0 <MAJOR.(MINOR+1).0`. A
 * pre-release pin such as `0.27.0-rc.1` supports the release it precedes and its patch releases.
 */
export function rangeFromPin(pinVersion: string): VersionRange {
  const base = pinVersion.split(/[-+]/)[0] ?? "";
  const parsed = parseSemVer(base);
  if (!parsed)
    throw new Error(`Unparseable contract pin version: ${pinVersion}`);
  return {
    floor: { major: parsed.major, minor: parsed.minor, patch: 0 },
    ceiling: { major: parsed.major, minor: parsed.minor + 1, patch: 0 },
  };
}

export const formatRange = (range: VersionRange): string =>
  `>=${range.floor.major}.${range.floor.minor}.${range.floor.patch} <${range.ceiling.major}.${range.ceiling.minor}.${range.ceiling.patch}`;

export type VersionVerdict =
  | { status: "supported"; version: string }
  | { status: "unsupported"; version: string; supported: string }
  | { status: "missing" };

export function judgeVersion(
  value: unknown,
  range: VersionRange,
): VersionVerdict {
  const parsed = parseSemVer(value);
  if (!parsed) return { status: "missing" };
  const version = value as string;
  if (
    compareSemVer(parsed, range.floor) >= 0 &&
    compareSemVer(parsed, range.ceiling) < 0
  )
    return { status: "supported", version };
  return { status: "unsupported", version, supported: formatRange(range) };
}
