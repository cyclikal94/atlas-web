import type { Page } from "@playwright/test";
import { DATA_CONFIG } from "../../src/data/model/config";
import type { HarnessEnqueue } from "../../src/fixture/data-harness/main";
import { recordEvidence } from "./data-evidence";
import {
  ACCOUNT,
  atlasError,
  bootSession,
  dataPage,
  type Lifetime,
  readLifetime,
  recordLifetime,
  type Settled,
  seedSettled,
  startOutbox,
  stubNetwork,
  untilTreeSettled,
  uuid,
} from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-O1 and the real-engine runs of the outbox (plan 8.5): the PRODUCTION outbox plans, facade and dispatcher, in a real engine,
 * through the production session's stamped wrapper, with the network stubbed by `page.route`. FIXTURE evidence for this engine on
 * this machine: the stub says what a server MIGHT answer, not what the released backend does (the I-O specs run against it). The
 * dispatcher is a FIXTURE test leader (production starts no dispatcher until WEB-09b supplies leadership). Quota is not exercised
 * here (a real engine cannot be made to raise `QuotaExceededError` on request).
 */
const create = (
  id: string,
  extra: Record<string, unknown> = {},
): HarnessEnqueue => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  command: { kind: "create", id, ...extra },
  displayPatch: { [id]: { label: id } },
});
const edit = (id: string, n: number): HarnessEnqueue => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary",
      basis: "resource",
      versionChecked: true,
    },
  ],
  command: { kind: "edit", id, base: { $base: id }, n },
});
const cached = (id: string, version: number) => ({
  id,
  kind: "person",
  parent_id: null,
  label: id,
  value: null,
  version,
  can_edit: true,
  archived: false,
  kind_date: null,
});

const enqueue = (page: Page, spec: HarnessEnqueue) =>
  page.evaluate((s) => window.__atlasData?.enqueue(s), spec);
const queue = (page: Page) =>
  page.evaluate((a) => window.__atlasData?.queue(a), ACCOUNT);

test.describe("E-O1: two real tabs enqueue for one resource at once", () => {
  test("every round yields DISTINCT, contiguous expected versions; the fence set by one tab blocks the other's insert and edit", async ({
    context,
  }, info) => {
    const a = await dataPage(context);
    const b = await dataPage(context);
    for (const page of [a, b]) {
      await page.evaluate(async (acct) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setRuntimeIdentity({ account: acct, epoch: 1 });
        await data.openService(acct, { create: true });
      }, ACCOUNT);
    }
    await a.evaluate(
      ({ acct, rows }) => window.__atlasData?.put(acct, "cache", rows),
      {
        acct: ACCOUNT,
        rows: Array.from({ length: 8 }, (_, i) => cached(`r${i}`, 5)),
      },
    );
    const rounds = 8;
    const outcomes: Array<{ a: unknown; b: unknown }> = [];
    for (let i = 0; i < rounds; i += 1) {
      const spec = edit(`r${i}`, i);
      const [x, y] = await Promise.all([
        a.evaluate((x) => window.__atlasData?.enqueueDirect(x.acct, x.spec), {
          acct: ACCOUNT,
          spec,
        }),
        b.evaluate((x) => window.__atlasData?.enqueueDirect(x.acct, x.spec), {
          acct: ACCOUNT,
          spec,
        }),
      ]);
      outcomes.push({ a: x, b: y });
    }
    expect(
      outcomes.every(
        (o) =>
          (o.a as { kind: string }).kind === "queued" &&
          (o.b as { kind: string }).kind === "queued",
      ),
    ).toBe(true);
    const rows = (await queue(a)) ?? [];
    expect(rows).toHaveLength(rounds * 2);
    for (let i = 0; i < rounds; i += 1) {
      const mine = rows.filter((r) => r.target_resource_ids[0] === `r${i}`);
      expect(mine.map((r) => r.expected_version).sort()).toEqual([5, 6]);
      // The second waits on the first: one chain per resource.
      expect(mine.map((r) => r.depends_on.length).sort()).toEqual([0, 1]);
    }
    const versions = (await a.evaluate(
      (acct) => window.__atlasData?.rows(acct, "resource_versions"),
      ACCOUNT,
    )) as Array<{ resource_id: string; locally_assumed_version: number }>;
    expect(versions.every((v) => v.locally_assumed_version === 7)).toBe(true);
    const seqs = rows.map((r) => r.created_seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: rounds * 2 }, (_, i) => i + 1));

    // The fence set by one tab: refused in the other, and in a tab opened AFTER it was set.
    expect(
      await a.evaluate(
        (acct) => window.__atlasData?.fence(acct, "op-1"),
        ACCOUNT,
      ),
    ).toBe("set");
    const refusedB = await b.evaluate(
      (x) => window.__atlasData?.enqueueDirect(x.acct, x.spec),
      { acct: ACCOUNT, spec: edit("r0", 99) },
    );
    expect(refusedB).toEqual({ kind: "refused", reason: "fenced" });
    const c = await dataPage(context);
    await c.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct);
    }, ACCOUNT);
    expect(
      await c.evaluate(
        (x) => window.__atlasData?.enqueueDirect(x.acct, x.spec),
        { acct: ACCOUNT, spec: edit("r1", 98) },
      ),
    ).toEqual({ kind: "refused", reason: "fenced" });
    expect(
      await a.evaluate(
        (acct) => window.__atlasData?.unfence(acct, "op-1"),
        ACCOUNT,
      ),
    ).toBe("released");
    expect(
      (
        await b.evaluate(
          (x) => window.__atlasData?.enqueueDirect(x.acct, x.spec),
          { acct: ACCOUNT, spec: edit("r0", 100) },
        )
      )?.kind,
    ).toBe("queued");
    recordEvidence(info, "outbox-two-tabs", {
      rounds,
      expectedVersionsPerResource: [5, 6],
      finalRecord: 7,
      fenceBlocksOtherTabAndLateTab: true,
    });
  });
});

test.describe("E-O2: the production dispatcher in a real engine (stubbed network)", () => {
  test("queued drafts are sent FIFO with Idempotency-Key = local_id and the canonical body; receipts acknowledge them", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.outboxState()?.kind))
      .toMatch(/idle|held/);
    const ids: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const out = await enqueue(page, create(id));
      expect(out?.kind).toBe("queued");
      ids.push((out as { localId: string }).localId);
    }
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(3);
    expect(net.commands.map((c) => c.key)).toEqual(ids);
    expect(net.commands.map((c) => JSON.parse(c.body).id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      net.commands.every(
        (c) =>
          c.path === "/commands" &&
          c.contentType?.startsWith("application/json"),
      ),
    ).toBe(true);
    expect(net.commands[0]?.body).toBe(`{"id":"a","kind":"create"}`);
    await expect
      .poll(async () => (await queue(page))?.map((d) => d.status), {
        timeout: 10_000,
      })
      .toEqual(["acknowledged", "acknowledged", "acknowledged"]);
    const effects = (await page.evaluate(
      (acct) => window.__atlasData?.rows(acct, "pending_effects"),
      ACCOUNT,
    )) as Array<{ display: { label: string } | null }>;
    expect(effects.map((e) => e.display?.label).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    recordEvidence(info, "dispatcher-fifo", {
      sent: net.commands.length,
      keysAreLocalIds: true,
      other: net.other,
    });
  });

  test("a LOST RESPONSE (the connection resets after the server applied it) leaves the draft in flight, and the retry carries the same key and a byte-identical body", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    net.commandScript.push(() => ({ abort: true }));
    await startOutbox(page);
    const out = await enqueue(page, create("lost"));
    const id = (out as { localId: string }).localId;
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(2);
    expect(net.commands[1]).toEqual(net.commands[0]);
    expect(net.commands[1]?.key).toBe(id);
    await expect
      .poll(async () => (await queue(page))?.[0]?.status, { timeout: 10_000 })
      .toBe("acknowledged");
    recordEvidence(info, "lost-response-same-key", {
      requests: net.commands.length,
    });
  });

  test("a 409 conflict pauses only that draft; an operation_conflict is never resent; a 404 rejects with its dependants", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page);
    await page.evaluate(
      (acct) =>
        window.__atlasData?.put(acct, "cache", [
          {
            id: "r",
            kind: "person",
            parent_id: null,
            label: "r",
            value: null,
            version: 5,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]),
      ACCOUNT,
    );
    net.commandScript.push(
      () => ({ status: 409, body: atlasError("conflict") }),
      () => ({ status: 200, body: JSON.stringify({ revision: 7 }) }),
      () => ({ status: 409, body: atlasError("operation_conflict") }),
      () => ({ status: 404, body: atlasError("not_found") }),
    );
    const first = await enqueue(page, edit("r", 1));
    const dependant = await enqueue(page, edit("r", 2));
    const independent = await enqueue(page, create("x"));
    const opConflict = await enqueue(page, create("y"));
    const refused = await enqueue(page, create("z"));
    const refusedDependant = await enqueue(page, edit("z", 1));
    await expect
      .poll(() => net.commands.length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(4);
    await expect
      .poll(
        async () =>
          Object.fromEntries(
            ((await queue(page)) ?? []).map((d) => [d.local_id, d.status]),
          ),
        { timeout: 15_000 },
      )
      .toMatchObject({
        [(first as { localId: string }).localId]: "version_conflict",
        [(dependant as { localId: string }).localId]: "queued",
        [(independent as { localId: string }).localId]: "acknowledged",
        [(opConflict as { localId: string }).localId]: "operation_conflict",
        [(refused as { localId: string }).localId]: "rejected",
        [(refusedDependant as { localId: string }).localId]: "rejected",
      });
    const sentKeys = net.commands.map((c) => c.key);
    expect(
      sentKeys.filter((k) => k === (opConflict as { localId: string }).localId),
    ).toHaveLength(1);
    expect(sentKeys).not.toContain((dependant as { localId: string }).localId);
    recordEvidence(info, "answers", { sent: net.commands.length });
  });
});

test.describe("E-O3: the outbox's transactions are atomic in a real engine, through a NAMED fault", () => {
  test("a discard that fails at its 2nd write leaves the queue and the version record exactly as they were; once the fault is gone it applies whole", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    // Nothing is sent: the compatibility fact is held by never starting the dispatcher's loop.
    await startOutbox(page, ACCOUNT, { start: false });
    await page.evaluate(
      (acct) =>
        window.__atlasData?.put(acct, "cache", [
          {
            id: "r",
            kind: "person",
            parent_id: null,
            label: "r",
            value: null,
            version: 5,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]),
      ACCOUNT,
    );
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const out = await enqueue(page, edit("r", n));
      ids.push((out as { localId: string }).localId);
    }
    const before = await page.evaluate(
      async (acct) => ({
        drafts: await window.__atlasData?.rows(acct, "drafts"),
        versions: await window.__atlasData?.rows(acct, "resource_versions"),
      }),
      ACCOUNT,
    );
    expect(
      (before.versions as Array<{ locally_assumed_version: number }>)[0]
        ?.locally_assumed_version,
    ).toBe(8);
    // The named fault: the 2nd write (`put`, `delete` or their bulk forms) on `drafts`, `resource_versions` or `pending_effects` in one transaction throws.
    await page.evaluate(() => {
      const w = window as unknown as { __arm: boolean; __seen: number };
      w.__arm = true;
      w.__seen = 0;
      const counts = new WeakMap<object, number>();
      const targets = new Set([
        "drafts",
        "resource_versions",
        "pending_effects",
      ]);
      const proto = IDBObjectStore.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      for (const name of ["put", "putAll", "delete", "add"]) {
        const original = proto[name];
        if (typeof original !== "function") continue;
        proto[name] = function (this: IDBObjectStore, ...args: unknown[]) {
          if (w.__arm && targets.has(this.name)) {
            const n = (counts.get(this.transaction) ?? 0) + 1;
            counts.set(this.transaction, n);
            if (n === 2) {
              w.__seen += 1;
              throw new DOMException("injected fault", "DataError");
            }
          }
          return original.apply(this, args);
        };
      }
    });
    const refused = await page.evaluate(
      (id) => window.__atlasData?.discardDraft(id),
      ids[0] as string,
    );
    expect(refused).toEqual({ kind: "refused", reason: "storage" });
    const after = await page.evaluate(
      async (acct) => ({
        drafts: await window.__atlasData?.rows(acct, "drafts"),
        versions: await window.__atlasData?.rows(acct, "resource_versions"),
        injected: (window as unknown as { __seen: number }).__seen,
      }),
      ACCOUNT,
    );
    expect(after.injected).toBeGreaterThanOrEqual(1);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.versions).toEqual(before.versions);
    await page.evaluate(() => {
      (window as unknown as { __arm: boolean }).__arm = false;
    });
    const done = await page.evaluate(
      (id) => window.__atlasData?.discardDraft(id),
      ids[0] as string,
    );
    expect(done).toMatchObject({
      kind: "discarded",
      outcome: "removed",
      affected: 2,
    });
    const final = await page.evaluate(
      async (acct) => ({
        drafts: (await window.__atlasData?.rows(acct, "drafts")) as Array<{
          local_id: string;
          status: string;
        }>,
        versions: await window.__atlasData?.rows(acct, "resource_versions"),
      }),
      ACCOUNT,
    );
    expect(final.drafts.map((d) => d.status)).toEqual(["rejected", "rejected"]);
    expect(final.drafts.map((d) => d.local_id).sort()).toEqual(
      [ids[1], ids[2]].sort(),
    );
    expect(
      (final.versions as Array<{ locally_assumed_version: number }>)[0]
        ?.locally_assumed_version,
    ).toBe(5);
    recordEvidence(info, "discard-atomic-named-fault", {
      injectedAttempts: after.injected,
      draftsUnchangedAfterFailure: true,
      recordAfterCascade: 5,
    });
  });
});

