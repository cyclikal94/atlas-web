// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import type { QuotaGuard } from "../../src/data/engine/quota-guard";
import { DATA_CONFIG, maxResponseBytesFor } from "../../src/data/model/config";
import type { EnqueueRequest } from "../../src/data/model/outbox";
import { accountDatabaseName } from "../../src/data/model/schema";
import type { FormRecoveryRow } from "../../src/data/model/types";
import { createOutbox, type Outbox } from "../../src/data/outbox/outbox";
import { createFormRecoveryPort } from "../../src/data/ports/form-recovery";
import { unrevokedHold } from "../../src/session";
import { engineWorld } from "../support/data/engine-world";
import { DataTestWorld } from "../support/data/env";
import { type AgeWorld, ageWorld } from "../support/data/lagging-estimate";
import { fakeOrigin } from "../support/data/origin-ledger";
import { outboxWorld } from "../support/data/outbox-world";
import { uuid } from "../support/data/sync-pages";

/**
 * R28 (revision 17), through the PUBLIC outbox over the production plans and facade, the recovery port and the engine: the origin's reserve
 * across the expiry of a landed debit and across a step of the wall clock, on every consumer that grows the stores.
 *
 * The review of revision 16 reproduced both schedules over two account databases (so that the serialisation of one database's
 * transactions is not what keeps the reserve): initial free space 5,394,304 bytes, the user-input floor 4,194,304, room for 1,200,000
 * bytes above it; A queues a 900,000-byte command at time zero, its landed debit expiring at 5,000 ms; B asks again at 5,001 ms with a
 * sample it took at 4,999 ms (or with a request begun at 4,999 ms and answered after the debit's end, or a millisecond after the clock
 * moved BACKWARDS and the debit was deleted as "further ahead than its lifetime allows") and was queued: 1,800,000 bytes retained in
 * room for 1,200,000, 3,594,304 bytes left of the 4,194,304-byte floor. The first block here is that seam with the same numbers and the
 * same controls (the fresh sample, the ledger window, ample space, a forward step). The reviewer's own probe files are preserved byte for
 * byte in `.agtx/evidence/WEB-09a/revision-17/review-probes/`. The estimate lags like the browser's (`ageWorld`: it shows a write only to
 * a request made a lifetime after it landed, in real time), the ledger is the model of the origin's, and the clocks are injected:
 * PROTOCOL evidence, no native quota is exhausted and no clock is really altered.
 */
const TTL = DATA_CONFIG.quotaEstimateTtlMs;
const RESERVE = DATA_CONFIG.quotaReserveBytes;
const FLOOR = RESERVE / 2;
const BODY = 900_000;
const room = (roomy: boolean): number =>
  FLOOR + (roomy ? 2_500_000 : 1_200_000);

const request = (id: string, size = BODY): EnqueueRequest => ({
  localId: id,
  endpoint: "/commands",
  targets: [],
  build: () => ({ command: { kind: "create", text: "x".repeat(size) } }),
});

const boxOf = (
  service: Parameters<typeof createOutbox>[0]["service"],
  quota: QuotaGuard,
): Outbox =>
  createOutbox({
    service,
    quota,
    ids: { uuid: () => crypto.randomUUID() },
    clock: { now: () => 0, iso: () => new Date(0).toISOString() },
    fence: () => ({ hasPendingOperation: false, sessionStarted: true }),
  });

// ---- the review's seam: two pages, two account databases ---------------------------------------------------------------------------

/** One page of the origin with its own account database (so a held transaction in one cannot serialise another). */
async function separateAccount(n: number) {
  const w = await outboxWorld();
  const account = uuid(700 + n);
  w.identity.move({ account, epoch: 1 });
  const runtime = new w.env.modules.accountService.DataRuntime({
    identity: w.identity,
    persistence: { hold: async () => unrevokedHold(() => undefined) },
    registry: w.page.registry,
    open: (a, o) => w.page.open(a, o),
  });
  const opened = await runtime.open(account, { create: true });
  if (opened.kind !== "opened") throw new Error(opened.kind);
  await w.env.settle();
  return {
    ...w,
    service: opened.service,
    drafts: () => w.env.idb.snapshot(`atlas-${account}`)?.drafts ?? [],
  };
}

type Account = Awaited<ReturnType<typeof separateAccount>>;

