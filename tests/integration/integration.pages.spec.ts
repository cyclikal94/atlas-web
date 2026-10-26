import type { Page } from "@playwright/test";
import {
  bootHarness,
  expect,
  finishSignIn,
  freshHarnessDocument,
  identityReadsAtProxy,
  liftedAt,
  proxy,
  raw,
  rawSignIn,
  recordMeasurement,
  records,
  type SettledLike,
  setVisibility,
  signIn,
  startSignIn,
  test,
  untilHeld,
  untilRecord,
  untilView,
  view,
  watchLift,
  withStaleSharedConfirmation,
} from "./helpers";
import {
  AUTH_NAMES,
  closeInOrder,
  judgeOrderedClose,
  mark,
  type OrderedCloseReceipt,
  openObserver,
} from "./ordered-close";
import {
  judgeTypedCall,
  judgeVerificationPremise,
  type KernelEvent,
  type VerificationPremiseInput,
} from "./verification-premise";

/**
 * I-09, I-10 and I-12 to I-15 (plan 14.3), required on Chromium and run on the other engines where the engine allows. Two pages of
 * one browser context are two tabs of one origin sharing IndexedDB, Web Locks and the cookie jar. Visibility is driven by
 * overriding `document.visibilityState` (limitation stated in docs/browser-support.md).
 */

const SESSIONS = /^\/api\/experimental\/v1\/sessions$/;
const sessionsRule = (action: "hold" | "hold_request") => ({
  method: "GET",
  path: "/^\\/api\\/experimental\\/v1\\/sessions$/",
  action,
  ordinal: 1,
});
void SESSIONS;

async function signedIn(
  context: import("@playwright/test").BrowserContext,
  who: "alice" | "bob" = "alice",
): Promise<Page> {
  const page = await bootHarness(context);
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  return page;
}

test.describe("I-09: two pages, one browser context", () => {
  test("page 1's request is held by the proxy: page 2's exposure DEFERS; a clean answer lets it proceed (surrender-to-grant delay recorded)", async ({
    context,
  }) => {
    const first = await signedIn(context);
    const rule = await proxy.addRule(sessionsRule("hold"));
    await first.evaluate(() => {
      window.__t.pending = window.__retry(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      );
    });
    await untilHeld(rule.id);
    const second = await bootHarness(context);
    await watchLift(second);
    await second.waitForTimeout(1500);
    // Page 2 has NOT exposed: a request that is still open cannot yet say whether the session has ended.
    expect(await liftedAt(second)).toBeNull();
    expect(
      await second.evaluate(() =>
        document.getElementById("protected-root")?.hasAttribute("inert"),
      ),
    ).toBe(true);
    const released = Date.now();
    await proxy.release(rule.id);
    await expect
      .poll(() => liftedAt(second), { timeout: 15_000 })
      .not.toBeNull();
    const liftedTime = await liftedAt(second);
    const delay = (liftedTime ?? released) - released;
    recordMeasurement(
      "P-5 surrender-to-grant (clean answer, page 1 -> page 2, chromium)",
      { milliseconds: delay },
    );
    await untilView(second, "displaying");
    expect(await first.evaluate(() => window.__t.pending)).toMatchObject({
      ok: true,
    });
  });

  test("a 401 answer closes page 2 before it ever displays", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const first = await signedIn(context);
    const other = await rawSignIn("alice");
    const rule = await proxy.addRule(sessionsRule("hold_request"));
    await first.evaluate(() => {
      window.__t.pending = window.__retry(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      );
    });
    await untilHeld(rule.id);
    const second = await bootHarness(context);
    await watchLift(second);
    // The session is removed by another route while the request waits; releasing it lets the backend answer 401.
    const current = (await records(first)).auth_state.settled;
    await raw("DELETE", `/sessions/${current?.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    await proxy.release(rule.id);
    await untilView(second, "neutral", "1b");
    expect(await liftedAt(second)).toBeNull(); // page 2 never displayed
    await untilView(first, "neutral", "1b");
    expect(
      Object.values((await records(first)).auth_state.fences)
        .flat()
        .some((f) => f.kind === "invalid_session"),
    ).toBe(true);
  });
});

test.describe("I-10: real adapters, two pages", () => {
  test("both pages display the settled account from the shared record; concurrent requests from both are all answered; no lock or lease is left", async ({
    context,
  }) => {
    const first = await signedIn(context);
    const second = await bootHarness(context);
    await untilView(second, "displaying");
    const results = await Promise.all(
      [first, second].map((page) =>
        page.evaluate(async () => {
          const out = await Promise.all(
            Array.from({ length: 5 }, () =>
              window.__retry(() => window.__s.operations.listSessions()),
            ),
          );
          return out.map((r) => r.ok);
        }),
      ),
    );
    // A request may be NOT_SENT for a moment (a hold), never lost; count the answered ones.
    expect(results.flat().filter(Boolean).length).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          Object.keys((await records(first)).auth_state.leases).length,
        { timeout: 15_000 },
      )
      .toBe(0);
    // No lease lock is still held (a test may use query(); the product never does). A release is published to other pages a moment
    // after the holder lets go, so this is polled.
    await expect
      .poll(
        () =>
          first.evaluate(async () => {
            const state = await navigator.locks.query();
            return (state.held ?? [])
              .map((l) => l.name ?? "")
              .filter(
                (n) =>
                  n.startsWith("atlas-lease-") || n.startsWith("atlas-issue-"),
              );
          }),
        { timeout: 15_000 },
      )
      .toEqual([]);
    expect(Object.keys((await records(first)).auth_state.fences)).toEqual([]);
  });
});

test.describe("I-12: the level-0 gate with a real session", () => {
  test("hidden then visible: the first frame is neutral, the same-account lift restores focus", async ({
    context,
  }) => {
    const page = await signedIn(context, "bob");
    // Let the router finish rendering its route: until its heading is there the shell may still replace the element we focus.
    await page.waitForSelector("#protected-root h1");
    await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
    });
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
    await setVisibility(page, "hidden");
    const gated = await page.evaluate(() => ({
      inert: document.getElementById("protected-root")?.hasAttribute("inert"),
      modal: (
        document.getElementById("resume-gate") as HTMLDialogElement | null
      )?.matches(":modal"),
      title: document.title,
    }));
    expect(gated).toEqual({ inert: true, modal: true, title: "Atlas" });
    await setVisibility(page, "visible");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById("protected-root")?.hasAttribute("inert"),
        ),
      )
      .toBe(false);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
  });

  test("a fence recorded while hidden prevents the lift", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const first = await signedIn(context, "bob");
    await setVisibility(first, "hidden");
    // Another page of the same browser finds the session gone and records the fence.
    const other = await rawSignIn("bob");
    const current = (await records(first)).auth_state.settled;
    await raw("DELETE", `/sessions/${current?.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    const second = await bootHarness(context);
    await second.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    await untilRecord(
      first,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "the second page recorded the fence",
    );
    await setVisibility(first, "visible");
    await untilView(first, "neutral", "1b");
    expect(
      await first.evaluate(
        () => document.getElementById("protected-root")?.innerHTML,
      ),
    ).toBe("");
  });
});

/** Every API and health request of the context, refused by the network (the HTML is still served). */
const UNREACHABLE = /\/(api\/|health)/;

/** The unresolved leases each verification of `page` captured when its cover committed. */
const capturedBy = (page: Page) =>
  page.evaluate(() =>
    (window.__atlasFixture?.session?.trace ?? [])
      .filter(
        (e) =>
          e.event === "cover.committed" && e.data?.klass === "verification",
      )
      .map((e) => [...((e.data?.unresolved as string[] | undefined) ?? [])]),
  );

/**
 * After the ordered close: refuse the API, boot the target and record it in the receipt (the judge checks the refusal came after the
 * setup ended, the boot after the refusal, and that the target captured nothing). Returns the target and the refused-call count.
 */
async function offlineTarget(
  context: import("@playwright/test").BrowserContext,
  receipt: OrderedCloseReceipt,
  producerBoots: string[],
) {
  const refused = { calls: 0 };
  await context.route(UNREACHABLE, (route) => {
    refused.calls += 1;
    return route.abort("connectionrefused");
  });
  const refusalSeq = mark(receipt);
  const page = await bootHarness(context);
  const bootSeq = mark(receipt);
  const recordTarget = async () => {
    receipt.target = {
      refusalSeq,
      bootSeq,
      boot: await page.evaluate(() => window.__s.bootId),
      producerBoots,
      captured: await capturedBy(page),
    };
  };
  return { page, refused, recordTarget };
}

const CLOSE_PREMISE = "the I-13 close premise (ordered-close.ts)";
const TARGET_PREMISE = "the I-13 target (ordered-close.ts)";

test.describe("I-13: ordinary offline continuation (row 6)", () => {
  test("with the API unreachable (HTML still served) a new page for a settled account exposes it, and the canary passes", async ({
    context,
    provokes,
  }) => {
    provokes(0);
    const seed = await signedIn(context, "alice");
    const a = (await records(seed)).auth_state.settled as SettledLike;
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    // The seed is closed only under the ordering boundary of ordered-close.ts (review 37 R37-N1): a page closed with a request
    // outstanding leaves an UNRESOLVED lease, and the protocol (correctly, row 9) then keeps the content hidden until one online read
    // settles it. One empty read is not enough: the seed's own display reads committed their leases after it in review 37's Firefox
    // run. The barrier admits no cover from the read until the seed is destroyed, and the record is read again afterwards.
    const receipt = await closeInOrder(context, [seed], a);
    expect(judgeOrderedClose(receipt).problems, CLOSE_PREMISE).toEqual([]);
    const { page, refused, recordTarget } = await offlineTarget(
      context,
      receipt,
      [seedBoot],
    );
    await untilView(page, "displaying");
    expect(
      await page.evaluate(
        () => window.__atlasFixture?.session?.booted !== null,
      ),
    ).toBe(true);
    // The person is shown the account without a single successful API call; the attempts that were made were refused by the network.
    expect(refused.calls).toBeGreaterThanOrEqual(0);
    expect((await records(page)).auth_state.settled).not.toBeNull();
    await recordTarget();
    expect(
      judgeOrderedClose(receipt, { target: true }).problems,
      TARGET_PREMISE,
    ).toEqual([]);
  });
});

/** A harness document that never starts a session (`?boot=off`): it can read and write the store, it makes no request. */
async function bootOff(context: import("@playwright/test").BrowserContext) {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  return page;
}

/**
 * For the engine-level controls, which need no backend: a settled record written through the production store by a `?boot=off`
 * document of a fresh context (TEST INSTRUMENTATION: no session ever reads it).
 */
async function settledRecordOnly(
  context: import("@playwright/test").BrowserContext,
) {
  const page = await bootOff(context);
  const identity = {
    account_id: "barrier-account",
    epoch: 1,
    session_id: "barrier-session",
  };
  await page.evaluate(async (settled) => {
    const harness = window.__atlasFixture?.session;
    if (!harness) throw new Error("no harness");
    const now = (await harness.readRecords()) as {
      auth_state: Record<string, unknown>;
    };
    await harness.seedAuthState({
      ...now.auth_state,
      settled: { ...settled, settled_at: new Date().toISOString() },
    });
  }, identity);
  return { page, identity };
}

interface LateWriteWindow {
  __lateWrite?: "queued" | "running" | "committed" | "aborted" | "failed";
}

/**
 * TEST INSTRUMENTATION: in `page`, create a readwrite transaction on the record that adds lease `lease` (a cover's write, made in its
 * body once its transaction starts). Resolves once the transaction is CREATED; `window.__lateWrite` then follows it.
 */
const queueLeaseWrite = (page: Page, lease: string) =>
  page.evaluate(
    ({ database, store, lease }) =>
      new Promise<string>((resolve, reject) => {
        const w = window as unknown as LateWriteWindow;
        const request = indexedDB.open(database);
        request.onerror = () => reject(new Error("open failed"));
        request.onsuccess = () => {
          const db = request.result;
          const t = db.transaction(store, "readwrite");
          const records = t.objectStore(store);
          const read = records.get("auth_state");
          read.onsuccess = () => {
            const state = read.result as {
              settled: { account_id: string; epoch: number };
              leases: Record<string, unknown>;
            };
            state.leases = {
              ...state.leases,
              [lease]: {
                account_id: state.settled.account_id,
                epoch: state.settled.epoch,
                boot_id: "late-writer",
                class: "ordinary",
              },
            };
            records.put(state, "auth_state");
            w.__lateWrite = "running";
          };
          t.oncomplete = () => {
            w.__lateWrite = "committed";
          };
          t.onabort = () => {
            w.__lateWrite = "aborted";
          };
          w.__lateWrite = "queued";
          resolve("queued");
        };
      }),
    { ...AUTH_NAMES, lease },
  );

/** The lease ids in the record, read raw (no validation) in `page`. */
const rawLeases = (page: Page) =>
  page.evaluate(
    ({ database, store }) =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onerror = () => reject(new Error("open failed"));
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction(store, "readwrite")
            .objectStore(store)
            .get("auth_state");
          read.onsuccess = () => {
            db.close();
            resolve(
              Object.keys(
                (read.result as { leases?: Record<string, unknown> })?.leases ??
                  {},
              ).sort(),
            );
          };
          read.onerror = () => reject(new Error("read failed"));
        };
      }),
    AUTH_NAMES,
  );

