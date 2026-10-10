// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { invalidateOperation } from "../../src/data/model/retry";
import { readMerged } from "../../src/data/plans/outbox";
import { resetSizingFloor } from "../../src/data/plans/sync-writers";
import { controllerProbe } from "../support/data/controller-world";
import { engineWorld } from "../support/data/engine-world";
import { scopeOf } from "../support/data/marker-storage";
import { cacheRow, draftRow } from "../support/data/rows";
import { uuid } from "../support/data/sync-pages";

/**
 * R13 (revision 10): the cache stays hidden until its display state is ESTABLISHED. The fifth review reproduced it over the production
 * controller: with the first read of the sync facts delayed or failed, or a later read failing, the controller's cache state was
 * `unknown`, which a gate reads as `open`, and a cache the database (or the durable failure counter, or the fallback marker) said was
 * invalid was shown. `unknown` now means ONLY "no open database"; an open database whose facts are pending or unreadable is
 * `unverified` and hidden, and a read that failed AFTER a good one leaves that one standing.
 *
 * What these tests drive is the PRODUCTION controller (`createDataEnv`), plans and store over the double of IndexedDB, with fake time,
 * and what they check is what the screens derive: the gate. FIXTURE evidence: a named injected transaction fault, not a native fault
 * (the native cases are E-C7 in `fixture.data-sync.spec.ts`). A FOLLOWER tab is a controller with no engine; a RELOAD is a second
 * controller over the same database and markers.
 */
const FACTS = "data.readSyncFacts";
const OP = invalidateOperation("cursor-0");
const FIRST_WAIT = DATA_CONFIG.factsReadRetryMs;
const WAITS = (() => {
  const out: number[] = [];
  for (let n = 0; n < 9; n += 1)
    out.push(Math.min(DATA_CONFIG.factsReadRetryMaxMs, FIRST_WAIT * 2 ** n));
  return out;
})();

type Record = "invalid" | "counter" | "marker" | "none";
type Mode = "pending" | "error" | "abort";

async function build(record: Record) {
  const w = await engineWorld({ cursor: "cursor-0" });
  w.put("cache", [
    cacheRow({ id: uuid(9), value: { name: "retained private resource" } }),
  ]);
  w.put("drafts", [draftRow({ local_id: "kept", status: "queued" })]);
  if (record === "invalid")
    w.setSync({ cache_status: "invalid", local_write_streaks: {} });
  if (record === "counter")
    w.setSync({
      local_write_streaks: { [OP]: DATA_CONFIG.localWritePauseAfter },
    });
  if (record === "marker") w.markers.set(scopeOf(w.service.account), OP);
  return w;
}

type World = Awaited<ReturnType<typeof build>>;

/** Counts the reads of the sync facts. Arm it BEFORE a fault: the double stops at the first rule that matches, and this never does. */
function countReads(w: World): () => number {
  let reads = 0;
  w.env.idb.inject({
    match: (tx) => {
      if (tx.label === FACTS) reads += 1;
      return false;
    },
    mode: "error",
    times: 1,
  });
  return () => reads;
}

const failFacts = (w: World, mode: Mode, times = 1) =>
  w.env.idb.inject({ match: (tx) => tx.label === FACTS, mode, times });

/** Any write to the singleton re-evaluates a live read of it (the double pushes a commit to the watchers of the stores it touched). */
const nudge = (w: World, ui?: Awaited<ReturnType<typeof controllerProbe>>) => {
  const service = ui?.ui.service() ?? w.service;
  return service.store.run(resetSizingFloor, {
    incarnationId: service.incarnationId,
  });
};

/** What the screens may still use while the cache is hidden: the cached row is readable and the drafts are all there. */
async function retained(
  w: World,
  ui: Awaited<ReturnType<typeof controllerProbe>>,
) {
  const cached = await ui.ui.service()?.store.run(readMerged, {
    incarnationId: w.service.incarnationId,
    id: uuid(9),
  });
  const summary = ui.ui.summary.get();
  return {
    cached: cached?.base?.id,
    drafts: w.rows("drafts").length,
    queued: summary.status === "ready" ? summary.value.waiting : null,
  };
}

