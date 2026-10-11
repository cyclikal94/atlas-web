import type { DeviceRow, SessionSummary } from "../../../session";
import { formatAgo } from "../relative-time";
import {
  ANOTHER_DEVICE,
  ANOTHER_DEVICE_IN_SENTENCE,
  ANOTHER_SIGN_IN,
  ANOTHER_SIGN_IN_IN_SENTENCE,
  APP,
  appOn,
  BROWSER_TEXT,
  browserOn,
  PLATFORM_TEXT,
  someBrowserOn,
  THIS_BROWSER,
  THIS_DEVICE,
  UNKNOWN_BROWSER,
  UNKNOWN_CLIENT,
  unknownClientOn,
} from "./label-copy";

/**
 * WEB-08d: decoding the BE-Q25 members the session module passes through untouched (`client`, `device_name`, `name`, both
 * capacities). Every value is UNTRUSTED: the server says a label is a hint derived from a self-reported User-Agent, never identity,
 * and a name is user text. Everything here is pure and synchronous; nothing is persisted, logged or sent.
 */
export type Browser =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "opera"
  | "samsung_internet"
  | "unknown";
export type Platform =
  | "windows"
  | "macos"
  | "ios"
  | "android"
  | "linux"
  | "chromeos"
  | "unknown";
export type ClientLabel =
  | { channel: "browser"; browser: Browser; platform: Platform }
  | { channel: "native"; platform: Platform }
  | { channel: "unknown"; platform: Platform };

const own = (value: object, key: string) => Object.hasOwn(value, key);
const oneOf = <T extends string>(
  value: unknown,
  known: Readonly<Record<string, unknown>>,
): T | "unknown" =>
  typeof value === "string" && own(known, value) ? (value as T) : "unknown";

/**
 * A label, or null when there is none to use (absent, null, not an object, or without its `channel` and `platform` members). Any
 * value the contract may add in a later MINOR version (a browser, a platform, a channel) decodes to `unknown`; extra members are
 * ignored, and a `native` label's `browser` is never read.
 */
export function decodeClientLabel(raw: unknown): ClientLabel | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  if (!own(raw, "channel") || !own(raw, "platform")) return null;
  const { channel, browser, platform } = raw as Record<string, unknown>;
  const p = oneOf<Platform>(platform, PLATFORM_TEXT);
  if (channel === "browser")
    return {
      channel: "browser",
      browser: oneOf<Browser>(browser, BROWSER_TEXT),
      platform: p,
    };
  if (channel === "native") return { channel: "native", platform: p };
  return { channel: "unknown", platform: p };
}

/** D-8d-03: "Chrome on macOS", "Chrome", "A browser on Windows", "Unknown browser", "Atlas app on iOS", "Atlas app". */
export function clientLabelText(label: ClientLabel): string {
  const platform =
    label.platform === "unknown" ? null : PLATFORM_TEXT[label.platform];
  if (label.channel === "native") return platform ? appOn(platform) : APP;
  if (label.channel === "unknown")
    return platform ? unknownClientOn(platform) : UNKNOWN_CLIENT;
  const browser =
    label.browser === "unknown" ? null : BROWSER_TEXT[label.browser];
  if (browser) return platform ? browserOn(browser, platform) : browser;
  return platform ? someBrowserOn(platform) : UNKNOWN_BROWSER;
}

// ---- device names: the server's `DeviceName` rules, by code point ------------------------------------------------------------------
export type NameProblem = "empty" | "too_long" | "edge_space" | "forbidden";
export const NAME_MAX_SCALARS = 64;

/** Rust's `char::is_whitespace` (the Unicode White_Space property). Not JS `\s`, which adds U+FEFF and omits U+0085. */
const WHITE_SPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
export const isWhiteSpace = (cp: number): boolean => WHITE_SPACE.has(cp);

/** A control (Cc), a bidirectional, invisible or separator code point the server refuses, a noncharacter, or a lone surrogate. */
export function isForbiddenCodePoint(cp: number): boolean {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  if (
    cp === 0x061c ||
    cp === 0x200b ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb)
  )
    return true;
  return (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe;
}

/** Null when the server would accept `value` exactly as it is (nothing is trimmed or normalised), else the first problem. */
export function checkDeviceName(value: string): NameProblem | null {
  // Code points, not UTF-16 units: 64 emoji are 64 scalars. A lone surrogate is one element here, and is forbidden below.
  const points = [...value].map((c) => c.codePointAt(0) ?? 0);
  if (points.length === 0) return "empty";
  if (points.length > NAME_MAX_SCALARS) return "too_long";
  if (
    isWhiteSpace(points[0] ?? 0) ||
    isWhiteSpace(points[points.length - 1] ?? 0)
  )
    return "edge_space";
  return points.some(isForbiddenCodePoint) ? "forbidden" : null;
}

/** D-8d-07: a name is shown only if it is a valid `DeviceName`; anything else is treated as absent (a correct server never sends it). */
export function decodeDeviceName(raw: unknown): string | null {
  return typeof raw === "string" && checkDeviceName(raw) === null ? raw : null;
}

