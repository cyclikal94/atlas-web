import { useEffect, useRef } from "react";
import type { ModelView } from "../../../lib/form-recovery/model";
import { keptEntry } from "../kept-input";

/** Whether the kept session of `key` holds the person's input (an editor is opened again on it). */
export const holdsInput = (key: string): boolean => {
  const entry = keptEntry(key);
  return entry !== null && (entry.revision > 0 || entry.submitting !== null);
};

/** The restored copies an editor has already been opened on (page memory: the next reload starts afresh). */
const opened = new WeakSet<object>();

/**
 * WEB-14a maintenance merge of accepted WEB-10c, correction D-1: a restore host opens its editor ONCE for each copy restored into `key`, as
 * soon as it may (`ready`: no editor is open, what the editor needs is read). WEB-10c's editors keep what was typed for the screen's visit
 * when they close (Cancel is not a discard), so a restored session still holds input after the person's Cancel: opening the editor again
 * on it would undo that Cancel, every time. Any later opening is the person's own ("Set what this waits for", "Turn order…").
 */
export function useOpenOnRestore(
  view: ModelView,
  key: string,
  ready: boolean,
  open: () => void,
): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const restored = view.restored;
    if (!ready || restored === null || opened.has(restored)) return;
    if (!holdsInput(key)) return;
    opened.add(restored);
    latest.current();
  }, [ready, view.restored, key]);
}
