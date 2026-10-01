// @vitest-environment node
import { describe, expect, test } from "vitest";
import { evaluate } from "../../src/session/kernel/evaluate";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import { newWorld, signedInPage } from "../support/session/scenarios";

/**
 * F-READFAIL-*: a page that cannot read `atlas-auth` fails CLOSED (matrix 3.7.2 item 3). The read-failure card lives in a
 * separate root, so changing the view alone left an already displayed protected tree mounted, visible and exposed to
 * assistive technology beneath it. The failure now closes what is displayed, mounted or being reserved, synchronously and
 * before the card is published; a later successful read reopens only through the normal exposure protocol.
 */
const failReads = (f: Fixture, page: FakePage, mode: "abort" | "pending") =>
  f.store.inject({
    match: (tx) => tx.label === "read" && tx.page === page.id,
    mode,
  });

const readFailureCard = (page: FakePage) =>
  expect(page.session.view.get()).toMatchObject({
    kind: "neutral",
    state: "1e.read_failure",
  });

describe("a read that fails after the page has displayed", () => {
  test("an aborted read unmounts the protected tree in the same step, then a good read reopens it through an exposure", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    expect(l.page.surface.mounted?.account).toBe(l.account);
    const attached = l.page.surface.attachCount;
    const stop = failReads(f, l.page, "abort");
    await f.runWith(evaluate(l.page.kernel, "review-read-failure"));
    readFailureCard(l.page);
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.surface.level0).toBe(true);
    expect(l.page.kernel.memory.display).toEqual({ kind: "gated" });
    expect(l.page.kernel.memory.mountedAccount).toBeNull();
    expect(checkProperties(f)).toEqual([]);

    // Nothing reappears while reads keep failing, however often the page retries.
    await f.world.advance(10_000);
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.surface.attachCount).toBe(attached);
    readFailureCard(l.page);

    // A later successful read reopens ONLY by the exposure protocol: a new exposure lease, then `act`.
    stop();
    const acts = f.world.logs.filter(
      (e) => e.type === "trace.act.begin",
    ).length;
    await f.world.advance(40_000);
    expect(l.page.session.view.get().kind).toBe("displaying");
    expect(l.page.surface.mounted?.account).toBe(l.account);
    expect(l.page.surface.attachCount).toBe(attached + 1);
    expect(
      f.world.logs.filter((e) => e.type === "trace.act.begin").length,
    ).toBe(acts + 1);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a read that never completes (stalled past the stall interval) fails closed as well", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const stop = failReads(f, l.page, "pending");
    const reading = evaluate(l.page.kernel, "review-stalled-read");
    await f.world.advance(l.page.kernel.config.recordingStallMs + 1);
    await reading;
    readFailureCard(l.page);
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.kernel.memory.display).toEqual({ kind: "gated" });
    stop();
  });

  test("a hidden page, whose tree is still mounted (inert) behind the level-0 gate, unmounts it too", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    l.page.hide();
    await f.settle();
    expect(l.page.surface.mounted).not.toBeNull();
    failReads(f, l.page, "abort");
    await f.runWith(evaluate(l.page.kernel, "review-hidden-read-failure"));
    readFailureCard(l.page);
    expect(l.page.surface.mounted).toBeNull();
    expect(l.page.kernel.memory.mountedAccount).toBeNull();
  });

  test("the durable record is untouched: nothing is written, and another page that can read still displays", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = f.addPage();
    await f.boot(other);
    expect(other.surface.mounted?.account).toBe(l.account);
    const before = JSON.stringify(f.store.records);
    failReads(f, l.page, "abort");
    await f.runWith(evaluate(l.page.kernel, "review-read-failure"));
    expect(l.page.surface.mounted).toBeNull();
    expect(other.surface.mounted?.account).toBe(l.account);
    expect(other.session.view.get().kind).toBe("displaying");
    expect(JSON.stringify(f.store.records)).toBe(before);
  });
});

describe("a read that fails while an exposure is being reserved", () => {
  test("the attempt is cancelled, the held `act` refuses, and nothing is mounted", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const other = f.addPage();
    // Hold the render task that runs `act`: the exposure has its lease (RESERVED) but has not displayed.
    f.world.setKnob("D3", "unbounded", (meta) => meta.page === other.id);
    await f.boot(other);
    expect(other.kernel.memory.exposure?.state).toBe("RESERVED");
    expect(other.surface.mounted).toBeNull();

    const stop = failReads(f, other, "abort");
    await f.runWith(evaluate(other.kernel, "review-read-failure"));
    readFailureCard(other);
    expect(other.kernel.memory.exposure).toBeNull();

    // The held task now runs: its own state says CANCELLED, so it lifts and mounts nothing.
    f.world.release("D3");
    await f.world.runUntilIdle();
    expect(other.surface.mounted).toBeNull();
    expect(other.surface.attachCount).toBe(0);
    expect(other.kernel.memory.display).toEqual({ kind: "gated" });
    expect(checkProperties(f)).toEqual([]);

    // Reads recover: the page exposes again, through a fresh exposure.
    stop();
    await f.world.advance(40_000);
    f.world.release("D3");
    await f.world.runUntilIdle();
    expect(other.surface.mounted?.account).toBe(l.account);
    expect(other.surface.attachCount).toBe(1);
    expect(checkProperties(f)).toEqual([]);
  });
});
