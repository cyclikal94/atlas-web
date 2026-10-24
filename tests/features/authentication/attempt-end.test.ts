// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  attemptEnd,
  watchAttemptEnd,
} from "../../../src/features/authentication/attempt-end";
import type { Identity, SessionView, Store } from "../../../src/session";
import { sourceText } from "../../support/source-text";

/**
 * WEB-08c §2.4 (D-8c-04): the `1c.ended` producer over a fake sequence of the session's `view` and `identity`. Each case is a 1c
 * transition; the real-kernel composed cases are the lifecycle traces (T7, T20).
 */
class Cell<T> implements Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(next: T): void {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const who = (account: string, epoch: number): Identity =>
  ({ account_id: account, epoch, session_id: `s-${epoch}` }) as Identity;
const displaying = (account: string, epoch: number): SessionView =>
  ({ kind: "displaying", account_id: account, epoch }) as SessionView;
const neutral = (state: string): SessionView =>
  ({ kind: "neutral", state }) as SessionView;
const signedOut = (state: string | null = null): SessionView =>
  ({ kind: "signed_out", state }) as SessionView;

function world(view: SessionView, identity: Identity | null) {
  const v = new Cell(view);
  const i = new Cell(identity);
  const raised: string[] = [];
  const stop = watchAttemptEnd(
    { view: v, identity: i },
    { add: (entry) => raised.push(entry.kind) },
  );
  return { v, i, raised, stop };
}

describe("watchAttemptEnd: when 'That sign-in didn't finish' is raised", () => {
  test("signed out, an attempt resolved not_activated: raised once", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.finishing"));
    w.v.set(neutral("1c.resolving"));
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended"]);
  });

  test("A was still valid: A displays again at the same epoch: raised (the in-tree notice)", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.finishing"));
    w.v.set(neutral("1c.resolving"));
    w.v.set(displaying(A, 3));
    expect(w.raised).toEqual(["ended"]);
  });

  test("resolving offline, then back: still one notice (1c.offline belongs to the resolution)", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.resolving"));
    w.v.set(neutral("1c.offline"));
    w.v.set(neutral("1c.resolving"));
    w.v.set(neutral("1c.lock_wait"));
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended"]);
  });

  test("MU-8C-08: settled at a NEWER epoch (the attempt finished after all): nothing", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.resolving"));
    w.i.set(who(B, 4));
    w.v.set(displaying(B, 4));
    expect(w.raised).toEqual([]);
  });

  test("same-account re-authentication settled at a newer epoch: nothing", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.resolving"));
    w.i.set(who(A, 4));
    w.v.set(displaying(A, 4));
    expect(w.raised).toEqual([]);
  });

  test("MU-8C-07: an exit to a fence (1b, 1d, 1a.*, 1e.*) or to catching up says what happened itself: nothing", () => {
    for (const exit of [
      neutral("1b"),
      neutral("1d"),
      neutral("1a.confirming"),
      neutral("1e.checking"),
      neutral("1e.session_online"),
      neutral("2"),
      signedOut("1b"),
      signedOut("1a.ended_elsewhere"),
    ]) {
      const w = world(displaying(A, 3), who(A, 3));
      w.v.set(neutral("1c.resolving"));
      w.v.set(exit);
      expect(w.raised, JSON.stringify(exit)).toEqual([]);
      w.stop();
    }
  });

  test("a gating attempt that was never indeterminate (finishing → settled or refused) raises nothing", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.finishing"));
    w.v.set(signedOut());
    w.v.set(neutral("1c.finishing"));
    w.i.set(who(A, 1));
    w.v.set(displaying(A, 1));
    expect(w.raised).toEqual([]);
  });

  test("a booting view between is not an exit; the next one decides", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.resolving"));
    w.v.set({ kind: "booting" } as SessionView);
    expect(w.raised).toEqual([]);
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended"]);
  });

  test("an attempt found indeterminate at boot (begun before a reload or in another tab, T5/T8) is covered from the first view", () => {
    const w = world(neutral("1c.resolving"), null);
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended"]);
  });

  test("repeated notifications collapse: one resolution, one notice; a second resolution, a second notice", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.resolving"));
    w.v.set(neutral("1c.resolving"));
    w.i.set(null);
    w.v.set(signedOut());
    w.v.set(signedOut());
    w.i.set(null);
    expect(w.raised).toEqual(["ended"]);
    w.v.set(neutral("1c.resolving"));
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended", "ended"]);
  });

  test("stopping it unsubscribes", () => {
    const w = world(signedOut(), null);
    w.stop();
    w.v.set(neutral("1c.resolving"));
    w.v.set(signedOut());
    expect(w.raised).toEqual([]);
  });
});

describe("the controller's own signal: an attempt that answered `gating` (found in the real engines, E-L3)", () => {
  test("the resolution ended BEFORE 1c.resolving was ever published: the controller's signal judges that exit (same epoch, A displays): raised once", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.finishing"));
    w.v.set(displaying(A, 3));
    expect(w.raised).toEqual([]);
    attemptEnd.indeterminate(who(A, 3));
    expect(w.raised).toEqual(["ended"]);
    attemptEnd.indeterminate(who(A, 3));
    expect(w.raised).toEqual(["ended"]);
  });

  test("signalled while still gating: it arms the watcher, and the exit raises it once", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.finishing"));
    attemptEnd.indeterminate(null);
    expect(w.raised).toEqual([]);
    w.v.set(signedOut());
    expect(w.raised).toEqual(["ended"]);
  });

  test("both signals for one resolution: one message", () => {
    const w = world(signedOut(), null);
    w.v.set(neutral("1c.resolving"));
    w.v.set(signedOut());
    attemptEnd.indeterminate(null);
    expect(w.raised).toEqual(["ended"]);
  });

  test("the signal after a newer settlement, or after an exit to a fence: nothing", () => {
    const settledB = world(displaying(A, 3), who(A, 3));
    settledB.v.set(neutral("1c.finishing"));
    settledB.i.set(who(B, 4));
    settledB.v.set(displaying(B, 4));
    attemptEnd.indeterminate(who(A, 3));
    expect(settledB.raised).toEqual([]);
    settledB.stop();
    const fenced = world(displaying(A, 3), who(A, 3));
    fenced.v.set(neutral("1c.finishing"));
    fenced.v.set(neutral("1b"));
    attemptEnd.indeterminate(who(A, 3));
    expect(fenced.raised).toEqual([]);
    fenced.stop();
  });

  test("MU-8C-15: the password sign-in tells the watcher when its activation is indeterminate", () => {
    const source = sourceText("src/features/authentication/controller.ts");
    expect(source).toMatch(
      /if \(outcome\.kind === "gating"\) attemptEnd\.indeterminate\(before\);/,
    );
  });
});

describe("interim views between the resolution and its outcome are not the exit (found in the real engines, E-L3)", () => {
  test("1c.resolving → 3 (a withdrawn recovery report) → 1e.checking → A displays: raised once, at the display", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.resolving"));
    w.v.set(neutral("3"));
    w.v.set(neutral("1e.checking"));
    expect(w.raised).toEqual([]);
    w.v.set(displaying(A, 3));
    expect(w.raised).toEqual(["ended"]);
  });

  test("the controller's signal during the interim views arms; the outcome decides", () => {
    const w = world(displaying(A, 3), who(A, 3));
    w.v.set(neutral("1c.finishing"));
    w.v.set(neutral("1e.checking"));
    attemptEnd.indeterminate(who(A, 3));
    expect(w.raised).toEqual([]);
    w.v.set(neutral("1b"));
    expect(w.raised).toEqual([]);
  });
});
