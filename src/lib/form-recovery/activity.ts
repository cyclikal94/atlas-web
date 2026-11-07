import {
  pageFormRegistry,
  type RecoverableFormHandle,
  type RecoverableFormRegistry,
} from "./registry";

/**
 * PAGE WORK AN UPDATE RELOAD MUST NOT OVERTAKE (WEB-14a revision 39; review of revision 38, R40-FREEZE/R40-COMPOSITION; design assessment
 * C1-C2, I2-I4). Not every effect of a page is a form's input: a single sign-on leaving for its provider, linking one from Settings, or what
 * a page knows only in its memory after a registration (an invitation that may be spent). Each takes part in the update's checkpoint through
 * a handle of the page's registry, as a form does:
 *
 *  - ADMITTED OR NOT, AT THE GESTURE (`admitActivity`): null while an update reload is being prepared (`registry.frozen()`), so the caller
 *    starts nothing; otherwise the work is outstanding (`settled`) from this same step until it ends, whatever unmounts meanwhile, and the
 *    update waits for it. `end` once its outcome is known (any outcome: a failure is not a saved copy, there is simply nothing left to wait
 *    for). `depart` when it is leaving the page (a navigation to a provider): it stays outstanding, so no update reload is made over that
 *    navigation, until the page is shown again (a return from the back-forward cache).
 *  - KEPT IN THIS PAGE (`holdUnrestorable`): state no reload brings back and that the person still needs (what to do after a registration
 *    whose result is not known). It stops a save's reload (`restorable` false) until released, or discarded by "Discard and reload anyway".
 *
 * Neither holds anything to save, and neither is shown as an open form. Memory only.
 */
const ACTIVITY = "activity:";

export const isActivity = (form: RecoverableFormHandle): boolean =>
  form.formContext.startsWith(ACTIVITY);

const held = () => Object.assign(() => undefined, { holds: () => true });

export interface Activity {
  /** The work has ended, whatever its outcome. Idempotent. */
  end(): void;
  /** The work is leaving the page: outstanding until the page is shown again, or `end`. */
  depart(): void;
}

export function admitActivity(
  name: string,
  registry: RecoverableFormRegistry = pageFormRegistry,
): Activity | null {
  if (registry.frozen()) return null;
  let ended = false;
  let settle: () => void = () => undefined;
  const outstanding = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const unregister = registry.register({
    formContext: `${ACTIVITY}${name}`,
    isDirty: () => false,
    flush: async () => "saved",
    discard: async () => "discarded",
    freeze: held,
    settled: () => (ended ? null : outstanding),
  });
  const end = (): void => {
    if (ended) return;
    ended = true;
    settle();
    unregister();
  };
  return {
    end,
    depart() {
      if (!ended) addEventListener("pageshow", end, { once: true });
    },
  };
}

/** Holds state no reload brings back in this page; returns its release. */
export function holdUnrestorable(
  name: string,
  registry: RecoverableFormRegistry = pageFormRegistry,
): () => void {
  let discarded = false;
  return registry.register({
    formContext: `${ACTIVITY}${name}`,
    isDirty: () => !discarded,
    // Nothing can be saved of it: a peer's request to save says so.
    flush: async () => "failed",
    discard: async () => {
      discarded = true;
      return "discarded";
    },
    freeze: held,
    restorable: () => false,
  });
}