test.describe("E-O4: a long queue of large retained drafts (R3, R6), in a real engine and two tabs", () => {
  /** Headers and bodies the way the enqueue plan writes them: 400 retained conflicts of 48 KiB, one per resource. */
  const retained = (count: number, payloadBytes: number) => {
    const payload = "x".repeat(payloadBytes);
    const headers = Array.from({ length: count }, (_, i) => ({
      local_id: `retained-${i}`,
      account_id: ACCOUNT,
      endpoint: "/commands",
      target_id: null,
      kind: "import",
      command_digest: `d-${i}`,
      defaults_revision: null,
      target_resource_ids: [`retained-res-${i}`],
      side_effect_bases: {},
      index_targets: [`retained-res-${i}`],
      bases: {},
      bumped: [],
      defaults_context: null,
      review_block: null,
      depends_on: [],
      status: "version_conflict",
      held_pending_cache: false,
      unavailable_outcome: false,
      retry_state: null,
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      display_patch: null,
      receipt_revision: null,
      created_seq: i + 1,
      created_at: "2026-10-01T09:00:00.000Z",
    }));
    const bodies = headers.map((header) => ({
      local_id: header.local_id,
      command: { kind: "import", payload },
    }));
    return { headers, bodies };
  };

  test("an independent draft behind 400 retained conflicts (about 19 MiB of bodies) is sent at once; the summary is exact; a second tab reads the same queue and sends nothing", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page, ACCOUNT, { start: false });
    const { headers, bodies } = retained(400, 48 * 1024);
    await page.evaluate(
      async ([a, h, b]) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        await data.put(a as string, "drafts", h as object[]);
        await data.put(a as string, "draft_commands", b as object[]);
      },
      [ACCOUNT, headers, bodies],
    );
    // The independent draft arrives through the facade, after the retained ones (a later `created_seq`).
    const out = await enqueue(page, create("independent"));
    expect(out?.kind).toBe("queued");
    const started = Date.now();
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect.poll(() => net.commands.length, { timeout: 15_000 }).toBe(1);
    const firstSendMs = Date.now() - started;
    expect(JSON.parse(net.commands[0]?.body ?? "{}").id).toBe("independent");
    // Nothing else was sent: the retained conflicts are not sendable and the dispatcher kept looking sparingly.
    await page.waitForTimeout(1_500);
    expect(net.commands).toHaveLength(1);
    const summary = await page.evaluate(
      (a) => window.__atlasData?.summary(a),
      ACCOUNT,
    );
    expect(summary).toMatchObject({ needsDecision: 400, waiting: 0 });

    // A second tab of the same account reads the same exact summary and queue, and issues nothing of its own.
    const other = await dataPage(context);
    await other.evaluate(async (a) => {
      window.__atlasData?.setIdentity(a);
      await window.__atlasData?.open(a, { create: false });
    }, ACCOUNT);
    const second = await other.evaluate(
      (a) => window.__atlasData?.summary(a),
      ACCOUNT,
    );
    expect(second).toEqual(summary);
    expect(net.commands).toHaveLength(1);
    recordEvidence(info, "long-queue-large-drafts", {
      retained: 400,
      payloadBytesEach: 48 * 1024,
      firstSendMs,
      summary,
    });
  });
});

test.describe("E-O5 (revision 12, R24 and R25): a replacement needs a fresh key, and a base-dependent command is charged its real size, in a real engine", () => {
  const OLD = uuid(1);
  const OTHER = uuid(2);
  const FRESH = uuid(3);
  const withKey = (spec: HarnessEnqueue, localId: string): HarnessEnqueue => ({
    ...spec,
    localId,
  });
  const drafts = (page: Page) =>
    page.evaluate((a) => window.__atlasData?.rows(a, "drafts"), ACCOUNT);
  const bodies = (page: Page) =>
    page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ACCOUNT,
    );

  test("R24: an old draft in conflict is replaced only under a FRESH key; the key of a sent draft, of the old draft, and of nothing else, is refused with every row as it was; a retry of the completed replacement writes nothing", async ({
    context,
  }, info) => {
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await startOutbox(page);
    // The second command is held by the server: its draft stays `in_flight`, body frozen, while a supersession asks for its key.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldRequests: string[] = [];
    await context.route("**/api/experimental/v1/commands", async (route) => {
      if (route.request().headers()["idempotency-key"] !== OTHER)
        return route.fallback();
      heldRequests.push(route.request().postData() ?? "");
      await gate;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ revision: 9 }),
      });
    });
    net.commandScript.push(() => ({
      status: 409,
      body: atlasError("conflict"),
    }));
    expect((await enqueue(page, withKey(create("first"), OLD)))?.kind).toBe(
      "queued",
    );
    await expect
      .poll(
        async () =>
          (await queue(page))?.find((d) => d.local_id === OLD)?.status,
        {
          timeout: 15_000,
        },
      )
      .toBe("version_conflict");
    expect((await enqueue(page, withKey(create("second"), OTHER)))?.kind).toBe(
      "queued",
    );
    await expect
      .poll(
        async () =>
          (await queue(page))?.find((d) => d.local_id === OTHER)?.status,
        {
          timeout: 15_000,
        },
      )
      .toBe("in_flight");
    const draftsBefore = await drafts(page);
    const bodiesBefore = await bodies(page);

    const supersede = (spec: HarnessEnqueue) =>
      page.evaluate(
        ([old, s]) =>
          window.__atlasData?.supersede(old as string, s as HarnessEnqueue),
        [OLD, spec] as const,
      );
    // The key of the draft that was SENT: refused, and its frozen body is not touched.
    expect(await supersede(withKey(create("replacement"), OTHER))).toEqual({
      kind: "refused",
      reason: "key_in_use",
    });
    // The old draft's own key: refused, and the old draft is still there.
    expect(await supersede(withKey(create("replacement"), OLD))).toEqual({
      kind: "refused",
      reason: "key_in_use",
    });
    expect(await drafts(page)).toEqual(draftsBefore);
    expect(await bodies(page)).toEqual(bodiesBefore);

    release();
    await expect
      .poll(
        async () =>
          (await queue(page))?.find((d) => d.local_id === OTHER)?.status,
        {
          timeout: 15_000,
        },
      )
      .toBe("acknowledged");
    // The sent command's request was never changed: one request for it, with the body it was sent with.
    expect(heldRequests).toHaveLength(1);
    expect(JSON.parse(heldRequests[0] ?? "{}").id).toBe("second");
    expect(net.commands.filter((c) => c.key === OTHER)).toHaveLength(0);

    // A fresh key replaces the old draft; the same call again is recognised and writes nothing (here after the dispatcher has sent the
    // replacement and its receipt is recorded: the retry is a retry of a supersession that was completed, whatever became of its result).
    const first = await supersede(withKey(create("replacement"), FRESH));
    expect(first).toEqual({ kind: "superseded", localId: FRESH, paused: [] });
    await expect
      .poll(
        async () =>
          (await queue(page))?.find((d) => d.local_id === FRESH)?.status,
        { timeout: 15_000 },
      )
      .toBe("acknowledged");
    const afterFirst = await drafts(page);
    expect(
      afterFirst?.some((d) => (d as { local_id: string }).local_id === OLD),
    ).toBe(false);
    const bodiesAfterFirst = await bodies(page);
    expect(await supersede(withKey(create("replacement"), FRESH))).toEqual(
      first,
    );
    expect(await drafts(page)).toEqual(afterFirst);
    expect(await bodies(page)).toEqual(bodiesAfterFirst);
    expect(net.commands.filter((c) => c.key === FRESH)).toHaveLength(1);
    recordEvidence(info, "supersede-keys", {
      refusedKeys: ["sent draft", "old draft"],
      requestsForTheSentDraft: heldRequests.length,
      retryWroteNothing: true,
    });
  });

  const PATHS = ["enqueue", "edit", "supersede"] as const;
  // `strict`: the command cannot be built without its bases, but the estimate's widest-version probe can (the estimate is right).
  // `unsizeable`: no probe can build it, so the estimate is the allowance alone and the PLAN's own measure protects the quota.
  const KINDS = ["strict", "unsizeable"] as const;
  for (const path of PATHS)
    for (const kind of KINDS)
      test(`R25: a base-dependent 900 KB command is refused as quota when only half the reserve plus 500,000 bytes is free, and written when there is room (${path}, ${kind}; the free space is a named injection)`, async ({
        context,
      }, info) => {
        await stubNetwork(context);
        await seedSettled(context);
        const page = await bootSession(context);
        const tight = DATA_CONFIG.quotaReserveBytes / 2 + 500_000;
        const roomy = DATA_CONFIG.quotaReserveBytes / 2 + 20 * 1024 * 1024;
        const command = (pad: string): HarnessEnqueue => ({
          endpoint: "/commands",
          targets: [
            {
              resourceId: "r",
              role: "primary",
              basis: "resource",
              versionChecked: true,
            },
          ],
          // `expected_version` is the base the transaction reads: the command cannot be built without it.
          command: { kind: "edit", id: "r", base: { $base: "r" }, pad },
          ...(kind === "strict"
            ? { requiresBases: true }
            : { unsizeable: true }),
        });
        const big = "x".repeat(900_000);
        await startOutbox(page, ACCOUNT, {
          start: false,
          estimateFreeBytes: tight,
        });
        await page.evaluate(
          (a) =>
            window.__atlasData?.put(a, "cache", [
              {
                id: "r",
                kind: "person",
                parent_id: null,
                label: "r",
                value: null,
                version: 5,
                can_edit: true,
                archived: false,
                kind_date: null,
              },
            ]),
          ACCOUNT,
        );
        if (path !== "enqueue") {
          expect(
            (await enqueue(page, withKey(command("small"), OLD)))?.kind,
          ).toBe("queued");
          if (path === "supersede") {
            const rows = (await drafts(page)) as object[];
            await page.evaluate(
              ([a, r]) =>
                window.__atlasData?.put(a as string, "drafts", [
                  { ...(r as object[])[0], status: "version_conflict" },
                ]),
              [ACCOUNT, rows] as const,
            );
          }
        }
        const attempt = (spec: HarnessEnqueue) =>
          page.evaluate(
            ([p, s, old]) => {
              const data = window.__atlasData;
              if (!data) throw new Error("no harness");
              const spec = s as HarnessEnqueue;
              return p === "enqueue"
                ? data.enqueue(spec)
                : p === "edit"
                  ? data.editQueued(old as string, spec)
                  : data.supersede(old as string, spec);
            },
            [path, spec, OLD] as const,
          );
        const before = {
          drafts: await drafts(page),
          bodies: await bodies(page),
        };
        expect(await attempt(withKey(command(big), FRESH))).toEqual({
          kind: "refused",
          reason: "quota",
        });
        expect({
          drafts: await drafts(page),
          bodies: await bodies(page),
        }).toEqual(before);

        // With room for it, the same command is written, as built from the base the transaction read.
        await page.evaluate(() => window.__atlasData?.stopOutbox());
        await startOutbox(page, ACCOUNT, {
          start: false,
          estimateFreeBytes: roomy,
        });
        const written = await attempt(withKey(command(big), FRESH));
        expect(["queued", "edited", "superseded"]).toContain(written?.kind);
        const id = path === "edit" ? OLD : FRESH;
        const stored = (await bodies(page))?.find(
          (b) => (b as { local_id: string }).local_id === id,
        ) as { command: { base: number; pad: string } } | undefined;
        expect(stored?.command.pad).toHaveLength(900_000);
        expect(stored?.command.base).toBe(5);
        recordEvidence(info, `quota-real-size-${path}-${kind}`, {
          freeBytesInjected: { tight, roomy },
          commandBytes: 900_000,
          refusedWhenTight: true,
        });
      });
});