/** First Strong Isolate ... Pop Directional Isolate: a name cannot reorder the text around it in a composed string. */
export const isolate = (text: string): string => `\u2068${text}\u2069`;

// ---- capacity ---------------------------------------------------------------------------------------------------------------------
export type CapacityReading =
  | { kind: "unavailable" }
  | { kind: "unlimited"; used: number }
  | { kind: "limited"; limit: number; used: number; remaining: number };

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * D-8d-11: `undefined` (the member was absent: an older server) and anything inconsistent with the contract are `unavailable`;
 * `limit: null` with `remaining: null` is `unlimited`. A reading is an observation, never a reservation.
 */
export function decodeCapacity(raw: unknown): CapacityReading {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { kind: "unavailable" };
  const { limit, used, remaining } = raw as Record<string, unknown>;
  if (!count(used)) return { kind: "unavailable" };
  if (limit === null && remaining === null) return { kind: "unlimited", used };
  if (
    count(limit) &&
    limit >= 1 &&
    count(remaining) &&
    remaining === Math.max(limit - used, 0)
  )
    return { kind: "limited", limit, used, remaining };
  return { kind: "unavailable" };
}

// ---- titles ------------------------------------------------------------------------------------------------------------------------
/** D-8d-03: a session is titled by its client label, else WEB-08a's fallback. Never user text, so never isolated. */
export function sessionTitle(row: SessionSummary): string {
  const label = decodeClientLabel(row.client);
  if (label) return clientLabelText(label);
  return row.current ? THIS_BROWSER : ANOTHER_SIGN_IN;
}

export interface DeviceDisplay {
  /** The name, else the client label, else WEB-08a's fallback (D-8d-04). */
  readonly title: string;
  /** True when `title` is the person's own text: it is shown in `<bdi>` and isolated in composed strings. */
  readonly named: boolean;
  /** The client label shown on the metadata line when the title is a name. */
  readonly label: string | null;
  /** True when the title is WEB-08a's fallback ("This device" / "Another device"). */
  readonly fallback: boolean;
}

export function deviceDisplay(row: DeviceRow): DeviceDisplay {
  const name = decodeDeviceName(row.name);
  const decoded = decodeClientLabel(row.client);
  const label = decoded ? clientLabelText(decoded) : null;
  if (name !== null)
    return { title: name, named: true, label, fallback: false };
  if (label !== null)
    return { title: label, named: false, label: null, fallback: false };
  return {
    title: row.current ? THIS_DEVICE : ANOTHER_DEVICE,
    named: false,
    label: null,
    fallback: true,
  };
}

export const deviceTitle = (row: DeviceRow): string => deviceDisplay(row).title;

/** The device title as it stands inside a sentence: a name isolated, a fallback in lower case. */
export function deviceInSentence(row: DeviceRow): string {
  const d = deviceDisplay(row);
  if (d.named) return isolate(d.title);
  if (d.fallback)
    return row.current ? THIS_DEVICE.toLowerCase() : ANOTHER_DEVICE_IN_SENTENCE;
  return d.title;
}

/** The session title inside a sentence, with its device's name (isolated) when it has one. */
export function sessionInSentence(row: SessionSummary): string {
  const label = decodeClientLabel(row.client);
  const title = label
    ? clientLabelText(label)
    : row.current
      ? THIS_BROWSER.toLowerCase()
      : ANOTHER_SIGN_IN_IN_SENTENCE;
  const device = decodeDeviceName(row.device_name);
  return device === null ? title : `${title} (${isolate(device)})`;
}

/**
 * D-8d-06: what tells a row's action apart from its neighbours' without an identifier: the title (with any device name) and the row's
 * own timestamp. "Chrome on macOS, signed in 3 days ago"; "Firefox on Windows, last synced 2 hours ago"; "this device, \u2068Kitchen\u2069".
 */
export function sessionPhrase(row: SessionSummary, now: Date): string {
  if (row.current) {
    const label = decodeClientLabel(row.client);
    return label
      ? `of this browser, ${clientLabelText(label)}`
      : "of this browser";
  }
  const ago = formatAgo(row.created_at, now);
  const subject = sessionInSentence(row);
  return ago ? `${subject}, signed in ${ago}` : subject;
}

export function devicePhrase(row: DeviceRow, now: Date): string {
  const d = deviceDisplay(row);
  if (row.current)
    return d.fallback
      ? "this device"
      : `this device, ${d.named ? isolate(d.title) : d.title}`;
  const ago = formatAgo(row.last_synced_at, now);
  return `${deviceInSentence(row)}, ${ago ? `last synced ${ago}` : "never synced"}`;
}

/** D-8d-06: titles shared by two or more rows (compared exactly), for the "look the same" hint. */
export function hasDuplicateTitles(rows: readonly DeviceRow[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const title = deviceTitle(row);
    if (seen.has(title)) return true;
    seen.add(title);
  }
  return false;
}
