import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { ResourceView } from "../../../src/data/plans/pending-reads";
import type { Loadable, Watchable } from "../../../src/data/store/port";

/**
 * The anchor section's OWN read of a task (WEB-13b revision 13, review 14 R11): the `data.readResourceView` watch it subscribes to for
 * `set_anchor` settings, through the page's real store. Install it, then mount the section again (`t.remount()`, a return to the task):
 * only watches created from then on are seen. The read underneath stays real; `hold` hides what it publishes from the section (the
 * section is shown `held`: loading, or unavailable) until `release` tells it again. A watch React created while rendering and never
 * subscribed to is not the section's, and is ignored (Review 14's preserved preparation failure).
 */
export function sectionTaskRead(
  data: { service(): { store: object } | null },
  taskId: string | ((id: string) => boolean),
  options: { held?: Loadable<never> } = {},
) {
  const service = data.service();
  if (service === null) throw new Error("setup: no open service");
  const store = service.store as {
    watch(plan: { name: string }, input: unknown): Watchable<unknown>;
  };
  const watch = store.watch.bind(store);
  const matches =
    typeof taskId === "string" ? (id: string) => id === taskId : taskId;
  let shown: Loadable<never> | null = options.held ?? null;
  let hidden = 0;
  const listeners = new Set<() => void>();
  const subscribed: Watchable<ResourceView>[] = [];
  vi.spyOn(store, "watch").mockImplementation(((
    plan: { name: string },
    input: { id: string; settingsKind?: string },
  ) => {
    const source = watch(plan, input) as Watchable<ResourceView>;
    if (
      plan.name !== "data.readResourceView" ||
      input.settingsKind !== "set_anchor" ||
      !matches(input.id)
    )
      return source;
    return {
      get: () => {
        if (shown === null) return source.get();
        hidden += 1;
        return shown;
      },
      subscribe: (listener: () => void) => {
        subscribed.push(source);
        listeners.add(listener);
        const off = source.subscribe(() => {
          if (shown === null) listener();
          else hidden += 1;
        });
        return () => {
          listeners.delete(listener);
          off();
        };
      },
    } satisfies Watchable<ResourceView>;
  }) as never);
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    /** From now on the section is shown `as` (loading by default), whatever the read underneath publishes. */
    hold: (as: Loadable<never> = { status: "loading" }) =>
      act(() => {
        shown = as;
        tell();
      }),
    /** The section is told again, and shown the read as it is. */
    release: () =>
      act(() => {
        shown = null;
        tell();
      }),
    /** How often the hold hid the read from the section (a hold that hid nothing proves nothing). */
    hidden: () => hidden,
    /** How many watches of the task the section subscribed to through this. */
    subscriptions: () => subscribed.length,
    /** The read the section subscribed to last, as the store publishes it (whatever the hold): never invented here. */
    real: (): Loadable<ResourceView> | undefined => subscribed.at(-1)?.get(),
  };
}
