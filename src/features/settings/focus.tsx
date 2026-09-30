import { createContext, type MutableRefObject, useContext } from "react";

/** Remembers whether the Appearance link opened the dialog, so closing can return focus deterministically. */
export const SettingsFocusContext =
  createContext<MutableRefObject<boolean> | null>(null);

export function useOpenedByLink(): MutableRefObject<boolean> {
  const value = useContext(SettingsFocusContext);
  if (!value) throw new Error("Settings focus context missing");
  return value;
}