interface BarrierStateWindow {
  __closeBarrier: {
    state(): { phase: string; keepalive: number };
    release(): Promise<{ phase: string; keepalive: number }>;
    arm(identity: SettledLike): Promise<{ kind: string }>;
    transaction(): IDBTransaction | null;
  };
}

/** The typed client's GET /sessions in `page` for `a`, its result kept in `window.__t.late`; the activity number it created. */
const startLateSessions = (page: Page, a: SettledLike) =>
  page.evaluate(
    (arg) => {
      const trace = window.__atlasFixture?.session?.trace ?? [];
      const from = trace.length;
      window.__t.late = window.__s.api
        .client("ordinary", arg.account, arg.epoch)
        .GET("/sessions")
        .then(
          () => "returned",
          (error: unknown) => (error as { kind?: string }).kind ?? "threw",
        );
      // The typed client's send() creates its activity synchronously inside the call (revision 33).
      const created = trace
        .slice(from)
        .find(
          (e) => e.event === "activity.create" && e.data?.klass === "ordinary",
        );
      return (created?.data?.n as number | undefined) ?? null;
    },
    { account: a.account_id, epoch: a.epoch },
  );

/**
 * Count each document's transactions on `atlas-auth` as they are created, with the kernel trace's length at that moment
 * (TEST INSTRUMENTATION). A cover's transaction is the only readwrite transaction with `strict` durability a quiet, clean seed can
 * create: exposures are `default`, reads are `default`, and retirement, recording and settlement need a lease or an answer that a
 * clean record under the barrier cannot have.
 */
async function recordAuthTransactions(
  context: import("@playwright/test").BrowserContext,
) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __authTx?: Array<{ at: number; mode: string; durability: string }>;
    };
    w.__authTx = [];
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function transaction(
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const created = original.apply(this, args);
      if (this.name === "atlas-auth")
        w.__authTx?.push({
          at: window.__atlasFixture?.session?.trace.length ?? -1,
          mode: args[1] ?? "readonly",
          durability: args[2]?.durability ?? "default",
        });
      return created;
    } as IDBDatabase["transaction"];
  });
}

