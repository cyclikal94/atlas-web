// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createBroadcastSyncChannel,
  SYNC_CHANNEL,
} from "../../src/data/engine/sync-channel";

/**
 * R29 (revision 13): the `atlas-sync` channel is opened by use and closed by its owner. A construction that is discarded (a render React
 * did not keep) must leave no open channel, and a provider that stops must be able to let go of the one it opened.
 */
class Fake {
  static all: Fake[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  posted: unknown[] = [];
  constructor(readonly name: string) {
    Fake.all.push(this);
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  close(): void {
    this.closed = true;
  }
}
const factory = Fake as unknown as typeof BroadcastChannel;
afterEach(() => {
  Fake.all = [];
  vi.restoreAllMocks();
});

describe("the channel is lazy and closable", () => {
  test("constructing one opens nothing", () => {
    createBroadcastSyncChannel(factory);
    expect(Fake.all).toHaveLength(0);
  });

  test("the first `subscribe` opens ONE channel under the data layer's name, and a later use shares it", () => {
    const channel = createBroadcastSyncChannel(factory);
    channel.subscribe(() => undefined);
    channel.subscribe(() => undefined);
    channel.post({ type: "data_changed", account: "a", stores: ["drafts"] });
    expect(Fake.all).toHaveLength(1);
    expect(Fake.all[0]?.name).toBe(SYNC_CHANNEL);
  });

  test("the first `post` alone opens one too", () => {
    const channel = createBroadcastSyncChannel(factory);
    channel.post({ type: "data_changed", account: "a", stores: ["drafts"] });
    expect(Fake.all).toHaveLength(1);
    expect(Fake.all[0]?.posted).toHaveLength(1);
  });

  test("`close` closes the browser channel and stops its handler; it is idempotent, and a closed channel that is never used again opens nothing", () => {
    const channel = createBroadcastSyncChannel(factory);
    channel.subscribe(() => undefined);
    const opened = Fake.all[0] as Fake;
    channel.close();
    channel.close();
    expect(opened.closed).toBe(true);
    expect(opened.onmessage).toBeNull();
    expect(Fake.all).toHaveLength(1);
  });

  test("a use after `close` opens a NEW channel (a restart), and the old listeners still hear it", () => {
    const channel = createBroadcastSyncChannel(factory);
    const heard: string[] = [];
    channel.subscribe((message) => heard.push(message.type));
    channel.close();
    channel.post({ type: "data_changed", account: "a", stores: ["drafts"] });
    expect(Fake.all).toHaveLength(2);
    expect(Fake.all[0]?.closed).toBe(true);
    expect(Fake.all[1]?.closed).toBe(false);
    Fake.all[1]?.onmessage?.({
      data: { type: "data_changed", account: "a", stores: ["drafts"] },
    });
    expect(heard).toEqual(["data_changed"]);
  });

  test("a message that is not in the closed union is dropped, and an unsubscribed listener hears nothing", () => {
    const channel = createBroadcastSyncChannel(factory);
    const heard: unknown[] = [];
    const off = channel.subscribe((message) => heard.push(message));
    const opened = Fake.all[0] as Fake;
    opened.onmessage?.({ data: { type: "nonsense" } });
    expect(heard).toHaveLength(0);
    off();
    opened.onmessage?.({
      data: { type: "data_changed", account: "a", stores: ["drafts"] },
    });
    expect(heard).toHaveLength(0);
  });

  test("a browser with no BroadcastChannel, or one that refuses to open, is a channel that sends and hears nothing", () => {
    const none = createBroadcastSyncChannel(undefined);
    none.subscribe(() => undefined);
    none.post({ type: "data_changed", account: "a", stores: ["drafts"] });
    none.close();
    class Refuses {
      constructor() {
        throw new Error("no");
      }
    }
    const refusing = createBroadcastSyncChannel(
      Refuses as unknown as typeof BroadcastChannel,
    );
    refusing.subscribe(() => undefined);
    refusing.post({ type: "data_changed", account: "a", stores: ["drafts"] });
    refusing.close();
    expect(Fake.all).toHaveLength(0);
  });
});