describe("the first read of the facts is delayed or fails", () => {
  const records: Record[] = ["invalid", "counter", "marker"];
  const modes: Mode[] = ["pending", "error", "abort"];

  for (const record of records)
    for (const mode of modes)
      test(`${record} + a ${mode} first read: hidden until a read says otherwise, and the shell and drafts stay usable`, async () => {
        const w = await build(record);
        failFacts(w, mode);
        const ui = await controllerProbe(w, { leader: false });
        expect(ui.ui.inputs.get().cache).toBe("unverified");
        expect(ui.gate()).toBe("refreshing");
        // Nothing about the cache is shown, and nothing else is affected: the row is there, the drafts are there and counted.
        expect(await retained(w, ui)).toEqual({
          cached: uuid(9),
          drafts: 1,
          queued: 1,
        });
        // The read lands (the failed one is made again; the pending one is re-evaluated by the next write): every record still hides it.
        if (mode === "pending") {
          await nudge(w);
          await w.settle();
        } else await w.advance(FIRST_WAIT);
        expect(ui.ui.inputs.get().cache).not.toBe("unverified");
        expect(ui.gate()).toBe("refreshing");
        expect(ui.gate()).not.toBe("open");
        ui.dispose();
        w.engine.stop();
      });

  for (const mode of modes)
    test(`no record + a ${mode} first read: hidden while unverified, open when a read says it is valid`, async () => {
      const w = await build("none");
      failFacts(w, mode);
      const ui = await controllerProbe(w, { leader: false });
      expect(ui.gate()).toBe("refreshing");
      if (mode === "pending") {
        await nudge(w);
        await w.settle();
      } else await w.advance(FIRST_WAIT);
      expect(ui.ui.inputs.get().cache).toBe("valid");
      expect(ui.gate()).toBe("open");
      ui.dispose();
      w.engine.stop();
    });

  test("control: a valid cache with no fault opens at once, with exactly one read of the facts", async () => {
    const w = await build("none");
    const reads = countReads(w);
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.ui.inputs.get().cache).toBe("valid");
    expect(ui.gate()).toBe("open");
    await w.advance(DATA_CONFIG.factsReadRetryMaxMs * 4);
    expect(reads()).toBe(1);
    ui.dispose();
    w.engine.stop();
  });

  test("a reload (a new controller) over a record the database holds is hidden before and after its first read", async () => {
    const w = await build("counter");
    const first = await controllerProbe(w, { leader: false });
    expect(first.gate()).toBe("refreshing");
    first.dispose();
    failFacts(w, "pending");
    const reloaded = await controllerProbe(w, { leader: false });
    expect(reloaded.gate()).toBe("refreshing");
    await nudge(w);
    await w.settle();
    expect(reloaded.ui.inputs.get().cache).toBe("invalid");
    expect(reloaded.gate()).toBe("refreshing");
    reloaded.dispose();
    w.engine.stop();
  });
});

describe("a later read fails after the display state was established", () => {
  for (const record of ["invalid", "counter", "marker"] as const)
    for (const mode of ["error", "abort"] as const)
      test(`${record} established, then a ${mode} read: hidden throughout, and when the read is made again`, async () => {
        const w = await build(record);
        const ui = await controllerProbe(w, { leader: false });
        expect(ui.gate()).toBe("refreshing");
        failFacts(w, mode);
        await nudge(w);
        await w.settle();
        expect(ui.gate()).toBe("refreshing");
        await w.advance(FIRST_WAIT);
        expect(ui.gate()).toBe("refreshing");
        ui.dispose();
        w.engine.stop();
      });

  test("the invalid state that stood stays hidden until a read says it is valid, and then opens", async () => {
    const w = await build("invalid");
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.gate()).toBe("refreshing");
    // The facts cannot be read for a while, and meanwhile another tab's recovery makes the cache valid.
    failFacts(w, "error", 2);
    await nudge(w);
    await w.settle();
    w.setSync({ cache_status: "valid", local_write_streaks: {} });
    expect(ui.gate()).toBe("refreshing");
    await w.advance(FIRST_WAIT);
    expect(ui.gate()).toBe("refreshing");
    await w.advance(FIRST_WAIT * 2);
    expect(ui.ui.inputs.get().cache).toBe("valid");
    expect(ui.gate()).toBe("open");
    ui.dispose();
    w.engine.stop();
  });

  test("a valid state that stood is left standing through a failed read (the last good read), and a read that lands corrects it", async () => {
    const w = await build("none");
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.gate()).toBe("open");
    failFacts(w, "error");
    await nudge(w);
    await w.settle();
    expect(ui.ui.inputs.get().cache).toBe("valid");
    expect(ui.gate()).toBe("open");
    // Meanwhile another tab's invalidation landed: the read made again says so.
    w.setSync({ cache_status: "invalid" });
    await w.advance(FIRST_WAIT);
    expect(ui.ui.inputs.get().cache).toBe("invalid");
    expect(ui.gate()).toBe("refreshing");
    ui.dispose();
    w.engine.stop();
  });

  test("the chip's last-synced time is kept through a failed read, not blanked", async () => {
    const w = await build("none");
    w.setSync({ last_synced_at: "2026-10-01T10:00:00.000Z" });
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.ui.inputs.get().lastSyncedAt).toBe("2026-10-01T10:00:00.000Z");
    failFacts(w, "error");
    await nudge(w);
    await w.settle();
    expect(ui.ui.inputs.get().lastSyncedAt).toBe("2026-10-01T10:00:00.000Z");
    ui.dispose();
    w.engine.stop();
  });
});