test.describe("I-13 (revision 34), premise controls: the schedules its ordered close must tell apart, forced in the real engine", () => {
  test("a request the seed starts after the barrier's clean read is queued behind it, never committed or sent, and ends with its document: the target displays offline", async ({
    context,
    provokes,
  }) => {
    provokes(0);
    await recordAuthTransactions(context);
    const seed = await signedIn(context, "alice");
    const a = (await records(seed)).auth_state.settled as SettledLike;
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    let late: { n: number; lease: string } | null = null;
    const receipt = await closeInOrder(context, [seed], a, {
      whileArmed: async () => {
        const n = await startLateSessions(seed, a);
        expect(n, "the late request created its activity").not.toBeNull();
        // Acknowledged: its cover began, holds both of its locks and created its transaction, which waits behind the barrier.
        const queued = await seed.waitForFunction(
          (activity) => {
            const trace = window.__atlasFixture?.session?.trace ?? [];
            const begin = trace.findIndex(
              (e) => e.event === "cover.begin" && e.data?.n === activity,
            );
            if (begin < 0) return null;
            const created = (
              (
                window as unknown as {
                  __authTx?: Array<{
                    at: number;
                    mode: string;
                    durability: string;
                  }>;
                }
              ).__authTx ?? []
            ).some(
              (t) =>
                t.at > begin &&
                t.mode === "readwrite" &&
                t.durability === "strict",
            );
            return created ? (trace[begin]?.data?.lease as string) : null;
          },
          n,
          { timeout: 4_000 },
        );
        const lease = (await queued.jsonValue()) as string;
        late = { n: n as number, lease };
        const held = await seed.evaluate(async () =>
          ((await navigator.locks.query()).held ?? []).map((l) => l.name),
        );
        expect(held).toEqual(
          expect.arrayContaining([
            `atlas-lease-${lease}`,
            `atlas-issue-${lease}`,
          ]),
        );
        const trace = await seed.evaluate(
          () => (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
        );
        const committed = trace.some(
          (e) => e.event === "cover.committed" && e.data?.n === n,
        );
        expect(
          committed,
          "the late request was queued behind the barrier",
        ).toBe(false);
        expect(
          trace.some((e) => e.event === "request.issued" && e.data?.n === n),
        ).toBe(false);
        expect(await sessionsAtProxy()).toBe(0);
      },
    });
    expect(late).not.toBeNull();
    expect(judgeOrderedClose(receipt).problems, CLOSE_PREMISE).toEqual([]);
    const { page, recordTarget } = await offlineTarget(context, receipt, [
      seedBoot,
    ]);
    await untilView(page, "displaying");
    await recordTarget();
    expect(
      judgeOrderedClose(receipt, { target: true }).problems,
      TARGET_PREMISE,
    ).toEqual([]);
    // Its request was never sent, before or after its document was destroyed, and its lease was never written.
    expect(await sessionsAtProxy()).toBe(0);
    expect(
      (await records(page)).auth_state.leases[
        (late as { lease: string } | null)?.lease ?? ""
      ],
    ).toBeUndefined();
  });

  test("a seed request live at the barrier's read is declined at once and armed over only once retired; an unlisted producer tab is refused; every listed producer closes under the barrier", async ({
    context,
    provokes,
  }) => {
    provokes(0);
    const seed = await signedIn(context, "alice");
    const a = (await records(seed)).auth_state.settled as SettledLike;
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    const second = await bootHarness(context);
    await untilView(second, "displaying");
    const secondBoot = await second.evaluate(() => window.__s.bootId);
    const held = await proxy.addRule(sessionsRule("hold"));
    await seed.evaluate(
      (arg) => {
        window.__t.seedCall = window.__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        );
      },
      { account: a.account_id, epoch: a.epoch },
    );
    await untilHeld(held.id);
    const live = Object.entries((await records(seed)).auth_state.leases)
      .filter(
        ([, lease]) =>
          (lease as { boot_id?: string }).boot_id === seedBoot &&
          lease.class === "ordinary",
      )
      .map(([id]) => id);
    expect(live.length).toBeGreaterThanOrEqual(1);
    // The second signed-in tab is not listed: refused before any barrier, and nothing is closed.
    const unlisted = await closeInOrder(context, [seed], a);
    expect(unlisted.failure ?? "").toMatch(
      /^an unlisted document of the context can still produce requests: /,
    );
    expect(unlisted.arms).toEqual([]);
    expect(seed.isClosed() || second.isClosed()).toBe(false);
    // Both listed. The first read sees the held request's lease: declined, its transaction ended; the request is then answered.
    let answered = false;
    const receipt = await closeInOrder(context, [seed, second], a, {
      onDeclined: async () => {
        if (answered) return;
        answered = true;
        await proxy.release(held.id);
      },
    });
    expect(receipt.arms[0]).toMatchObject({
      kind: "declined",
      settledPhase: "idle",
    });
    for (const id of live)
      expect(receipt.arms[0]?.reasons?.join(" ")).toContain(id);
    expect(receipt.arms.at(-1)?.kind).toBe("armed");
    expect(receipt.closes.map((c) => c.name)).toEqual([
      "producer-1",
      "producer-2",
    ]);
    expect(judgeOrderedClose(receipt).problems, CLOSE_PREMISE).toEqual([]);
    const { page, recordTarget } = await offlineTarget(context, receipt, [
      seedBoot,
      secondBoot,
    ]);
    await untilView(page, "displaying");
    await recordTarget();
    expect(
      judgeOrderedClose(receipt, { target: true }).problems,
      TARGET_PREMISE,
    ).toEqual([]);
  });

  test("without the barrier, a request the seed's document never sees settle leaves an unresolved lease: the barrier declines it, and after review 37's close the target stays closed offline until an online verification resolves it", async ({
    context,
    provokes,
  }) => {
    provokes(0);
    await instrumentIdentityReads(context);
    const seed = await signedIn(context, "alice");
    const a = (await records(seed)).auth_state.settled as SettledLike;
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    // Review 37's premise: one empty read.
    await untilRecord(
      seed,
      (s) => Object.keys(s.leases).length === 0,
      "no lease is outstanding",
    );
    // A request made after that read, whose outcome its document never sees (`__freeze`, as the I-14d orphan control).
    await seed.evaluate(
      (arg) => {
        (window as unknown as PremiseWindow).__freeze =
          "/api/experimental/v1/sessions";
        void window.__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        );
      },
      { account: a.account_id, epoch: a.epoch },
    );
    await expect.poll(() => sessionsAtProxy()).toBe(1);
    await untilRecord(
      seed,
      (s) =>
        Object.values(s.leases).length === 1 &&
        Object.values(s.leases).every(
          (l) => (l as { boot_id?: string }).boot_id === seedBoot,
        ),
      "only the frozen request's lease remains",
    );
    const orphan = Object.keys(
      (await records(seed)).auth_state.leases,
    )[0] as string;
    // The barrier never arms over it: it declines every read, ends each transaction, and stops at its bound saying why.
    const refused = await closeInOrder(context, [seed], a, {
      deadlineMs: 2_000,
    });
    expect(refused.failure).toBe(
      `the record was never clean within 2000 ms: unresolved leases ${JSON.stringify([orphan])}`,
    );
    expect(refused.arms.length).toBeGreaterThanOrEqual(1);
    expect(
      refused.arms.every(
        (arm) => arm.kind === "declined" && arm.settledPhase === "idle",
      ),
    ).toBe(true);
    expect(refused.closes).toEqual([]);
    expect(seed.isClosed()).toBe(false);
    // Review 37's close: the seed destroyed with the request outstanding.
    await seed.close();
    let apiCalls = 0;
    await context.route(UNREACHABLE, (route) => {
      apiCalls += 1;
      return route.abort("connectionrefused");
    });
    const target = await bootHarness(context);
    // The target verifies the abandoned lease before any display; offline, nothing can answer that verification.
    await target.waitForFunction(
      (id) =>
        (window.__atlasFixture?.session?.trace ?? []).some(
          (e) =>
            e.event === "cover.committed" &&
            e.data?.klass === "verification" &&
            ((e.data?.unresolved as string[] | undefined) ?? []).includes(id),
        ),
      orphan,
      { timeout: 10_000 },
    );
    const trace = await target.evaluate(
      () => (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
    );
    expect(trace.some((e) => e.event === "act.begin")).toBe(false);
    expect((await view(target)).kind).toBe("neutral");
    expect(apiCalls).toBeGreaterThanOrEqual(1);
    const orphaned = (await records(target)).auth_state.leases[orphan] as
      | { boot_id?: string }
      | undefined;
    expect(orphaned?.boot_id).toBe(seedBoot);
    const heldLocks = await target.evaluate(async () =>
      ((await navigator.locks.query()).held ?? []).map((l) => l.name),
    );
    expect(heldLocks).not.toContain(`atlas-lease-${orphan}`);
    // Online again (the `online` event is the page's own signal to look again): one verification resolves the lease by evidence.
    await context.unroute(UNREACHABLE);
    await target.evaluate(() => window.dispatchEvent(new Event("online")));
    await untilView(target, "displaying");
    await untilRecord(
      target,
      (s) => s.leases[orphan] === undefined,
      "the abandoned lease is resolved",
    );
    const after = (await records(target)).auth_state;
    expect(after.fences).toEqual({});
    expect(after.settled?.session_id).toBe(a.session_id);
  });

  test("in the engine: a write another document queues behind the armed barrier never commits once that document is closed; without the barrier the same write commits", async ({
    context,
  }) => {
    const { page: writer, identity } = await settledRecordOnly(context);
    const receipt = await closeInOrder(context, [writer], identity, {
      whileArmed: async (observer) => {
        const before = await observer.evaluate(
          () =>
            (window as unknown as BarrierStateWindow).__closeBarrier.state()
              .keepalive,
        );
        expect(await queueLeaseWrite(writer, "late-write")).toBe("queued");
        // The barrier serves fifty more of its own reads while the write waits behind it.
        await expect
          .poll(
            () =>
              observer.evaluate(
                () =>
                  (
                    window as unknown as BarrierStateWindow
                  ).__closeBarrier.state().keepalive,
              ),
            {
              message: "the barrier kept reading while the write waited",
              timeout: 5_000,
            },
          )
          .toBeGreaterThanOrEqual(before + 50);
        expect(
          await writer.evaluate(
            () => (window as unknown as LateWriteWindow).__lateWrite,
          ),
          "the write waited behind the barrier",
        ).toBe("queued");
      },
    });
    expect(judgeOrderedClose(receipt).problems, CLOSE_PREMISE).toEqual([]);
    expect(Object.keys(receipt.after?.snapshot.leases ?? {})).toEqual([]);
    // The positive control: the same write from another document, with no barrier, commits.
    const control = await bootOff(context);
    expect(await queueLeaseWrite(control, "control-write")).toBe("queued");
    await control.waitForFunction(
      () => (window as unknown as LateWriteWindow).__lateWrite === "committed",
    );
    expect(await rawLeases(control)).toEqual(["control-write"]);
  });

  test("the barrier's own failures stop the setup and are reported, never a clean close: blocked, ended before the close, aborted, observer lost", async ({
    context,
  }) => {
    const { page: first, identity } = await settledRecordOnly(context);
    await first.close();
    const stopped = (
      receipt: OrderedCloseReceipt,
      failure: string | RegExp,
    ) => {
      expect(receipt.failure ?? "").toMatch(failure);
      expect(judgeOrderedClose(receipt).problems[0]).toBe(
        `the setup stopped: ${receipt.failure}`,
      );
    };
    // Blocked: another document holds a readwrite transaction on the record; the acquisition is abandoned at its bound.
    const holder = await openObserver(context);
    expect(
      await holder.evaluate(
        (id) =>
          (window as unknown as BarrierStateWindow).__closeBarrier.arm(id),
        identity,
      ),
    ).toMatchObject({ kind: "armed" });
    let producer = await bootOff(context);
    const blocked = await closeInOrder(context, [producer], identity, {
      inert: [holder],
      acquireMs: 1_000,
      releaseMs: 1_000,
    });
    stopped(blocked, "the barrier could not be acquired within 1000 ms");
    // Whether the engine acknowledges the abort of a transaction still queued behind another is its own: Chromium does at once,
    // Firefox only once the holder ends (diagnostic d2 of revision 34). Either way the setup stopped and its observer is closed.
    expect(blocked.arms).toEqual([
      expect.objectContaining({ kind: "blocked" }),
    ]);
    expect(["abandoned", "timeout"]).toContain(blocked.arms[0]?.settledPhase);
    expect(producer.isClosed()).toBe(false);
    expect(
      await holder.evaluate(() =>
        (window as unknown as BarrierStateWindow).__closeBarrier.release(),
      ),
    ).toMatchObject({ phase: "completed" });
    await holder.close();
    await producer.close();
    // Ended before the close: the barrier's reads stop once it is armed, so its transaction commits before the producer closes.
    producer = await bootOff(context);
    const ended = await closeInOrder(context, [producer], identity, {
      whileArmed: async (observer) => {
        await observer.evaluate(() =>
          (window as unknown as BarrierStateWindow).__closeBarrier.release(),
        );
      },
    });
    stopped(
      ended,
      "the barrier was completed, not armed, when producer-1 had closed",
    );
    // Aborted while armed.
    producer = await bootOff(context);
    const aborted = await closeInOrder(context, [producer], identity, {
      whileArmed: async (observer) => {
        await observer.evaluate(() =>
          (window as unknown as BarrierStateWindow).__closeBarrier
            .transaction()
            ?.abort(),
        );
        await observer.waitForFunction(
          () =>
            (window as unknown as BarrierStateWindow).__closeBarrier.state()
              .phase === "aborted",
        );
      },
    });
    stopped(
      aborted,
      "the barrier was aborted, not armed, when producer-1 had closed",
    );
    // The observer lost while armed.
    producer = await bootOff(context);
    const lost = await closeInOrder(context, [producer], identity, {
      whileArmed: async (observer) => {
        await observer.close();
      },
    });
    stopped(lost, /^the observer document was lost or failed: /);
    expect(lost.release?.phase).toBe("lost");
    expect(lost.after).toBeNull();
    // Nothing was written: the record is the one the setup wrote.
    expect(await rawLeases(await bootOff(context))).toEqual([]);
  });
});