test.describe("E-O6 (revision 13, R25 and R28): the reserve covers the whole write, and every page of the origin shares one ledger, in a real engine", () => {
  const OLD = uuid(11);
  const OLD2 = uuid(15);
  const FRESH = uuid(12);
  const MIB = 1024 * 1024;
  const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
  const withKey = (spec: HarnessEnqueue, localId: string): HarnessEnqueue => ({
    ...spec,
    localId,
  });
  const drafts = (page: Page) =>
    page.evaluate((a) => window.__atlasData?.rows(a, "drafts"), ACCOUNT);
  const bodies = (page: Page) =>
    page.evaluate(
      (a) => window.__atlasData?.rows(a, "draft_commands"),
      ACCOUNT,
    );
  /** The origin's ledger record, read straight from the real IndexedDB (only after a page has used the ledger: opening creates it). */
  const ledger = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<{
          holds: Record<
            string,
            {
              bytes: number;
              until: number;
              owned?: boolean;
              base?: number | null;
            }
          >;
          landed: {
            base: number;
            landed: number;
            until: number;
            settled?: string[];
          } | null;
        } | null>((resolve, reject) => {
          const request = indexedDB.open("atlas-quota-ledger");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const read = db
              .transaction("ledger", "readonly")
              .objectStore("ledger")
              .get("state");
            read.onsuccess = () => {
              db.close();
              resolve(read.result ?? null);
            };
            read.onerror = () => reject(read.error);
          };
        }),
    );
  const cacheRow = (page: Page) =>
    page.evaluate(
      (a) =>
        window.__atlasData?.put(a, "cache", [
          {
            id: "r",
            kind: "person",
            parent_id: null,
            label: "r",
            value: null,
            version: 5,
            can_edit: true,
            archived: false,
            kind_date: null,
          },
        ]),
      ACCOUNT,
    );
  const small = (): HarnessEnqueue => ({
    endpoint: "/commands",
    targets: [
      {
        resourceId: "r",
        role: "primary",
        basis: "resource",
        versionChecked: true,
      },
    ],
    command: { kind: "edit", id: "r", base: { $base: "r" }, n: 1 },
  });

  const PATHS = ["enqueue", "edit", "supersede"] as const;
  for (const path of PATHS)
    test(`R25: a ${900_000}-byte DEFAULTS CONTEXT is refused as quota when only half the reserve plus 500,000 bytes is free, and written, as given, when there is room (${path}; the free space is a named injection)`, async ({
      context,
    }, info) => {
      await stubNetwork(context);
      await seedSettled(context);
      const page = await bootSession(context);
      const tight = FLOOR + 500_000;
      const roomy = FLOOR + 20 * MIB;
      await startOutbox(page, ACCOUNT, {
        start: false,
        estimateFreeBytes: tight,
      });
      await cacheRow(page);
      if (path !== "enqueue") {
        expect((await enqueue(page, withKey(small(), OLD)))?.kind).toBe(
          "queued",
        );
        if (path === "supersede") {
          const rows = (await drafts(page)) as object[];
          await page.evaluate(
            ([a, r]) =>
              window.__atlasData?.put(a as string, "drafts", [
                { ...(r as object[])[0], status: "version_conflict" },
              ]),
            [ACCOUNT, rows] as const,
          );
        }
      }
      const attempt = (spec: HarnessEnqueue, replaced = OLD) =>
        page.evaluate(
          ([p, s, old]) => {
            const data = window.__atlasData;
            if (!data) throw new Error("no harness");
            const spec = s as HarnessEnqueue;
            return p === "enqueue"
              ? data.enqueue(spec)
              : p === "edit"
                ? data.editQueued(old as string, spec)
                : data.supersede(old as string, spec);
          },
          [path, spec, replaced] as const,
        );
      const context900 = { previousAudience: "x".repeat(900_000) };
      const before = { drafts: await drafts(page), bodies: await bodies(page) };
      expect(
        await attempt(
          withKey(
            { ...small(), defaultsContext: context900 },
            path === "edit" ? OLD : FRESH,
          ),
        ),
      ).toEqual({ kind: "refused", reason: "quota" });
      expect({
        drafts: await drafts(page),
        bodies: await bodies(page),
      }).toEqual(before);
      // The control: a SMALL context at the same free space is written.
      const smallOut = await attempt(
        withKey(
          { ...small(), defaultsContext: { previousAudience: "tiny" } },
          path === "edit" ? OLD : FRESH,
        ),
      );
      expect(["queued", "edited", "superseded"]).toContain(smallOut?.kind);

      // With room for it, the large context is stored, as given.
      await page.evaluate(() => window.__atlasData?.stopOutbox());
      await startOutbox(page, ACCOUNT, {
        start: false,
        estimateFreeBytes: roomy,
      });
      const id =
        path === "edit" ? OLD : path === "enqueue" ? uuid(13) : uuid(14);
      if (path === "supersede") {
        // The control above superseded `OLD`: the roomy attempt needs another draft in conflict to replace.
        expect((await enqueue(page, withKey(small(), OLD2)))?.kind).toBe(
          "queued",
        );
        const rows = (
          (await drafts(page)) as Array<{ local_id: string }>
        ).filter((d) => d.local_id === OLD2);
        await page.evaluate(
          ([a, r]) =>
            window.__atlasData?.put(a as string, "drafts", [
              { ...(r as object[])[0], status: "version_conflict" },
            ]),
          [ACCOUNT, rows] as const,
        );
      }
      const written = await attempt(
        withKey({ ...small(), defaultsContext: context900 }, id),
        path === "supersede" ? OLD2 : OLD,
      );
      expect(["queued", "edited", "superseded"]).toContain(written?.kind);
      const stored = (await drafts(page))?.find(
        (d) => (d as { local_id: string }).local_id === id,
      ) as { defaults_context: { previousAudience: string } } | undefined;
      expect(stored?.defaults_context.previousAudience).toHaveLength(900_000);
      recordEvidence(info, `quota-defaults-context-${path}`, {
        freeBytesInjected: { tight, roomy },
        contextBytes: 900_000,
        refusedWhenTight: true,
        smallContextAdmittedWhenTight: true,
      });
    });

  /**
   * Two real pages of one origin, each with the PRODUCTION guard (the origin's IndexedDB ledger and the page's own Web Locks) and the same
   * injected free space. `bClockOffsetMs` moves page B's guard clock ahead (a named injection): what another page's lease looks like to a
   * page whose clock has moved on.
   *
   * NO PAGE BOOTS AFTER A HARNESS OUTBOX HAS STARTED (R43, revision 23). A booting page makes every OTHER page of the origin check its
   * session (its view is neutral for 3 to 27 ms, 10 at the median: `1e.checking`) and the protected tree of each is torn down and mounted again; a page
   * does the same to itself at its own boot. A tree that is BOUND to the account when it is torn down closes the page's connection
   * registry (`dispose` in `browser-env`, `closeAll(closed_for_deletion)`), and the harness's outbox is a second runtime over that
   * registry: its service ends for good, and its next save is refused `identity_changed` (the facade's answer for a service that is not
   * live). The registry is closed by that disposal ONLY, and it was captured doing so in 32 of the 200 second pages of the Firefox sequences, at the page's own boot
   * (before any outbox of the harness, so harmlessly), and made on demand by `R43 control` below (Chromium and Firefox every time; WebKit in 2 of 33 runs, rarely), with exactly the
   * refusal that "R28, delayed estimate and no hint" met once in a full Firefox regression.
   *
   * This helper used to start page A's outbox and boot page B afterwards, so A's outbox lived through B's boot, and it was safe only
   * because A's tree is not bound at that moment (A booted before the database existed, and a tree does not look again by itself: it
   * binds when its session remounts it, which B's boot does harmlessly). That ordering is an accident, and nothing in the helper said
   * so. Both pages now boot FIRST and are read until they are quiet (`untilTreeSettled`: the session has booted, no lease stands,
   * nothing has moved the registry, the kernel or the connections for 300 ms), A again after B's boot, and only then does either
   * harness outbox start: no boot, no check and no remount of a tree is left to come. Each outbox is read for the closure that would end
   * it (`readLifetime`: the registry's close log, its latch and its connections, which a service cannot be live without), the facts are
   * recorded as evidence, and a page whose registry was closed after its outbox started FAILS THE SET-UP with those facts, instead of
   * answering `identity_changed` at some later save. No assertion, duration or injection of any case changed.
   *
   * WHY THE OLD ORDER FAILED, ESTABLISHED (R43, revision 24; the evidence is `revision-24/lifetime-diag`). A page whose tree is NOT
   * bound is not safe either: an unbound tree LOOKS again for the database (`follow` then `attach`, `create: false`) at the first
   * identity notification of its page once the database exists, and the look completes in 1 to 12 ms, binding the tree. A booting page B
   * makes page A's session observe B's boot attempt (an identity read, `GET /browser-sessions/current`, a cookie-capable VERIFICATION
   * request, in flight as a foreign lease): A evaluates and re-publishes its identity (A is still `displaying`, so that is the look's
   * trigger), and only when B's answer arrives does A set its hold and leave `displaying`, which tears the tree down. Whether a tree's
   * runtime that is disposed closes the page's registry depends on which of the two came first: a look still PENDING at the disposal is
   * abandoned and closes nothing (R35), and a look that has COMPLETED has bound the database, so the disposal closes every connection of
   * the account on the page, the harness outbox's included. The shared stub answers at once, so the gap between the two is a few
   * milliseconds and the look is nearly always still pending; the answer travels through the test process, so on a loaded machine the
   * gap is the process's latency. With page B's first identity read held 30 to 300 ms (`bootSession`'s `holdIdentityReadMs`) the old
   * order closed A's registry in 65 of 250 Firefox sequences (0 of 72 without the hold), and EVERY closure was a sequence in which A's
   * look had completed before A's view left `displaying` (38 of 38 in the 150 sequences that recorded the opens; none of the other 112 closed anything), with the production tree's disposal as the
   * closing stack. The failing run's footprint (two identity reads from B, 7 ms apart, which B makes in 1 of 72 unperturbed sequences and in
   * every held one) is that schedule's. It is NOT shown which of those it was: its lifetime facts were not captured. A fixture
   * artefact, not a production defect: production has one runtime per page (`new DataRuntime` in `browser-env` only), and everything the
   * tree's disposal closes belongs to the tree; only the harness's second runtime over the same registry is caught by it.
   *
   * The order below does not depend on any of it: every boot has happened and every tree has settled before any harness outbox exists, and
   * a page that settles has no identity read of another page left to flip it. `R43: with page B's first identity read held` runs this very
   * set-up under the hold that breaks the old order.
   */
  const twoPages = async (
    context: import("@playwright/test").BrowserContext,
    free: number,
    bClockOffsetMs = 0,
    /** R28, revision 17: the estimate lags like the browser's (`estimateLagsWrites`), and both guards have the page's monotonic clock. */
    extra: { estimateLagsWrites?: boolean; quotaMonotonic?: boolean } = {},
    /** R43, revision 24: page B's first identity read is answered this much later (a named latency injection; see `bootSession`). */
    boot: { holdBIdentityReadMs?: number } = {},
  ) => {
    await stubNetwork(context);
    // A HEALTHY backend answers the identity reads: the shared stub answers neither `/me` nor `/sessions` (404), so each page's controller
    // keeps asking, which is traffic nobody needs here.
    await serveIdentityReads(context);
    await seedSettled(context);
    const settled: Record<string, Settled> = {};
    const a = await bootSession(context);
    await recordLifetime(a);
    settled.aBooted = await untilTreeSettled(a, { connections: 0 });
    const b = await bootSession(context, {
      ...(boot.holdBIdentityReadMs === undefined
        ? {}
        : { holdIdentityReadMs: boot.holdBIdentityReadMs }),
    });
    await recordLifetime(b);
    settled.bBooted = await untilTreeSettled(b, { connections: 0 });
    // B's boot made A check its session and remount its tree: A is read again, now that the last boot has happened.
    settled.aAfterB = await untilTreeSettled(a, { connections: 0 });
    // Neither tree is bound to the account yet (it does not exist), so no later check or remount of a tree can close a registry.
    const closesBefore = {
      a: (await readLifetime(a)).closes.length,
      b: (await readLifetime(b)).closes.length,
    };
    await startOutbox(a, ACCOUNT, {
      start: false,
      estimateFreeBytes: free,
      originLedger: true,
      ...extra,
    });
    // The database now exists, with the harness's own pair of connections on page A.
    settled.aOutbox = await untilTreeSettled(a, { connections: 2 });
    await startOutbox(b, ACCOUNT, {
      start: false,
      estimateFreeBytes: free,
      originLedger: true,
      quotaClockOffsetMs: bClockOffsetMs,
      ...extra,
    });
    settled.bOutbox = await untilTreeSettled(b, { connections: 2 });
    const lifetime = async (): Promise<{ a: Lifetime; b: Lifetime }> => ({
      a: await readLifetime(a),
      b: await readLifetime(b),
    });
    const at = await lifetime();
    recordEvidence(test.info(), "two-pages-set-up", {
      settled,
      closesBeforeTheOutboxes: closesBefore,
      lifetime: at,
    });
    // A closed registry ends the harness's outbox for good: say so now, with what closed it, and not as a refused save later.
    for (const [name, page] of [
      ["A", at.a],
      ["B", at.b],
    ] as const) {
      const before = name === "A" ? closesBefore.a : closesBefore.b;
      expect(
        { closes: page.closes.slice(before), latch: page.latch },
        `the set-up of page ${name}: nothing closed its connection registry after its harness outbox started, and it is open (the facts of both pages are in the evidence)`,
      ).toEqual({ closes: [], latch: "open" });
    }
    return { a, b, lifetime, settled };
  };
  /**
   * A page that DEPARTS while the other page goes on departs QUIET (R43, revision 24). The two-page set-up of revision 23 leaves both
   * trees unbound; the departure of a page is then the first notification page B's tree hears, and B's tree LOOKS for the database and
   * binds it (about 5 ms) a moment before B's session, watching the lock of a session lease that the destroyed page died holding
   * (`watch.granted`), sets its hold and leaves `displaying` (about 20 ms after the look began). The disposal of the tree that has just bound
   * closes B's registry, and with it B's harness outbox: the first answer of "the settlement is rejected and the owner's page is then
   * destroyed" was `refused / identity_changed` from its first poll, in 29 of 40 isolated Firefox repetitions here and in 17 of 20 on revision
   * 23's tree (the same race as `R43 race`, on page B). With the departing page's own session quiet first (`untilTreeSettled`: booted, no
   * lease stands, nothing moved for 300 ms) no lease is left for B to verify: 20 of 20. What these cases are about, the quota hold, its real
   * Web Lock and a rejected settlement, is untouched: the wait reads the session only, and every assertion after the departure is unchanged.
   */
  const departQuietly = async (page: Page): Promise<void> => {
    const quiet = await untilTreeSettled(page, { connections: 2 });
    recordEvidence(test.info(), "departure-of-the-owner-page", {
      quietBeforeClosing: quiet,
    });
    await page.close();
  };
  /**
   * The names of the Web Locks the origin holds that own a quota hold, read by the TEST through `navigator.locks.query()` (the
   * application never calls it: lint rule R2 covers `src/`, and this is a spec, which is how the real lock is shown to exist).
   */
  const ownerLocks = (page: Page) =>
    page.evaluate(async () => {
      const state = await navigator.locks.query();
      return (state.held ?? [])
        .map((lock) => lock.name ?? "")
        .filter((name) => name.startsWith("atlas-quota-hold:"));
    });
  const big = (id: string): HarnessEnqueue =>
    withKey(
      create(id, { pad: "x".repeat(900_000) }),
      uuid(id === "one" ? 21 : 22),
    );
  /**
   * The other page's save, asked again every 250 ms, once the owner's page is gone (R28, revision 16). The browser releases the destroyed
   * page's lock (when it does so is the platform's, premise P-lock-b); the other page's refusal then proves it with a real `ifAvailable`
   * request and RECLAIMS the hold. A destroyed page is not proof that its transaction did not commit, so the hold's bytes move into the
   * landed ledger and count for ONE estimate lifetime: the page is refused until the entry's end, and admitted after it. `reclaimed` is
   * what the record showed at the first refusal that found the hold gone; `clockOffsetMs` is the other page's named clock injection.
   */
  const admittedAfterPageGone = async (b: Page, clockOffsetMs = 0) => {
    let refused = 0;
    let reclaimed: { landed: number; until: number } | null = null;
    // What page B saw at every poll, recorded BEFORE anything is asserted (revision 24: this case failed once in Firefox with nothing but
    // "refused for 15 s" to say why): milliseconds since the poll began, B's answer, the real Web Locks that still own a quota hold (the
    // platform's release of the destroyed page's lock is what lets B prove the release), and what the shared record held.
    const began = Date.now();
    const history: Array<[number, string, number, number, boolean]> = [];
    try {
      await expect
        .poll(
          async () => {
            const outcome = await enqueue(b, big("two"));
            if (outcome?.kind === "refused") {
              refused += 1;
              const record = await ledger(b);
              if (
                reclaimed === null &&
                Object.keys(record?.holds ?? {}).length === 0 &&
                record?.landed
              )
                reclaimed = {
                  landed: record.landed.landed,
                  until: record.landed.until,
                };
              history.push([
                Date.now() - began,
                `${outcome.kind}/${outcome.reason ?? ""}`,
                (await ownerLocks(b)).length,
                Object.keys(record?.holds ?? {}).length,
                record?.landed != null,
              ]);
            } else
              history.push([
                Date.now() - began,
                outcome?.kind ?? "?",
                0,
                0,
                false,
              ]);
            return outcome?.kind;
          },
          { timeout: DATA_CONFIG.quotaHoldLeaseMs / 2, intervals: [250] },
        )
        .toBe("queued");
    } catch (error) {
      recordEvidence(test.info(), "r28-owner-destroyed-not-admitted", {
        columns: [
          "ms since the first poll",
          "B's answer",
          "real quota-hold locks still held",
          "holds in the record",
          "landed entry in the record",
        ],
        estimateLifetimeMs: DATA_CONFIG.quotaEstimateTtlMs,
        holdLeaseMs: DATA_CONFIG.quotaHoldLeaseMs,
        // The absolute clock (`Date.now()`) at the first poll, which is the moment the caller's `a.close()` returned: page B's
        // `lifetimeOfB.dateOffset` plus a time on B's own clock is on the same scale.
        firstPollAt: began,
        reclaimed,
        history,
        // Page B's own lifetime (its registry's close log with stacks, its latch, its view episodes, the opens of the account database),
        // which says whether B's service was closed under it, and by what.
        lifetimeOfB: await readLifetime(b).catch(
          (failure: Error) => failure.message,
        ),
        // What B's session did (its kernel trace, on B's own clock): the reaction to the departure of the other page.
        sessionTraceOfB: await b
          .evaluate(() =>
            (window.__atlasFixture?.session?.trace ?? [])
              .slice(-70)
              .map((e) => [Math.round(e.at), e.event]),
          )
          .catch((failure: Error) => failure.message),
      });
      throw error;
    }
    const admittedAt = Date.now() + clockOffsetMs;
    const seen = reclaimed as { landed: number; until: number } | null;
    expect(
      seen,
      "the refusal that reclaimed the hold found its bytes landed",
    ).not.toBeNull();
    expect(seen?.landed).toBeGreaterThanOrEqual(900_000);
    // The room came back when the landed entry's estimate lifetime ended, not before.
    expect(admittedAt).toBeGreaterThanOrEqual((seen?.until ?? 0) - 50);
    return { refused, reclaimed: seen, admittedAt };
  };

  test("R28: two real pages, each with its own production guard and the same estimate, save 900,000 bytes AT THE SAME TIME with room for one above the floor: exactly one is written and the other refused as quota", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    const [x, y] = await Promise.all([
      enqueue(a, big("one")),
      enqueue(b, big("two")),
    ]);
    expect([x?.kind, y?.kind].sort()).toEqual(["queued", "refused"]);
    const refused = [x, y].find((o) => o?.kind === "refused");
    expect(refused).toEqual({ kind: "refused", reason: "quota" });
    const rows = (await drafts(a)) as object[];
    expect(rows).toHaveLength(1);
    // The bodies alone leave less than the whole floor only if BOTH had been written: the origin kept the headroom.
    const record = await ledger(a);
    await expect
      .poll(async () => Object.keys((await ledger(b))?.holds ?? {}).length, {
        timeout: 10_000,
      })
      .toBe(0);
    expect((await ledger(b))?.landed?.landed).toBeGreaterThanOrEqual(900_000);
    recordEvidence(info, "origin-ledger-two-pages-race", {
      freeBytesInjected: free,
      outcomes: [x?.kind, y?.kind],
      draftsWritten: rows.length,
      ledgerAfter: record,
    });
  });

  test("R28 with page A's ledger SLOW (a named injection): A's answers from the origin's ledger arrive 300 ms late, so a change that is not ONE transaction would let B in between; with room for one, still exactly one is written", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    // NAMED INJECTION (page A only): the completion event of every transaction on the ledger database is delivered 300 ms late. The
    // database itself is unchanged and as fast as ever; only A learns of its own transactions late. An implementation that reads in
    // one transaction and writes in another leaves a 300 ms window between them, in which page B reads the empty ledger.
    await a.evaluate(() => {
      const proto = IDBTransaction.prototype;
      const original = Object.getOwnPropertyDescriptor(proto, "oncomplete");
      if (!original?.set || !original.get) throw new Error("no oncomplete");
      const { get, set } = original;
      Object.defineProperty(proto, "oncomplete", {
        configurable: true,
        get() {
          return get.call(this);
        },
        set(handler) {
          if (
            typeof handler !== "function" ||
            (this as IDBTransaction).db.name !== "atlas-quota-ledger"
          ) {
            set.call(this, handler);
            return;
          }
          set.call(this, (event: Event) => {
            setTimeout(() => handler.call(this, event), 300);
          });
        },
      });
    });
    const [x, y] = await Promise.all([
      enqueue(a, big("one")),
      enqueue(b, big("two")),
    ]);
    expect([x?.kind, y?.kind].sort()).toEqual(["queued", "refused"]);
    expect((await drafts(b)) as object[]).toHaveLength(1);
    recordEvidence(info, "origin-ledger-two-pages-slow-ledger", {
      freeBytesInjected: free,
      injectedDelayMs: 300,
      outcomes: [x?.kind, y?.kind],
    });
  });

  test("R28, the control: the same two pages with room for BOTH write both, so the ledger refuses nothing it need not", async ({
    context,
  }, info) => {
    const { a, b } = await twoPages(context, FLOOR + 2_500_000);
    const [x, y] = await Promise.all([
      enqueue(a, big("one")),
      enqueue(b, big("two")),
    ]);
    expect([x?.kind, y?.kind]).toEqual(["queued", "queued"]);
    expect((await drafts(a)) as object[]).toHaveLength(2);
    recordEvidence(info, "origin-ledger-two-pages-control", {
      freeBytesInjected: FLOOR + 2_500_000,
      outcomes: [x?.kind, y?.kind],
    });
  });

  test("R28, delayed estimate and no hint: page A's save has LANDED; page B's estimate still shows the figure from before it (the stub never moves) and B never heard a `data_changed`, yet B's next save is refused", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b, lifetime, settled } = await twoPages(context, free);
    const first = await enqueue(a, big("one"));
    // The facts of both pages' lifetimes are recorded BEFORE anything is asserted (R43, revision 23): a first save that is refused
    // `identity_changed` (the facade's answer for a service that is not live) leaves the registry's close log, its latches, the sessions'
    // views and the connections, with the page's clock, instead of a bare refusal.
    const facts = await lifetime();
    recordEvidence(
      info,
      "origin-ledger-two-pages-delayed-estimate-first-save",
      {
        freeBytesInjected: free,
        settled,
        first,
        lifetime: facts,
      },
    );
    expect(
      first?.kind,
      `page A's first save (${JSON.stringify(first)}); the registry closes of A and B: ${JSON.stringify([facts.a.closes, facts.b.closes])}`,
    ).toBe("queued");
    await expect
      .poll(async () => (await ledger(b))?.landed?.landed ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(900_000);
    const second = await enqueue(b, big("two"));
    recordEvidence(info, "origin-ledger-two-pages-delayed-estimate", {
      freeBytesInjected: free,
      second,
      lifetime: await lifetime(),
    });
    expect(second).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect((await drafts(b)) as object[]).toHaveLength(1);
  });

  test("R28: a page that closes with its save still outstanding leaves its hold in the origin's ledger; its Web Lock is released by the browser, which the other page proves, and the hold is reclaimed at once, its bytes counting as landed for one estimate lifetime (adapted, revision 16: revision 15 admitted the other page at once; revision 13 kept it refused until the lease ended)", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    // Page A takes a reservation straight from its production guard and never settles it (a page that dies mid-save): the harness
    // exposes the guard's reserve for exactly this.
    const verdict = await a.evaluate(() =>
      window.__atlasData?.reserveQuota(900_000),
    );
    expect(verdict).toBe("ok");
    const [token] = Object.keys((await ledger(b))?.holds ?? {});
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    await departQuietly(a);
    // Nobody settled it: the record still holds the page's promise, flagged as owned, with the lease it had (revision 13's assertions).
    const record = await ledger(b);
    expect(
      Object.values(record?.holds ?? {}).map((hold) => hold.bytes),
    ).toEqual([900_000]);
    expect(Object.values(record?.holds ?? {})[0]).toMatchObject({
      owned: true,
    });
    const lease = Object.values(record?.holds ?? {})[0]?.until ?? 0;
    expect(lease - Date.now()).toBeGreaterThan(0);
    expect(lease - Date.now()).toBeLessThanOrEqual(
      DATA_CONFIG.quotaHoldLeaseMs,
    );
    // The browser releases the destroyed page's lock (when it does so is the platform's, premise P-lock-b), and the other page's judgement
    // proves it with a real `ifAvailable` request: until it can, the hold counts (refused); after, the hold is reclaimed at once, however
    // much of the lease is left, and its bytes are LANDED, not deleted (revision 16): the other page is admitted when their estimate
    // lifetime ends. Revision 15 admitted it at once (the hold was deleted); revision 13 kept it refused until the lease ended (up to 30 s).
    const { refused, reclaimed, admittedAt } = await admittedAfterPageGone(b);
    expect(await ownerLocks(b)).toEqual([]);
    expect(
      Object.keys((await ledger(b))?.holds ?? {}).length,
    ).toBeLessThanOrEqual(1);
    recordEvidence(info, "origin-ledger-dead-page-hold", {
      freeBytesInjected: free,
      holdBytes: 900_000,
      leaseMs: DATA_CONFIG.quotaHoldLeaseMs,
      estimateLifetimeMs: DATA_CONFIG.quotaEstimateTtlMs,
      refusedBeforeAdmission: refused,
      landedWhenReclaimed: reclaimed,
      admittedAt,
      reclaimedBeforeTheLeaseEnded: lease - Date.now() > 0,
    });
  });

  test("R28 (revision 15): a page that is still open keeps its hold however far the OTHER page's clock has moved; it is reclaimed only when the page is gone, and its bytes then count as landed for one estimate lifetime (adapted, revision 16: revision 15 freed the room at once)", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    // Page B reads its clock ten leases ahead (NAMED INJECTION): from B's point of view A's lease ended long ago and A has not renewed it
    // (a page that is suspended is exactly that). Whether the hold is honoured is decided by A's real Web Lock, held while A lives.
    const { a, b } = await twoPages(
      context,
      free,
      10 * DATA_CONFIG.quotaHoldLeaseMs,
    );
    const verdict = await a.evaluate(() =>
      window.__atlasData?.reserveQuota(900_000),
    );
    expect(verdict).toBe("ok");
    const before = await ledger(b);
    const [token] = Object.keys(before?.holds ?? {});
    expect(before?.holds[token as string]).toMatchObject({
      bytes: 900_000,
      owned: true,
    });
    // The lease, as B reads it, is over by an order of magnitude; A's lock is held.
    expect(
      (before?.holds[token as string]?.until ?? 0) <
        Date.now() + 10 * DATA_CONFIG.quotaHoldLeaseMs,
    ).toBe(true);
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    // Refused, over and over: nothing reclaims a hold whose owner is alive.
    for (let i = 0; i < 3; i += 1)
      expect(await enqueue(b, big("two"))).toEqual({
        kind: "refused",
        reason: "quota",
      });
    expect(Object.keys((await ledger(b))?.holds ?? {})).toEqual([token]);
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    // The page is gone: the browser releases its lock, the proof is made, the hold is reclaimed and its bytes land (revision 16); the
    // room is free when their estimate lifetime ends (page B reads its clock ten leases ahead, so the end is read on that clock).
    await departQuietly(a);
    const { reclaimed } = await admittedAfterPageGone(
      b,
      10 * DATA_CONFIG.quotaHoldLeaseMs,
    );
    expect(await ownerLocks(b)).toEqual([]);
    recordEvidence(info, "origin-ledger-owner-alive", {
      freeBytesInjected: free,
      pageBClockAheadMs: 10 * DATA_CONFIG.quotaHoldLeaseMs,
      holdBytes: 900_000,
      refusedWhileTheOwnerLived: 3,
      landedWhenReclaimed: reclaimed,
      queuedAfterTheEstimateLifetime: true,
    });
  });

  test("R28 (revision 15): a save that settles gives up its Web Lock once the record is rewritten: no lock and no hold are left", async ({
    context,
  }, info) => {
    const free = FLOOR + 5 * MIB;
    const { a, b } = await twoPages(context, free);
    expect(await enqueue(a, big("one"))).toMatchObject({ kind: "queued" });
    await expect
      .poll(async () => (await ledger(b))?.holds ?? null, {
        timeout: 10_000,
        intervals: [100],
      })
      .toEqual({});
    await expect
      .poll(async () => await ownerLocks(b), {
        timeout: 10_000,
        intervals: [100],
      })
      .toEqual([]);
    expect((await ledger(b))?.landed?.landed).toBeGreaterThanOrEqual(900_000);
    recordEvidence(info, "origin-ledger-settled-lock", {
      freeBytesInjected: free,
      holdsAfter: 0,
      ownerLocksAfter: 0,
    });
  });

  test("R28 (revision 14): a page that is still open RENEWS its outstanding hold in the origin's ledger, on the production timer, and the other page sees the lease move on and is still refused", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    // Page A takes a reservation straight from its production guard and keeps the page open: a save that is still going on.
    const verdict = await a.evaluate(() =>
      window.__atlasData?.reserveQuota(900_000),
    );
    expect(verdict).toBe("ok");
    const holdOf = async () =>
      Object.values((await ledger(b))?.holds ?? {}).map((hold) => ({
        bytes: hold.bytes,
        until: hold.until,
      }));
    const [first] = await holdOf();
    expect(first?.bytes).toBe(900_000);
    // The renewal is a third of the lease on (the production figure, never shortened): wait for it by what it does, not for a time.
    await expect
      .poll(async () => (await holdOf())[0]?.until ?? 0, {
        timeout: DATA_CONFIG.quotaHoldLeaseMs - 2_000,
        intervals: [500],
      })
      .toBeGreaterThan((first?.until ?? 0) + 5_000);
    const renewed = await holdOf();
    // Still ONE hold of the same bytes, and still a lease and not a permanent promise.
    expect(renewed.map((hold) => hold.bytes)).toEqual([900_000]);
    expect((renewed[0]?.until ?? 0) - Date.now()).toBeGreaterThan(0);
    expect((renewed[0]?.until ?? 0) - Date.now()).toBeLessThanOrEqual(
      DATA_CONFIG.quotaHoldLeaseMs,
    );
    expect(await enqueue(b, big("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    recordEvidence(info, "origin-ledger-renewal", {
      freeBytesInjected: free,
      leaseMs: DATA_CONFIG.quotaHoldLeaseMs,
      firstLeaseEnd: first?.until,
      renewedLeaseEnd: renewed[0]?.until,
      otherPageRefused: true,
    });
  });

  /**
   * NAMED INJECTION (R28, revision 16), page A only: every write to the ledger database after the first `skip` throws inside the page's own
   * transaction, so the REAL transaction aborts and the call rejects, as a failure of that one record would. The first write is the
   * admission; what follows is the settlement of the save, and the renewals. The injection is lifted by `window.__ledgerFaults = null`.
   */
  const failLedgerWrites = (page: Page, skip: number) =>
    page.evaluate((after) => {
      const w = window as unknown as {
        __ledgerFaults: { skip: number; seen: number; failed: number } | null;
      };
      w.__ledgerFaults = { skip: after, seen: 0, failed: 0 };
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        const faults = w.__ledgerFaults;
        if (
          faults !== null &&
          this.transaction.db.name === "atlas-quota-ledger"
        ) {
          faults.seen += 1;
          if (faults.seen > faults.skip) {
            faults.failed += 1;
            throw new DOMException(
              "injected failure of the ledger record",
              "AbortError",
            );
          }
        }
        return Reflect.apply(original, this, args);
      };
    }, skip);
  const ledgerFaultsSeen = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __ledgerFaults: { failed: number } | null;
          }
        ).__ledgerFaults?.failed ?? 0,
    );
  const liftLedgerFaults = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as { __ledgerFaults: null }).__ledgerFaults = null;
    });

  test("R28 (revision 16): a completed write whose settlement the REAL ledger rejects stays counted: the page keeps its Web Lock and offers the settlement again, the other page is refused, and the bytes land exactly once when the ledger takes it", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    await failLedgerWrites(a, 1);
    // The save is written (the store is not the ledger); its settlement is rejected by the ledger, over and over.
    expect(await enqueue(a, big("one"))).toMatchObject({ kind: "queued" });
    await expect
      .poll(() => ledgerFaultsSeen(a), { timeout: 10_000, intervals: [100] })
      .toBeGreaterThanOrEqual(3);
    const unpublished = await ledger(b);
    const [token] = Object.keys(unpublished?.holds ?? {});
    // The hold stands in the record, whole and owned, and the real lock that owns it is still held: nobody can prove it over.
    expect(Object.keys(unpublished?.holds ?? {})).toHaveLength(1);
    expect(unpublished?.holds[token as string]).toMatchObject({ owned: true });
    expect(unpublished?.holds[token as string]?.bytes).toBeGreaterThanOrEqual(
      900_000,
    );
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    expect(await enqueue(b, big("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    // The ledger answers again: the next offer is taken, the hold becomes the landed debit in one change, and the lock is let go.
    await liftLedgerFaults(a);
    await expect
      .poll(async () => Object.keys((await ledger(b))?.holds ?? {}).length, {
        timeout: 20_000,
        intervals: [250],
      })
      .toBe(0);
    await expect
      .poll(async () => await ownerLocks(b), {
        timeout: 10_000,
        intervals: [100],
      })
      .toEqual([]);
    const landed = (await ledger(b))?.landed;
    expect(landed?.landed).toBeGreaterThanOrEqual(900_000);
    // Once, not twice: the bytes of the one save (its body and its header), well short of two.
    expect(landed?.landed).toBeLessThan(1_800_000);
    expect(landed?.settled).toContain(token);
    expect(await enqueue(b, big("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    expect((await drafts(b)) as object[]).toHaveLength(1);
    recordEvidence(info, "origin-ledger-settlement-rejected", {
      freeBytesInjected: free,
      namedInjection:
        "every write to the ledger record after the admission throws, until lifted",
      offersRejectedBeforeLifting: (await ledgerFaultsSeen(a)) >= 3,
      landedBytes: landed?.landed,
      otherPageRefusedBeforeAndAfter: true,
    });
  });

  test("R28 (revision 16): the review's schedule in a real engine: the settlement is rejected and the owner's page is then destroyed; the other page proves the real lock released and the hold's bytes LAND, they are not deleted", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    await failLedgerWrites(a, 1);
    expect(await enqueue(a, big("one"))).toMatchObject({ kind: "queued" });
    await expect
      .poll(() => ledgerFaultsSeen(a), { timeout: 10_000, intervals: [100] })
      .toBeGreaterThanOrEqual(2);
    const [token] = Object.keys((await ledger(b))?.holds ?? {});
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    // The owner is gone before its settlement ever got through.
    await departQuietly(a);
    const { refused, reclaimed } = await admittedAfterPageGone(b);
    expect(await ownerLocks(b)).toEqual([]);
    recordEvidence(info, "origin-ledger-settlement-rejected-owner-destroyed", {
      freeBytesInjected: free,
      refusedBeforeAdmission: refused,
      landedWhenReclaimed: reclaimed,
      estimateLifetimeMs: DATA_CONFIG.quotaEstimateTtlMs,
    });
  });

  test("R28 (revision 16): at the production maximum age a reservation whose writer BEGAN keeps its hold, its Web Lock and its renewals, and one whose writer never began is revoked and gives its room back exactly (a named clock injection; the renewal tick is the production timer)", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    // A reservation whose writer has begun (`live()` was read) and never finishes: an unfinished commit.
    expect(
      await a.evaluate(() => window.__atlasData?.reserveQuota(900_000, true)),
    ).toBe("ok");
    const first = await ledger(b);
    const [token] = Object.keys(first?.holds ?? {});
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    // Page A's clock now reads the production maximum age ahead: at its next renewal tick the reservation is that old. The tick is the
    // production timer (a third of the lease, never shortened): wait for it by what it does, the lease moving ahead.
    await a.evaluate(
      (ms) => window.__atlasData?.setQuotaClockOffset(ms),
      DATA_CONFIG.quotaHoldMaxAgeMs,
    );
    await expect
      .poll(async () => (await ledger(b))?.holds[token as string]?.until ?? 0, {
        timeout: DATA_CONFIG.quotaHoldLeaseMs,
        intervals: [500],
      })
      .toBeGreaterThan(
        (first?.holds[token as string]?.until ?? 0) +
          DATA_CONFIG.quotaHoldMaxAgeMs / 2,
      );
    // Not revoked: the hold, its owner and its lease stand, however old the reservation is, and the other page is refused.
    const renewed = await ledger(b);
    expect(renewed?.holds[token as string]).toMatchObject({
      bytes: 900_000,
      owned: true,
    });
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    expect(renewed?.landed).toBeNull();
    expect(await enqueue(b, big("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    recordEvidence(info, "origin-ledger-max-age-begun", {
      freeBytesInjected: free,
      namedInjection: "page A reads its clock quotaHoldMaxAgeMs ahead",
      maxAgeMs: DATA_CONFIG.quotaHoldMaxAgeMs,
      holdStoodAfterTheAge: true,
      otherPageRefused: true,
    });
  });

  test("R28 (revision 16): at the production maximum age a reservation whose writer never began is a leak: it is revoked, its hold goes without a landed debit, its Web Lock is let go, and the other page is admitted (a named clock injection; the renewal tick is the production timer)", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    const { a, b } = await twoPages(context, free);
    expect(
      await a.evaluate(() => window.__atlasData?.reserveQuota(900_000)),
    ).toBe("ok");
    const [token] = Object.keys((await ledger(b))?.holds ?? {});
    expect(await ownerLocks(b)).toEqual([`atlas-quota-hold:${token}`]);
    expect(await enqueue(b, big("two"))).toEqual({
      kind: "refused",
      reason: "quota",
    });
    await a.evaluate(
      (ms) => window.__atlasData?.setQuotaClockOffset(ms),
      DATA_CONFIG.quotaHoldMaxAgeMs,
    );
    await expect
      .poll(async () => Object.keys((await ledger(b))?.holds ?? {}).length, {
        timeout: DATA_CONFIG.quotaHoldLeaseMs,
        intervals: [500],
      })
      .toBe(0);
    await expect
      .poll(async () => await ownerLocks(b), {
        timeout: 10_000,
        intervals: [100],
      })
      .toEqual([]);
    // Exact: the writer could not begin, so nothing was written and nothing is landed.
    expect((await ledger(b))?.landed ?? null).toBeNull();
    expect(await enqueue(b, big("two"))).toMatchObject({ kind: "queued" });
    recordEvidence(info, "origin-ledger-max-age-never-began", {
      freeBytesInjected: free,
      namedInjection: "page A reads its clock quotaHoldMaxAgeMs ahead",
      maxAgeMs: DATA_CONFIG.quotaHoldMaxAgeMs,
      revokedWithoutALandedDebit: true,
      otherPageAdmitted: true,
    });
  });

  // ---- R28 (revision 17): the estimate's cache and a step of the wall clock -------------------------------------------------------------
  /** A bounded wait in the TEST's own time (real time: the lifetimes are the production figures, never shortened). */
  const waitUntil = async (instant: number) => {
    const ms = instant - Date.now();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  };
  /** A 900,000-byte save under a name and a key of its own. */
  const bigSave = (name: string, n: number): HarnessEnqueue =>
    withKey(create(name, { pad: "x".repeat(900_000) }), uuid(n));
  const TTL = DATA_CONFIG.quotaEstimateTtlMs;

  for (const roomy of [false, true])
    test(`R28 (revision 17): a reading taken inside page A's debit is not spent after it: page B's cached estimate predates the end of the debit, and B asks the estimate again at the boundary, ${roomy ? "room for three" : "room for one"} (a named lagging-estimate injection; the lifetime is the production figure)`, async ({
      context,
    }, info) => {
      const free = FLOOR + (roomy ? 3_800_000 : 1_200_000);
      const { a, b } = await twoPages(context, free, 0, {
        estimateLagsWrites: true,
      });
      expect((await enqueue(a, bigSave("one", 31)))?.kind).toBe("queued");
      await expect
        .poll(async () => (await ledger(b))?.landed?.landed ?? 0, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(900_000);
      const until = (await ledger(b))?.landed?.until ?? 0;
      // The browser's estimate is the origin's: it shows A's write to a request made a lifetime from now. Every page's harness is told.
      for (const page of [a, b])
        await page.evaluate(
          (bytes) => window.__atlasData?.noteLanded(bytes),
          900_000,
        );
      // B's first save is judged on a reading taken inside the debit's lifetime, which the lagging estimate does not show.
      await waitUntil(until - 1_500);
      const inside = await enqueue(b, bigSave("two", 32));
      expect(
        Date.now(),
        "the first save was judged inside the lifetime",
      ).toBeLessThan(until);
      if (roomy) expect(inside?.kind).toBe("queued");
      else expect(inside).toEqual({ kind: "refused", reason: "quota" });
      // The debit has ended; B's reading is about two seconds old, well inside ITS lifetime, and does not show A's write.
      await waitUntil(until + 400);
      const after = await enqueue(b, bigSave("three", 33));
      if (roomy) expect(after?.kind).toBe("queued");
      else expect(after).toEqual({ kind: "refused", reason: "quota" });
      // The estimate was asked again, by a request that began after the debit's end.
      const asked =
        (await b.evaluate(() => window.__atlasData?.estimateRequests())) ?? [];
      expect(asked.length).toBeGreaterThanOrEqual(2);
      expect(asked.at(-1)).toBeGreaterThanOrEqual(until);
      // The debit is still in the record (kept for the readings that began before it), and was not what refused or admitted B.
      expect((await ledger(b))?.landed?.landed ?? 0).toBeGreaterThanOrEqual(
        900_000,
      );
      recordEvidence(
        info,
        `origin-ledger-reading-across-debit-end-${roomy ? "roomy" : "tight"}`,
        {
          freeBytesInjected: free,
          namedInjection:
            "the injected estimate lags: it shows a write to a request made one estimate lifetime (5,000 ms, real time) after it landed",
          estimateLifetimeMs: TTL,
          estimateRequestsOfB: asked.length,
          lastRequestAfterTheDebitEnded: (asked.at(-1) ?? 0) >= until,
          secondSaveOutcome: after?.kind,
        },
      );
    });

  for (const roomy of [false, true])
    test(`R28 (revision 17): a step of the wall clock BACKWARDS does not delete page A's fresh debit: page B, whose clock reads an hour earlier, still counts it (clamped to one lifetime from B's own reading, its bytes kept), ${roomy ? "room for both" : "room for one"} (a named clock injection)`, async ({
      context,
    }, info) => {
      const free = FLOOR + (roomy ? 2_500_000 : 1_200_000);
      const { a, b } = await twoPages(context, free, -3_600_000);
      expect((await enqueue(a, bigSave("one", 34)))?.kind).toBe("queued");
      await expect
        .poll(async () => (await ledger(b))?.landed?.landed ?? 0, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(900_000);
      const second = await enqueue(b, bigSave("two", 35));
      if (roomy) expect(second?.kind).toBe("queued");
      else expect(second).toEqual({ kind: "refused", reason: "quota" });
      // Not deleted: the record keeps the bytes, and its end is one lifetime from B's reading (B's clock reads an hour earlier).
      const record = (await ledger(b))?.landed;
      expect(record?.landed ?? 0).toBeGreaterThanOrEqual(900_000);
      const bNow = Date.now() - 3_600_000;
      expect(record?.until ?? 0).toBeGreaterThan(bNow);
      expect(record?.until ?? 0).toBeLessThanOrEqual(bNow + TTL);
      recordEvidence(
        info,
        `origin-ledger-clock-step-backwards-${roomy ? "roomy" : "tight"}`,
        {
          freeBytesInjected: free,
          namedInjection: "page B's guard reads Date.now() one hour behind",
          secondSaveOutcome: second?.kind,
          debitKept: true,
        },
      );
    });

  for (const roomy of [false, true])
    test(`R28 (revision 17): a step of the wall clock FORWARDS, found by a page that lived through it (it has the page's monotonic clock), does not end page A's debit: the entry is taken to have just landed and written back, ${roomy ? "room for both" : "room for one"} (a named clock injection)`, async ({
      context,
    }, info) => {
      const free = FLOOR + (roomy ? 2_500_000 : 1_200_000);
      const { a, b } = await twoPages(context, free, 0, {
        quotaMonotonic: true,
      });
      expect((await enqueue(a, bigSave("one", 36)))?.kind).toBe("queued");
      await expect
        .poll(async () => (await ledger(b))?.landed?.landed ?? 0, {
          timeout: 10_000,
        })
        .toBeGreaterThanOrEqual(900_000);
      // The step: page B's wall clock reads an hour ahead from now on; its monotonic clock does not move with it.
      await b.evaluate(
        (ms) => window.__atlasData?.setQuotaClockOffset(ms),
        3_600_000,
      );
      const second = await enqueue(b, bigSave("two", 37));
      if (roomy) expect(second?.kind).toBe("queued");
      else expect(second).toEqual({ kind: "refused", reason: "quota" });
      // Written back: one lifetime from B's reading, in B's (stepped) scale, with the bytes kept.
      const record = (await ledger(b))?.landed;
      expect(record?.landed ?? 0).toBeGreaterThanOrEqual(900_000);
      const bNow = Date.now() + 3_600_000;
      expect(record?.until ?? 0).toBeGreaterThan(bNow);
      expect(record?.until ?? 0).toBeLessThanOrEqual(bNow + TTL);
      recordEvidence(
        info,
        `origin-ledger-clock-step-forwards-${roomy ? "roomy" : "tight"}`,
        {
          freeBytesInjected: free,
          namedInjection:
            "page B's guard reads Date.now() one hour ahead; the page's own performance.now() is its monotonic clock",
          secondSaveOutcome: second?.kind,
          debitKept: true,
        },
      );
    });

  // ---- R28b (revision 18): a page whose guard is built AFTER a step of the wall clock ---------------------------------------------------
  const HOUR = 3_600_000;
  /**
   * Serves `GET /me` and `GET /sessions` successfully, as a healthy backend does (the same answers as `fixture.data-wake.spec.ts`). Call it
   * AFTER `stubNetwork`: the route registered last answers first.
   */
  const serveIdentityReads = async (
    context: import("@playwright/test").BrowserContext,
  ) => {
    const now = Date.now();
    await context.route("**/api/experimental/v1/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: ACCOUNT, username: "alice" }),
      }),
    );
    await context.route("**/api/experimental/v1/sessions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "s1",
              device_id: "dev-1",
              created_at: new Date(now - 60_000).toISOString(),
              expires_at: new Date(now + 86_400_000).toISOString(),
              authentication: "password",
              current: true,
            },
          ],
        }),
      }),
    );
  };
  /**
   * The review of revision 17's schedule in a real engine: both pages are booted first, page A's outbox lands a 900,000-byte save, the wall
   * clock moves an hour ahead with no real time passing (a named injection: `quotaClockOffsetMs`; no real clock is altered), and only THEN
   * is page B's guard constructed, with the page's own monotonic clock and nothing earlier to compare. Both pages share one real IndexedDB
   * database and one real ledger. B's save is judged about a second after A's landing, well inside the debit's five-second lifetime (the
   * production figure, never shortened).
   *
   * THE CLOSING SCHEDULES (R34, revision 19). "Every original page closed" has two forms, and both are kept: B booted AFTER A closed (the
   * review's own schedule: a new page, every earlier page gone), and B booted BEFORE A closed and opened its account after (the form of
   * revision 18's first version, which failed in WebKit in about one run in ten with a refused save, `StoreFailure: closed` and `no open
   * store`).
   *
   * WHAT CLOSED B'S STORE. Two preserved failing traces show B's store gone within about 50 ms of page A's close, at a page age of 1.6 to
   * 2.2 s, with B's production session reading `/me` and `/sessions` at that moment. In the first 24 runs of the readiness below (WebKit),
   * one run recorded the closure itself (`gateDiagnostics().closes`): at 937 ms into B's life, with A's outbox just started and A not yet
   * closed, `closeAll(account, "closed_for_deletion")` from `dispose` in `browser-env` (the production tree's DATA ENVIRONMENT being disposed:
   * the tree remounting), and the page's registry latched `open` again 15 ms later when the tree rebound. A close of the page's registry
   * ends EVERY connection of the account on the page, the tree's controller's and the harness's second runtime's (the outbox) alike, because
   * the registry is one for the page and its latch is what keeps a late writer from re-creating a database. The harness's runtime does not
   * follow the tree's lifecycle, so a tree disposal after the harness has opened closes its store from under it: exactly the symptoms of
   * revision 18 (the control below makes the same registry close on demand with the production `closeOwnConnections`, in every engine). In
   * production there is one runtime per page and the tree rebinds it; the engine's leader attaches to the controller's service in WEB-09b.
   * So this was a defect of the fixture's lifecycle and not of the guard or the product.
   *
   * WHAT IS NOT ESTABLISHED. Which event of the other page remounts B's tree (A's outbox creating the database and publishing, A's
   * departure releasing locks the other pages' sessions wait on, or both) is not pinned: B's connection count was 0 when A closed and was 2
   * within 11 to 280 ms afterwards in all 72 runs of the diagnostic that watched it, and the one capture above came before A closed. No run has
   * reproduced the failure itself (over 200 runs of the schedule in WebKit, loaded to a load average of 50 and not, with and without the
   * default page), so the claim is that the closure SEEN is the one that closes the store, supported by the control and by the traces, not
   * that the failing runs were seen closing.
   *
   * REVISION 23 (R43) pinned the trigger for Chromium and Firefox: a page that BOOTS makes every other page of the origin check its session
   * (its view is neutral for 3 to 27 ms and its tree is torn down and mounted again; 198 of 200 Firefox sequences, the other two recorded none), a page's own boot does
   * the same to itself, and a page's DEPARTURE did not (page A's close left page B's view, tree and outbox alone, 6 of 6 in Firefox). In
   * WebKit the check of another page's boot ran in 2 of the 33 runs of the `R43 control` arrangement (31 showed none: the view never left
   * `displaying`), and there a tree binds the database by itself, so in both of those two runs the check disposed a bound tree and closed
   * the registry: the same mechanism, rarely, and the likely cause of the closures R34 captured, but not caught at that schedule. Both pages'
   * lifetimes (`readLifetime`) are in this case's evidence now, so a failure of this schedule carries what the sessions did.
   *
   * THE CASE. It no longer guesses that a page is ready from its age (`quiet()`: "a page boots in about 1.5 s"). It reads the pages
   * (`untilTreeSettled`: the session has booted, the tree has bound the database where it is to, no lease stands, and nothing has happened
   * to the registry, the kernel or the connections for 300 ms) before the harness's outbox shares the registry of a tree that may still
   * dispose it, and it records what it found, with the registry's close log, before it asserts, so that a failure carries its own cause.
   */
  const SCHEDULES = [
    "no step at all",
    "a step, the new page first",
    "a step, every original page closed",
    "a step, every original page closed, the new page booted before they closed",
  ] as const;
  for (const schedule of SCHEDULES)
    for (const roomy of [false, true])
      test(`R28b (revision 18): a page whose guard is built after the clock moved keeps page A's debit, ${schedule}, ${roomy ? "room for both" : "room for one"} (a named clock injection; the estimate's free space is injected too)`, async ({
        context,
      }, info) => {
        const free = FLOOR + (roomy ? 2_500_000 : 1_200_000);
        await stubNetwork(context);
        // A HEALTHY backend answers the identity reads: the shared stub answers neither `/me` nor `/sessions` (404), so each page's
        // controller keeps asking and its tree remounts, which closes the account's connections under the harness's outbox. This case
        // has a page started and another closed in the middle of the run, so it must not depend on that.
        await serveIdentityReads(context);
        await seedSettled(context);
        const closing = schedule.startsWith(
          "a step, every original page closed",
        );
        // B exists before the landing in every schedule but the review's own closing one, in which it is a NEW page that opens once every
        // earlier page is gone.
        const bootsEarly = schedule !== "a step, every original page closed";
        const settled: Record<string, Settled> = {};
        const trail: string[] = [];
        let b: Page | null = null;
        let original: Page | null = null;
        let until = 0;
        let judgedAt = 0;
        let savingStarted = 0;
        let second: unknown = null;
        let failure: string | null = null;
        try {
          const a = await bootSession(context);
          original = a;
          // Recording only (R43, revision 23): what each page's session and registry did, for the evidence below.
          await recordLifetime(a);
          // Page A has no database yet (its outbox creates it): there is nothing to wait for but its session.
          settled.aBooted = await untilTreeSettled(a, { connections: 0 });
          const early = bootsEarly ? await bootSession(context) : null;
          if (early) {
            await recordLifetime(early);
            settled.earlyBooted = await untilTreeSettled(early, {
              connections: 0,
            });
          }
          trail.push("booted");
          await startOutbox(a, ACCOUNT, {
            start: false,
            estimateFreeBytes: free,
            originLedger: true,
            quotaMonotonic: true,
          });
          // The database now exists, with the harness's own pair of connections on page A. A tree that booted before the database existed
          // does not look again by itself; it binds the database when its session remounts it, which another page's departure causes.
          settled.aOutbox = await untilTreeSettled(a, { connections: 2 });
          trail.push("A started");
          expect((await enqueue(a, bigSave("one", 41)))?.kind).toBe("queued");
          await expect
            .poll(async () => (await ledger(a))?.landed?.landed ?? 0, {
              timeout: 10_000,
            })
            .toBeGreaterThanOrEqual(900_000);
          const landed = await ledger(a);
          until = landed?.landed?.until ?? 0;
          const offset = schedule === "no step at all" ? 0 : HOUR;
          // A lived through the step (it reads the clock again at its next look); or it is gone, with its Web Locks released.
          if (schedule === "a step, the new page first")
            await a.evaluate(
              (ms) => window.__atlasData?.setQuotaClockOffset(ms),
              offset,
            );
          if (closing) await a.close();
          trail.push(closing ? "A closed" : "A kept");
          b = early ?? (await bootSession(context));
          if (!early) await recordLifetime(b);
          // In a closing schedule B's tree binds the database now (a new page finds it at once; an early page's session remounts the
          // tree when A has gone), and B waits for that and for 300 ms of quiet before the harness's outbox shares its registry. With A
          // alive nothing of B's is bound or moving, and the wait is for the quiet alone.
          settled.bBeforeOutbox = await untilTreeSettled(b, {
            connections: closing ? 2 : 0,
          });
          trail.push("B settled");
          await startOutbox(b, ACCOUNT, {
            start: false,
            estimateFreeBytes: free,
            originLedger: true,
            quotaMonotonic: true,
            quotaClockOffsetMs: offset,
          });
          savingStarted = await b.evaluate(() => Date.now());
          second = await enqueue(b, bigSave("two", 42));
          judgedAt = await b.evaluate(() => Date.now());
          trail.push("B saved");
        } catch (error) {
          failure = (error as Error).message;
        }
        // The facts are recorded BEFORE anything is asserted, so that a failure leaves what the page and the ledger showed: the
        // registry's close log, the latches and the kernel's last events as well as the ledger.
        const stored = b
          ? (((await drafts(b).catch(() => [])) ?? []) as object[])
          : [];
        const retained = stored.length * 900_000;
        const record = b ? await ledger(b).catch(() => null) : null;
        recordEvidence(
          info,
          `origin-ledger-new-page-after-step-${schedule.replace(/[^a-z]+/g, "-")}-${roomy ? "roomy" : "tight"}`,
          {
            freeBytesInjected: free,
            floorBytes: FLOOR,
            namedInjection:
              "page B's guard reads Date.now() an hour ahead from its construction; the page's own performance.now() is its monotonic clock; the estimate's free bytes are injected",
            schedule,
            failure,
            trail,
            settled,
            landedUntil: until,
            judgedAtMsBeforeTheDebitEnded: until - judgedAt,
            secondSaveMs: judgedAt - savingStarted,
            secondSaveOutcome: second,
            draftsRetained: stored.length,
            bytesLeftAboveTheFloor: free - retained - FLOOR,
            ledgerAfter: record,
            registry: b
              ? await b
                  .evaluate(() => window.__atlasData?.gateDiagnostics())
                  .catch((error: Error) => ({ unreadable: error.message }))
              : null,
            // The lifetime of both pages (the registry's close log, latch, connections and the session's views, on each page's clock):
            // page A is gone in a closing schedule, and its record is then unreadable.
            lifetimeOfB: b
              ? await readLifetime(b).catch((error: Error) => ({
                  unreadable: error.message,
                }))
              : null,
            lifetimeOfA: original
              ? await readLifetime(original).catch((error: Error) => ({
                  unreadable: error.message,
                }))
              : null,
            estimateRequestsOfB: b
              ? ((await b
                  .evaluate(() => window.__atlasData?.estimateRequests())
                  .catch(() => [])) ?? [])
              : [],
          },
        );
        expect(failure, "the case ran to its end").toBeNull();
        expect(
          judgedAt,
          "the second save was judged inside the first debit's own lifetime (real time)",
        ).toBeLessThan(until);
        if (roomy) expect((second as { kind?: string })?.kind).toBe("queued");
        else expect(second).toEqual({ kind: "refused", reason: "quota" });
        // The reserve: no more is retained than the origin can spare above the floor, and the debit was not deleted by the new page.
        expect(free - retained).toBeGreaterThanOrEqual(FLOOR);
        expect(record?.landed?.landed ?? 0).toBeGreaterThanOrEqual(900_000);
      });

  /**
   * R34 control (revision 19): the failure of revision 18's closing schedule, made on demand. The production tree's disposal (its data
   * environment, `browser-env`'s `dispose`) closes EVERY connection of the account on the page with the latch `closed_for_deletion`, because
   * the page's connection registry is one for the page (the latch is what keeps a late writer from re-creating a database). It was
   * captured doing so on B after the other page's activity (WebKit, 937 ms into B's life: `closeAll`, `closed_for_deletion`, then `open` again
   * 15 ms later when the tree rebound; `gateDiagnostics().closes` in the evidence of `origin-ledger-new-page-after-step-a-step-every-original-
   * page-closed-the-new-page-booted-be…`). The fixture's outbox is a SECOND runtime over that registry and does not follow the tree's
   * lifecycle, so its store is closed under it, with exactly the revision-18 symptoms: a refused or failed save, `StoreFailure: closed`, and
   * `no open store`. The production port that every page has for a wipe, `closeOwnConnections`, makes the same call, so it is used here.
   */
  test("R34 control: a close of the page's connection registry (what the production tree's disposal does) ends the store of the harness's outbox on that page, with the symptoms of revision 18's closing schedule", async ({
    context,
  }, info) => {
    const free = FLOOR + 1_200_000;
    await stubNetwork(context);
    await serveIdentityReads(context);
    await seedSettled(context);
    const page = await bootSession(context);
    await untilTreeSettled(page, { connections: 0 });
    await startOutbox(page, ACCOUNT, {
      start: false,
      estimateFreeBytes: free,
      originLedger: true,
      quotaMonotonic: true,
    });
    const settled = await untilTreeSettled(page, { connections: 2 });
    expect((await enqueue(page, bigSave("one", 41)))?.kind).toBe("queued");
    const draftsBefore = ((await drafts(page)) ?? []) as object[];
    await page.evaluate(
      (account) =>
        window.__atlasData?.ports.database.closeOwnConnections(account),
      ACCOUNT,
    );
    const afterClose = await drafts(page).then(
      () => null,
      (error: Error) => error.message,
    );
    const saved = await enqueue(page, bigSave("two", 42));
    const registry = await page.evaluate(() =>
      window.__atlasData?.gateDiagnostics(),
    );
    recordEvidence(info, "r34-registry-close-control", {
      settled,
      draftsBefore: draftsBefore.length,
      afterClose,
      saved,
      registry,
    });
    expect(draftsBefore).toHaveLength(1);
    expect(afterClose).toMatch(/no open store/);
    expect((saved as { kind?: string })?.kind).not.toBe("queued");
    expect(registry?.closes.map((close) => close[2])).toContain(
      "closed_for_deletion",
    );
  });

  /**
   * R43 controls (revision 23): the mechanism behind the refusal that "R28, delayed estimate and no hint" met once, made on demand, and
   * the order that removes it. The two cases take the SAME pages through the SAME boots (page A; a throwaway page C, whose boot makes A
   * check its session and remount its tree, which then BINDS the database; page B) and differ only in WHEN A's harness outbox starts.
   *
   * THE MECHANISM. A booting page makes every other page of the origin check its session: the view is neutral for 3 to 27 ms (10 at the median), the
   * protected tree is torn down and mounted again, and a tree that is BOUND to the account when it is torn down closes the page's
   * connection registry (`dispose` in `browser-env`, `closeAll(closed_for_deletion)`; the latch is `open` again 15 to 25 ms later when the
   * tree rebinds). The harness's outbox is a second runtime over that registry, and its service has ended for good: its next save is
   * refused `identity_changed`, the facade's answer for a service that is not live. This is the refusal of the failing run, with the
   * registry's own log of what closed it.
   *
   * WHAT THEY SHOW AND WHAT THEY DO NOT. They show the mechanism where the engine runs the check (Chromium and Firefox) and that the order removes it. Whether
   * the failing run's page A was bound when B booted was not recorded. REVISION 24 (R43) found how a tree binds without a remount and
   * without a second page: it LOOKS again for the database at the first identity notification of its page once the database exists, and
   * the look completes in a few milliseconds (`R43 control` on an `atlas-sync` hint below, and the race in `twoPages`' comment). Page A of the old order
   * was therefore bound at B's flip whenever that look had completed first, which a held identity read of B makes a third of the
   * sequences in Firefox; the failing run's footprint (two identity reads from B) is that schedule's, and which sequence it was is not recorded.
   */
  const bootThree = async (
    context: import("@playwright/test").BrowserContext,
    startOutboxFirst: boolean,
    free: number,
    /** Called with page A once it is quiet and BEFORE the last page boots: what A's registry and tree are at the moment that matters. */
    beforeTheLastBoot: (a: Page) => Promise<void> = async () => undefined,
  ) => {
    await stubNetwork(context);
    await serveIdentityReads(context);
    await seedSettled(context);
    const pages: Record<string, Page> = {};
    const settled: Record<string, Settled> = {};
    // A wait that fails says what EVERY page's registry, latch, connections and session views were, not only that it timed out.
    const settle = async (
      name: string,
      page: Page,
      connections: number,
    ): Promise<void> => {
      try {
        settled[name] = await untilTreeSettled(page, { connections });
      } catch (error) {
        const facts: Record<string, unknown> = {};
        for (const [label, each] of Object.entries(pages))
          facts[label] = await readLifetime(each).catch(
            (failure: Error) => failure.message,
          );
        throw new Error(
          `${(error as Error).message}; waiting for ${name}; the lifetimes: ${JSON.stringify(facts)}`,
        );
      }
    };
    const a = await bootSession(context);
    pages.A = a;
    await recordLifetime(a);
    await settle("aBooted", a, 0);
    const start = async (page: Page, offset = 0) =>
      startOutbox(page, ACCOUNT, {
        start: false,
        estimateFreeBytes: free,
        originLedger: true,
        quotaMonotonic: true,
        quotaClockOffsetMs: offset,
      });
    let closesAtOutbox = 0;
    if (startOutboxFirst) {
      await start(a);
      await settle("aOutbox", a, 2);
      closesAtOutbox = (await readLifetime(a)).closes.length;
    }
    // A throwaway page: its boot makes A check its session and remount its tree. With the database in existence (A's outbox made it) the
    // remounted tree BINDS it (4 connections: its pair and the harness's); with none, there is nothing to bind.
    const c = await bootSession(context);
    pages.C = c;
    await recordLifetime(c);
    await settle("cBooted", c, 0);
    // A is read for the quiet only: where the engine binds a tree without a remount, or runs the check of A at C's boot, A's registry may
    // already have been closed by now, which is the mechanism and not a failure of the wait.
    if (startOutboxFirst) await settle("aAfterC", a, 0);
    await beforeTheLastBoot(a);
    const b = await bootSession(context);
    pages.B = b;
    await recordLifetime(b);
    await settle("bBooted", b, 0);
    // With the outbox live over a bound tree, B's boot is what ends it (the control below): A is read for the quiet only.
    await settle("aAfterB", a, 0);
    if (!startOutboxFirst) {
      await start(a);
      await settle("aOutbox", a, 2);
    }
    await start(b);
    await settle("bOutbox", b, 2);
    return { a, b, c, settled, closesAtOutbox };
  };

  /**
   * ENGINES. Chromium and Firefox run the session check (the neutral stretch of the view, and the tree's disposal and remount) in every
   * other page when a page boots; WebKit rarely did (2 of 33 runs; in the other 31 the view of a page never left `displaying`, its tree
   * bound the database without a remount, and no registry was closed; in the two it closed the registry of a tree that had bound itself), so a
   * control that asks for the refusal asks for it where the check ran:
   * what every engine shows is the implication (a check of a page whose tree is bound closes its registry and ends its outbox, and
   * without a check nothing does), and the engines that run the check are required to have run it.
   */
  const runsTheCheck = (info: import("@playwright/test").TestInfo): boolean =>
    info.project.name !== "fixture-webkit";
  const completedChecksSince = (facts: Lifetime, since: number): number =>
    facts.episodes.filter(([start, end]) => end !== null && start >= since)
      .length;
  test("R43 control: a page whose tree is BOUND and whose harness outbox is live loses the outbox when another page boots: the registry is closed by the tree's disposal and the first save is refused `identity_changed`, the refusal of the failing run", async ({
    context,
  }, info) => {
    let beforeB: Lifetime | null = null;
    const { a, settled, closesAtOutbox } = await bootThree(
      context,
      true,
      FLOOR + 1_200_000,
      async (page) => {
        beforeB = await readLifetime(page);
      },
    );
    const first = await enqueue(a, bigSave("one", 41));
    const facts = await readLifetime(a);
    const fresh = facts.closes.slice(closesAtOutbox);
    const checks = completedChecksSince(facts, 0);
    // The checks of A that B's boot caused (revision 35: see the adapted assertion below).
    const sinceB = completedChecksSince(
      facts,
      (beforeB as Lifetime | null)?.ms ?? 0,
    );
    recordEvidence(info, "r43-control-bound-tree-then-a-boot", {
      namedArrangement:
        "page A's harness outbox is started first, a throwaway page's boot comes next, and page B boots last",
      engineRunsTheCheck: runsTheCheck(info),
      settled,
      first,
      checksOfA: checks,
      checksOfAAfterBBooted: sinceB,
      closesAfterTheOutboxStarted: fresh,
      lifetimeOfAJustBeforeBBooted: beforeB,
      lifetimeOfA: facts,
    });
    // Every closure of A's registry after its outbox started is the production tree's own disposal (and the registry opens again).
    for (const close of fresh) {
      expect(close[2]).toBe("closed_for_deletion");
      expect(close[3]).toMatch(/browser-env/);
    }
    expect(facts.latch).toBe("open");
    // ADAPTED, revision 35 (a harness premise, found by the focused run `driver-r35c` in Chromium): the check counted above starts at the
    // page's own start, so it also counts the check the THROWAWAY page's boot caused (that is what binds A's tree). Whether B's boot made A
    // check again is what decides the closure: the engine does so for nearly every boot and not every one (revision 23 measured 198 of 200
    // in Chromium and Firefox), and in the failed run A's only check was the throwaway page's, its view never left `displaying` after B's
    // boot, nothing closed and the first save was queued, as the implication below requires. So the closure is asserted exactly when B's
    // boot made A check, and its absence otherwise; the premises (a check ran, the tree was bound before B booted) are unchanged.
    if (runsTheCheck(info)) {
      // Where the check runs, it ran, the tree was bound by the time B booted, and the outbox is gone if B's boot made A check.
      expect(
        checks,
        "this engine runs the session check of a page when another page boots",
      ).toBeGreaterThanOrEqual(1);
      expect(
        (beforeB as Lifetime | null)?.openCount,
        "page A's tree was bound (its pair of connections and the harness's) when the last page booted",
      ).toBeGreaterThanOrEqual(4);
      expect(
        fresh,
        `closures after the outbox started, with ${sinceB} check(s) of A after B's boot`,
      ).toHaveLength(sinceB > 0 ? 1 : 0);
    }
    // The implication, in every engine: a closure of the registry ends the outbox for good, and without one it lives.
    if (fresh.length > 0)
      expect(first).toEqual({ kind: "refused", reason: "identity_changed" });
    else expect(first?.kind).toBe("queued");
  });

  test("R43 control: the same pages and the same boots, with both harness outboxes started AFTER the last boot (the order `twoPages` has), keep every outbox: the first save is queued and nothing closed either registry", async ({
    context,
  }, info) => {
    const { a, b, settled } = await bootThree(
      context,
      false,
      FLOOR + 1_200_000,
    );
    const first = await enqueue(a, bigSave("one", 41));
    const factsA = await readLifetime(a);
    const factsB = await readLifetime(b);
    const checks = completedChecksSince(factsA, 0);
    recordEvidence(info, "r43-control-outboxes-after-the-last-boot", {
      engineRunsTheCheck: runsTheCheck(info),
      settled,
      first,
      checksOfA: checks,
      lifetimeOfA: factsA,
      lifetimeOfB: factsB,
    });
    expect(first?.kind).toBe("queued");
    expect(factsA.closes).toEqual([]);
    expect(factsB.closes).toEqual([]);
    expect(factsA.latch).toBe("open");
  });

  /**
   * R43 (revision 24): the set-up under the schedule that broke the OLD order. Page B's first identity read is held 30, 80 and 300 ms (a
   * named latency injection: on a loaded machine the stub's answer, a round trip through the test process, is this late), which in the old
   * order (page A's outbox started, then page B booted) closed A's registry in about a third of its runs, in Firefox. Every boot has
   * happened and every tree has settled before any outbox exists here, so nothing of B's boot is left to flip A: both outboxes are kept,
   * the first save is queued, and the set-up's own check (nothing closed a registry after its outbox started) holds. The old order's
   * failure is probabilistic, so this is a CONTROL of the order and not a measurement of the old one: the measurement is the
   * campaign in the evidence, and `R43 race` below states the condition under which the old order closes the registry.
   */
  for (const hold of [30, 80, 300])
    test(`R43: with page B's first identity read held ${hold} ms (the schedule that closed the old order's registry in about a third of its runs), the set-up keeps both outboxes: the first save is queued and nothing closed either registry`, async ({
      context,
    }, info) => {
      const { a, lifetime, settled } = await twoPages(
        context,
        FLOOR + 1_200_000,
        0,
        {},
        { holdBIdentityReadMs: hold },
      );
      const first = await enqueue(a, bigSave("one", 41));
      const at = await lifetime();
      recordEvidence(info, `r43-held-identity-read-${hold}`, {
        namedInjection: `page B's first identity read (GET /browser-sessions/current) is answered ${hold} ms late`,
        settled,
        first,
        lifetime: at,
      });
      expect(first?.kind).toBe("queued");
      expect(at.a.closes).toEqual([]);
      expect(at.b.closes).toEqual([]);
      expect(at.a.latch).toBe("open");
    });

  /**
   * R43 race (revision 24): the condition under which the OLD order (page A boots, its outbox starts, page B boots at once) closes A's
   * registry, stated on the page's own record and asserted in EVERY sequence whatever the schedule gives. A's tree LOOKS for the database
   * (an open with `create: false`) at the first identity notification of A once A's own outbox has created it; the open completes in a few
   * milliseconds and binds the tree. B's boot attempt (an identity read, a foreign lease while it is in flight) makes A evaluate and then,
   * when B's answer arrives, set its hold and leave `displaying`: the tree is disposed. The registry is closed (and A's first save refused
   * `identity_changed`) IF AND ONLY IF the look had COMPLETED before A's view left `displaying`: a look still pending at the disposal is
   * abandoned and closes nothing (R35). With B's first identity read held 80 ms the schedule gives each outcome (about a third of the
   * sequences close the registry in Firefox), so the implication is exercised on whatever the engine does; the assertion does not depend on
   * how often. This is the OLD order, kept here only as the control that pins the condition: nothing else in this spec boots a page after an outbox started.
   */
  for (const sequence of [1, 2, 3, 4])
    test(`R43 race (sequence ${sequence}): in the old order, with page B's first identity read held 80 ms, page A's registry is closed, and its first save refused, if and only if A's tree look had completed before A's view left \`displaying\``, async ({
      context,
    }, info) => {
      test.setTimeout(90_000);
      await stubNetwork(context);
      await seedSettled(context);
      const a = await bootSession(context);
      await recordLifetime(a);
      // The old set-up's own wait: the page's age (the tree's first mounts are over), nothing else.
      const age = await a.evaluate(() => performance.now());
      if (age < 1_500) await a.waitForTimeout(1_500 - age);
      await startOutbox(a, ACCOUNT, {
        start: false,
        estimateFreeBytes: FLOOR + 1_200_000,
        originLedger: true,
      });
      const outboxAt = Date.now();
      const b = await bootSession(context, { holdIdentityReadMs: 80 });
      await recordLifetime(b);
      const age2 = await b.evaluate(() => performance.now());
      if (age2 < 1_500) await b.waitForTimeout(1_500 - age2);
      await startOutbox(b, ACCOUNT, {
        start: false,
        estimateFreeBytes: FLOOR + 1_200_000,
        originLedger: true,
      });
      const first = await enqueue(a, bigSave("one", 41));
      const facts = await readLifetime(a);
      const since = outboxAt - (facts.dateOffset ?? 0);
      const flip =
        facts.episodes.find(([start]) => start >= since)?.[0] ?? null;
      const look =
        facts.opens.find(
          ([ms, kind]) =>
            kind === "request" && ms >= since && (flip === null || ms <= flip),
        ) ?? null;
      const done =
        look === null
          ? null
          : (facts.opens.find(
              ([, kind, detail]) => kind === "success" && detail === look[2],
            )?.[0] ?? null);
      const completedBeforeTheFlip =
        flip !== null && done !== null && done <= flip;
      const closed = facts.closes.filter(([ms]) => ms >= since);
      recordEvidence(info, `r43-race-${sequence}`, {
        namedInjection:
          "page B's first identity read (GET /browser-sessions/current) is answered 80 ms late",
        engineRunsTheCheck: runsTheCheck(info),
        first,
        msAfterTheOutbox: {
          flip: flip === null ? null : flip - since,
          lookRequested: look === null ? null : look[0] - since,
          lookCompleted: done === null ? null : done - since,
        },
        completedBeforeTheFlip,
        closedAfterTheOutboxStarted: closed,
        lifetimeOfA: facts,
      });
      // The condition, in every sequence of every engine.
      expect(
        closed.length > 0,
        "A's registry was closed after its outbox started if and only if A's tree look had completed before its view left `displaying`",
      ).toBe(completedBeforeTheFlip);
      for (const close of closed) {
        expect(close[2]).toBe("closed_for_deletion");
        expect(close[3]).toMatch(/browser-env/);
      }
      if (closed.length > 0)
        expect(first).toEqual({ kind: "refused", reason: "identity_changed" });
      else expect(first?.kind).toBe("queued");
    });

  /**
   * R43 (revision 24): the same closure through the PRODUCTION binding path and nothing else. A tree binds a database that another path
   * created when the page hears an `atlas-sync` hint (`data_changed`, the first sync's own message to other tabs): here page A's outbox
   * has created the database, a hint reaches A's tree, and the tree BINDS with no remount and no second page. Page B then boots: its
   * boot attempt makes A leave `displaying`, the bound tree is disposed, A's registry closes, and A's first save is refused. Where the
   * engine runs the check of another page's boot (Chromium and Firefox) the closure is required; in every engine a closure ends the
   * outbox and none leaves it.
   */
  test("R43 control: a tree that binds the database on an `atlas-sync` hint (the production path) and is then disposed by another page's boot closes the registry: the first save is refused `identity_changed`", async ({
    context,
  }, info) => {
    await stubNetwork(context);
    await serveIdentityReads(context);
    await seedSettled(context);
    const a = await bootSession(context);
    await recordLifetime(a);
    await untilTreeSettled(a, { connections: 0 });
    await startOutbox(a, ACCOUNT, {
      start: false,
      estimateFreeBytes: FLOOR + 1_200_000,
      originLedger: true,
    });
    await untilTreeSettled(a, { connections: 2 });
    const closesAtOutbox = (await readLifetime(a)).closes.length;
    // The hint another tab's first sync posts: this page hears it on the channel its tree listens on.
    await a.evaluate((account) => {
      const channel = new BroadcastChannel("atlas-sync");
      channel.postMessage({
        type: "data_changed",
        account,
        stores: ["cache", "sync_state"],
      });
      channel.close();
    }, ACCOUNT);
    const bound = await untilTreeSettled(a, { connections: 4 });
    const beforeB = await readLifetime(a);
    const b = await bootSession(context);
    await recordLifetime(b);
    await untilTreeSettled(b, { connections: 0 });
    await untilTreeSettled(a, { connections: 0 });
    const first = await enqueue(a, bigSave("one", 41));
    const facts = await readLifetime(a);
    const fresh = facts.closes.slice(closesAtOutbox);
    recordEvidence(info, "r43-control-bound-by-a-hint", {
      engineRunsTheCheck: runsTheCheck(info),
      boundByTheHint: bound,
      first,
      closesAfterTheOutboxStarted: fresh,
      lifetimeOfAJustBeforeBBooted: beforeB,
      lifetimeOfA: facts,
    });
    expect(
      beforeB.openCount,
      "the hint bound page A's tree: its pair of connections and the harness's, with no flip and no second page",
    ).toBeGreaterThanOrEqual(4);
    for (const close of fresh) {
      expect(close[2]).toBe("closed_for_deletion");
      expect(close[3]).toMatch(/browser-env/);
    }
    if (runsTheCheck(info)) expect(fresh).toHaveLength(1);
    if (fresh.length > 0)
      expect(first).toEqual({ kind: "refused", reason: "identity_changed" });
    else expect(first?.kind).toBe("queued");
  });
});
