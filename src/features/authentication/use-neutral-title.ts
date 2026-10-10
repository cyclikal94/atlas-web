import { useEffect } from "react";
import {
  clearNeutralTitle,
  type NeutralTitlePart,
  setNeutralTitle,
} from "../../protected-surface/title";

/** A public surface's tab title: generic, from a closed set, and put back to plain "Atlas" when it goes. */
export function useNeutralTitle(part: NeutralTitlePart): void {
  useEffect(() => {
    setNeutralTitle(document, part);
    return () => clearNeutralTitle(part, document);
  }, [part]);
}
