// @vitest-environment node
import { describe, expect, test } from "vitest";
import { engineWorld } from "../support/data/engine-world";
import { outboxWorld } from "../support/data/outbox-world";
import { draftRow } from "../support/data/rows";

/**
 * R8: `start()`, `stop()` and `start()` while an old request is outstanding. The step of the old generation keeps the loop busy; the
 * new generation's first tick is coalesced into it and, before the correction, nothing ran it when the old step unwound. WEB-09b
 * uses this public lifecycle on every ownership change, so progress must never depend on an unrelated wake. FIXTURE evidence: the
 * network is a script and time is fake.
 */
describe("the sync engine's restart while a request is outstanding (R8)", () => {
  test("stop and start with the first response held: the replacement runs when the old step unwinds, without any other wake", async () => {
    const w = await engineWorld();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(1);

    w.engine.stop();
    w.start();
    await w.settle();
    // The old step is still waiting: the new generation has not issued its own request yet (one request in flight at a time).
    expect(w.requests).toHaveLength(1);

    release(w.emptyPage());
    await w.settle();
    expect(w.requests).toHaveLength(2);
    expect(w.state().kind).toBe("idle");
  });

  test("the old answer is discarded, not applied under the new generation: nothing of it is counted or committed", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    w.engine.stop();
    w.start();
    release(w.status(500));
    await w.settle();
    // A 500 for a generation that no longer exists is not a failure of the new one: no back-off was recorded for it.
    expect(
      w.sync().read_retry_states.sync?.backing_off_since ?? null,
    ).toBeNull();
    expect(w.requests.length).toBeGreaterThanOrEqual(2);
  });

  test("stop with a request held, and no start: nothing is scheduled afterwards", async () => {
    const w = await engineWorld();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    w.engine.stop();
    release(w.emptyPage());
    await w.settle();
    await w.advance(120_000);
    expect(w.requests).toHaveLength(1);
    expect(w.state().kind).toBe("not_started");
  });

  test("start, stop, start, stop, start with one request outstanding: one replacement runs, once", async () => {
    const w = await engineWorld();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    for (let i = 0; i < 2; i += 1) {
      w.engine.stop();
      w.start();
    }
    release(w.emptyPage());
    await w.settle();
    expect(w.requests).toHaveLength(2);
  });

  test("a change of ownership (the signal aborts) with a request held, then a new start: the replacement runs", async () => {
    const w = await engineWorld({ ownerToken: "owner-1" });
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.start();
    await w.settle();
    // Leadership is lost, then gained again by this page with a fresh ownership.
    w.ownership.abort();
    const next = new AbortController();
    w.engine.start({ token: "owner-2", signal: next.signal });
    release(w.emptyPage());
    await w.settle();
    expect(w.requests).toHaveLength(2);
  });
});

describe("the outbox dispatcher's restart while a send is outstanding (R8, audit)", () => {
  test("stop and start with a command's answer held: the replacement runs when the old step unwinds, and the same key is resent once", async () => {
    const w = await outboxWorld();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.put("drafts", [draftRow({ local_id: "d1", created_seq: 1 })]);
    w.start();
    await w.settle();
    expect(w.sent).toHaveLength(1);

    w.dispatcher.stop();
    w.start();
    await w.settle();
    // One request in flight at a time (`maxInFlight` is 1): the new generation waits for the old step.
    expect(w.sent).toHaveLength(1);

    release(w.receipt());
    await w.settle();
    // The old answer was discarded by the dead generation, so the draft is still `in_flight` and is resent under its own key,
    // which the server answers with the same receipt (an idempotent resend, never a second command).
    expect(w.sent.map((s) => s.key)).toEqual(["d1", "d1"]);
    expect(
      w
        .drafts()
        .filter((d) => d.status === "queued" || d.status === "in_flight"),
    ).toEqual([]);
  });

  test("stop with a send held and no start: nothing is sent afterwards", async () => {
    const w = await outboxWorld();
    let release: (response: Response) => void = () => undefined;
    w.script.push(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    w.put("drafts", [draftRow({ local_id: "d1", created_seq: 1 })]);
    w.start();
    await w.settle();
    w.dispatcher.stop();
    release(w.receipt());
    await w.settle();
    await w.advance(120_000);
    expect(w.sent).toHaveLength(1);
    expect(w.dispatcher.state.get().kind).toBe("not_started");
  });
});

describe("a commit the persistence hold refuses (R2)", () => {
  test("the sync engine applies nothing when the record names another identity: the cursor does not move and nothing is counted as a failure", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.gate.mode = "stale";
    w.start();
    await w.settle();
    expect(w.sync().cursor).toBe("cursor-0");
    expect(w.sync().read_retry_states.sync ?? null).toBeNull();
    expect(w.state()).toEqual({ kind: "waiting", reason: "paused_by_session" });
    expect(w.gate.open).toBe(0);
  });

  test("an unverifiable commit is asked again, paced, never counted, and applies once the hold can be had", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.gate.mode = "unavailable";
    w.start();
    await w.settle();
    expect(w.sync().cursor).toBe("cursor-0");
    const asked = w.requests.length;
    await w.advance(2_000);
    await w.advance(4_000);
    expect(w.requests.length).toBeGreaterThan(asked);
    expect(w.sync().read_retry_states.sync ?? null).toBeNull();
    w.gate.mode = "held";
    for (let i = 0; i < 12 && w.sync().cursor === "cursor-0"; i += 1)
      await w.advance(8_000);
    expect(w.sync().cursor).not.toBe("cursor-0");
    expect(w.state().kind).toBe("idle");
    // Every commit that persisted did so inside a hold that was released.
    expect(w.gate.open).toBe(0);
  });

  test("the dispatcher leaves a draft exactly as it was when its receipt cannot be verified, and resends it under the same key", async () => {
    const w = await outboxWorld();
    w.put("drafts", [draftRow({ local_id: "d1", created_seq: 1 })]);
    w.gate.mode = "unavailable";
    w.start();
    await w.settle();
    // Nothing was claimed or applied while the gate refuses: the draft is untouched and uncounted.
    expect(w.drafts()[0]).toMatchObject({ status: "queued", attempts: 0 });
    w.gate.mode = "held";
    for (
      let i = 0;
      i < 10 &&
      w.drafts().length > 0 &&
      w.drafts()[0]?.status !== "acknowledged";
      i += 1
    )
      await w.advance(8_000);
    expect(w.sent.map((s) => s.key).every((key) => key === "d1")).toBe(true);
    expect(w.gate.open).toBe(0);
  });
});
