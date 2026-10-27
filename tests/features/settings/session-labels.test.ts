import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { capacityText } from "../../../src/features/settings/sessions-devices/CapacityLine";
import {
  checkDeviceName,
  clientLabelText,
  decodeCapacity,
  decodeClientLabel,
  decodeDeviceName,
  deviceDisplay,
  devicePhrase,
  hasDuplicateTitles,
  isForbiddenCodePoint,
  isolate,
  isWhiteSpace,
  sessionPhrase,
  sessionTitle,
} from "../../../src/features/settings/sessions-devices/labels";
import type { DeviceRow, SessionSummary } from "../../../src/session";
import { deviceRow, sessionRow } from "../../helpers/session-double";

/**
 * WEB-08d: the pure decoding of BE-Q25's untrusted members (D-8d-03 to D-8d-07, D-8d-11). Every value the server can send, every value
 * a later MINOR version may add, and every value a faulty server could send has a defined, safe reading.
 */
const now = new Date("2026-09-30T12:00:00.000Z");
const session = (over: Record<string, unknown> = {}) =>
  sessionRow(over) as unknown as SessionSummary;
const device = (over: Record<string, unknown> = {}) =>
  deviceRow(over) as unknown as DeviceRow;

describe("client labels (D-8d-03)", () => {
  test.each([
    [
      { channel: "browser", browser: "chrome", platform: "macos" },
      "Chrome on macOS",
    ],
    [
      { channel: "browser", browser: "edge", platform: "windows" },
      "Edge on Windows",
    ],
    [
      { channel: "browser", browser: "firefox", platform: "linux" },
      "Firefox on Linux",
    ],
    [
      { channel: "browser", browser: "safari", platform: "ios" },
      "Safari on iOS",
    ],
    [
      { channel: "browser", browser: "opera", platform: "chromeos" },
      "Opera on ChromeOS",
    ],
    [
      { channel: "browser", browser: "samsung_internet", platform: "android" },
      "Samsung Internet on Android",
    ],
    [{ channel: "browser", browser: "chrome", platform: "unknown" }, "Chrome"],
    [
      { channel: "browser", browser: "unknown", platform: "windows" },
      "A browser on Windows",
    ],
    [
      { channel: "browser", browser: "unknown", platform: "unknown" },
      "Unknown browser",
    ],
    [{ channel: "native", browser: null, platform: "ios" }, "Atlas app on iOS"],
    [{ channel: "native", browser: null, platform: "unknown" }, "Atlas app"],
    // A later MINOR value of any member is `unknown` (the contract says so).
    [
      { channel: "browser", browser: "brave", platform: "macos" },
      "A browser on macOS",
    ],
    [
      { channel: "browser", browser: "chrome", platform: "harmonyos" },
      "Chrome",
    ],
    [
      { channel: "tv", browser: null, platform: "android" },
      "Unknown app or browser on Android",
    ],
    [
      { channel: "tv", browser: null, platform: "plan9" },
      "Unknown app or browser",
    ],
    // A native label never shows a browser, whatever it carries.
    [
      { channel: "native", browser: "chrome", platform: "android" },
      "Atlas app on Android",
    ],
    // A browser label with a null, numeric or missing browser is a browser of unknown family; extra members are ignored.
    [
      { channel: "browser", browser: null, platform: "ios" },
      "A browser on iOS",
    ],
    [
      { channel: "browser", browser: 7, platform: "ios", extra: "<b>" },
      "A browser on iOS",
    ],
    [{ channel: "browser", platform: "linux" }, "A browser on Linux"],
  ])("%j reads %s", (raw, text) => {
    const label = decodeClientLabel(raw);
    expect(label).not.toBeNull();
    expect(clientLabelText(label as NonNullable<typeof label>)).toBe(text);
  });

  test.each([
    undefined,
    null,
    "Chrome on macOS",
    42,
    [],
    {},
    { channel: "browser", browser: "chrome" },
    { browser: "chrome", platform: "macos" },
  ])("%j is no label at all", (raw) => {
    expect(decodeClientLabel(raw)).toBeNull();
  });

  test("a later MINOR value decodes to `unknown` itself, not only to the same words", () => {
    expect(
      decodeClientLabel({
        channel: "browser",
        browser: "brave",
        platform: "harmonyos",
      }),
    ).toEqual({ channel: "browser", browser: "unknown", platform: "unknown" });
    expect(
      decodeClientLabel({
        channel: "native",
        browser: null,
        platform: "tizen",
      }),
    ).toEqual({ channel: "native", platform: "unknown" });
  });

  test("an inherited member is not a member: a prototype's `channel` does not make a label", () => {
    const inherited = Object.create({ channel: "browser", platform: "macos" });
    expect(decodeClientLabel(inherited)).toBeNull();
  });
});

