// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DATA_CONFIG } from "../../src/data/model/config";
import { controllerProbe } from "../support/data/controller-world";
import { type EngineWorld, engineWorld } from "../support/data/engine-world";
import {
  markerInstances,
  pageMarkers,
  scopeOf,
} from "../support/data/marker-storage";
import { cacheRow } from "../support/data/rows";

/**
 * R51 (revision 31): an earlier page's completion, delivered late, cannot erase a NEWER invalidation's fallback marker.
 *
 * The independent review of revision 30 had an engine apply an ordinary EMPTY delta page that retains `cursor-0` and held the delivery
 * of that successful commit's answer. A second engine (another page) received `410` at the same position, its invalidation and counter
 * writes aborted, and its failure path recorded `invalidate:cursor-0`; an attached follower hid the cache. Releasing the older
 * completion removed that marker (the success path retired `page:<cursor>` and `invalidate:<cursor>` unconditionally, on the premise
 * that "the position moved on", which an accepted empty page does not do), while the durable singleton still said `valid`: a follower
 * attached afterwards reported `cache: valid`, `gate: open`, over a cache the server had said was invalid.
 *
 * The request is admitted by the capture gate, in the transaction that reads the markers; the gate's reading is the WITNESS of the
 * request, and its success retires the markers that reading saw and no newer one. A marker recorded after the gate decided, at the very
 * position the request was made for, is a newer answer of the server that this request's answer says nothing about.
 *
 * FIXTURE evidence: the production engine, plans, guards, markers and controller over the double of IndexedDB and `localStorage`; the
 * server is a script and the delayed delivery is injected (the transaction commits, its answer is held), as the review injected it.
 * The native cases (real IndexedDB, a second real page, the real `localStorage`) are E-C8; WEB-09b's leadership is not exercised.
 */
const CURSOR = "cursor-0";
/**
 * The markers that stand for the operation, as one string (the sorted names of their keys), or undefined when none does. ADAPTED,
 * revision 32 (R52): a failure is a key of its own, so what a case compares is the instances that stand, not one shared value.
 */
const marker = (w: EngineWorld, operation: string): string | undefined => {
  const names = markerInstances(w.markerStorage, w.service.account, operation);
  return names.length === 0 ? undefined : names.join(",");
};

const fail = (w: EngineWorld, label: string, times: number): void => {
  w.env.idb.inject({
    match: (tx) => tx.label === label,
    mode: "error",
    times,
  });
};

/** Holds the DELIVERY of the answer of the next run of `planName` (it commits at once; the caller is told when `release` is called). */
function holdResult(w: EngineWorld, planName: string) {
  const store = w.service.store as unknown as {
    run: (
      plan: { name: string },
      input: unknown,
      options: unknown,
    ) => Promise<unknown>;
  };
  const real = store.run.bind(store);
  let armed = true;
  let landed = false;
  let release = (): void => undefined;
  store.run = (plan, input, options) => {
    const answer = real(plan, input, options);
    if (!armed || plan.name !== planName) return answer;
    armed = false;
    return new Promise((resolve, reject) => {
      answer.then((value) => {
        landed = true;
        release = () => resolve(value);
      }, reject);
    });
  };
  return { landed: () => landed, release: () => release() };
}

const ownership = () => ({ token: null, signal: new AbortController().signal });

async function build(): Promise<EngineWorld> {
  const w = await engineWorld({ cursor: CURSOR });
  w.put("cache", [cacheRow({ id: "private", value: { name: "retained" } })]);
  return w;
}

type Scenario = "timely-marker" | "delayed-marker" | "delayed-durable";
const SCENARIOS: Scenario[] = [
  "timely-marker",
  "delayed-marker",
  "delayed-durable",
];

