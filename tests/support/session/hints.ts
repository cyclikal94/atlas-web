import type { Hint, HintChannel } from "../../../src/session/ports/hints";
import type { World } from "./world";

/**
 * A BroadcastChannel stand-in: per-destination delivery (delay knob D2), NEVER drops a message to an eligible page,
 * never delivers to the sender, and delivers nothing to a frozen or destroyed page (plan 13.1).
 */
export class FakeHintBus {
  private listeners = new Map<string, Set<(hint: Hint) => void>>();
  constructor(private readonly world: World) {}

  channelFor(page: string): HintChannel {
    return {
      post: (hint) => {
        this.world.log({ type: "hint.post", page, hint: hint as unknown });
        for (const [destination, set] of this.listeners) {
          if (destination === page) continue;
          if (
            this.world.isDestroyed(destination) ||
            this.world.isFrozen(destination)
          )
            continue;
          for (const listener of set) {
            this.world.schedule(
              "D2",
              destination,
              { hint: hint.type, from: page },
              () => {
                this.world.log({
                  type: "hint.deliver",
                  page: destination,
                  from: page,
                  hint: hint as unknown,
                });
                listener(structuredClone(hint));
              },
            );
          }
        }
      },
      subscribe: (listener) => {
        let set = this.listeners.get(page);
        if (!set) {
          set = new Set();
          this.listeners.set(page, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
    };
  }
  destroyPage(page: string): void {
    this.listeners.delete(page);
  }
}
