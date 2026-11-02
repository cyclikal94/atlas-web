// @vitest-environment node
import { describe, expect, test } from "vitest";
import { pageMarkers } from "../support/data/marker-storage";
import { outboxWorld } from "../support/data/outbox-world";

/**
 * WEB-10c revision 13 (finding F-10C-13a): the page's memory of stops (`LocalStops`) is shared by every writer of the page: the outbox's
 * drafts and also the task catch-up's write-failure fences (`materialise:<task>[:<day>]`, held when no marker can be written). The
 * person's "Try again" of the OUTBOX (all drafts) ends the outbox's own stops only; another feature's stop, which it never recorded and
 * whose outcome it does not hold, stays. FIXTURE evidence: the production dispatcher and facade over the doubles of IndexedDB and
 * `localStorage`. Baseline on 788bfb2 (dispatcher unchanged there): the memory-hold case fails (the catch-up's hold released), the marker
 * case passes (its control: a marker of an operation the outbox never names is not witnessed).
 */
describe("F-10C-13a: the outbox's Try again ends only the outbox's stops", () => {
  for (const kind of ["memory hold", "marker"] as const)
    test(`a catch-up fence (${kind}) held beside the outbox's own stop stays after the outbox's Try again of all drafts`, async () => {
      const w = await outboxWorld();
      w.online = false;
      w.reload({ markers: pageMarkers(w.markerStorage) });
      await w.settle();
      try {
        const DAY =
          "materialise:aaaaaaaa-0000-4000-8000-0000000000b1:2026-10-25";
        // The catch-up's fence, and a stop of the outbox's own (a draft's memory hold), stand together in the page.
        if (kind === "memory hold") w.markers.stops.hold(w.service, DAY);
        else expect(w.markers.set(w.service, DAY).state).toBe("recorded");
        w.markers.stops.hold(w.service, "draft:a");
        // The page's leader: its dispatcher runs (its explicit retry is the leader's act).
        w.start();
        await w.settle();
        w.outbox.retry();
        for (let i = 0; i < 10; i += 1) await w.settle();
        // The outbox's own stop is its to end; the catch-up's is not.
        expect(w.markers.stops.has(w.service, "draft:a")).toBe(false);
        if (kind === "memory hold")
          expect(w.markers.stops.has(w.service, DAY)).toBe(true);
        else expect(w.markers.probe(w.service, DAY)).toBe("marked");
      } finally {
        w.dispatcher.stop();
        w.service.dispose("closed");
      }
    });
});
