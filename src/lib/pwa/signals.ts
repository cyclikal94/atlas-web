/**
 * The data layer's supersession signal (WEB-14a D-P8), kept out of the initial chunk: only lazily loaded modules raise it (the data
 * layer's browser composition) and listen to it (the coordinator).
 */
type Listener = () => void;

let superseded = false;
const supersededListeners = new Set<Listener>();

/**
 * The data layer's signal (D-P8): another tab's newer build upgraded an account database this page had, or found, open. Raised once per
 * page; a listener added later is told at once.
 */
export function raiseDataSuperseded(): void {
  if (superseded) return;
  superseded = true;
  for (const listener of [...supersededListeners]) listener();
}

export function onDataSuperseded(listener: Listener): () => void {
  if (superseded) listener();
  supersededListeners.add(listener);
  return () => {
    supersededListeners.delete(listener);
  };
}
