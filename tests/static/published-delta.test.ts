import { describe, expect, test } from "vitest";
import type { SyncStub } from "../e2e/data-sync-helpers";
import { progressCommitted, publishDelta } from "../e2e/published-delta";

/**
 * Self-qualification of the fixture sync server's published delta (WEB-10c revision 9, R35; design assessment Q-H1), with no browser: a
 * stub answering exactly as `stubNetwork`'s `/sync` route (the next scripted answer, else an empty page with a new cursor) and a client
 * that commits an answer only from the cursor its poll left (W1's compare-and-set, `src/data/model/guards.ts`). The schedules are forced
 * in order; nothing here waits.
 */
function server() {
  const net: Pick<SyncStub, "script" | "requests"> = {
    script: [],
    requests: [],
  };
  const ask = (cursor: string) => {
    const url = new URL(
      `https://atlas.test/api/experimental/v1/sync?cursor=${cursor}`,
    );
    net.requests.push(url);
    const next = net.script.shift();
    const answer = next
      ? next(url)
      : {
          status: 200,
          body: JSON.stringify({
            phase: "delta",
            batches: [],
            next_cursor: `cursor-${net.requests.length}`,
            has_more: false,
          }),
        };
    return JSON.parse(answer.body) as {
      batches: Array<{ revision: number; changes: unknown[] }>;
      next_cursor: string;
    };
  };
  return { net, ask };
}

/** A W1-like client: a poll captures the cursor; its answer commits only if the cursor has not moved since. */
function client(start: string) {
  const state = { cursor: start, applied: 1 };
  return {
    state,
    poll(
      ask: (cursor: string) => ReturnType<ReturnType<typeof server>["ask"]>,
    ) {
      const captured = state.cursor;
      const answer = ask(captured);
      return {
        commit(): boolean {
          if (state.cursor !== captured) return false;
          state.cursor = answer.next_cursor;
          for (const batch of answer.batches)
            state.applied = Math.max(state.applied, batch.revision);
          return true;
        },
      };
    },
  };
}

const CHANGE = [{ kind: "upsert", resource: { id: "p-1", version: 2 } }];

describe("R35: a published delta is committed whichever competing poll wins", () => {
  test("the E-T20 schedule (revision 8 run 4): an empty answer to cursor-7 commits first, the correction's poll loses its CAS; the next poll, from the winner's cursor, is given the correction", () => {
    const { net, ask } = server();
    const c = client("cursor-7");
    const empty = c.poll(ask); // answered before the change is published
    const published = publishDelta(net, 2, CHANGE);
    const correction = c.poll(ask);
    expect(empty.commit(), "the empty answer wins").toBe(true);
    expect(correction.commit(), "the correction's answer loses its CAS").toBe(
      false,
    );
    expect(c.state.applied, "the correction is not committed yet").toBe(1);
    expect(published.ended()).toBe(false);
    const again = c.poll(ask);
    expect(again.commit()).toBe(true);
    expect(c.state.applied, "the correction is committed").toBe(2);
    expect(c.state.cursor).toBe(published.own);
    c.poll(ask).commit();
    expect(published.ended(), "the poll from its own cursor ends it").toBe(
      true,
    );
    expect(published.served).toEqual([
      { cursor: "cursor-7", page: true },
      { cursor: "cursor-1", page: true },
      { cursor: published.own, page: false },
    ]);
  });

  test("control (the one-shot answer before revision 9): in the same schedule the correction is never committed", () => {
    const { net, ask } = server();
    const c = client("cursor-7");
    const empty = c.poll(ask);
    net.script.push(() => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [{ revision: 2, changes: CHANGE }],
        next_cursor: "cursor-r4-2",
        has_more: false,
      }),
    }));
    const correction = c.poll(ask);
    empty.commit();
    correction.commit();
    for (let i = 0; i < 5; i += 1) c.poll(ask).commit();
    expect(c.state.applied, "the page was delivered, never committed").toBe(1);
  });

  test("reverse order: the correction's poll commits first; the competing empty answer loses, and nothing is given twice", () => {
    const { net, ask } = server();
    const c = client("cursor-7");
    const empty = c.poll(ask);
    const published = publishDelta(net, 2, CHANGE);
    const correction = c.poll(ask);
    expect(correction.commit()).toBe(true);
    expect(empty.commit()).toBe(false);
    expect(c.state.applied).toBe(2);
    c.poll(ask).commit();
    expect(published.ended()).toBe(true);
    expect(published.served.filter((s) => s.page)).toHaveLength(1);
  });

  test("two polls after publication from one cursor are both given it; the first commit wins and the next poll ends it", () => {
    const { net, ask } = server();
    const c = client("cursor-7");
    const published = publishDelta(net, 2, CHANGE);
    const one = c.poll(ask);
    const two = c.poll(ask);
    expect(one.commit()).toBe(true);
    expect(two.commit()).toBe(false);
    expect(c.state.applied).toBe(2);
    c.poll(ask).commit();
    expect(published.ended()).toBe(true);
  });

  test("scripted answers keep their order: one queued before it is served first, one queued after it only once it has ended", () => {
    const { net, ask } = server();
    const marker = (cursor: string) => () => ({
      status: 200,
      body: JSON.stringify({
        phase: "delta",
        batches: [],
        next_cursor: cursor,
        has_more: false,
      }),
    });
    net.script.push(marker("cursor-before"));
    const published = publishDelta(net, 2, CHANGE);
    net.script.push(marker("cursor-after"));
    const c = client("cursor-7");
    c.poll(ask).commit();
    expect(c.state.cursor).toBe("cursor-before");
    c.poll(ask).commit();
    expect(c.state.cursor).toBe(published.own);
    c.poll(ask).commit();
    expect(published.ended()).toBe(true);
    c.poll(ask).commit();
    expect(c.state.cursor).toBe("cursor-after");
  });
});

describe("R35: the writer's committed progress row is checked exactly", () => {
  const tail = [{ id: "e-4" }, { id: "e-5" }, { id: "e-6" }];
  const row = (
    patch: Record<string, unknown> = {},
    value: Record<string, unknown> = {},
  ) => ({
    id: "p-1",
    version: 2,
    ...patch,
    value: { entry_count: 6, recent_entries: tail, ...value },
  });
  test("the exact row holds", () => {
    expect(progressCommitted([{ id: "x" }, row()], "p-1", 2, tail, 6)).toBe(
      true,
    );
  });
  test.each([
    ["the right id at the old version", row({ version: 1 })],
    ["another entry count", row({}, { entry_count: 5 })],
    [
      "another tail",
      row(
        {},
        { recent_entries: [{ id: "e-3" }, { id: "e-4" }, { id: "e-5" }] },
      ),
    ],
    [
      "the tail out of order",
      row(
        {},
        { recent_entries: [{ id: "e-5" }, { id: "e-4" }, { id: "e-6" }] },
      ),
    ],
    ["no value", { id: "p-1", version: 2, value: null }],
  ])("not the commit: %s", (_name, wrong) => {
    expect(
      progressCommitted([wrong as Record<string, unknown>], "p-1", 2, tail, 6),
    ).toBe(false);
  });
  test("no row with the id", () => {
    expect(progressCommitted([row({ id: "p-2" })], "p-1", 2, tail, 6)).toBe(
      false,
    );
  });
});
