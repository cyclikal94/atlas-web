// @vitest-environment node
import { describe, expect, test } from "vitest";
import { checkProperties } from "../support/session/properties";
import {
  holdLock,
  installAttempt,
  newWorld,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * A page HIDDEN behind the level-0 gate still has its (inert) tree mounted. When the durable record then closes the SAME
 * account for it (a fence, a gating attempt), nothing protected may remain: the tree is unmounted (level 1), never merely
 * left inert behind a neutral state. Found by the real-engine gate spec (S-GATE) after the fake matrices had passed: those
 * cover an account that CHANGES and a page that is displaying, not this combination.
 */
describe("a hidden page whose record closes the same account", () => {
  const fence = (
    f: Awaited<ReturnType<typeof newWorld>>,
    account: string,
    epoch: number,
  ) => {
    const state = stateOf(f);
    state.fence_seq += 1;
    state.fences[account] = [
      {
        seq: state.fence_seq,
        epoch,
        obs_id: "hidden-fence",
        kind: "invalid_session",
        reason: "unauthenticated",
        created_at: "2026-09-30T12:00:00.000Z",
      },
    ];
  };

  test("a fence recorded while hidden unmounts the tree on becoming visible, and the neutral card is named", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect(l.page.surface.mounted?.account).toBe(l.account);
    l.page.hide();
    await f.settle();
    expect(l.page.surface.mounted).not.toBeNull(); // still mounted, inert, behind the gate
    fence(f, l.account, l.epoch);
    l.page.show();
    await f.settle();
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1b",
    });
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same when the page learns of it by the periodic scan rather than a visibility event", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    l.page.hide();
    await f.settle();
    fence(f, l.account, l.epoch);
    // Still hidden: a hint is how a hidden page hears of it.
    f.bus.channelFor("p-other").post({ type: "auth_state_changed" });
    await f.settle();
    expect(l.page.surface.mounted).toBeNull();
  });

  test("a gating attempt begun (and still owned) elsewhere while hidden unmounts it as well", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    l.page.hide();
    await f.settle();
    // Another window is mid-activation: the record says so and its owner lock is held, so the attempt is live.
    installAttempt(f, { epoch: l.epoch + 1, phase: "activating" });
    const release = await holdLock(f, "owner", `atlas-attempt-${l.epoch + 1}`);
    l.page.show();
    await f.settle();
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.session.view.get()).toMatchObject({
      kind: "neutral",
      state: "1c.finishing",
    });
    release();
  });

  test("with nothing recorded, becoming visible again lifts the SAME tree (no remount)", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const attaches = l.page.surface.attachCount;
    l.page.hide();
    await f.settle();
    l.page.show();
    await f.settle();
    expect(l.page.surface.mounted?.account).toBe(l.account);
    expect(l.page.surface.attachCount).toBe(attaches + 1);
  });
});