test.describe("I-14: account switch and return (rows 7 and 8)", () => {
  test("B's attempt held at activate: A is gated while it activates; B settles; A's records are untouched and A's queue cannot replay under B; switching back is a fresh attempt and an A fence survives the switch", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    // A fence for A first (a detected invalidation), so that "an A fence survives the switch" is meaningful.
    const revoker = await rawSignIn("alice");
    await raw("DELETE", `/sessions/${a?.session_id}`, {
      cookie: revoker.cookie,
      headers: { "x-csrf-token": revoker.csrf },
    });
    await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "A is fenced",
    );
    const fencesBefore = Object.values(
      (await records(page)).auth_state.fences,
    ).flat().length;

    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "bob");
    await untilHeld(rule.id);
    // While B's activation gates, the neutral card for a sign-in in progress is shown.
    await untilView(page, "neutral", "1c.finishing");
    await proxy.release(rule.id);
    expect((await finishSignIn(page)).kind).toBe("settled");
    const state = (await records(page)).auth_state;
    expect(state.settled?.account_id).not.toBe(a?.account_id);
    // A's fence and A's local records were not touched by the switch.
    expect(Object.values(state.fences[a?.account_id ?? ""] ?? []).length).toBe(
      fencesBefore,
    );
    expect((await records(page)).pending_deletions).toEqual({});
    // A's queue never replays under B: a stamped call for (A, old epoch) is STALE.
    const stale = await page.evaluate(
      async (arg) => {
        try {
          await window.__s.api.fetchFor(
            "ordinary",
            arg.account,
            arg.epoch,
          )(new Request(`${location.origin}/api/experimental/v1/sessions`));
          return "sent";
        } catch (error) {
          return (error as { kind?: string }).kind ?? String(error);
        }
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    expect(stale).toBe("stale");
    // Switching back is a fresh attempt with a fresh epoch, and A's old fence is still there until catch-up.
    expect((await signIn(page, "alice")).kind).toBe("settled");
    const back = (await records(page)).auth_state;
    expect(back.settled?.account_id).toBe(a?.account_id);
    expect(back.settled?.epoch).toBeGreaterThan(state.settled?.epoch ?? 0);
    expect(
      Object.values(back.fences[a?.account_id ?? ""] ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await view(page)).kind).toBe("neutral");
  });
});

test.describe("I-14b: an answer that arrives after the switch (G4, matrix 3.7.2)", () => {
  test("a clean answer to A's request, delivered after B has settled in the same page, is dropped as stale and never returned to its caller", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await page.evaluate(
      (arg) => {
        // Revision 34: each attempt records the activity its call creates synchronously (as revision 33's typed-call witness does).
        const activities: number[] = [];
        window.__t.lateActivities = activities;
        window.__t.late = window.__retryTyped(() => {
          const trace = window.__atlasFixture?.session?.trace ?? [];
          const from = trace.length;
          const sent = window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            );
          const created = trace
            .slice(from)
            .find(
              (e) =>
                e.event === "activity.create" && e.data?.klass === "ordinary",
            );
          if (typeof created?.data?.n === "number")
            activities.push(created.data.n);
          return sent;
        });
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    await untilHeld(held.id);
    // The held request's own lease: the cover of the call's issued attempt, in the record while its answer is held.
    const requestLease = await page.evaluate(() => {
      const trace = window.__atlasFixture?.session?.trace ?? [];
      const mine = (window.__t.lateActivities as number[]).filter((n) =>
        trace.some((e) => e.event === "request.issued" && e.data?.n === n),
      );
      if (mine.length !== 1) return null;
      const cover = trace.find(
        (e) => e.event === "cover.committed" && e.data?.n === mine[0],
      );
      return (cover?.data?.lease as string | undefined) ?? null;
    });
    expect(requestLease, "the held request's own lease").not.toBeNull();
    expect(
      Object.keys((await records(page)).auth_state.leases),
      "the held request's lease is in the record while its answer is held",
    ).toContain(requestLease);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    const b = (await records(page)).auth_state.settled;
    expect(b?.account_id).not.toBe(a?.account_id);
    await proxy.release(held.id);
    expect(await page.evaluate(() => window.__t.late)).toBe("stale");
    // The lease of the request was retired in its own order, so nothing is left for another page to treat as unresolved. Revision
    // 34 (adaptation, as WEB-08a revision 3 made for I-14c): the question is about THIS request's lease and account A, read at once
    // (its retirement is ordered before the answer's release). B's own display reads, started by B's exposure, may still be in flight
    // here: in the focused WebKit run of revision 34 (pool request-3c8ea194f0174460b065) the old check found exactly those four
    // leases (account B, epoch 2, retired 9-11 ms later), while A's lease had already been retired.
    const after = (await records(page)).auth_state.leases;
    expect(
      Object.keys(after),
      "the request's lease was retired in its own order",
    ).not.toContain(requestLease);
    expect(
      Object.entries(after).filter(
        ([, lease]) =>
          lease.account_id === a?.account_id || lease.epoch === a?.epoch,
      ),
      "no lease of account A is left for another page to treat as unresolved",
    ).toEqual([]);
    const bootId = await page.evaluate(() => window.__s.bootId);
    for (const lease of Object.values(after))
      expect(
        {
          account: lease.account_id,
          epoch: lease.epoch,
          boot: (lease as { boot_id?: string }).boot_id,
        },
        "every other lease is B's own live request on this page",
      ).toEqual({ account: b?.account_id, epoch: b?.epoch, boot: bootId });
  });
});