describe("titles and fallbacks (D-8d-03, D-8d-04)", () => {
  test("a session is titled by its label; a null, absent or unusable label falls back to WEB-08a's words", () => {
    const chrome = { channel: "browser", browser: "chrome", platform: "macos" };
    expect(sessionTitle(session({ client: chrome }))).toBe("Chrome on macOS");
    expect(sessionTitle(session({ client: null }))).toBe("This browser");
    expect(sessionTitle(session({ current: false }))).toBe("Another sign-in");
    expect(sessionTitle(session({ current: false, client: "x" }))).toBe(
      "Another sign-in",
    );
    expect(sessionTitle(session({ client: chrome, device_name: "Den" }))).toBe(
      "Chrome on macOS",
    );
  });

  test("a device is titled by its name, then its label, then the fallback; the label moves to the metadata under a name", () => {
    const label = { channel: "native", browser: null, platform: "ios" };
    expect(
      deviceDisplay(device({ name: "Kieran's phone", client: label })),
    ).toEqual({
      title: "Kieran's phone",
      named: true,
      label: "Atlas app on iOS",
      fallback: false,
    });
    expect(deviceDisplay(device({ client: label }))).toEqual({
      title: "Atlas app on iOS",
      named: false,
      label: null,
      fallback: false,
    });
    expect(deviceDisplay(device({ name: null, client: null }))).toMatchObject({
      title: "This device",
      fallback: true,
    });
    expect(deviceDisplay(device({ current: false, name: null })).title).toBe(
      "Another device",
    );
  });

  test("a name a correct server never sends is treated as absent (D-8d-07): it never becomes the title", () => {
    for (const bad of [
      "evil\u202Etxt.exe",
      "zero\u200Bwidth",
      "x".repeat(65),
      " padded",
      "\uD800lone",
      42,
      {},
      ["Den"],
    ])
      expect(
        deviceDisplay(
          device({
            name: bad,
            client: {
              channel: "browser",
              browser: "edge",
              platform: "windows",
            },
          }),
        ).title,
      ).toBe("Edge on Windows");
    expect(decodeDeviceName(undefined)).toBeNull();
    expect(decodeDeviceName("<script>alert(1)</script>")).toBe(
      "<script>alert(1)</script>",
    );
  });
});

