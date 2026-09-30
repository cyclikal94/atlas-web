import { describe, expect, test, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  applyPreference,
  parsePreference,
  readPreference,
  resolveTheme,
  THEME_COLOR,
  writePreference,
} from "../../src/design/theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const throwing = () => {
  throw new DOMException("blocked", "SecurityError");
};

describe("parsePreference", () => {
  test.each([
    ["light", "light"],
    ["dark", "dark"],
    ["auto", "auto"],
    [null, "auto"],
    [undefined, "auto"],
    ["", "auto"],
    ["Light", "auto"],
    ["blue", "auto"],
    [42, "auto"],
    [{}, "auto"],
  ])("%j -> %s", (raw, expected) => {
    expect(parsePreference(raw)).toBe(expected);
  });
});

describe("resolveTheme", () => {
  test.each([
    ["auto", false, "dark"],
    ["auto", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["light", true, "light"],
    ["dark", false, "dark"],
  ] as const)(
    "%s with system light=%s -> %s (no device preference resolves to dark)",
    (preference, system, expected) => {
      expect(resolveTheme(preference, system)).toBe(expected);
    },
  );
});

describe("storage", () => {
  test("Auto is the default: nothing stored means auto", () => {
    expect(readPreference(memoryStorage())).toBe("auto");
  });

  test("a corrupt stored value falls back to Auto", () => {
    expect(
      readPreference(memoryStorage({ [APPEARANCE_STORAGE_KEY]: "{not json" })),
    ).toBe("auto");
  });

  test("an explicit choice is stored and read back", () => {
    const storage = memoryStorage();
    expect(writePreference("dark", storage)).toBe("saved");
    expect(storage.data.get(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(readPreference(storage)).toBe("dark");
  });

  test("choosing Auto clears the override: the resolved value is never persisted", () => {
    const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: "light" });
    expect(writePreference("auto", storage)).toBe("saved");
    expect(storage.data.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });

  test("reading never throws when storage throws", () => {
    expect(readPreference({ getItem: throwing })).toBe("auto");
  });

  test("writing never throws and reports unavailable when storage throws (blocked or quota)", () => {
    expect(
      writePreference("light", { setItem: throwing, removeItem: throwing }),
    ).toBe("unavailable");
  });

  test("no storage at all reports unavailable", () => {
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(throwing);
    expect(writePreference("light")).toBe("unavailable");
    expect(readPreference()).toBe("auto");
    vi.restoreAllMocks();
  });
});

describe("applyPreference", () => {
  const fresh = () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.head.innerHTML =
      '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#08090A"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#F7F8F9">';
    return doc;
  };

  test("an explicit choice sets data-theme and the matching theme-color", () => {
    const doc = fresh();
    expect(applyPreference("light", doc, false)).toBe("light");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    const metas = doc.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute("content")).toBe(THEME_COLOR.light);
    expect(metas[0]?.hasAttribute("media")).toBe(false);
  });

  test("Auto removes data-theme and follows the device", () => {
    const doc = fresh();
    applyPreference("dark", doc, true);
    expect(applyPreference("auto", doc, true)).toBe("light");
    expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(
      doc.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ).toBe(THEME_COLOR.light);
  });

  test("creates the theme-color meta when it is missing", () => {
    const doc = document.implementation.createHTMLDocument("x");
    applyPreference("dark", doc, false);
    expect(
      doc.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ).toBe(THEME_COLOR.dark);
  });
});