test.describe("I-14c: a transition completed by ANOTHER page whose notice never reaches this one (G4, matrix 3.7.2)", () => {
  test("A's clean answer, delivered after a second page settled B, is dropped as stale although this page was never told; it then learns of B from the check itself", async ({
    context,
  }) => {
    // This page's BroadcastChannel notices are switched off (after boot) by wrapping the channel in every page of the
    // context: the only way this page can learn of the other page's transition is to read `atlas-auth` itself.
    await context.addInitScript(() => {
      const Native = window.BroadcastChannel;
      if (!Native) return;
      window.BroadcastChannel = class extends Native {
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          super.onmessage =
            typeof handler === "function"
              ? (event: MessageEvent) => {
                  if (
                    !(window as unknown as { __dropHints?: boolean })
                      .__dropHints
                  )
                    handler.call(this, event);
                }
              : handler;
        }
        get onmessage() {
          return super.onmessage;
        }
      };
    });
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await first.evaluate(
      (arg) => {
        window.__t.late = window.__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        );
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    await untilHeld(held.id);
    // The request's own lease, while its answer is held (the only lease this page has just now).
    const requestLeases = Object.keys((await records(first)).auth_state.leases);
    expect(requestLeases.length).toBeGreaterThan(0);
    await first.evaluate(() => {
      (window as unknown as { __dropHints?: boolean }).__dropHints = true;
    });
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // The first page has not been told: its own copy still names A.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await proxy.release(held.id);
    expect(await first.evaluate(() => window.__t.late)).toBe("stale");
    // The request's lease was retired in its own order. Other leases may exist by now, (this page re-reads the record at once
    // and starts exposing the account that IS settled), so the question is about THIS request's lease.
    await expect
      .poll(async () => {
        const now = (await records(first)).auth_state.leases;
        return requestLeases.filter((id) => id in now);
      })
      .toEqual([]);
    // Still no notice, and the page nevertheless catches up: the check re-read the record when it found it had moved on.
    await expect
      .poll(() => first.evaluate(() => window.__s.identity.get()?.account_id))
      .toBe(settled?.account_id);
  });
});

/**
 * The verdict is taken in the step that reads the record, not at the delivery of that read's completion (G4, matrix 3.7.2). Real
 * IndexedDB, real Web Locks, the released backend. Two pieces of test instrumentation model a busy page: this page's
 * BroadcastChannel notices are switched off, and the completion of its `response_check` transaction is held (the transaction
 * itself ran and committed; only its `complete` is delayed to the page). Neither is a measured browser scheduling delay.
 */
const switchOffNotices = (context: import("@playwright/test").BrowserContext) =>
  context.addInitScript(() => {
    const Native = window.BroadcastChannel;
    if (!Native) return;
    window.BroadcastChannel = class extends Native {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage =
          typeof handler === "function"
            ? (event: MessageEvent) => {
                if (
                  !(window as unknown as { __dropHints?: boolean }).__dropHints
                )
                  handler.call(this, event);
              }
            : handler;
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });

/** Switch this page's notices off, hold the completion of its `response_check`, and start a typed `GET /sessions` for `a`. */
async function startHeldCheckCall(
  page: Page,
  a: { account_id: string; epoch: number } | null | undefined,
) {
  await page.evaluate(
    (arg) => {
      const w = window as unknown as {
        __dropHints?: boolean;
        __atlasFixture: {
          session: {
            booted: {
              store: {
                transact: (
                  body: unknown,
                  options?: { label?: string },
                ) => { complete: Promise<unknown> };
              };
            };
          };
        };
      };
      w.__dropHints = true;
      const store = w.__atlasFixture.session.booted.store;
      const original = store.transact.bind(store);
      store.transact = (body, options) => {
        const tx = original(body, options);
        if (options?.label !== "response_check") return tx;
        return {
          complete: tx.complete.then(
            (value) =>
              new Promise((resolve) => {
                window.__t.checkHeld = true;
                window.__t.releaseCheck = () => resolve(value);
              }),
          ),
        };
      };
      window.__t.checkHeld = false;
      // A call refused as `not_sent` (a hold was in force for a moment: the page's own post-display verification is answered about
      // now, and its read of `/me` runs beside it) counted as no attempt and sent nothing: it is made again, as a queue would, exactly
      // as I-09 and I-14e do. Revision 10's WebKit failure of this case was that refusal (kernel trace, `activity.cancel` reason `hold`).
      window.__t.late = window
        .__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        )
        .then((kind) => {
          window.__t.returnedAt = Date.now();
          return kind;
        });
    },
    { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
  );
}

test.describe("I-14d: the release does not wait for the completion of the check (G4, matrix 3.7.2)", () => {
  test("the transition is ordered AFTER the read: the answer was released at the read, while the completion is still held, and the other page's sign-in is not held up", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await startHeldCheckCall(first, a);
    await untilHeld(held.id);
    await proxy.release(held.id);
    await first.waitForFunction(() => window.__t.checkHeld === true);
    // The completion has been delivered to the page and is held by the instrumentation: the call has already returned.
    expect(await first.evaluate(() => window.__t.late)).toBe("returned");
    const returnedAt = await first.evaluate(
      () => window.__t.returnedAt as number,
    );
    const second = await bootHarness(context);
    const signInStartedAt = await second.evaluate(() => Date.now());
    expect((await signIn(second, "bob")).kind).toBe("settled");
    expect(returnedAt).toBeLessThanOrEqual(signInStartedAt);
    // This page has not been told, and nothing it already returned changes when the completion is let through.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await first.evaluate(() => (window.__t.releaseCheck as () => void)());
    expect(await first.evaluate(() => window.__t.late)).toBe("returned");
  });

  test("the transition is ordered BEFORE the read: `stale` while the completion is still held, and the page catches up from the read", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await startHeldCheckCall(first, a);
    await untilHeld(held.id);
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    const releasedAt = await first.evaluate(() => Date.now());
    await proxy.release(held.id);
    await first.waitForFunction(() => window.__t.checkHeld === true);
    // Refused by the read itself; the delayed completion and the missing notice changed nothing. Nor did the verdict wait
    // for the stall interval (5 s), which is what a caller waiting for a held completion would have had to.
    expect(await first.evaluate(() => window.__t.late)).toBe("stale");
    const refusedAt = await first.evaluate(
      () => window.__t.returnedAt as number,
    );
    expect(refusedAt - releasedAt).toBeLessThan(2500);
    await first.evaluate(() => (window.__t.releaseCheck as () => void)());
    await expect
      .poll(() => first.evaluate(() => window.__s.identity.get()?.account_id))
      .toBe(settled?.account_id);
  });
});

/**
 * I-14d, revision 11: the cause of revision 10's single WebKit failure of the case above (`the proxy holds 1 response(s)`, zero after
 * 15 s). The kernel trace attached to that failure shows the test's typed call (activity 4) created in the very millisecond in which
 * the page's own post-display VERIFICATION (activity 2: `GET /browser-sessions/current`, asked for by the session as soon as an account
 * is displayed) was answered; the answer's detection step set a hold (`hold.set`, cause `detection`, released a millisecond later), and
 * the call was cancelled with reason `hold` (`activity.cancel`): `not_sent`, which counts as no attempt and sends nothing, so the
 * proxy never saw it. That refusal is the documented queue contract ("a hold, or a closing write, was in force for a moment"), and
 * every other case that calls a stamped endpoint at once after sign-in retries it (`__retry`, `__retryTyped`); I-14b, I-14c and I-14d
 * did not. The page's read of `/me` (the data layer's, WEB-09a) runs beside the verification at the same moment and widens the window a
 * little; it does not create it (the verification, the hold and the refusal are the session module's, WEB-08a).
 *
 * These two cases put the call exactly there ON PURPOSE (test instrumentation: `fetch` is wrapped so that the typed call is made in the
 * task in which the verification's answer is delivered, before the kernel has seen it; the proxy holds the answer so that the
 * placement is deterministic, not a measured delay): the call is refused `not_sent` and nothing reaches the proxy (the failure's
 * signature, reproduced), and, retried as the other cases do, it is sent once and held once.
 */