describe("an invalidation the engine holds survives a failed read of the facts", () => {
  test("the hold hides the cache through a failed read, whatever the database says, and the read made again does not release it", async () => {
    const w = await build("none");
    // The invalidation was admitted and its write fails everywhere: the database says `valid`, only this tab's engine knows.
    w.env.idb.inject({
      match: (tx) => tx.label === "data.invalidateCache",
      mode: "error",
      times: 100,
    });
    w.env.idb.inject({
      match: (tx) => tx.label === "data.recordLocalWriteOutcome",
      mode: "error",
      times: 100,
    });
    w.script.push(w.status(410, { body: { code: "resync_required" } }));
    const ui = await controllerProbe(w, { leader: true });
    w.start();
    await w.settle();
    expect(w.engine.invalidations.get().map((hold) => hold.operation)).toEqual([
      OP,
    ]);
    expect(ui.gate()).toBe("refreshing");
    failFacts(w, "error");
    await nudge(w);
    await w.settle();
    expect(ui.gate()).toBe("refreshing");
    await w.advance(FIRST_WAIT);
    expect(ui.gate()).toBe("refreshing");
    ui.dispose();
    w.engine.stop();
  });
});

describe("the read is made again at a bounded, doubling pace", () => {
  test("the waits double from the first to the largest and stay there; each lands one read", async () => {
    const w = await build("invalid");
    const reads = countReads(w);
    failFacts(w, "error", 100);
    const ui = await controllerProbe(w, { leader: false });
    let expected = 1;
    expect(reads()).toBe(expected);
    for (const wait of WAITS) {
      await w.advance(wait - 1);
      expect(reads(), `just before a wait of ${wait} ms`).toBe(expected);
      await w.advance(1);
      expected += 1;
      expect(reads(), `a wait of ${wait} ms`).toBe(expected);
      expect(ui.gate()).toBe("refreshing");
    }
    expect(WAITS[WAITS.length - 1]).toBe(DATA_CONFIG.factsReadRetryMaxMs);
    ui.dispose();
    w.engine.stop();
  });

  test("a read that lands ends the pacing: no further read is made", async () => {
    const w = await build("none");
    const reads = countReads(w);
    failFacts(w, "error", 2);
    const ui = await controllerProbe(w, { leader: false });
    await w.advance(FIRST_WAIT);
    await w.advance(FIRST_WAIT * 2);
    expect(ui.gate()).toBe("open");
    const after = reads();
    await w.advance(DATA_CONFIG.factsReadRetryMaxMs * 5);
    expect(reads()).toBe(after);
    ui.dispose();
    w.engine.stop();
  });

  test("a read that landed starts the next failure's pacing over from the FIRST wait", async () => {
    const w = await build("none");
    const reads = countReads(w);
    failFacts(w, "error", 3);
    const ui = await controllerProbe(w, { leader: false });
    // Failed at 0, 250 and 750 ms; the fourth read (after 1,000 ms more) lands.
    await w.advance(FIRST_WAIT);
    await w.advance(FIRST_WAIT * 2);
    await w.advance(FIRST_WAIT * 4);
    expect(ui.gate()).toBe("open");
    const landed = reads();
    // A new failure: the read made again waits the first wait, not the doubling's next step.
    failFacts(w, "error", 1);
    await nudge(w);
    await w.settle();
    const failed = reads();
    expect(failed).toBeGreaterThan(landed);
    await w.advance(FIRST_WAIT - 1);
    expect(reads()).toBe(failed);
    await w.advance(1);
    expect(reads()).toBe(failed + 1);
    ui.dispose();
    w.engine.stop();
  });

  test("the browser coming back makes the read at once, and the paced one it replaces does not add a second", async () => {
    const w = await build("none");
    const reads = countReads(w);
    failFacts(w, "error", 1);
    const ui = await controllerProbe(w, { leader: false });
    expect(reads()).toBe(1);
    ui.online();
    await w.settle();
    expect(reads()).toBe(2);
    expect(ui.gate()).toBe("open");
    await w.advance(FIRST_WAIT * 4);
    expect(reads()).toBe(2);
    ui.dispose();
    w.engine.stop();
  });

  test("the browser coming back while the store still fails: the read is made at once, and the pacing continues from THERE (the old timer is replaced, not left standing)", async () => {
    const w = await build("invalid");
    const reads = countReads(w);
    failFacts(w, "error", 2);
    const ui = await controllerProbe(w, { leader: false });
    expect(reads()).toBe(1);
    await w.advance(FIRST_WAIT * 0.4);
    ui.online();
    await w.settle();
    expect(reads()).toBe(2);
    // The next wait is the doubled one, from now. The timer of the first failure (due at 250 ms) must not still be standing.
    await w.advance(FIRST_WAIT * 1.2);
    expect(reads()).toBe(2);
    await w.advance(FIRST_WAIT * 1.2);
    expect(reads()).toBe(3);
    expect(ui.gate()).toBe("refreshing");
    ui.dispose();
    w.engine.stop();
  });

  test("the person's own 'look again' (the data layer is bound again) makes the read at once", async () => {
    const w = await build("invalid");
    const reads = countReads(w);
    failFacts(w, "error", 1);
    const ui = await controllerProbe(w, { leader: false });
    expect(reads()).toBe(1);
    ui.ui.actions.retryLoad();
    await w.settle();
    expect(reads()).toBe(2);
    expect(ui.gate()).toBe("refreshing");
    ui.dispose();
    w.engine.stop();
  });

  test("a controller that is disposed makes no further read", async () => {
    const w = await build("none");
    const reads = countReads(w);
    failFacts(w, "error", 100);
    const ui = await controllerProbe(w, { leader: false });
    const before = reads();
    ui.dispose();
    await w.advance(DATA_CONFIG.factsReadRetryMaxMs * 3);
    expect(reads()).toBe(before);
    w.engine.stop();
  });
});

