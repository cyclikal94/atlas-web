// @vitest-environment node
import { describe, expect, test } from "vitest";
import { type EngineWorld, engineWorld } from "../support/data/engine-world";

/**
 * WEB-09c R41-MUT (revision 41): the lifecycle the allocation cases rely on (`tests/data/engine-sizing-allocation.test.ts`), qualified on
 * its own over the REAL composition (the production engine, the double of IndexedDB driving itself, fake world time). The invariants:
 *  - the request ceiling is enforced at the issue boundary, whatever drives the world, and ends a run that would ask again without bound;
 *  - `dispose` is stronger than `stop(); await settled()`: it joins the work still in flight and the double's automatic drive, and a
 *    disposed world never moves again, in particular not while a LATER scenario runs;
 *  - what cannot be made quiet is reported, never swallowed.
 * The negative controls show the old teardown (none, or stop and settled alone) letting an old world cross into the next scenario.
 */
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * One scripted answer held OUTSIDE the world's control (like a body read of the platform) until the test releases it: the schedule is
 * chosen by the gate, never by elapsed time.
 */
const held = (w: EngineWorld) => {
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    answer: async () => {
      await arrived;
      return w.emptyPage("cursor-late", true);
    },
    release: () => release(),
  };
};
/** Waits, in real turns, until `done` holds (bounded): the condition selects the outcome, not the time. */
const until = async (done: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; !done() && Date.now() < end; )
    await realDelay(2);
  return done();
};
/** A second, unrelated scenario that drives its own world (the next case of a file); `during` runs while it is under way. */
const anotherScenario = async (
  during: () => Promise<void> = async () => {},
) => {
  const b = await engineWorld({ cursor: "b-0" });
  b.start();
  await b.settle();
  await during();
  await b.settle();
  const report = await b.dispose();
  expect(report.problems).toEqual([]);
};

describe("R41-MUT: the request ceiling ends a run at the issue boundary", () => {
  test("an engine that keeps asking (every page says more) stops at the first request past the ceiling, whoever drives the world", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    for (let i = 0; i < 50; i += 1)
      w.script.push(w.emptyPage(`cursor-${i + 1}`, true));
    w.ceiling = 3;
    w.start();
    // No explicit settle: the double's automatic drive alone runs the engine.
    for (let i = 0; i < 2_000 && w.overrun === null; i += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(w.overrun).toMatchObject({ at: 4, ceiling: 3 });
    expect(w.requests).toHaveLength(4);
    await w.settle();
    // Every engine stopped at once: the failed call is not an answer the engine was credited for, and nothing more is asked.
    expect(w.state()).toEqual({ kind: "not_started" });
    await w.advance(10 * 60_000);
    expect(w.requests).toHaveLength(4);
    expect((await w.dispose()).problems).toEqual([]);
  });

  test("control: within the ceiling nothing is recorded, and the default (no ceiling) is unchanged", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    expect(w.ceiling).toBeNull();
    for (let i = 0; i < 5; i += 1)
      w.script.push(w.emptyPage(`cursor-${i + 1}`, true));
    w.start();
    await w.settle();
    expect(w.requests).toHaveLength(6);
    expect(w.overrun).toBeNull();
    expect(w.state().kind).toBe("idle");
    w.ceiling = 6;
    expect((await w.dispose()).problems).toEqual([]);
    expect(w.overrun).toBeNull();
  });
});