/** Two pages over separate databases, each with its own guard on the origin's ledger, and A's 900,000-byte save already landed. */
async function twoPages(roomy: boolean, options: { monotonic?: boolean } = {}) {
  const a = await separateAccount(0);
  const b = await separateAccount(1);
  const origin = fakeOrigin();
  const age = ageWorld(100_000);
  const free = room(roomy);
  const qa = age.guard(origin, "A", free, options);
  const qb = age.guard(origin, "B", free, options);
  const one = await a.env.run(boxOf(a.service, qa).enqueue(request(uuid(601))));
  expect(one.kind).toBe("queued");
  age.wrote(BODY);
  await vi.waitFor(() => {
    expect(origin.state().holds).toEqual({});
    expect(origin.claimed()).toEqual([]);
  });
  const save = (page: Account, guard: QuotaGuard, n: number) =>
    page.env.run(boxOf(page.service, guard).enqueue(request(uuid(n))));
  const retained = () => (a.drafts().length + b.drafts().length) * BODY;
  return { a, b, origin, age, free, qa, qb, save, retained };
}

describe("the review's schedules: the estimate's cache and its answers cross the debit's end", () => {
  for (const mode of [
    "cached-before-expiry",
    "fresh-after-expiry",
    "within-ledger-window",
    "ample-space",
  ] as const)
    test(`estimate expiry via the public outbox: ${mode}`, async () => {
      const roomy = mode === "ample-space";
      const p = await twoPages(roomy);
      if (mode === "cached-before-expiry" || mode === "within-ledger-window") {
        p.age.advance(TTL - 1);
        const before = await p.save(p.b, p.qb, 602);
        expect(before.kind).not.toBe("queued");
      } else if (mode === "ample-space") {
        p.age.advance(TTL - 1);
        expect(await p.qb.check("input", 1)).toBe("ok");
      }
      if (mode === "fresh-after-expiry") p.age.advance(TTL + 1);
      else if (mode !== "within-ledger-window") p.age.advance(2);
      const second = await p.save(p.b, p.qb, 603);
      expect(p.free - p.retained()).toBeGreaterThanOrEqual(FLOOR);
      if (roomy) expect(second.kind).toBe("queued");
      else expect(second.kind).not.toBe("queued");
      p.qa.close?.();
      p.qb.close?.();
    });

  for (const delayed of [false, true])
    for (const roomy of [false, true])
      test(`estimate answer crosses debit expiry: delayed=${delayed}, roomy=${roomy}`, async () => {
        const p = await twoPages(roomy);
        let second: ReturnType<typeof p.save>;
        if (delayed) {
          const gate = p.age.hold();
          p.age.advance(TTL - 1);
          second = p.save(p.b, p.qb, 902);
          await vi.waitFor(() => expect(p.age.asked.B).toHaveLength(1));
          p.age.advance(2);
          gate.release();
        } else {
          p.age.advance(TTL + 1);
          second = p.save(p.b, p.qb, 902);
        }
        const two = await second;
        expect(p.free - p.retained()).toBeGreaterThanOrEqual(FLOOR);
        if (roomy) expect(two.kind).toBe("queued");
        else expect(two.kind).not.toBe("queued");
      });

  for (const rollback of [false, true])
    for (const roomy of [false, true])
      test(`wall-clock change: rollback=${rollback}, roomy=${roomy}`, async () => {
        const p = await twoPages(roomy);
        const original = p.origin.state();
        p.age.step(rollback ? -1 : 1);
        const two = await p.save(p.b, p.qb, 802);
        expect(p.free - p.retained()).toBeGreaterThanOrEqual(FLOOR);
        if (roomy) expect(two.kind).toBe("queued");
        else expect(two.kind).toBe("refused");
        // The debit is still in the ledger, as made or clamped to one lifetime from the look, never deleted (a save that was admitted
        // adds its own bytes to it).
        expect(p.origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
          original.landed?.landed ?? 0,
        );
      });

  for (const direction of [-3_600_000, 3_600_000] as const)
    for (const roomy of [false, true])
      test(`a step of ${direction < 0 ? "an hour backwards" : "an hour forwards"} found by pages that have the monotonic clock: roomy=${roomy}`, async () => {
        const p = await twoPages(roomy, { monotonic: true });
        p.age.advance(1);
        p.age.step(direction);
        const two = await p.save(p.b, p.qb, 803);
        expect(p.free - p.retained()).toBeGreaterThanOrEqual(FLOOR);
        if (roomy) expect(two.kind).toBe("queued");
        else expect(two.kind).toBe("refused");
        // And once the time that really passes has gone by, the room is the estimate's to judge: with room, the same save is admitted.
        if (roomy) return;
        p.age.advance(TTL);
        expect((await p.save(p.b, p.qb, 804)).kind).toBe("refused");
      });
});