describe("identity and incarnation transitions", () => {
  test("what one binding established is not carried to the next: the new binding is hidden until ITS first read lands", async () => {
    const w = await build("none");
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.gate()).toBe("open");
    // The identity leaves: nothing is readable, nothing is gated.
    w.identity.move({ account: null, epoch: 1 });
    await w.settle();
    expect(ui.ui.inputs.get().cache).toBe("unknown");
    expect(ui.gate()).toBe("open");
    expect(ui.ui.service()).toBeNull();
    // It returns (the same account, a new binding): the first read of the facts is pending, so the cache is hidden although the
    // previous binding had established `valid`.
    failFacts(w, "pending");
    w.identity.move({ account: w.service.account, epoch: 1 });
    await w.settle();
    expect(ui.ui.service()).not.toBeNull();
    expect(ui.ui.inputs.get().cache).toBe("unverified");
    expect(ui.gate()).toBe("refreshing");
    await nudge(w, ui);
    await w.settle();
    expect(ui.gate()).toBe("open");
    ui.dispose();
    w.engine.stop();
  });

  test("an invalid cache established by one binding does not hide the next binding once ITS read says valid, and the reverse does not open", async () => {
    const w = await build("invalid");
    const ui = await controllerProbe(w, { leader: false });
    expect(ui.gate()).toBe("refreshing");
    w.identity.move({ account: null, epoch: 1 });
    await w.settle();
    // While the identity is away the database becomes valid (a recovery in another tab); the new binding reads that.
    w.setSync({ cache_status: "valid", local_write_streaks: {} });
    w.identity.move({ account: w.service.account, epoch: 1 });
    await w.settle();
    expect(ui.gate()).toBe("open");
    // And the reverse: a binding whose read cannot be made is hidden, whatever the one before it said.
    w.identity.move({ account: null, epoch: 1 });
    await w.settle();
    failFacts(w, "error", 100);
    w.identity.move({ account: w.service.account, epoch: 1 });
    await w.settle();
    expect(ui.gate()).toBe("refreshing");
    ui.dispose();
    w.engine.stop();
  });

  test("a binding that ended stops its own re-reads: nothing is read for a database that is no longer bound", async () => {
    const w = await build("none");
    const reads = countReads(w);
    failFacts(w, "error", 100);
    const ui = await controllerProbe(w, { leader: false });
    w.identity.move({ account: null, epoch: 1 });
    await w.settle();
    const before = reads();
    await w.advance(DATA_CONFIG.factsReadRetryMaxMs * 3);
    expect(reads()).toBe(before);
    ui.dispose();
    w.engine.stop();
  });
});