/**
 * Revision 33 (review 34 R34-N1, family `i14d-post-navigation-lease-premise`): the new document is no longer made by NAVIGATING
 * the signed-in page. A navigation abandons that document's ordinary requests still outstanding (the `/today` page's
 * `/defaults/snapshot` and two `/daily` reads, made as it displays); their leases stay in the record, and the new document must
 * verify them BEFORE it may display (the protection of src/session/kernel/expose.ts). Revision 11 held that verification and then
 * waited for a display that needed its answer: review 34's Chromium failure. The signed-in page (the seed) now stays alive and the
 * target is a SEPARATE document of the same context, so the seed's requests finish and retire normally (a target meeting a live one
 * waits for it, as I-09 shows). Before anything is released the setup's premise is JUDGED (verification-premise.ts): distinct
 * boots, the aged confirmation unchanged, the target exposed and then made exactly one verification with an empty captured set,
 * whose lease is the target's and whose answer is the one the proxy holds, the only identity read in the context. The typed call is
 * judged too: made by the hook as that answer is delivered, before the answer's detection hold ended, every attempt accounted for.
 * The premise controls below force both other schedules in the real engine: a live seed's held request (deferred, then accepted)
 * and a navigation that abandons one (rejected for its own reasons, then recovered).
 */
interface PremiseWindow {
  __onCurrent?: () => void;
  __currentIssued?: number;
  __hookRuns?: number;
  __hookAt?: number;
  __premiseToken?: string;
  /** A path whose requests this document makes but never sees settle (answered, failed or aborted): its continuation never runs. */
  __freeze?: string;
}

/**
 * Count each document's identity reads as they are made, and run a one-shot hook as an identity answer is delivered. With `__freeze`
 * set, a matching request is made and its outcome withheld from the document for good (TEST INSTRUMENTATION): a navigation then
 * destroys its owner before the owner can retire its lease, in every engine. Without it, whether a navigation leaves the lease is the
 * engine's: Chromium destroyed the document first (review 34), Firefox let the aborted request's continuation retire it (diagnostic
 * d2 of revision 33).
 */
async function instrumentIdentityReads(
  context: import("@playwright/test").BrowserContext,
) {
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      const w = window as unknown as PremiseWindow;
      if (w.__freeze && new URL(url, location.href).pathname === w.__freeze)
        return new Promise<Response>(() => {
          void original(...args).catch(() => undefined);
        });
      // R16: this document's identity reads, counted as they are made (the setup proves its read was issued and held).
      if (url.includes("/browser-sessions/current"))
        w.__currentIssued = (w.__currentIssued ?? 0) + 1;
      const response = await original(...args);
      if (url.includes("/browser-sessions/current") && w.__onCurrent) {
        const hook = w.__onCurrent;
        w.__onCurrent = undefined;
        // Revision 33: when the hook ran, by the kernel's own trace (the answer reaches the kernel after this returns).
        w.__hookRuns = (w.__hookRuns ?? 0) + 1;
        w.__hookAt ??= window.__atlasFixture?.session?.trace.length ?? -1;
        hook();
      }
      return response;
    };
  });
}

/** Mark a booted document, so records read later can be shown to come from it (a later document of the same page has no mark). */
const markDocument = (page: Page) =>
  page.evaluate(() => {
    const token = crypto.randomUUID();
    (window as unknown as PremiseWindow).__premiseToken = token;
    return token;
  });

/** Sign the seed in, let it display, and age the shared confirmation; returns the identity and the `confirmed_at` written. */
async function seedWithStaleConfirmation(
  context: import("@playwright/test").BrowserContext,
) {
  const seed = await bootHarness(context);
  expect((await signIn(seed, "alice")).kind).toBe("settled");
  await untilView(seed, "displaying");
  // WEB-08c revision 14 (review 14 R16): since HF1-SHARED-CONFIRMATION-20261013 the settlement's shared confirmation spares the
  // settled page its post-display verification (the accepted behaviour; control: no identity read reached the proxy). The
  // verification these cases place a call against is the one a NEW document makes when the record's confirmation is older than the
  // interval: the token is still adopted (no CSRF read), so it is the document's only identity read, exactly as every display made it
  // when revision 10 failed. Made eligible explicitly, then proven issued (by the target, once) and held.
  expect(await identityReadsAtProxy()).toEqual([]);
  const a = (await records(seed)).auth_state.settled as SettledLike;
  expect(await withStaleSharedConfirmation(seed, a)).toMatchObject({
    aged: true,
    settlement_matched: true,
    confirmation_matched: true,
    written_age_ms: 120_000,
  });
  const aged = (
    (await records(seed)).auth_state as unknown as {
      confirmation: { confirmed_at: string } | null;
    }
  ).confirmation?.confirmed_at;
  if (!aged) throw new Error("setup: the aged confirmation was not read back");
  return { seed, a, aged };
}

