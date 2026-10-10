import type {
  SyncChannel,
  SyncMessage,
} from "../../../src/data/engine/sync-channel";
import type { World } from "../session/world";

/**
 * A BroadcastChannel stand-in for the data layer's `atlas-sync` channel: per-destination delivery through the world (delay knob
 * D2), never to the sender, nothing to a frozen or destroyed page. Messages are structured-cloned and every one is logged.
 */
export class FakeSyncBus {
  private listeners = new Map<string, Set<(message: SyncMessage) => void>>();
  readonly posted: Array<{ from: string; message: SyncMessage }> = [];
  constructor(private readonly world: World) {}

  channelFor(page: string): SyncChannel {
    return {
      post: (message) => {
        this.posted.push({ from: page, message: structuredClone(message) });
        this.world.log({
          type: "sync.post",
          page,
          message: message as unknown,
        });
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
              { sync: message.type, from: page },
              () => {
                this.world.log({
                  type: "sync.deliver",
                  page: destination,
                  from: page,
                  message: message as unknown,
                });
                listener(structuredClone(message));
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
        return () => {
          set?.delete(listener);
        };
      },
    };
  }

  destroyPage(page: string): void {
    this.listeners.delete(page);
  }
}
