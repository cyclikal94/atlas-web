/**
 * Appearance preference (WF-SETTINGS-05, Q2). Device-local, never account data, never sent anywhere.
 *
 * Stored values are "light" or "dark". Auto is the absence of a stored value: the resolved theme is
 * never persisted, so the device setting keeps applying. A missing, corrupt or unreadable value means Auto.
 * public/theme-init.js implements the same read and apply before first paint; tests prove parity.
 */

export type AppearancePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "atlas.appearance.v1";
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Kept in step with --background in tokens.css; asserted by tests/design/tokens.test.ts. */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: "#0C0C10",
  light: "#F7F7FA",
};

export function parsePreference(raw: unknown): AppearancePreference {
  return raw === "light" || raw === "dark" ? raw : "auto";
}

/** Auto follows the device; a device with no preference resolves to dark (the default theme). */
export function resolveTheme(
  preference: AppearancePreference,
  systemPrefersLight: boolean,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemPrefersLight ? "light" : "dark";
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Blocked storage (private windows, disabled site data) throws on access.
    return undefined;
  }
}

export function readPreference(
  storage: Pick<Storage, "getItem"> | undefined = defaultStorage(),
): AppearancePreference {
  try {
    return parsePreference(storage?.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

/** Returns "unavailable" when the choice could not be kept, so the dialog can say so. Never throws. */
export function writePreference(
  preference: AppearancePreference,
  storage:
    | Pick<Storage, "setItem" | "removeItem">
    | undefined = defaultStorage(),
): "saved" | "unavailable" {
  if (!storage) return "unavailable";
  try {
    if (preference === "auto") storage.removeItem(APPEARANCE_STORAGE_KEY);
    else storage.setItem(APPEARANCE_STORAGE_KEY, preference);
    return "saved";
  } catch {
    return "unavailable";
  }
}

export function systemPrefersLight(
  win: Pick<Window, "matchMedia"> = window,
): boolean {
  try {
    return win.matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Sets or removes data-theme (present only for an explicit choice), and keeps one theme-color meta in step
 * with the resolved theme. Returns the resolved theme.
 */
export function applyPreference(
  preference: AppearancePreference,
  doc: Document,
  prefersLight: boolean,
): ResolvedTheme {
  const root = doc.documentElement;
  if (preference === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  const resolved = resolveTheme(preference, prefersLight);
  const metas = Array.from(
    doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  );
  let meta = metas[0];
  for (const extra of metas.slice(1)) extra.remove();
  if (!meta) {
    meta = doc.createElement("meta");
    meta.name = "theme-color";
    doc.head.append(meta);
  }
  meta.removeAttribute("media");
  meta.content = THEME_COLOR[resolved];
  return resolved;
}