describe("device names: the server's DeviceName rules by code point (D-8d-07, D-8d-09)", () => {
  test("64 emoji (128 UTF-16 units) are accepted; 65 are too long; 64 + a lone surrogate is forbidden, not counted as 65", () => {
    expect(checkDeviceName("\u{1F600}".repeat(64))).toBeNull();
    expect(checkDeviceName("\u{1F600}".repeat(65))).toBe("too_long");
    expect(checkDeviceName("x".repeat(64))).toBeNull();
    expect(checkDeviceName("x".repeat(65))).toBe("too_long");
    expect(checkDeviceName("ab\uD83D")).toBe("forbidden");
    expect(checkDeviceName("\uDE00ab")).toBe("forbidden");
  });

  test("problems are reported in order: empty, too long, edge white space, forbidden", () => {
    expect(checkDeviceName("")).toBe("empty");
    expect(checkDeviceName(" Kitchen")).toBe("edge_space");
    expect(checkDeviceName("Kitchen\u3000")).toBe("edge_space");
    expect(checkDeviceName("Kit\u202Echen")).toBe("forbidden");
    expect(checkDeviceName("Kitchen  iPad")).toBeNull();
  });

  // Rust's char::is_whitespace is the White_Space property: pinned per code point, including where JS `\s` differs.
  const whiteSpace = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
    0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ];
  test.each(whiteSpace)("U+%s is white space", (cp) => {
    expect(isWhiteSpace(cp)).toBe(true);
  });
  test.each([0x180e, 0xfeff, 0x200b, 0x61, 0x5bb6])(
    "U+%s is not white space (JS \\s says otherwise for U+FEFF)",
    (cp) => {
      expect(isWhiteSpace(cp)).toBe(false);
    },
  );
  test("the property is the server's, not JavaScript's \\s", () => {
    expect(/\s/.test("\uFEFF")).toBe(true);
    expect(/\s/.test("\u0085")).toBe(false);
    expect(checkDeviceName("\u0085x")).toBe("edge_space");
    expect(checkDeviceName("x\uFEFF")).toBe("forbidden");
  });

  test.each([
    [0x00, true],
    [0x1f, true],
    [0x7f, true],
    [0x9f, true],
    [0xa0, false],
    [0x061c, true],
    [0x200b, true],
    [0x200c, false], // ZWNJ is allowed
    [0x200d, false], // ZWJ is allowed
    [0x200e, true],
    [0x200f, true],
    [0x202a, true],
    [0x202e, true],
    [0x202f, false],
    [0x2028, true],
    [0x2029, true],
    [0x2060, true],
    [0x2064, true],
    [0x2065, false],
    [0x2066, true],
    [0x2069, true],
    [0xfeff, true],
    [0xfff9, true],
    [0xfffb, true],
    [0xfffc, false],
    [0xfdd0, true],
    [0xfdef, true],
    [0xfdf0, false],
    [0xfffe, true],
    [0xffff, true],
    [0x1fffe, true],
    [0x10ffff, true],
    [0xd800, true],
    [0xdfff, true],
    [0x1f600, false],
  ])("U+%s forbidden: %s", (cp, forbidden) => {
    expect(isForbiddenCodePoint(cp)).toBe(forbidden);
  });
});

describe("capacity (D-8d-11)", () => {
  test.each([
    [undefined, { kind: "unavailable" }],
    [null, { kind: "unavailable" }],
    ["3 of 32", { kind: "unavailable" }],
    [[], { kind: "unavailable" }],
    [
      { limit: 32, used: 3, remaining: 29 },
      { kind: "limited", limit: 32, used: 3, remaining: 29 },
    ],
    [
      { limit: 4, used: 4, remaining: 0 },
      { kind: "limited", limit: 4, used: 4, remaining: 0 },
    ],
    // Over the limit (a lowered limit): remaining is clamped at 0 by the server.
    [
      { limit: 4, used: 6, remaining: 0 },
      { kind: "limited", limit: 4, used: 6, remaining: 0 },
    ],
    [
      { limit: null, used: 7, remaining: null },
      { kind: "unlimited", used: 7 },
    ],
    // Inconsistent: exactly one null, a wrong remaining, limit < 1, negatives, fractions, strings, missing members.
    [{ limit: null, used: 7, remaining: 3 }, { kind: "unavailable" }],
    [{ limit: 4, used: 1, remaining: null }, { kind: "unavailable" }],
    [{ limit: 10, used: 2, remaining: 3 }, { kind: "unavailable" }],
    [{ limit: 4, used: 6, remaining: -2 }, { kind: "unavailable" }],
    [{ limit: 0, used: 0, remaining: 0 }, { kind: "unavailable" }],
    [{ limit: 4, used: -1, remaining: 5 }, { kind: "unavailable" }],
    [{ limit: 4.5, used: 1, remaining: 3.5 }, { kind: "unavailable" }],
    [{ limit: "4", used: 1, remaining: 3 }, { kind: "unavailable" }],
    [{ limit: 4, remaining: 4 }, { kind: "unavailable" }],
    [{ used: 1 }, { kind: "unavailable" }],
  ])("%j is %j", (raw, reading) => {
    expect(decodeCapacity(raw)).toEqual(reading);
  });

  test("the words: limited, full, unlimited and unavailable, for each list; nothing promises a place", () => {
    const limited = decodeCapacity({ limit: 32, used: 3, remaining: 29 });
    const full = decodeCapacity({ limit: 4, used: 4, remaining: 0 });
    const unlimited = decodeCapacity({ limit: null, used: 1, remaining: null });
    const none = decodeCapacity(undefined);
    expect(capacityText("sessions", limited)).toBe("3 of 32 sign-ins in use.");
    expect(capacityText("sessions", full)).toBe(
      "4 of 4 sign-ins in use. A new sign-in won't work until you sign one out.",
    );
    expect(capacityText("sessions", unlimited)).toBe(
      "1 sign-in in use. This server sets no limit.",
    );
    expect(capacityText("sessions", none)).toBe(
      "We can't show how many sign-ins this account can have.",
    );
    expect(capacityText("devices", limited)).toBe(
      "3 of 32 places for syncing in use.",
    );
    expect(capacityText("devices", full)).toBe(
      "4 of 4 places for syncing in use. A new device can't start syncing until you retire one.",
    );
    expect(capacityText("devices", unlimited)).toBe(
      "1 place for syncing in use. This server sets no limit.",
    );
    expect(capacityText("devices", none)).toBe(
      "We can't show how many devices can sync.",
    );
    for (const text of [limited, full, unlimited, none].flatMap((r) => [
      capacityText("sessions", r),
      capacityText("devices", r),
    ]))
      expect(text).not.toMatch(/room for|reserved|guarantee/i);
  });

  test("no capacity limit is hard-coded in the feature: neither the design's five nor the server's 32", () => {
    const dir = resolve(
      __dirname,
      "../../../src/features/settings/sessions-devices",
    );
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/\b32\b/);
      expect(text, file).not.toMatch(/(?:of|limit:?|room for)\s*5\b/i);
    }
  });
});

