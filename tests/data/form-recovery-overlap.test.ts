// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  createQuotaGuard,
  type QuotaGuard,
} from "../../src/data/engine/quota-guard";
import { digestOf } from "../../src/data/model/canonical";
import { DATA_CONFIG } from "../../src/data/model/config";
import {
  digestOfMembers,
  EMPTY_DIGEST,
  population,
} from "../../src/data/model/local-work";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { setClosing } from "../../src/data/plans/fence";
import {
  capturedAfter,
  claimFormWriter,
} from "../../src/data/plans/form-recovery";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import type { AccountStore, Plan } from "../../src/data/store/port";
import { DataTestWorld } from "../support/data/env";
import { fakeOrigin } from "../support/data/origin-ledger";

/**
 * R1 (revision 6): overlapping lifetimes. The first revision serialised and numbered a capture inside one port instance and, when the
 * store declined a write for its sequence number, "reconciled" by re-numbering it above the stored one. That is right for a new
 * writer whose counter starts at zero and wrong for an OBSOLETE capture that waited (in a quota estimate, a held write, an earlier
 * instance) while a later one was written: it was promoted over the newer text.
 *
 * Captures are now ordered by `(writer_gen, capture_seq)`: the sequence is fixed in call order and shared by every port over the
 * page's store handle, the generation is claimed durably per page context, and an obsolete capture is refused inside the
 * transaction and is FINAL. Each schedule below holds one capture on purpose (the quota estimate, the write itself) while its
 * replacement runs to completion, then lets it go.
 */
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);
const FORM = "task-edit:42";
const TAB = "tab-a";

const snap = (text: string, savedAt = "2026-10-01T09:00:00.000Z") => ({
  formContext: FORM,
  tabInstanceId: TAB,
  values: { text },
  savedAt,
});

interface Gate {
  entered: Promise<void>;
  release(): void;
}
const gate = (): { gate: Gate; wait: () => Promise<void> } => {
  let release!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    gate: { entered: reached, release },
    wait: async () => {
      entered();
      await opened;
    },
  };
};

/** A quota guard whose estimate is held until its gate opens (every later reservation passes at once). */
const heldQuota = (g: { wait: () => Promise<void> }): QuotaGuard => {
  let first = true;
  return {
    reserve: async () => {
      if (first) {
        first = false;
        await g.wait();
      }
      return {
        verdict: "ok",
        live: () => true,
        settle: () => undefined,
      };
    },
  } as unknown as QuotaGuard;
};

