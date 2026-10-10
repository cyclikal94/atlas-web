// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createIdbLedger,
  LEDGER_DATABASE,
  type LedgerState,
  STUCK_MS,
} from "../../src/data/store/quota-ledger";
import { rawIdb } from "../support/data/raw-idb";

/**
 * The origin's quota ledger over (a model of) raw IndexedDB (R28, revision 13). Several `createIdbLedger` instances over ONE stub are
 * several pages of one origin: the stub runs read-write transactions one after another, which is the property the ledger relies on, so
 * a get and a put inside one transaction are atomic across pages.
 *
 * What is proved here: the read-modify-write is ONE transaction (no lost update between pages), one page's calls apply in the order it
 * made them, a failure of any step rejects and the next call tries again, a connection another page asks to be closed is let go and
 * reopened, and what is stored is validated on the way back in. The real engines are exercised by the real-engine specs (E-O6).
 * Model evidence: it says nothing about durability or a browser's quota.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const hold = (token: string, bytes = 1): LedgerState => ({
  holds: { [token]: { bytes, until: Number.POSITIVE_INFINITY } },
  landed: null,
});
const addHold =
  (token: string, bytes = 1) =>
  (state: LedgerState) => ({
    state: {
      holds: {
        ...state.holds,
        [token]: { bytes, until: 1_000_000 },
      },
      landed: state.landed,
    },
    result: Object.keys(state.holds).length,
  });

describe("the ledger is one record of one small database, shared by every page", () => {
  test("a change made by one page is read by another, and the database is created on first use only", async () => {
    const idb = rawIdb();
    const a = createIdbLedger(idb.factory);
    const b = createIdbLedger(idb.factory);
    expect(idb.opens).toBe(0);
    expect(await a?.update(addHold("a1"))).toBe(0);
    expect(await b?.peek((state) => Object.keys(state.holds))).toEqual(["a1"]);
    expect(idb.record(LEDGER_DATABASE, "ledger", "state")).toEqual({
      holds: { a1: { bytes: 1, until: 1_000_000 } },
      landed: null,
    });
  });

  test("it is ONE transaction: forty changes from two pages, in flight together, lose none", async () => {
    const idb = rawIdb();
    const pages = [createIdbLedger(idb.factory), createIdbLedger(idb.factory)];
    const changes: Array<Promise<number>> = [];
    for (let i = 0; i < 40; i += 1)
      changes.push(
        (pages[i % 2] as NonNullable<(typeof pages)[number]>).update(
          addHold(`t${i}`),
        ),
      );
    const seen = await Promise.all(changes);
    const stored = idb.record(
      LEDGER_DATABASE,
      "ledger",
      "state",
    ) as LedgerState;
    expect(Object.keys(stored.holds)).toHaveLength(40);
    // Each change saw every change applied before it, so the counts it read are 0..39 with none repeated: serialised, not merged.
    expect([...seen].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
  });

  test("one page's calls apply in the order it made them: a settlement made before the next judgement is applied first", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    const order: string[] = [];
    const calls = [
      page.update((state) => {
        order.push("reserve");
        return addHold("r")(state);
      }),
      page.update((state) => {
        order.push("settle");
        const { r: _r, ...rest } = state.holds;
        return { state: { holds: rest, landed: null }, result: 0 };
      }),
      page.peek((state) => {
        order.push(`judge:${Object.keys(state.holds).length}`);
      }),
    ];
    await Promise.all(calls);
    expect(order).toEqual(["reserve", "settle", "judge:0"]);
  });

  test("a read is a READ-ONLY transaction and a change a read-write one, neither waiting for the disk", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.peek((state) => state);
    await page.update(addHold("x"));
    expect(idb.transactions).toEqual([
      { mode: "readonly", durability: "relaxed" },
      { mode: "readwrite", durability: "relaxed" },
    ]);
  });

  test("a change that answers `state: null` writes nothing", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(() => ({ state: null, result: "x" }));
    expect(idb.record(LEDGER_DATABASE, "ledger", "state")).toBeUndefined();
  });

  test("with no IndexedDB there is no ledger, and the caller keeps its own", () => {
    expect(createIdbLedger(null)).toBeUndefined();
  });
});

describe("what is stored is validated on the way in", () => {
  test("a damaged record is read as an empty ledger and replaced by the next change, never trusted and never blocking", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("first"));
    for (const damaged of ["text", 7, null, [], { holds: "no" }]) {
      idb.put(LEDGER_DATABASE, "ledger", "state", damaged);
      expect(await page.update(addHold("again"))).toBe(0);
      expect(
        Object.keys(
          (idb.record(LEDGER_DATABASE, "ledger", "state") as LedgerState).holds,
        ),
      ).toEqual(["again"]);
    }
  });

  test("an entry with an impossible figure is dropped, the rest kept", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("seed"));
    idb.put(LEDGER_DATABASE, "ledger", "state", {
      holds: {
        fine: { bytes: 5, until: 9 },
        negative: { bytes: -5, until: 9 },
      },
      landed: { base: Number.NaN, landed: 1, until: 1 },
    });
    expect(await page.peek((state) => state)).toEqual({
      holds: { fine: { bytes: 5, until: 9 } },
      landed: null,
    });
  });
});

describe("failures reject, and the next call tries again", () => {
  test("an open that fails rejects the call, and the next one opens again", async () => {
    const idb = rawIdb();
    idb.failOpen = 1;
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await expect(page.update(addHold("a"))).rejects.toThrow("open failed");
    expect(await page.update(addHold("b"))).toBe(0);
    expect(idb.opens).toBe(2);
  });

  test("a transaction that cannot begin rejects the call, and the connection is opened afresh", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("a"));
    idb.failTransaction = 1;
    await expect(page.update(addHold("b"))).rejects.toThrow(
      "transaction failed",
    );
    expect(await page.update(addHold("c"))).toBe(1);
    expect(idb.opens).toBe(2);
  });

  test("an aborted transaction rejects the call and stores nothing of it", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("a"));
    idb.abortNext = 1;
    await expect(page.update(addHold("b"))).rejects.toThrow("aborted");
    expect(
      Object.keys(
        (idb.record(LEDGER_DATABASE, "ledger", "state") as LedgerState).holds,
      ),
    ).toEqual(["a"]);
    expect(await page.update(addHold("c"))).toBe(1);
  });

  test("a change that throws rejects the call, aborts, and stores nothing", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("a"));
    await expect(
      page.update(() => {
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(
      Object.keys(
        (idb.record(LEDGER_DATABASE, "ledger", "state") as LedgerState).holds,
      ),
    ).toEqual(["a"]);
  });

  test("a failed call does not hold up the calls behind it", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("a"));
    idb.abortNext = 1;
    const calls = [page.update(addHold("b")), page.update(addHold("c"))];
    const [first, second] = await Promise.allSettled(calls);
    expect(first?.status).toBe("rejected");
    expect(second?.status).toBe("fulfilled");
  });

  test("a call that is never answered is given up on, and the page's queue goes on", async () => {
    vi.useFakeTimers();
    const idb = rawIdb();
    idb.stallOpen = 1;
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    // The outcomes are RECORDED: a ledger that never gives up would leave them pending, and the test must fail by an assertion about that.
    const outcomes: string[] = [];
    page.update(addHold("a")).then(
      () => outcomes.push("first: fulfilled"),
      () => outcomes.push("first: rejected"),
    );
    page.update(addHold("b")).then(
      () => outcomes.push("second: fulfilled"),
      () => outcomes.push("second: rejected"),
    );
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    expect(outcomes).toEqual(["first: rejected", "second: fulfilled"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the connection is another page's to take back", () => {
  test("`versionchange` makes the ledger let go, and the next call opens it again", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await page.update(addHold("a"));
    expect(idb.opens).toBe(1);
    idb.versionChange(LEDGER_DATABASE);
    expect(idb.closed).toBe(1);
    expect(await page.update(addHold("b"))).toBe(1);
    expect(idb.opens).toBe(2);
  });

  test("`close` closes the connection the page opened, and a later call opens it again; a ledger never used closes nothing", async () => {
    const idb = rawIdb();
    const page = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    page.close();
    expect(idb.closed).toBe(0);
    await page.update(addHold("a"));
    page.close();
    await vi.waitFor(() => expect(idb.closed).toBe(1));
    expect(await page.update(addHold("b"))).toBe(1);
    expect(idb.opens).toBe(2);
  });

  test("two pages each hold one connection, and one's close leaves the other's", async () => {
    const idb = rawIdb();
    const a = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    const b = createIdbLedger(idb.factory) as NonNullable<
      ReturnType<typeof createIdbLedger>
    >;
    await a.update(addHold("a"));
    await b.update(addHold("b"));
    a.close();
    await vi.waitFor(() => expect(idb.closed).toBe(1));
    expect(await b.peek((state) => Object.keys(state.holds).sort())).toEqual([
      "a",
      "b",
    ]);
    expect(hold("x").holds.x?.bytes).toBe(1);
  });
});