describe("R51: an older page completion delivered after a newer invalidation at the same position", () => {
  for (const scenario of SCENARIOS)
    test(`${scenario}: the newer invalidation is exactly as recorded, the cache stays hidden for the attached follower and for one attached afterwards`, async () => {
      const w = await build();
      const attached = await controllerProbe(w, { leader: false });
      let later: Awaited<ReturnType<typeof controllerProbe>> | null = null;
      const newer = w.fork("later-engine");
      try {
        const hold =
          scenario === "timely-marker"
            ? null
            : holdResult(w, "data.commitPage");
        // The first engine applies an ordinary EMPTY page that keeps `cursor-0`.
        w.script.push(w.emptyPage(CURSOR));
        w.start();
        await w.settle();
        if (hold !== null) expect(hold.landed()).toBe(true);
        expect(w.requests).toHaveLength(1);
        expect(w.sync().cursor).toBe(CURSOR);
        // ANOTHER PAGE then receives `410` at that position; its invalidation and its counter writes abort (the marker is the only record),
        // or, in the durable control, the invalidation is written.
        if (scenario !== "delayed-durable") {
          fail(w, "data.invalidateCache", 1);
          fail(w, "data.recordLocalWriteOutcome", 1);
        }
        w.script.push(w.status(410));
        newer.start(ownership());
        await w.settle();
        expect(w.requests).toHaveLength(2);
        const recorded = marker(w, `invalidate:${CURSOR}`);
        if (scenario === "delayed-durable") {
          expect(recorded).toBeUndefined();
          expect(w.sync().cache_status).toBe("invalid");
        } else {
          expect(recorded).toBeDefined();
          expect(w.sync().cache_status).toBe("valid");
        }
        expect(attached.gate()).toBe("refreshing");
        // The older completion is delivered (in the control it already was).
        hold?.release();
        await w.settle();
        expect(marker(w, `invalidate:${CURSOR}`)).toBe(recorded);
        expect(attached.gate()).toBe("refreshing");
        // A follower attached NOW reads the records, and has no cached state to lean on.
        later = await controllerProbe(w, { leader: false });
        expect(later.gate()).toBe("refreshing");
        expect(later.ui.inputs.get().cache).toBe("invalid");
      } finally {
        later?.dispose();
        newer.stop();
        w.engine.stop();
        attached.dispose();
        w.service.dispose("closed");
      }
    });

  test("the same, with the older request still IN FLIGHT when the newer invalidation is recorded (the response arrives after it)", async () => {
    const w = await build();
    const attached = await controllerProbe(w, { leader: false });
    const newer = w.fork("later-engine");
    let later: Awaited<ReturnType<typeof controllerProbe>> | null = null;
    try {
      let open = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      w.script.push(async () => {
        await gate;
        return w.emptyPage(CURSOR);
      });
      w.start();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      fail(w, "data.invalidateCache", 1);
      fail(w, "data.recordLocalWriteOutcome", 1);
      w.script.push(w.status(410));
      newer.start(ownership());
      await w.settle();
      const recorded = marker(w, `invalidate:${CURSOR}`);
      expect(recorded).toBeDefined();
      expect(attached.gate()).toBe("refreshing");
      open();
      await w.settle();
      expect(w.sync().cursor).toBe(CURSOR);
      expect(marker(w, `invalidate:${CURSOR}`)).toBe(recorded);
      later = await controllerProbe(w, { leader: false });
      expect(later.gate()).toBe("refreshing");
    } finally {
      later?.dispose();
      newer.stop();
      w.engine.stop();
      attached.dispose();
      w.service.dispose("closed");
    }
  });

  test("a newer commit failure of the same page (`page:<cursor>`) recorded by another page is not retired either", async () => {
    const w = await build();
    try {
      const hold = holdResult(w, "data.commitPage");
      w.script.push(w.emptyPage(CURSOR));
      w.start();
      await w.settle();
      expect(hold.landed()).toBe(true);
      const page = w.markerStorage.page("another-page");
      const other = pageMarkers(page);
      other.set(scopeOf(w.service.account), `page:${CURSOR}`);
      const recorded = marker(w, `page:${CURSOR}`);
      hold.release();
      await w.settle();
      expect(marker(w, `page:${CURSOR}`)).toBe(recorded);
    } finally {
      w.engine.stop();
      w.service.dispose("closed");
    }
  });
});

describe("R51 controls: a page that succeeds still retires what the request was admitted over", () => {
  test("a marker that stood when the gate admitted the request (an invalidation another page could not write, its stop lifted by the person's retry) is retired by the page the server then accepts at that position", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    try {
      const page = w.markerStorage.page("another-page");
      const other = pageMarkers(page);
      other.set(scopeOf(w.service.account), `invalidate:${CURSOR}`);
      w.start();
      await w.settle();
      // The gate stops at the standing invalidation: nothing is asked of the server.
      expect(w.requests).toHaveLength(0);
      expect(w.state()).toMatchObject({
        kind: "stopped",
        cause: "local_storage",
      });
      expect(follower.gate()).toBe("refreshing");
      w.script.push(w.emptyPage(CURSOR));
      w.engine.retryNow();
      await w.settle();
      expect(w.requests).toHaveLength(1);
      // The server accepted the position again after that invalidation: the marker the request was admitted over is superseded.
      expect(marker(w, `invalidate:${CURSOR}`)).toBeUndefined();
      expect(follower.gate()).toBe("open");
    } finally {
      w.engine.stop();
      follower.dispose();
      w.service.dispose("closed");
    }
  });

  test("a page's own earlier commit failure (`page:<cursor>`, recorded in the marker) that the person's retry lifted is retired by the page that then lands", async () => {
    const w = await build();
    try {
      // The commit fails and so does the counter: the stop is the marker of `page:cursor-0`.
      for (let i = 0; i < 1; i += 1) {
        fail(w, "data.commitPage", DATA_CONFIG.localWritePauseAfter);
        fail(w, "data.recordLocalWriteOutcome", 1);
      }
      w.script.push(
        w.emptyPage(CURSOR),
        w.emptyPage(CURSOR),
        w.emptyPage(CURSOR),
      );
      w.start();
      await w.settle();
      await w.advance(60_000);
      expect(marker(w, `page:${CURSOR}`)).toBeDefined();
      expect(w.state()).toMatchObject({
        kind: "stopped",
        cause: "local_storage",
      });
      w.engine.retryNow();
      await w.settle();
      await w.advance(10_000);
      expect(marker(w, `page:${CURSOR}`)).toBeUndefined();
    } finally {
      w.engine.stop();
      w.service.dispose("closed");
    }
  });

  test("an invalidation's own earlier failure marker is retired by the retried write that lands (the persisted invalidation hides the cache by itself)", async () => {
    const w = await build();
    const follower = await controllerProbe(w, { leader: false });
    try {
      fail(w, "data.invalidateCache", 1);
      fail(w, "data.recordLocalWriteOutcome", 1);
      w.script.push(w.status(410));
      w.start();
      await w.settle();
      expect(marker(w, `invalidate:${CURSOR}`)).toBeDefined();
      expect(follower.gate()).toBe("refreshing");
      w.engine.retryNow();
      await w.settle();
      await w.advance(10_000);
      expect(w.sync().cache_status).toBe("invalid");
      expect(marker(w, `invalidate:${CURSOR}`)).toBeUndefined();
      expect(follower.gate()).toBe("refreshing");
    } finally {
      w.engine.stop();
      follower.dispose();
      w.service.dispose("closed");
    }
  });
});