// ---- every growth path of the outbox: enqueue, edit, supersession --------------------------------------------------------------------

type World = Awaited<ReturnType<typeof outboxWorld>>;
type Path = "enqueue" | "edit" | "supersede";
const PATHS: Path[] = ["enqueue", "edit", "supersede"];
const OLD = uuid(50);

/** A queued small draft under `OLD` (for the edit and supersede paths), in a conflict when it is to be superseded. */
async function seeded(w: World, path: Path): Promise<void> {
  if (path === "enqueue") return;
  expect((await w.outbox.enqueue(request(OLD, 100))).kind).toBe("queued");
  if (path === "supersede")
    w.put("drafts", [{ ...w.drafts()[0], status: "version_conflict" }]);
}

const grow = (
  path: Path,
  outbox: Outbox,
  id: string,
): Promise<{ kind: string }> =>
  path === "enqueue"
    ? outbox.enqueue(request(id))
    : path === "edit"
      ? outbox.editQueued(OLD, request(OLD))
      : outbox.supersede(OLD, request(id));

describe("every growth path judges a save on a reading no older than the debit that protected it", () => {
  for (const path of PATHS)
    for (const schedule of ["cached", "on its way"] as const)
      for (const roomy of [false, true])
        test(`${path}, ${schedule} reading across the debit's end, ${roomy ? "room for both" : "room for one"}`, async () => {
          const w = await outboxWorld();
          await seeded(w, path);
          const origin = fakeOrigin();
          const age = ageWorld();
          const free = room(roomy);
          const a = boxOf(w.service, age.guard(origin, "A", free));
          const qb = age.guard(origin, "B", free);
          const b = boxOf(w.service, qb);
          const first = await a.enqueue(request(uuid(51)));
          expect(first.kind).toBe("queued");
          age.wrote(BODY);
          age.advance(TTL - 1);
          let second: Promise<{ kind: string }>;
          if (schedule === "cached") {
            expect(await qb.check("input", 1)).toBe("ok");
            age.advance(2);
            second = grow(path, b, uuid(52));
          } else {
            const gate = age.hold();
            second = grow(path, b, uuid(52));
            await vi.waitFor(() => expect(age.asked.B).toEqual([TTL - 1]));
            age.advance(2);
            gate.release();
          }
          const result = await second;
          if (roomy)
            expect(["queued", "edited", "superseded"]).toContain(result.kind);
          else expect(result).toEqual({ kind: "refused", reason: "quota" });
          // The estimate was asked again, by a request begun after the debit's end.
          expect(age.asked.B?.at(-1)).toBe(TTL + 1);
        });
});

// ---- the recovery copy ----------------------------------------------------------------------------------------------------------------

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const NAME = accountDatabaseName(ACCOUNT);
const snap = (text: string) => ({
  formContext: "task-edit:42",
  tabInstanceId: "tab-a",
  values: { text },
  savedAt: "2026-10-01T09:00:00.000Z",
});

describe("a recovery copy is judged on a reading no older than the debit that protected it", () => {
  // The port reserves two bytes a character (+ 64 + 256): 450,000 characters ask for about 900,000 bytes.
  const TEXT = "x".repeat(450_000);
  for (const roomy of [false, true])
    test(`${roomy ? "room for both" : "room for one"}: the copy is ${roomy ? "saved" : "refused"} after the debit of another page's save ended, on a reading taken inside its lifetime`, async () => {
      const env = new DataTestWorld();
      env.idb.autoDrive = true;
      const page = env.page("A");
      page.identity.account = ACCOUNT;
      const opened = await page.open(ACCOUNT, { create: true });
      if (opened.kind !== "opened") throw new Error("setup");
      const origin = fakeOrigin();
      const age = ageWorld();
      const free = room(roomy);
      const saver = age.guard(origin, "A", free);
      const qb = age.guard(origin, "B", free);
      const held = await saver.reserve("input", BODY);
      expect(held.verdict).toBe("ok");
      age.wrote(BODY);
      held.settle("written");
      await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
      age.advance(TTL - 1);
      expect(await qb.check("input", 1)).toBe("ok");
      age.advance(2);
      const port = createFormRecoveryPort({
        service: () =>
          ({
            store: opened.store,
            incarnationId: opened.store.incarnationId,
          }) as never,
        now: () => "2026-10-01T12:00:00.000Z",
        quota: qb,
      });
      expect(await port.save(snap(TEXT))).toBe(roomy ? "saved" : "failed");
      const row = (
        (env.idb.snapshot(NAME)?.form_recovery ?? []) as FormRecoveryRow[]
      ).find((r) => r.tab_instance_id === "tab-a");
      expect(row?.fields ?? {}).toEqual(roomy ? { text: TEXT } : {});
      await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
    });
});