describe("R41-MUT: dispose joins what is in flight; stop and settled alone do not", () => {
  test("NEGATIVE control (the old teardown: none): a world left with an answer in flight works on during the next scenario", async () => {
    const a = await engineWorld({ cursor: "a-0" });
    const answer = held(a);
    a.script.push(answer.answer);
    a.start();
    await a.settle();
    expect(a.inFlight).toBe(1);
    const before = a.requests.length;
    let crossed = false;
    await anotherScenario(async () => {
      // The old world's answer arrives while the other scenario is under way.
      answer.release();
      crossed = await until(() => a.requests.length > before);
    });
    // The old world received it and asked again during the other scenario: nothing ended it.
    expect(crossed).toBe(true);
    expect((await a.dispose()).problems).toEqual([]);
  });

  test("NEGATIVE control: `stop(); await settled()` and a settle leave the answer in flight, unjoined", async () => {
    const a = await engineWorld({ cursor: "a-0" });
    const answer = held(a);
    a.script.push(answer.answer);
    a.start();
    await a.settle();
    a.engine.stop();
    // `settled()` answers for the engine's state, not for its outstanding work (after a stop it does not even resolve): race it.
    await Promise.race([a.engine.settled(), realDelay(5)]);
    await a.settle();
    expect(a.state()).toEqual({ kind: "not_started" });
    expect(a.inFlight).toBe(1);
    // The answer arrives later, as an answer of the platform does; dispose joins it.
    setTimeout(answer.release, 20);
    const report = await a.dispose();
    expect(report.problems).toEqual([]);
    expect(report.witness.inFlight).toBe(0);
  });

  test("POSITIVE: a disposed world is quiet and stays so while the next scenario runs (requests, logs, pending work unchanged)", async () => {
    const a = await engineWorld({ cursor: "a-0" });
    const answer = held(a);
    a.script.push(answer.answer);
    a.start();
    await a.settle();
    expect(a.inFlight).toBe(1);
    setTimeout(answer.release, 20);
    const report = await a.dispose();
    expect(report.problems).toEqual([]);
    expect(report.witness).toMatchObject({
      inFlight: 0,
      pending: 0,
      held: 0,
      holdsOpen: 0,
    });
    await anotherScenario();
    await realDelay(40);
    expect(a.requests).toHaveLength(report.witness.requests);
    expect(a.env.world.logs).toHaveLength(report.witness.logs);
    expect(a.env.world.pendingCount()).toBe(0);
  });

  test("every engine is owned: the replaced one of a reload, a fork, and a held persistence request are all ended", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.gate.queue = true;
    w.start();
    await w.settle();
    // The page's commit waits for the persistence gate: held operations the test owns.
    expect(w.gate.waiting.length).toBeGreaterThan(0);
    w.reload();
    const forked = w.fork("B");
    w.start();
    await w.settle();
    expect(w.engines).toHaveLength(3);
    expect(w.engines).toContain(forked);
    const report = await w.dispose();
    expect(report.problems).toEqual([]);
    expect(w.gate.waiting).toHaveLength(0);
    expect(report.witness.holdsOpen).toBe(0);
    expect(report.witness.states).toEqual([
      "not_started",
      "not_started",
      "not_started",
    ]);
  });

  test("an idle world's future poll is a valid state, not running work: dispose delivers it inertly and asks nothing", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.start();
    await w.settle();
    expect(w.state().kind).toBe("idle");
    expect(w.env.world.pendingCount()).toBeGreaterThan(0);
    const issued = w.requests.length;
    const report = await w.dispose();
    expect(report.problems).toEqual([]);
    expect(w.requests).toHaveLength(issued);
    expect(report.witness.pending).toBe(0);
  });
});

describe("R41-MUT: what cannot be made quiet is reported, not swallowed", () => {
  test("an answer that never arrives within the teardown is reported (and quiet once it does)", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    let answer: (() => void) | null = null;
    w.script.push(
      () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(w.emptyPage("cursor-1"));
        }),
    );
    w.start();
    await w.settle();
    const first = await w.dispose({ rounds: 2, joinMs: 20 });
    expect(first.problems.join("\n")).toMatch(/did not become quiet/);
    expect(first.witness.inFlight).toBe(1);
    (answer as unknown as () => void)();
    const second = await w.dispose();
    expect(second.problems).toEqual([]);
  });

  test("a world halted by its event bound is reported as such", async () => {
    const w = await engineWorld({ cursor: "cursor-0" });
    w.env.world.maxLogs = w.env.world.logs.length + 2;
    w.start();
    await w.settle();
    expect(w.env.world.livelocked).toBe(true);
    const report = await w.dispose({ rounds: 2 });
    expect(report.problems.join("\n")).toMatch(/halted/);
  });
});