async function world() {
  const env = new DataTestWorld();
  env.idb.autoDrive = true;
  const page = env.page("A");
  page.identity.account = ACCOUNT;
  const opened = await page.open(ACCOUNT, { create: true });
  if (opened.kind !== "opened") throw new Error("setup");
  const store = opened.store;
  /** A further handle on the same database: the page context that a reload makes. */
  const reload = async (): Promise<AccountStore> => {
    const again = await page.open(ACCOUNT);
    if (again.kind !== "opened") throw new Error("setup: reload");
    return again.store;
  };
  const rows = () =>
    (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[];
  const row = () => rows().find((r) => r.tab_instance_id === TAB);
  const portOver = (
    on: AccountStore,
    options: { quota?: QuotaGuard; now?: string } = {},
  ) =>
    createFormRecoveryPort({
      service: () => ({ store: on, incarnationId: on.incarnationId }) as never,
      now: () => options.now ?? "2026-10-01T12:00:00.000Z",
      ...(options.quota ? { quota: options.quota } : {}),
    });
  /** The number of `saveFormRecovery` transactions created so far. */
  const saveTransactions = () =>
    env.world.logs.filter(
      (e) => e.type === "idb.create" && e.label === "data.saveFormRecovery",
    ).length;
  return { env, store, reload, rows, row, portOver, saveTransactions };
}

/** A store whose `saveFormRecovery` writes are HELD until `release()`: the capture is asked for, claimed and numbered, and waits. */
function holdingWrites(
  inner: AccountStore,
  hold: (row: FormRecoveryRow) => boolean,
) {
  const held = gate();
  const wrapped: AccountStore = {
    account: inner.account,
    incarnationId: inner.incarnationId,
    run: async <I, R, O>(plan: Plan<I, R, O>, input: I) => {
      const candidate = (input as { row?: FormRecoveryRow }).row;
      if (
        plan.name === "data.saveFormRecovery" &&
        candidate !== undefined &&
        hold(candidate)
      )
        await held.wait();
      return inner.run(plan, input);
    },
    watch: (plan, input) => inner.watch(plan, input),
    close: () => inner.close(),
  };
  return { store: wrapped, gate: held.gate };
}

describe("an obsolete capture is refused and is final, whichever way it was held back", () => {
  test("a capture held in the QUOTA ESTIMATE while its replacement saves: the newer text stands, and the held one is one refused write, reported as failed", async () => {
    const w = await world();
    const before = w.portOver(w.store);
    await before.save(snap("one"));
    await before.save(snap("two"));
    const held = gate();
    const older = w.portOver(w.store, { quota: heldQuota(held) });
    const delayed = older.save(snap("older capture"));
    await held.gate.entered;
    const replacement = w.portOver(w.store);
    expect(await replacement.save(snap("newer capture"))).toBe("saved");
    const writes = w.saveTransactions();
    held.gate.release();
    // Not saved: a later capture is durable. And FINAL: exactly one more write was tried, never a re-numbered one.
    expect(await delayed).toBe("failed");
    expect(w.saveTransactions()).toBe(writes + 1);
    expect(w.row()?.fields).toEqual({ text: "newer capture" });
    expect((await replacement.load(FORM, TAB))?.values.text).toBe(
      "newer capture",
    );
  });

  test("a capture whose WRITE is held while its replacement saves", async () => {
    const w = await world();
    const seed = w.portOver(w.store);
    await seed.save(snap("one"));
    // ONE handle (the wrapper) for both ports: they are one page context; the predicate says which write is held.
    const hold = holdingWrites(w.store, (r) => r.fields.text === "older write");
    const older = w.portOver(hold.store);
    const delayed = older.save(snap("older write"));
    await hold.gate.entered;
    const replacement = w.portOver(hold.store);
    expect(await replacement.save(snap("newer write"))).toBe("saved");
    hold.gate.release();
    expect(await delayed).toBe("failed");
    expect(w.row()?.fields).toEqual({ text: "newer write" });
  });

  test("a capture asked for BEFORE a discard cannot bring the discarded text back, whichever instance made the discard", async () => {
    const w = await world();
    await w.portOver(w.store).save(snap("saved before"));
    const held = gate();
    const older = w.portOver(w.store, { quota: heldQuota(held) });
    const delayed = older.save(snap("typed before the discard"));
    await held.gate.entered;
    const replacement = w.portOver(w.store);
    await replacement.discard(FORM, TAB);
    expect(w.row()).toMatchObject({ terminal: true, fields: {} });
    held.gate.release();
    expect(await delayed).toBe("failed");
    expect(w.row()).toMatchObject({ terminal: true, fields: {} });
    expect(await replacement.load(FORM, TAB)).toBeNull();
  });

  test("a discard asked for BEFORE a newer capture does not erase it, even if the discard's write lands last", async () => {
    const w = await world();
    // ONE handle (the wrapper) for every port: one page context. Only a terminal write (a discard) is held.
    const hold = holdingWrites(w.store, (r) => r.terminal);
    await w.portOver(hold.store).save(snap("typed"));
    const older = w.portOver(hold.store);
    const discarding = older.discard(FORM, TAB);
    await hold.gate.entered;
    const replacement = w.portOver(hold.store);
    expect(await replacement.save(snap("typed after the discard"))).toBe(
      "saved",
    );
    hold.gate.release();
    await discarding;
    expect(w.row()).toMatchObject({
      terminal: false,
      fields: { text: "typed after the discard" },
    });
    expect((await replacement.load(FORM, TAB))?.values.text).toBe(
      "typed after the discard",
    );
  });

  test("the latest capture is the content already stored (a revert): an earlier capture with other content that is still on its way cannot land above it", async () => {
    const w = await world();
    const port = w.portOver(w.store);
    await port.save(snap("A"));
    const held = gate();
    const slow = w.portOver(w.store, { quota: heldQuota(held) });
    // Asked for after "A" and before the revert; held.
    const delayed = slow.save(snap("B"));
    await held.gate.entered;
    // The revert: "A" again, a LATER capture of content that is already durable. The order record moves up.
    expect(await port.save(snap("A"))).toBe("saved");
    held.gate.release();
    expect(await delayed).toBe("failed");
    expect(w.row()?.fields).toEqual({ text: "A" });
  });

  test("a capture from an EARLIER PAGE CONTEXT that is still alive (a page restored from the back/forward cache) cannot overtake a later one", async () => {
    const w = await world();
    const old = w.portOver(w.store);
    await old.save(snap("from the old page"));
    // The old page asks for another capture and stalls (its quota estimate never answers) ...
    const held = gate();
    const stalled = w.portOver(w.store, { quota: heldQuota(held) });
    const delayed = stalled.save(snap("old page, later"));
    await held.gate.entered;
    // ... the page is reloaded: a new handle, a new claim, a later generation.
    const newer = w.portOver(await w.reload());
    expect(await newer.save(snap("from the new page"))).toBe("saved");
    // The old page's two ports share its handle, hence its claim (generation 1); the reload's is the next one.
    expect(w.row()).toMatchObject({ writer_gen: 2 });
    held.gate.release();
    expect(await delayed).toBe("failed");
    expect(w.row()?.fields).toEqual({ text: "from the new page" });
  });

  test("(adapted, revision 18) two page contexts that first save at the same moment get DIFFERENT generations in call order: with no row for a claim to move, the earlier context's capture lands first and is overwritten, and the later context's text and generation stand", async () => {
    const w = await world();
    const first = w.portOver(w.store);
    const second = w.portOver(await w.reload());
    // Both calls are made before either is awaited: the claims are created in call order, and neither writes a row (R33, revision 18), so
    // the earlier context's capture is written and then overtaken by the later one's, which is in a LATER generation.
    const a = first.save(snap("context one"));
    const b = second.save(snap("context two"));
    expect(await Promise.all([a, b])).toEqual(["saved", "saved"]);
    expect(w.row()).toMatchObject({
      fields: { text: "context two" },
      writer_gen: 2,
    });
  });

  test("two page contexts that first save at the same moment, the earlier one's admission held back: the later context lands first and the earlier context's capture is the one that is refused, whichever order they reach the store in (the original schedule of revision 17, with the old claim's effect made by a held admission)", async () => {
    const w = await world();
    const held = gate();
    const first = w.portOver(w.store, { quota: heldQuota(held) });
    const second = w.portOver(await w.reload());
    const a = first.save(snap("context one"));
    await held.gate.entered;
    const b = second.save(snap("context two"));
    expect(await b).toBe("saved");
    held.gate.release();
    expect(await a).toBe("failed");
    expect(w.row()).toMatchObject({
      fields: { text: "context two" },
      writer_gen: 2,
    });
  });

  test("a context whose first capture lands BEFORE the other context claims is simply overwritten by the later one's capture", async () => {
    const w = await world();
    expect(await w.portOver(w.store).save(snap("context one"))).toBe("saved");
    expect(await w.portOver(await w.reload()).save(snap("context two"))).toBe(
      "saved",
    );
    expect(w.row()).toMatchObject({
      fields: { text: "context two" },
      writer_gen: 2,
    });
  });

  test("a replacement port CONTINUES the order of the one it replaces: sequences run on across instances over one handle", async () => {
    const w = await world();
    for (const [index, text] of ["a", "b", "c", "d"].entries()) {
      expect(await w.portOver(w.store).save(snap(text))).toBe("saved");
      expect(w.row()).toMatchObject({ capture_seq: index + 1, writer_gen: 1 });
    }
  });

  test("a held capture's quota is settled as NOT written when it was refused", async () => {
    const w = await world();
    await w.portOver(w.store).save(snap("one"));
    const settled: string[] = [];
    const held = gate();
    let first = true;
    const quota = {
      reserve: async () => {
        const mine = first;
        first = false;
        if (mine) await held.wait();
        return {
          verdict: "ok",
          live: () => true,
          settle: (outcome: string) => {
            if (mine) settled.push(outcome);
          },
        };
      },
    } as unknown as QuotaGuard;
    const delayed = w.portOver(w.store, { quota }).save(snap("obsolete"));
    await held.gate.entered;
    await w.portOver(w.store).save(snap("newer"));
    held.gate.release();
    expect(await delayed).toBe("failed");
    expect(settled).toEqual(["not_written"]);
  });
});

describe("the claim of a writer generation", () => {
  test("(adapted, revision 18) with no row it creates NOTHING: no row, the database's counter moves, and the digest of the unsynced work is the empty one", async () => {
    const w = await world();
    const claim = await w.store.run(claimFormWriter, {
      incarnationId: w.store.incarnationId,
      formContext: FORM,
      tabInstanceId: TAB,
      now: "2026-10-01T10:00:00.000Z",
    });
    expect(claim).toEqual({ kind: "claimed", gen: 1 });
    expect(w.rows()).toEqual([]);
    expect(
      (
        (w.env.idb.snapshot(NAME)?.sync_state ?? []) as Array<{
          form_writer_gen?: number;
        }>
      )[0]?.form_writer_gen,
    ).toBe(1);
    expect(await w.portOver(w.store).load(FORM, TAB)).toBeNull();
    expect(digestOfMembers(population([], w.rows()))).toBe(EMPTY_DIGEST);
  });

  test("a second claim of a form with no row is the next generation, and so is a claim of another form: one counter orders them all", async () => {
    const w = await world();
    const claim = (formContext: string, tabInstanceId: string) =>
      w.store.run(claimFormWriter, {
        incarnationId: w.store.incarnationId,
        formContext,
        tabInstanceId,
        now: "2026-10-01T10:00:00.000Z",
      });
    expect(await claim(FORM, TAB)).toEqual({ kind: "claimed", gen: 1 });
    expect(await claim(FORM, TAB)).toEqual({ kind: "claimed", gen: 2 });
    expect(await claim("other", TAB)).toEqual({ kind: "claimed", gen: 3 });
    expect(w.rows()).toEqual([]);
  });

  test("with a row it keeps the content, its digest and saved_at (so the digest of the unsynced work does not move), and moves the order record only", async () => {
    const w = await world();
    await w.portOver(w.store).save(snap("kept", "2026-10-01T09:00:00.000Z"));
    const before = w.row() as FormRecoveryRow;
    const digestBefore = digestOfMembers(population([], w.rows()));
    const claim = await w.store.run(claimFormWriter, {
      incarnationId: w.store.incarnationId,
      formContext: FORM,
      tabInstanceId: TAB,
      now: "2026-10-01T10:00:00.000Z",
    });
    expect(claim).toEqual({ kind: "claimed", gen: 2 });
    expect(w.row()).toEqual({ ...before, writer_gen: 2, capture_seq: 0 });
    expect(digestOfMembers(population([], w.rows()))).toBe(digestBefore);
  });

  test("a row written before generations counts as generation 0", async () => {
    const w = await world();
    w.env.idb.seed(NAME, "form_recovery", [
      {
        form_context: FORM,
        tab_instance_id: TAB,
        fields: { text: "old build" },
        redacted: [],
        saved_at: "2026-10-01T08:00:00.000Z",
        capture_seq: 9,
        terminal: false,
        content_digest: digestOf({ text: "old build" }),
      },
    ]);
    expect(await w.portOver(w.store).save(snap("new build"))).toBe("saved");
    expect(w.row()).toMatchObject({
      fields: { text: "new build" },
      writer_gen: 1,
      capture_seq: 1,
    });
  });

  test("it is REFUSED while `closing` is set, like every write of the store: nothing is written, and the save is refused", async () => {
    const w = await world();
    await w.store.run(setClosing, {
      incarnationId: w.store.incarnationId,
      now: 1,
      token: "t",
    });
    expect(await w.portOver(w.store).save(snap("late"))).toBe("refused");
    await w.portOver(w.store).discard(FORM, TAB);
    expect(w.rows()).toEqual([]);
  });

  test("a claim that FAILED is made again by the next capture (and a later claim is simply a later generation)", async () => {
    const w = await world();
    w.env.idb.inject({
      match: (tx) => tx.label === "data.claimFormWriter",
      mode: "error",
      times: 1,
    });
    const port = w.portOver(w.store);
    expect(await port.save(snap("first try"))).toBe("failed");
    expect(w.rows()).toEqual([]);
    expect(await port.save(snap("second try"))).toBe("saved");
    expect(w.row()).toMatchObject({
      fields: { text: "second try" },
      writer_gen: 1,
    });
  });

  test("a capture that the quota guard refuses writes no content (and does not leave a half-claimed writer behind)", async () => {
    const w = await world();
    const refusing = {
      reserve: async () => ({
        verdict: "refuse",
        live: () => false,
        settle: () => undefined,
      }),
    } as unknown as QuotaGuard;
    expect(await w.portOver(w.store, { quota: refusing }).save(snap("x"))).toBe(
      "failed",
    );
    expect(w.row()?.fields ?? {}).toEqual({});
    expect(await w.portOver(w.store).save(snap("y"))).toBe("saved");
    expect(w.row()?.fields).toEqual({ text: "y" });
  });
});

describe("a recovery copy whose admission could not be established (R28, revision 15)", () => {
  test("is refused like any capture the quota refuses: no content is written, the form stays open for a retry, and the next save with an answering ledger is written", async () => {
    const w = await world();
    const origin = fakeOrigin();
    const guard = createQuotaGuard({
      storage: {
        estimate: async () => ({
          usage: 0,
          quota: DATA_CONFIG.quotaReserveBytes * 4,
        }),
      },
      now: () => 0,
      ledger: origin.page("A").ledger,
    });
    origin.fail("A", 1_000);
    // The ledger never answers: nothing is promised, so nothing is written (the person is told the copy was not saved, as with any refusal).
    expect(await w.portOver(w.store, { quota: guard }).save(snap("x"))).toBe(
      "failed",
    );
    expect(w.row()?.fields ?? {}).toEqual({});
    expect(origin.claimed()).toEqual([]);
    // It answers again: the same port saves, and its hold goes with the write.
    origin.heal("A");
    expect(await w.portOver(w.store, { quota: guard }).save(snap("y"))).toBe(
      "saved",
    );
    expect(w.row()?.fields).toEqual({ text: "y" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(origin.state().holds).toEqual({});
  });
});

describe("a recovery copy whose settlement does not reach the ledger stays counted (R28, revision 16)", () => {
  const ROOM = DATA_CONFIG.quotaReserveBytes / 2 + 1_200_000;
  // The port reserves two bytes a character (+ 64 + 256): 450,000 characters ask for about 900,000 bytes.
  const TEXT = "x".repeat(450_000);
  /** A guard of page `name` that arms `arm` the moment a reservation has been made: the next ledger call is its SETTLEMENT. */
  const guardOf = (
    origin: ReturnType<typeof fakeOrigin>,
    name: string,
    arm?: () => void,
  ): QuotaGuard => {
    const guard = createQuotaGuard({
      storage: { estimate: async () => ({ usage: 0, quota: ROOM }) },
      now: () => 0,
      ledger: origin.page(name).ledger,
    });
    return arm === undefined
      ? guard
      : {
          ...guard,
          reserve: async (kind, bytes) => {
            const reservation = await guard.reserve(kind, bytes);
            arm();
            return reservation;
          },
        };
  };

  for (const failures of [2, 1_000])
    test(`${failures === 2 ? "two settlement calls rejected (the review's schedule)" : "every settlement call rejected until the ledger heals"}: the copy is written, the room it took stays taken for another page, and nothing is counted twice`, async () => {
      const w = await world();
      const origin = fakeOrigin();
      const first = guardOf(origin, "A", () => origin.fail("A", failures));
      expect(await w.portOver(w.store, { quota: first }).save(snap(TEXT))).toBe(
        "saved",
      );
      if (failures === 2)
        await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
      const other = guardOf(origin, "B");
      const refused = await other.reserve("input", 900_000);
      expect(refused.verdict).toBe("refuse");
      origin.heal("A");
      await vi.waitFor(() => expect(origin.claimed()).toEqual([]));
      expect(origin.state().holds).toEqual({});
      expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
        900_000,
      );
      expect((await other.reserve("input", 900_000)).verdict).toBe("refuse");
    });
});

describe("capturedAfter: the order of captures", () => {
  const at = (gen: number | undefined, seq: number, terminal = false) => ({
    ...(gen === undefined ? {} : { writer_gen: gen }),
    capture_seq: seq,
    terminal,
  });
  test("the generation first, then the sequence; a terminal write also wins a tie", () => {
    expect(capturedAfter(at(2, 0), at(1, 99))).toBe(true);
    expect(capturedAfter(at(1, 99), at(2, 0))).toBe(false);
    expect(capturedAfter(at(1, 5), at(1, 4))).toBe(true);
    expect(capturedAfter(at(1, 4), at(1, 4))).toBe(false);
    expect(capturedAfter(at(1, 4, true), at(1, 4))).toBe(true);
    expect(capturedAfter(at(1, 3, true), at(1, 4))).toBe(false);
  });
  test("an absent generation is 0", () => {
    expect(capturedAfter(at(undefined, 5), at(undefined, 4))).toBe(true);
    expect(capturedAfter(at(1, 1), at(undefined, 50))).toBe(true);
    expect(capturedAfter(at(undefined, 50), at(1, 1))).toBe(false);
  });
});

/**
 * R28 (revision 14): a recovery copy is user input, held to the same reserve as a draft, and its hold is a lease. The copy begins its
 * write only while the hold stands (the plan reads the reservation's `live()` where it decides what to write); a copy whose hold ended
 * writes nothing and is admitted again, a bounded number of times, like a draft.
 */
describe("a recovery copy whose hold ended writes nothing and is admitted again", () => {
  /** A guard whose reservations are live or lapsed as scripted, recording what it was asked and what was settled. */
  function scripted(lapses: number) {
    const asked: number[] = [];
    const settled: string[] = [];
    let made = 0;
    const quota = {
      reserve: async (_kind: string, bytes: number) => {
        asked.push(bytes);
        made += 1;
        const mine = made;
        return {
          verdict: "ok",
          live: () => mine > lapses,
          settle: (outcome: string) => {
            settled.push(`${mine}:${outcome}`);
          },
        };
      },
    } as unknown as QuotaGuard;
    return { quota, asked, settled };
  }

  test("a hold that ended once: the copy is admitted again at the same size and saved under the second", async () => {
    const w = await world();
    const probe = scripted(1);
    const port = w.portOver(w.store, { quota: probe.quota });
    expect(await port.save(snap("kept"))).toBe("saved");
    expect(probe.asked).toHaveLength(2);
    expect(probe.asked[1]).toBe(probe.asked[0]);
    expect(probe.settled).toEqual(["1:not_written", "2:written"]);
    expect(w.row()?.fields).toEqual({ text: "kept" });
  });

  test("holds that end on every admission: the copy is not saved (reported as failed), nothing is written, and every reservation is released", async () => {
    const w = await world();
    const probe = scripted(Number.POSITIVE_INFINITY);
    const port = w.portOver(w.store, { quota: probe.quota });
    await port.save(snap("seed"));
    const before = JSON.stringify(w.rows());
    const outcome = await port.save(snap("never written"));
    expect(outcome).toBe("failed");
    expect(JSON.stringify(w.rows())).toBe(before);
    expect(probe.settled.every((entry) => entry.endsWith(":not_written"))).toBe(
      true,
    );
    // Three admissions for the seed that could not be written either, and three for this one.
    expect(probe.asked.length).toBeGreaterThanOrEqual(3);
  });

  test("the control: a live hold writes, and a capture with no quota guard at all is written as it always was", async () => {
    const w = await world();
    const probe = scripted(0);
    expect(
      await w.portOver(w.store, { quota: probe.quota }).save(snap("live")),
    ).toBe("saved");
    expect(probe.settled).toEqual(["1:written"]);
    expect(await w.portOver(w.store).save(snap("unguarded"))).toBe("saved");
    expect(w.row()?.fields).toEqual({ text: "unguarded" });
  });

  test("(adapted, revision 18) a discard of a form that HAS a row reserves nothing and is not subject to a lease: it replaces the row with less", async () => {
    const w = await world();
    await w.portOver(w.store).save(snap("kept"));
    const probe = scripted(Number.POSITIVE_INFINITY);
    const port = w.portOver(w.store, { quota: probe.quota });
    await port.discard(FORM, TAB);
    expect(probe.asked).toHaveLength(0);
    expect(w.row()).toMatchObject({ terminal: true, fields: {} });
  });

  test("a discard of a form that has NO row would create one, so it is admitted like a save: reserved, and written under its hold", async () => {
    const w = await world();
    const probe = scripted(0);
    await w.portOver(w.store, { quota: probe.quota }).discard(FORM, TAB);
    expect(probe.asked).toHaveLength(1);
    expect(probe.settled).toEqual(["1:written"]);
    expect(w.row()).toMatchObject({ terminal: true, fields: {} });
  });
});