// ---- the engine's page commit, as the landing that the next judgement must count -----------------------------------------------

const person = (n: number, size = 8_000) => ({
  kind: "upsert" as const,
  resource: {
    id: uuid(10_000 + n),
    kind: "person",
    parent_id: null,
    label: "Person",
    value: { text: "a".repeat(size) },
    version: 1,
    can_edit: true,
    archived: false,
  },
});

describe("a cache page the engine committed is a landing like any other", () => {
  test("a save judged on a reading taken inside the page's debit and used after its end is refused where it would not fit, and a small one is admitted", async () => {
    const w = await engineWorld();
    const origin = fakeOrigin();
    const age: AgeWorld = ageWorld();
    const FREE = RESERVE + maxResponseBytesFor(1);
    const body = w.json({
      nextCursor: "after-page",
      batches: [
        {
          revision: 1,
          changes: Array.from({ length: 800 }, (_, i) => person(i)),
        },
      ],
    });
    const length = (await body.clone().arrayBuffer()).byteLength;
    Object.assign(w.quota, age.guard(origin, "A", FREE));
    w.script.push(body);
    w.start();
    await w.settle();
    w.engine.stop();
    expect(w.cache()).toHaveLength(800);
    age.wrote(length);
    await vi.waitFor(() =>
      expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(length),
    );
    const saver = age.guard(origin, "B", FREE);
    const outbox = boxOf(w.service, saver);
    age.advance(TTL - 1);
    expect(await saver.check("input", 1)).toBe("ok");
    age.advance(2);
    // The page's bytes are the origin's: a save larger than what is left beside them fits only if they were forgotten.
    const big = FREE - length - FLOOR + 300_000;
    expect(await outbox.enqueue(request(uuid(1), big))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect((await outbox.enqueue(request(uuid(2), 100_000))).kind).toBe(
      "queued",
    );
    expect(origin.state().holds).toEqual({});
  });
});

// ---- R28b (revision 18): a page that opens AFTER a step of the wall clock, on every consumer that grows the stores -----------------------

const HOUR = 3_600_000;

describe("a page that opens after a step of the wall clock keeps the debit of a write it did not see land (R28b, revision 18)", () => {
  /**
   * The review of revision 17's schedule over two account databases and the public outbox: A queues 900,000 bytes (its debit 904,961 bytes,
   * five seconds), the wall clock moves with no real time passing, and B's guard is CONSTRUCTED afterwards. `schedule` is the order in
   * which the pages reach the ledger.
   */
  const SCHEDULES = [
    "no step",
    "an original page that lived through the step looks first",
    "the new page first, an original page looks after",
    "every original page closed",
    "the estimate has caught up",
  ] as const;
  for (const schedule of SCHEDULES)
    for (const monotonic of [true, false])
      for (const roomy of [false, true])
        test(`the public outbox: ${schedule}, the new page has ${monotonic ? "the monotonic clock" : "the wall clock only"}, ${roomy ? "room for both" : "room for one"}`, async () => {
          const a = await separateAccount(0);
          const b = await separateAccount(1);
          const origin = fakeOrigin();
          const age = ageWorld(100_000);
          const free = room(roomy);
          const qa = age.guard(origin, "A", free, { monotonic: true });
          const one = await a.env.run(
            boxOf(a.service, qa).enqueue(request(uuid(611))),
          );
          expect(one.kind).toBe("queued");
          age.wrote(BODY);
          await vi.waitFor(() => {
            expect(origin.state().holds).toEqual({});
            expect(origin.claimed()).toEqual([]);
          });
          const original = origin.state();
          if (schedule !== "no step") age.step(HOUR);
          if (
            schedule ===
            "an original page that lived through the step looks first"
          )
            await qa.check("input", 0);
          if (schedule === "every original page closed") qa.close?.();
          if (schedule === "the estimate has caught up") age.advance(TTL + 1);
          const qb = age.guard(origin, "B", free, { monotonic });
          const two = await b.env.run(
            boxOf(b.service, qb).enqueue(request(uuid(612))),
          );
          if (schedule === "the new page first, an original page looks after")
            await qa.check("input", 0);
          const retained = (a.drafts().length + b.drafts().length) * BODY;
          // Nothing may be retained below the floor, and with room the second save is queued.
          expect(free - retained).toBeGreaterThanOrEqual(FLOOR);
          if (roomy) expect(two.kind).toBe("queued");
          else expect(two.kind).toBe("refused");
          expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(
            original.landed?.landed ?? 0,
          );
          qa.close?.();
          qb.close?.();
        });

  for (const path of PATHS)
    for (const schedule of [
      "the new page first",
      "every original page closed",
    ] as const)
      for (const roomy of [false, true])
        test(`${path}, ${schedule}, ${roomy ? "room for both" : "room for one"}`, async () => {
          const w = await outboxWorld();
          await seeded(w, path);
          const origin = fakeOrigin();
          const age = ageWorld(100_000);
          const free = room(roomy);
          const qa = age.guard(origin, "A", free, { monotonic: true });
          const first = await boxOf(w.service, qa).enqueue(request(uuid(51)));
          expect(first.kind).toBe("queued");
          age.wrote(BODY);
          await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
          age.advance(54);
          age.step(HOUR);
          if (schedule === "every original page closed") qa.close?.();
          const qb = age.guard(origin, "B", free, { monotonic: true });
          const result = await grow(path, boxOf(w.service, qb), uuid(52));
          if (roomy)
            expect(["queued", "edited", "superseded"]).toContain(result.kind);
          else expect(result).toEqual({ kind: "refused", reason: "quota" });
          qa.close?.();
          qb.close?.();
        });

  for (const roomy of [false, true])
    test(`a recovery copy, every original page closed, ${roomy ? "room for both" : "room for one"}: ${roomy ? "saved" : "refused"}, and nothing is written when it is refused`, async () => {
      const env = new DataTestWorld();
      env.idb.autoDrive = true;
      const page = env.page("A");
      page.identity.account = ACCOUNT;
      const opened = await page.open(ACCOUNT, { create: true });
      if (opened.kind !== "opened") throw new Error("setup");
      const origin = fakeOrigin();
      const age = ageWorld(100_000);
      const free = room(roomy);
      const saver = age.guard(origin, "A", free, { monotonic: true });
      const held = await saver.reserve("input", BODY);
      expect(held.verdict).toBe("ok");
      age.wrote(BODY);
      held.settle("written");
      await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
      age.advance(54);
      age.step(HOUR);
      saver.close?.();
      const qb = age.guard(origin, "B", free, { monotonic: true });
      const port = createFormRecoveryPort({
        service: () =>
          ({
            store: opened.store,
            incarnationId: opened.store.incarnationId,
          }) as never,
        now: () => "2026-10-01T12:00:00.000Z",
        quota: qb,
      });
      const TEXT = "x".repeat(450_000);
      expect(await port.save(snap(TEXT))).toBe(roomy ? "saved" : "failed");
      const rows = (env.idb.snapshot(NAME)?.form_recovery ??
        []) as FormRecoveryRow[];
      expect(
        rows.find((r) => r.tab_instance_id === "tab-a")?.fields ?? {},
      ).toEqual(roomy ? { text: TEXT } : {});
      await vi.waitFor(() => expect(origin.state().holds).toEqual({}));
      qb.close?.();
    });

  test("a cache page the engine committed is a landing the new page must count: a save larger than what is left beside it is refused, a small one admitted", async () => {
    const w = await engineWorld();
    const origin = fakeOrigin();
    const age: AgeWorld = ageWorld(100_000);
    const FREE = RESERVE + maxResponseBytesFor(1);
    const body = w.json({
      nextCursor: "after-page",
      batches: [
        {
          revision: 1,
          changes: Array.from({ length: 800 }, (_, i) => person(i)),
        },
      ],
    });
    const length = (await body.clone().arrayBuffer()).byteLength;
    const engineGuard = age.guard(origin, "A", FREE, { monotonic: true });
    Object.assign(w.quota, engineGuard);
    w.script.push(body);
    w.start();
    await w.settle();
    w.engine.stop();
    expect(w.cache()).toHaveLength(800);
    age.wrote(length);
    await vi.waitFor(() =>
      expect(origin.state().landed?.landed ?? 0).toBeGreaterThanOrEqual(length),
    );
    age.advance(54);
    age.step(HOUR);
    engineGuard.close?.();
    const saver = age.guard(origin, "B", FREE, { monotonic: true });
    const outbox = boxOf(w.service, saver);
    const big = FREE - length - FLOOR + 300_000;
    expect(await outbox.enqueue(request(uuid(1), big))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect((await outbox.enqueue(request(uuid(2), 100_000))).kind).toBe(
      "queued",
    );
    expect(origin.state().holds).toEqual({});
  });
});
