import { afterEach, describe, expect, test, vi } from "vitest";
import { createBrowserRuntime } from "../../src/data/ui/browser-env";
import { sessionDouble } from "../helpers/session-double";

/**
 * R29 (revision 13): what the browser composition opens, it closes. It opens the `atlas-sync` channel for the wipe responder, and its
 * `dispose` (which the provider calls when a lifetime ends, whether an unmount or the cleanup of a replayed effect) lets it go.
 * The composition is built over the page's own registry and the stub of `navigator.locks`; nothing opens a database here.
 */
class Fake {
  static all: Fake[] = [];
  onmessage: unknown = null;
  closed = false;
  constructor(readonly name: string) {
    Fake.all.push(this);
  }
  postMessage(): void {}
  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  Fake.all = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the browser composition", () => {
  test("opens the sync channel for its wipe responder, and `dispose` closes it", () => {
    vi.stubGlobal("BroadcastChannel", Fake);
    const built = createBrowserRuntime(sessionDouble());
    expect(Fake.all.filter((channel) => !channel.closed)).toHaveLength(1);
    expect(Fake.all[0]?.name).toBe("atlas-sync");
    built.dispose();
    expect(Fake.all.filter((channel) => !channel.closed)).toHaveLength(0);
  });

  test("each composition owns its channel: disposing one leaves another's open", () => {
    vi.stubGlobal("BroadcastChannel", Fake);
    const first = createBrowserRuntime(sessionDouble());
    const second = createBrowserRuntime(sessionDouble());
    first.dispose();
    expect(Fake.all.map((channel) => channel.closed)).toEqual([true, false]);
    second.dispose();
    expect(Fake.all.every((channel) => channel.closed)).toBe(true);
  });
});