/** The records the premise witness reads, collected while the identity answer is held. */
async function premiseRecords(
  seed: { boot: string; page: Page | null },
  target: Page,
  token: string,
  a: SettledLike,
  aged: string,
  verificationRule: string,
): Promise<VerificationPremiseInput> {
  const collected = await target.evaluate(async () => {
    const w = window as unknown as PremiseWindow;
    const recordsNow =
      (await window.__atlasFixture?.session?.readRecords()) as {
        auth_state: VerificationPremiseInput["record"];
      };
    return {
      boot: window.__s.bootId,
      token: w.__premiseToken ?? null,
      reads: w.__currentIssued ?? 0,
      trace: (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
      record: {
        settled: recordsNow.auth_state.settled,
        confirmation: recordsNow.auth_state.confirmation,
        leases: recordsNow.auth_state.leases,
      },
    };
  });
  const seedReads = seed.page
    ? await seed.page.evaluate(
        () => (window as unknown as PremiseWindow).__currentIssued ?? 0,
      )
    : 0;
  return {
    identity: { account: a.account_id, epoch: a.epoch, session: a.session_id },
    seed: { boot: seed.boot },
    target: {
      boot: collected.boot,
      token: { atBoot: token, atJudgement: collected.token },
    },
    trace: collected.trace,
    record: collected.record,
    agedConfirmedAt: aged,
    identityReads: {
      seed: seedReads,
      target: collected.reads,
      wire: (await identityReadsAtProxy()).length,
      held: (await proxy.held())[verificationRule] ?? 0,
    },
  };
}

const verificationRule = () =>
  proxy.addRule({
    method: "GET",
    path: "/^\\/api\\/experimental\\/v1\\/browser-sessions\\/current$/",
    action: "hold",
    ordinal: 1,
  });

const sessionsAtProxy = async () =>
  (await proxy.log()).filter(
    (entry) => entry.method === "GET" && /\/sessions$/.test(entry.path),
  ).length;

/** The typed call's records, judged by `judgeTypedCall`. */
async function typedCallVerdict(
  page: Page,
  a: SettledLike,
  verification: { n: number; lease: string; issued: number },
  retry: boolean,
) {
  const collected = await page.evaluate(() => {
    const w = window as unknown as PremiseWindow;
    return {
      trace: (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
      runs: w.__hookRuns ?? 0,
      at: w.__hookAt ?? null,
      attempts: [
        ...((window.__t.attempts as
          | Array<{ n: number | null; outcome: string | null }>
          | undefined) ?? []),
      ],
    };
  });
  return judgeTypedCall({
    identity: { account: a.account_id, epoch: a.epoch },
    trace: collected.trace,
    verification,
    hook: { runs: collected.runs, at: collected.at },
    attempts: collected.attempts,
    retry,
    wireSessions: await sessionsAtProxy(),
  });
}

/** Until the call's first attempt has finished or been issued (and, with `issued`, until one of its attempts was issued). */
const untilAttempt = (page: Page, issued: boolean) =>
  page.waitForFunction((needIssued) => {
    const trace = window.__atlasFixture?.session?.trace ?? [];
    const attempts =
      (window.__t.attempts as
        | Array<{ n: number | null; outcome: string | null }>
        | undefined) ?? [];
    const sent = (n: number | null) =>
      n !== null &&
      trace.some((e) => e.event === "request.issued" && e.data?.n === n);
    const first = attempts[0];
    return needIssued
      ? attempts.some((attempt) => sent(attempt.n)) ||
          window.__t.lateValue !== undefined
      : first !== undefined && (first.outcome !== null || sent(first.n));
  }, issued);

async function callAtVerificationAnswer(
  context: import("@playwright/test").BrowserContext,
  retry: boolean,
) {
  await instrumentIdentityReads(context);
  const { seed, a, aged } = await seedWithStaleConfirmation(context);
  const seedBoot = await seed.evaluate(() => window.__s.bootId);
  const verification = await verificationRule();
  // The target: a separate document of the same context, booted while the seed stays alive (the seed is never navigated).
  const page = await bootHarness(context);
  const token = await markDocument(page);
  // The target's own verification of the displayed account is outstanding at the proxy; its premise is judged before anything else.
  await untilHeld(verification.id);
  const premise = judgeVerificationPremise(
    await premiseRecords(
      { boot: seedBoot, page: seed },
      page,
      token,
      a,
      aged,
      verification.id,
    ),
  );
  expect(
    premise.problems,
    "the I-14d premise (verification-premise.ts)",
  ).toEqual([]);
  const checked = premise.verification as NonNullable<
    typeof premise.verification
  >;
  await untilView(page, "displaying");
  expect(
    await page.evaluate(
      () => (window as unknown as PremiseWindow).__currentIssued,
    ),
  ).toBe(1);
  expect(await identityReadsAtProxy()).toHaveLength(1);
  const sessions = await proxy.addRule(sessionsRule("hold"));
  await page.evaluate(
    (arg) => {
      const attempts: Array<{ n: number | null; outcome: string | null }> = [];
      window.__t.attempts = attempts;
      // Each attempt names the kernel activity it creates: the typed client's send() creates it synchronously inside the call.
      const once = () => {
        const trace = window.__atlasFixture?.session?.trace ?? [];
        const from = trace.length;
        const pending = window.__s.api
          .client("ordinary", arg.account, arg.epoch)
          .GET("/sessions");
        const created = trace
          .slice(from)
          .find((e) => e.event === "activity.create");
        const attempt: { n: number | null; outcome: string | null } = {
          n: typeof created?.data?.n === "number" ? created.data.n : null,
          outcome: null,
        };
        attempts.push(attempt);
        return pending
          .then(
            () => "returned",
            (error: unknown) => (error as { kind?: string }).kind ?? "threw",
          )
          .then((outcome) => {
            attempt.outcome = outcome;
            return outcome;
          });
      };
      window.__t.late = new Promise<string>((resolve) => {
        (window as unknown as PremiseWindow).__onCurrent = () => {
          void (arg.retry ? window.__retryTyped(once) : once()).then(
            (outcome) => {
              window.__t.lateValue = outcome;
              resolve(outcome);
            },
          );
        };
      });
    },
    { account: a?.account_id ?? "", epoch: a?.epoch ?? 0, retry },
  );
  // The hook is armed in the target before the answer is let through.
  expect(
    await page.evaluate(
      () => typeof (window as unknown as PremiseWindow).__onCurrent,
    ),
  ).toBe("function");
  // The answer is delivered now: the call is made in the same task.
  await proxy.release(verification.id);
  // Judged as soon as the first attempt has finished or been sent: made before the detection hold ended, never issued.
  await untilAttempt(page, false);
  if (retry) await untilAttempt(page, true);
  const early = await typedCallVerdict(page, a, checked, retry);
  expect(early.problems, "the typed call (verification-premise.ts)").toEqual(
    [],
  );
  return { page, sessions, a, checked };
}

test.describe("I-14d (revision 11): a typed call made as the page's own verification is answered", () => {
  test("it is refused `not_sent` (no attempt, nothing sent), which is what revision 10's WebKit failure was", async ({
    context,
  }) => {
    const { page, sessions, a, checked } = await callAtVerificationAnswer(
      context,
      false,
    );
    expect(await page.evaluate(() => window.__t.late)).toBe("not_sent");
    // Nothing reached the proxy, however long it is waited for: zero held, and no `GET /sessions` in its log.
    await page.waitForTimeout(1_500);
    expect((await proxy.held())[sessions.id] ?? 0).toBe(0);
    const requests = (await proxy.log()).filter(
      (entry) => entry.method === "GET" && /\/sessions$/.test(entry.path),
    );
    expect(requests).toEqual([]);
    expect(
      (await typedCallVerdict(page, a, checked, false)).problems,
      "the typed call after the window",
    ).toEqual([]);
    // The page itself is healthy: its identity is displayed and a call made now is sent.
    expect((await view(page)).kind).toBe("displaying");
  });

  test("retried as every other case does, it is sent once, held once, and returned when released", async ({
    context,
  }) => {
    const { page, sessions, a, checked } = await callAtVerificationAnswer(
      context,
      true,
    );
    await untilHeld(sessions.id);
    await page.waitForTimeout(500);
    expect((await proxy.held())[sessions.id]).toBe(1);
    await proxy.release(sessions.id);
    expect(await page.evaluate(() => window.__t.late)).toBe("returned");
    expect(
      (await typedCallVerdict(page, a, checked, true)).problems,
      "the typed call once returned",
    ).toEqual([]);
  });
});

test.describe("I-14d (revision 11), premise controls (revision 33): the schedules its setup must tell apart, forced in the real engine", () => {
  test("a live seed's held request defers the target's display; answered, the seed retires it, and the target's optional verification is accepted", async ({
    context,
  }) => {
    await instrumentIdentityReads(context);
    const { seed, a, aged } = await seedWithStaleConfirmation(context);
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    const held = await proxy.addRule(sessionsRule("hold"));
    await seed.evaluate(
      (arg) => {
        window.__t.seedCall = window.__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        );
      },
      { account: a.account_id, epoch: a.epoch },
    );
    await untilHeld(held.id);
    const live = Object.entries((await records(seed)).auth_state.leases).filter(
      ([, lease]) =>
        (lease as { boot_id?: string }).boot_id === seedBoot &&
        lease.class === "ordinary",
    );
    expect(live.length).toBeGreaterThanOrEqual(1);
    const verification = await verificationRule();
    const target = await bootHarness(context);
    const token = await markDocument(target);
    // DEFERRED on the seed's live lease: the waiting card, no exposure, no verification, no identity read.
    await untilView(target, "neutral", "1e.waiting");
    const waiting = await target.evaluate(
      () => (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
    );
    expect(waiting.some((e) => e.event === "act.begin")).toBe(false);
    expect(
      waiting.some(
        (e) =>
          e.event === "activity.create" && e.data?.klass === "verification",
      ),
    ).toBe(false);
    expect(await identityReadsAtProxy()).toEqual([]);
    // Answered: the seed's call returns, it retires its lease, and the target displays, then verifies with nothing captured.
    await proxy.release(held.id);
    expect(await seed.evaluate(() => window.__t.seedCall)).toBe("returned");
    await untilHeld(verification.id);
    const premise = judgeVerificationPremise(
      await premiseRecords(
        { boot: seedBoot, page: seed },
        target,
        token,
        a,
        aged,
        verification.id,
      ),
    );
    expect(premise.problems).toEqual([]);
    await untilView(target, "displaying");
    await proxy.release(verification.id);
    await untilRecord(
      target,
      (state) => Object.keys(state.leases).length === 0,
      "every lease is retired",
    );
    expect((await view(target)).kind).toBe("displaying");
  });

  test("a navigation that abandons the seed's held request leaves its lease for the next document, whose verification gates display: rejected as the premise, then recovered", async ({
    context,
  }) => {
    await instrumentIdentityReads(context);
    const { seed, a, aged } = await seedWithStaleConfirmation(context);
    const seedBoot = await seed.evaluate(() => window.__s.bootId);
    const held = await proxy.addRule(sessionsRule("hold"));
    await seed.evaluate(
      (arg) => {
        // The one named request whose continuation the old document never runs (see `instrumentIdentityReads`).
        (window as unknown as PremiseWindow).__freeze =
          "/api/experimental/v1/sessions";
        void window.__retryTyped(() =>
          window.__s.api
            .client("ordinary", arg.account, arg.epoch)
            .GET("/sessions")
            .then(
              () => "returned",
              (error: unknown) => (error as { kind?: string }).kind ?? "threw",
            ),
        );
      },
      { account: a.account_id, epoch: a.epoch },
    );
    await untilHeld(held.id);
    // The held request's lease is the seed's only one once its own display reads have been answered.
    await untilRecord(
      seed,
      (state) => Object.keys(state.leases).length === 1,
      "only the held request's lease remains",
    );
    const [orphan] = Object.keys((await records(seed)).auth_state.leases);
    const verification = await verificationRule();
    // The navigation of revision 11: the same page, a new document. The old document's request is abandoned before its owner could
    // retire it (frozen), as review 34's Chromium navigation abandoned the display reads.
    await freshHarnessDocument(seed, a);
    const token = await markDocument(seed);
    await untilHeld(verification.id);
    const state = (await records(seed)).auth_state;
    expect(
      (state.leases[orphan as string] as { boot_id?: string } | undefined)
        ?.boot_id,
    ).toBe(seedBoot);
    // Its owner is gone: the lease's lock is no longer held by anyone.
    const heldLocks = await seed.evaluate(async () =>
      ((await navigator.locks.query()).held ?? []).map((lock) => lock.name),
    );
    expect(heldLocks).not.toContain(`atlas-lease-${orphan}`);
    const trace = await seed.evaluate(
      () => (window.__atlasFixture?.session?.trace ?? []) as KernelEvent[],
    );
    const captured = trace.find(
      (e) => e.event === "cover.committed" && e.data?.klass === "verification",
    );
    expect(captured?.data?.unresolved).toEqual([orphan]);
    expect(trace.some((e) => e.event === "act.begin")).toBe(false);
    expect((await view(seed)).kind).toBe("neutral");
    const premise = judgeVerificationPremise(
      await premiseRecords(
        { boot: seedBoot, page: null },
        seed,
        token,
        a,
        aged,
        verification.id,
      ),
    );
    expect(premise.problems).toEqual(
      expect.arrayContaining([
        `a verification captured unresolved leases ${JSON.stringify([orphan])}: it verifies abandoned requests, it is not the optional check`,
        "the target never exposed the identity (no act.begin/act.end)",
      ]),
    );
    // Released: the same session's answer resolves the abandoned lease, and the same session displays.
    await proxy.release(verification.id);
    await untilView(seed, "displaying");
    await untilRecord(
      seed,
      (s) => s.leases[orphan as string] === undefined,
      "the abandoned lease is resolved",
    );
    const after = (await records(seed)).auth_state;
    expect(after.fences).toEqual({});
    expect(after.settled?.session_id).toBe(a.session_id);
    await proxy.release(held.id);
  });
});

/**
 * I-14e: the decode of the answer's body is part of the public call. Decoding a buffered body is asynchronous (a fetch task), so
 * a check taken before the library's or the operation's own `response.json()` is overtaken by a transition that completes while
 * the decode runs. The decode is held in the page by wrapping `Response.prototype.json` (the real decode runs, its settlement is
 * then held): TEST INSTRUMENTATION that places the interval, not a measured delay and not a naturally occurring freeze. The three
 * public calls that decode a list (the ordinary typed client, `listSessions`, `readDevices`) are held TOGETHER in one page, so
 * that one sign-in serves all three (the backend allows a bounded number of password sign-ins per source and minute). Their PUBLIC
 * promises must stay pending while the decodes are held, and a result of a call made under account A must never be handed to
 * a page that has since settled account B, or re-authenticated A, whether the transition is this page's own or another page's
 * whose notice never reaches this one.
 */
const REFUSED = {
  typed: "stale",
  listSessions: "closed",
  readDevices: "closed",
} as const;
const RETURNED = {
  typed: "returned",
  listSessions: "returned",
  readDevices: "returned",
} as const;

/** Start the three calls for the page's settled identity and hold their decodes; the public promise is `window.__t.answers`. */
async function startHeldDecodeCalls(page: Page) {
  await page.evaluate(() => {
    const original = Response.prototype.json;
    window.__t.decodeHeld = 0;
    window.__t.done = 0;
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.__t.releaseDecode = () => {
      release();
      Response.prototype.json = original;
    };
    Response.prototype.json = async function json(this: Response) {
      const value: unknown = await original.call(this);
      const lists = value as Record<string, unknown> | null;
      if (Array.isArray(lists?.sessions) || Array.isArray(lists?.devices)) {
        window.__t.decodeHeld = (window.__t.decodeHeld as number) + 1;
        await paused;
      }
      return value;
    };
    const identity = window.__s.identity.get();
    if (!identity) throw new Error("no identity");
    const text = (result: { ok: boolean; error?: string }) =>
      result.ok ? "returned" : (result.error ?? "");
    // A stamped call refused as `not_sent` (a hold or a closing write was in force for a moment) is retried, as a queue would.
    const typed = async (): Promise<string> => {
      const once = () =>
        window.__s.api
          .client("ordinary", identity.account_id, identity.epoch)
          .GET("/sessions")
          .then(
            () => "returned",
            (error: unknown) => (error as { kind?: string }).kind ?? "threw",
          );
      let last = await once();
      for (let i = 1; i < 60 && last === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await once();
      }
      return last;
    };
    const counted = (run: Promise<string>) =>
      run.then((value) => {
        window.__t.done = (window.__t.done as number) + 1;
        return value;
      });
    window.__t.answers = Promise.all([
      counted(typed()),
      counted(
        window.__retry(() => window.__s.operations.listSessions()).then(text),
      ),
      counted(
        window.__retry(() => window.__s.operations.readDevices()).then(text),
      ),
    ]).then(([typedAnswer, listSessions, readDevices]) => ({
      typed: typedAnswer,
      listSessions,
      readDevices,
    }));
  });
  await page.waitForFunction(() => window.__t.decodeHeld === 3);
  expect(await page.evaluate(() => window.__t.done)).toBe(0);
}

const releaseDecodes = (page: Page) =>
  page.evaluate(() => (window.__t.releaseDecode as () => void)());
const answers = (page: Page) => page.evaluate(() => window.__t.answers);
const stillPending = async (page: Page) =>
  expect(await page.evaluate(() => window.__t.done)).toBe(0);

test.describe("I-14e: the decode of the answer's body is part of the public call (G4, matrix 3.7.2)", () => {
  test("no transition: the held decodes end and all three results are returned (the control)", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    await startHeldDecodeCalls(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(RETURNED);
  });

  test("a sign-in as bob in the SAME page while the decodes are held: the public promises stay pending, then refuse alice's results", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    await startHeldDecodeCalls(page);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    const settled = (await records(page)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // The record and this page's identity both name bob, and the calls made under alice have still not resolved.
    expect(
      await page.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(settled?.account_id);
    await stillPending(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(REFUSED);
  });

  test("a re-authentication of the SAME account (epoch 1 to 2) while the decodes are held: refused", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    await startHeldDecodeCalls(page);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    const settled = (await records(page)).auth_state.settled;
    expect(settled?.account_id).toBe(a?.account_id);
    expect(settled?.epoch).toBeGreaterThan(a?.epoch ?? 0);
    await stillPending(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(REFUSED);
  });

  test("ANOTHER page settles bob while this page's notices are switched off: this page still names alice, and the results are refused", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    await first.evaluate(() => {
      (window as unknown as { __dropHints?: boolean }).__dropHints = true;
    });
    await startHeldDecodeCalls(first);
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // No notice reached this page: only the record knows, and the public promises have still not resolved.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await stillPending(first);
    await releaseDecodes(first);
    expect(await answers(first)).toEqual(REFUSED);
  });
});

test.describe("I-15: hiding the page aborts a real activate", () => {
  test("the activation is aborted at once; the attempt is indeterminate; activate/cancel resolves it", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "alice");
    await untilHeld(rule.id);
    await setVisibility(page, "hidden");
    await untilRecord(
      page,
      (s) =>
        s.attempt === null ||
        s.attempt.phase === "indeterminate" ||
        s.attempt.phase === "verifying",
      "the attempt leaves the activating phase",
    );
    await proxy.release(rule.id);
    await untilRecord(
      page,
      (s) => s.attempt === null,
      "activate/cancel resolves the attempt",
    );
    const state = (await records(page)).auth_state;
    expect(state.settled).toBeNull(); // a hidden page never adopts what it aborted
    const log = await proxy.log();
    expect(log.some((entry) => entry.path.endsWith("/activate/cancel"))).toBe(
      true,
    );
    void (await finishSignIn(page).catch(() => undefined));
  });

  test("hiding BEFORE the activate is issued (the page still waits for atlas-auth): no activate is ever sent and nothing was committed", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const other = await bootHarness(context);
    // The exchange is held, so that the other tab can take `atlas-auth` between the exchange and the activation.
    const exchange = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "alice");
    await untilHeld(exchange.id);
    await other.evaluate(async () => {
      const locks = window.__atlasFixture?.session?.locks;
      if (!locks) throw new Error("the session harness is not loaded");
      const held = await locks.acquire("atlas-auth");
      if (!held) throw new Error("could not take atlas-auth");
      window.__t.authHeld = held;
    });
    await proxy.release(exchange.id);
    // The page now waits for `atlas-auth`: nothing has been activated.
    await page.waitForTimeout(800);
    expect(
      (await proxy.log()).some((entry) =>
        entry.path.endsWith("/browser-sessions/activate"),
      ),
    ).toBe(false);
    await setVisibility(page, "hidden");
    await other.evaluate(() =>
      (window.__t.authHeld as { release(): void }).release(),
    );
    // The wait ends without sending: the attempt is cleared and nothing is settled.
    expect(await finishSignIn(page)).toMatchObject({
      kind: "not_started",
      reason: "hidden",
    });
    await untilRecord(
      page,
      (s) => s.attempt === null,
      "the abandoned attempt is cleared",
    );
    expect((await records(page)).auth_state.settled).toBeNull();
    expect(
      (await proxy.log()).some((entry) =>
        entry.path.endsWith("/browser-sessions/activate"),
      ),
    ).toBe(false);
  });
});