describe("telling rows apart without identifiers (D-8d-06)", () => {
  const firefox = {
    channel: "browser",
    browser: "firefox",
    platform: "windows",
  };
  test("an action's phrase is the title and the row's own timestamp; a name is isolated; fallbacks read as words", () => {
    expect(
      devicePhrase(
        device({
          current: false,
          client: firefox,
          last_synced_at: "2026-09-30T10:00:00.000Z",
        }),
        now,
      ),
    ).toBe("Firefox on Windows, last synced 2 hours ago");
    expect(
      devicePhrase(
        device({ current: false, name: "Kitchen", last_synced_at: null }),
        now,
      ),
    ).toBe(`${isolate("Kitchen")}, never synced`);
    expect(
      devicePhrase(device({ current: false, last_synced_at: null }), now),
    ).toBe("another device, never synced");
    expect(devicePhrase(device({ client: firefox }), now)).toBe(
      "this device, Firefox on Windows",
    );
    expect(devicePhrase(device({ name: "בית" }), now)).toBe(
      `this device, ${isolate("בית")}`,
    );
    expect(devicePhrase(device(), now)).toBe("this device");
    expect(
      sessionPhrase(
        session({
          current: false,
          client: firefox,
          device_name: "Den",
          created_at: "2026-09-27T12:00:00.000Z",
        }),
        now,
      ),
    ).toBe(`Firefox on Windows (${isolate("Den")}), signed in 3 days ago`);
    expect(sessionPhrase(session({ client: firefox }), now)).toBe(
      "of this browser, Firefox on Windows",
    );
    expect(sessionPhrase(session(), now)).toBe("of this browser");
  });

  test("no phrase contains an identifier or a state token", () => {
    const row = device({
      current: false,
      id: "dev-9f3a",
      state_token: "v1.secret",
      client: firefox,
    });
    expect(devicePhrase(row, now)).not.toMatch(/dev-9f3a|v1\.secret/);
    const s = session({ current: false, id: "sess-77", device_id: "dev-77" });
    expect(sessionPhrase(s, now)).not.toMatch(/sess-77|dev-77/);
  });

  test("duplicate titles are found exactly; distinct names or labels are not duplicates", () => {
    const a = device({ id: "a", current: false, client: firefox });
    const b = device({ id: "b", current: false, client: firefox });
    expect(hasDuplicateTitles([a, b])).toBe(true);
    expect(
      hasDuplicateTitles([
        a,
        device({ id: "b", current: false, client: firefox, name: "Den" }),
      ]),
    ).toBe(false);
    expect(hasDuplicateTitles([a])).toBe(false);
    expect(isolate("x")).toBe("\u2068x\u2069");
  });
});
