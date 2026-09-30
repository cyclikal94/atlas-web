import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  APPEARANCE_STORAGE_KEY,
  type AppearancePreference,
  applyPreference,
  LIGHT_QUERY,
  parsePreference,
  type ResolvedTheme,
  readPreference,
  resolveTheme,
  systemPrefersLight,
  writePreference,
} from "./theme";

export interface ThemeState {
  preference: AppearancePreference;
  resolved: ResolvedTheme;
  /** False when the last attempt to keep the choice failed: it lasts until this page is reloaded. */
  persisted: boolean;
  setPreference(preference: AppearancePreference): "saved" | "unavailable";
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<AppearancePreference>(() =>
    readPreference(),
  );
  const [prefersLight, setPrefersLight] = useState<boolean>(() =>
    systemPrefersLight(),
  );
  const [persisted, setPersisted] = useState(true);

  // Keep the document in step with the choice and the device.
  useEffect(() => {
    applyPreference(preference, document, prefersLight);
  }, [preference, prefersLight]);

  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(LIGHT_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) =>
      setPrefersLight(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Another tab changed the choice.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
      setPreferenceState(
        event.key === null ? readPreference() : parsePreference(event.newValue),
      );
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: AppearancePreference) => {
    const outcome = writePreference(next);
    setPreferenceState(next);
    setPersisted(outcome === "saved");
    return outcome;
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      preference,
      resolved: resolveTheme(preference, prefersLight),
      persisted,
      setPreference,
    }),
    [preference, prefersLight, persisted, setPreference],
  );
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
