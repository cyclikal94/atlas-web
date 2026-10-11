import type { BrowserContext, Page, Route } from "@playwright/test";
import { DATA_CONFIG } from "../../src/data/model/config";
import { accountDatabaseName } from "../../src/data/model/schema";
import { recordEvidence } from "./data-evidence";
import { untilTreeSettled } from "./data-sync-helpers";
import { expect, test } from "./helpers";

/**
 * E-W1, E-W3 to E-W6 (plan 8.6): the PRODUCTION session kernel, the PRODUCTION real data ports and real rows, in a real engine,
 * through the fixture-only session harness (`/__session`, which also carries the data harness). The network is stubbed with
 * `page.route`: there is NO backend, so this is FIXTURE evidence (real IndexedDB, real Web Locks, real BroadcastChannel; stubbed
 * HTTP). The same flows against the released backend are I-W1 (`tests/integration`). Not real Safari, not a device, not quota.
 */
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = () => new Date().toISOString();
const nameOf = accountDatabaseName;

const settled = (account: string, session = "s1") => ({
  schema: 1,
  latest_epoch: 1,
  fence_seq: 0,
  attempt: null,
  settled: {
    account_id: account,
    epoch: 1,
    settled_at: iso(),
    session_id: session,
  },
  fences: {},
  leases: {},
});
const signedOut = () => ({
  schema: 1,
  latest_epoch: 1,
  fence_seq: 0,
  attempt: null,
  settled: null,
  fences: {},
  leases: {},
});

const draft = (account: string, n: number) => ({
  local_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  account_id: account,
  endpoint: "/commands",
  target_id: null,
  command: { kind: "edit", n },
  command_digest: `digest-${n}`,
  defaults_revision: null,
  target_resource_ids: [],
  side_effect_bases: {},
  index_targets: [],
  bases: {},
  bumped: [],
  defaults_context: null,
  review_block: null,
  depends_on: [],
  status: "queued",
  held_pending_cache: false,
  unavailable_outcome: false,
  retry_state: null,
  attempts: 0,
  last_attempt_at: null,
  last_error: null,
  display_patch: null,
  receipt_revision: null,
  created_seq: n,
  created_at: iso(),
});
const recovery = (form: string) => ({
  form_context: form,
  tab_instance_id: "tab",
  fields: { title: "unfinished" },
  redacted: [],
  saved_at: iso(),
  capture_seq: 1,
  terminal: false,
  content_digest: `digest-${form}`,
});

interface Network {
  /** Holds every logout's DELETE until released. */
  hold(): void;
  release(): void;
  identity: { account: string; session: string };
  deletes: string[];
}

/** Stubs /health, the identity read and the logout DELETE (answering `confirmed_applied` for the key and account it was sent). */
async function stub(
  context: BrowserContext,
  account: string,
  session = "s1",
): Promise<Network> {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const state: Network = {
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = null;
      open();
    },
    identity: { account, session },
    deletes: [],
  };
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.28.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/browser-sessions/current"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account_id: state.identity.account,
          session_id: state.identity.session,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: `csrf.${state.identity.session}`,
        }),
      });
    if (
      request.method() === "DELETE" &&
      /\/sessions\/[^/]+$/.test(url.pathname)
    ) {
      state.deletes.push(url.pathname);
      if (gate) await gate;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          operation_id: request.headers()["idempotency-key"],
          account_id: state.identity.account,
          outcome: "confirmed_applied",
        }),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  return state;
}

async function harnessPage(
  context: BrowserContext,
  path = "/__session?boot=off",
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(path);
  // `/__data` carries the data harness only; `/__session` carries both.
  if (path.startsWith("/__session"))
    await page.waitForFunction(
      () => window.__atlasFixture?.session !== undefined,
    );
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

/** Creates an account's database and its rows with the production adapter, then closes this page's handle. */
async function arrange(
  page: Page,
  account: string,
  rows: { drafts?: number; recovery?: string[] },
): Promise<void> {
  const drafts = Array.from({ length: rows.drafts ?? 0 }, (_, i) =>
    draft(account, i + 1),
  );
  const forms = (rows.recovery ?? []).map(recovery);
  await page.evaluate(
    async ({ acct, drafts: d, forms: f }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct, { create: true });
      if (d.length) await data.put(acct, "drafts", d);
      if (f.length) await data.put(acct, "form_recovery", f);
      data.close(acct);
    },
    { acct: account, drafts, forms },
  );
}

async function seedAuth(
  context: BrowserContext,
  state: unknown,
  records: Record<string, unknown> = {},
): Promise<void> {
  const page = await harnessPage(context);
  await page.evaluate(
    async ({ s, r }) => {
      const h = window.__atlasFixture?.session;
      if (!h) throw new Error("no session harness");
      await h.seedAuthState(s);
      if (Object.keys(r).length) await h.seedRecords(r);
    },
    { s: state, r: records },
  );
  await page.close();
}

async function boot(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__session?route=%2Ftoday");
  await page.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await page.evaluate(() => window.__atlasFixture?.session?.ready);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}

const databases = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__atlasData?.list() ?? []);
const ledger = (
  page: Page,
): Promise<
  Record<string, { status: string; operation_id: string; count: number | null }>
> =>
  page.evaluate(async () => {
    const records = (await window.__atlasFixture?.session?.readRecords()) as {
      pending_deletions: Record<
        string,
        { status: string; operation_id: string; count: number | null }
      >;
    };
    return records.pending_deletions;
  });
const viewOf = (page: Page) =>
  page.evaluate(() => {
    const view = window.__atlasFixture?.session?.booted?.session.view.get() as {
      kind: string;
      state?: string;
      consent?: { count: number; ticket: string };
    };
    return view;
  });
const waitConsent = (page: Page) =>
  page.waitForFunction(
    () => {
      const view = window.__atlasFixture?.session?.booted?.session.view.get();
      return view?.kind === "neutral" && view.state === "wipe.consent";
    },
    undefined,
    { timeout: 15_000 },
  );
/**
 * Polls until the account's database is no longer listed. (Playwright's `waitForFunction` accepts the Promise an async predicate
 * returns as truthy, so it must not be used with one: an earlier version of this helper passed before anything had happened.)
 */
const waitGone = (page: Page, account: string) =>
  expect
    .poll(async () => (await databases(page)).includes(nameOf(account)), {
      timeout: 15_000,
      message: `${nameOf(account)} should be deleted`,
    })
    .toBe(false);

const summarise = (page: Page) =>
  page.evaluate(() =>
    window.__atlasFixture?.session?.booted?.session.operations.summariseLocalWork(),
  );
/**
 * Adapted in revision 37 (the E-W1 WebKit failure of driver-r37d, "no open store"): a harness write made DURING the logout raced the
 * protected tree's own teardown. `logout` resolves before the tree is unmounted, and the tree's runtime, which held the account's service,
 * closes every connection of the account on the page when it is disposed (R35), so a store the harness had just opened was closed under it.
 * A case that writes during the logout now first knows the tree is BOUND (before the network is held, so its requests settle), and writes
 * only once the logout's teardown has CLOSED the account on the page (a closure recorded since, and no connection of the account left).
 * Nothing about the logout changes: the write still lands while its request is held, before `closing`.
 */
const closuresOf = (page: Page, account: string): Promise<number> =>
  page.evaluate(
    (a) =>
      window.__atlasData?.gateDiagnostics().closes.filter((c) => c[1] === a)
        .length ?? 0,
    account,
  );
async function untilTreeBound(page: Page, account: string): Promise<number> {
  await untilTreeSettled(page, { account });
  return closuresOf(page, account);
}
async function untilTreeReleased(
  page: Page,
  account: string,
  closuresBefore: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await closuresOf(page, account)) > closuresBefore &&
        (await page.evaluate(
          (a) => window.__atlasData?.openCount(a) ?? -1,
          account,
        )) === 0,
      {
        timeout: 15_000,
        message: `the tree's teardown should close ${account}`,
      },
    )
    .toBe(true);
}
const logout = (page: Page) =>
  page.evaluate(async () => {
    const session = window.__atlasFixture?.session?.booted?.session;
    if (!session) throw new Error("no session");
    const unsynced = await session.operations.summariseLocalWork();
    if (!unsynced) throw new Error("nobody is settled");
    return session.operations.logout({ unsynced });
  });
const choose = (page: Page, choice: "delete" | "keep") =>
  page.evaluate(async (c) => {
    const session = window.__atlasFixture?.session?.booted?.session;
    if (!session) throw new Error("no session");
    const view = session.view.get() as { consent?: { ticket: string } };
    if (!view.consent) throw new Error("no consent prompt is showing");
    return session.wipe.resolveConsent(view.consent.ticket as never, c);
  }, choice);
const rowsOf = (
  page: Page,
  account: string,
  store: "drafts" | "form_recovery",
) =>
  page.evaluate(
    async ({ acct, s }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct);
      return (await data.rows(acct, s)).length;
    },
    { acct: account, s: store },
  );
const fenceOf = (page: Page, account: string) =>
  page.evaluate(async (acct) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    data.setIdentity(acct);
    await data.open(acct);
    return ((await data.syncState(acct))?.draft_fence ?? null) as unknown;
  }, account);

test.describe("E-W1: a confirmed logout with REAL unsynced work", () => {
  test("warns with the true count, recounts, fences, sends the DELETE and deletes the real database after the confirmed outcome", async ({
    context,
  }, info) => {
    await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 3, recovery: ["form-1"] });
    await prep.close();
    const page = await boot(context);
    const summary = await summarise(page);
    expect(summary?.count).toBe(4);
    expect(summary?.items).toEqual([
      "3 changes waiting to send",
      "1 unfinished form copy",
    ]);
    // The digest the dialog bound is what the fence stores and what the recount reproduces.
    const started = await logout(page);
    expect(started?.kind).toBe("started");
    await waitGone(page, A);
    await expect.poll(async () => Object.keys(await ledger(page))).toEqual([]);
    recordEvidence(info, "logout-wipe", {
      summary,
      started,
      databases: await databases(page),
    });
    expect(await databases(page)).not.toContain(nameOf(A));
  });

  test("work saved between the confirmation and the closure renews the prompt; KEEP retains every row, releases the fence and clears the ledger", async ({
    context,
  }, info) => {
    const network = await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 3 });
    await prep.close();
    const page = await boot(context);
    const bound = await untilTreeBound(page, A);
    network.hold();
    const started = await logout(page);
    expect(started?.kind).toBe("started");
    await untilTreeReleased(page, A, bound);
    // An unfinished form is autosaved while the logout request is in flight (recovery writes are allowed until `closing`).
    await page.evaluate(
      async (row) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        data.setIdentity(
          window.__atlasFixture?.session?.booted?.session.identity.get()
            ?.account_id ?? null,
        );
        await data.open(row.acct);
        await data.put(row.acct, "form_recovery", [row.form]);
      },
      { acct: A, form: recovery("autosaved-during") },
    );
    network.release();
    await waitConsent(page);
    const view = await viewOf(page);
    expect(view.consent?.count).toBe(4);
    expect(await choose(page, "keep")).toEqual({ kind: "absent" });
    expect(await databases(page)).toContain(nameOf(A));
    expect(await rowsOf(page, A, "drafts")).toBe(3);
    expect(await rowsOf(page, A, "form_recovery")).toBe(1);
    expect(await fenceOf(page, A)).toBeNull();
    await expect.poll(async () => Object.keys(await ledger(page))).toEqual([]);
    recordEvidence(info, "renewed-consent-keep", { view });
  });

  test("the same renewal, then DELETE: the database is gone and the ledger entry is cleared", async ({
    context,
  }) => {
    const network = await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 2 });
    await prep.close();
    const page = await boot(context);
    const bound = await untilTreeBound(page, A);
    network.hold();
    await logout(page);
    await untilTreeReleased(page, A, bound);
    await page.evaluate(
      async (row) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        data.setIdentity(row.acct);
        await data.open(row.acct);
        await data.put(row.acct, "form_recovery", [row.form]);
      },
      { acct: A, form: recovery("autosaved-during") },
    );
    network.release();
    await waitConsent(page);
    expect(await choose(page, "delete")).toEqual({ kind: "deleted" });
    await waitGone(page, A);
    await expect.poll(async () => Object.keys(await ledger(page))).toEqual([]);
  });
});

test.describe("E-W1: two accounts waiting, both insertion orders, both choices", () => {
  const entry = (
    account: string,
    op: string,
    digest: string,
    created: string,
  ) => ({
    operation_id: op,
    account_id: account,
    incarnation_id: null,
    status: "awaiting_consent",
    digest,
    approved_digest: null,
    count: 2,
    created_at: created,
  });
  for (const olderIs of [A, B] as const) {
    for (const choices of [
      ["delete", "keep"],
      ["keep", "delete"],
    ] as const) {
      test(`${olderIs === A ? "A" : "B"} is the older prompt; first choice ${choices[0]}, second ${choices[1]}: the right database goes, the other's work survives, nothing is resurrected`, async ({
        context,
      }, info) => {
        await stub(context, A);
        const prep = await harnessPage(context);
        await arrange(prep, A, { drafts: 2 });
        await arrange(prep, B, { drafts: 5 });
        // The prompts' digests are the REAL live digests, so a Delete is approved against the work that is there.
        const digests = await prep.evaluate(
          async ({ a, b }) => {
            const ports = window.__atlasData?.ports;
            if (!ports) throw new Error("no ports");
            return {
              a: await ports.coordination.liveDigest(a),
              b: await ports.coordination.liveDigest(b),
            };
          },
          { a: A, b: B },
        );
        await prep.close();
        const older = "2026-09-30T08:00:00.000Z";
        const newer = "2026-09-30T09:00:00.000Z";
        await seedAuth(context, signedOut(), {
          pending_deletions: {
            [A]: entry(
              A,
              "00000000-0000-4000-8000-0000000000a1",
              digests.a,
              olderIs === A ? older : newer,
            ),
            [B]: entry(
              B,
              "00000000-0000-4000-8000-0000000000b1",
              digests.b,
              olderIs === B ? older : newer,
            ),
          },
        });
        const page = await boot(context);
        await waitConsent(page);
        const first = olderIs;
        const second = olderIs === A ? B : A;
        expect((await ledger(page))[first]?.status).toBe("awaiting_consent");
        // The first prompt shown is the older entry's; its choice applies to ITS account only.
        const firstOutcome = await choose(page, choices[0]);
        expect(firstOutcome).toEqual({
          kind: choices[0] === "delete" ? "deleted" : "absent",
        });
        expect((await databases(page)).includes(nameOf(first))).toBe(
          choices[0] === "keep",
        );
        expect(await databases(page)).toContain(nameOf(second));
        expect(await rowsOf(page, second, "drafts")).toBe(second === A ? 2 : 5);
        // The other prompt is now the one showing.
        await waitConsent(page);
        expect((await ledger(page))[second]?.status).toBe("awaiting_consent");
        const secondOutcome = await choose(page, choices[1]);
        expect(secondOutcome).toEqual({
          kind: choices[1] === "delete" ? "deleted" : "absent",
        });
        const remaining = await databases(page);
        expect(remaining.includes(nameOf(first))).toBe(choices[0] === "keep");
        expect(remaining.includes(nameOf(second))).toBe(choices[1] === "keep");
        // Nothing was resurrected: no entry remains, and a retained database still holds exactly its own work.
        await expect
          .poll(async () => Object.keys(await ledger(page)))
          .toEqual([]);
        if (choices[0] === "keep")
          expect(await rowsOf(page, first, "drafts")).toBe(first === A ? 2 : 5);
        recordEvidence(
          info,
          `two-accounts-${olderIs === A ? "A" : "B"}-older-${choices.join("-")}`,
          { digests, remaining },
        );
      });
    }
  }
});

test.describe("E-W1: two tabs show the same prompt", () => {
  async function twoTabs(context: BrowserContext) {
    const network = await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 2 });
    await prep.close();
    const one = await boot(context);
    const bound = await untilTreeBound(one, A);
    network.hold();
    await logout(one);
    await untilTreeReleased(one, A, bound);
    await one.evaluate(
      async (row) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no data harness");
        data.setIdentity(row.acct);
        await data.open(row.acct);
        await data.put(row.acct, "form_recovery", [row.form]);
      },
      { acct: A, form: recovery("autosaved-during") },
    );
    network.release();
    await waitConsent(one);
    const two = await context.newPage();
    await two.goto("/__session?route=%2Ftoday");
    await two.waitForFunction(
      () => window.__atlasFixture?.session?.booted !== undefined,
    );
    await two.evaluate(() => window.__atlasFixture?.session?.ready);
    await waitConsent(two);
    return { one, two };
  }

  test("a Delete and a Keep issued at the same moment: exactly one outcome is applied", async ({
    context,
  }, info) => {
    const { one, two } = await twoTabs(context);
    const [a, b] = await Promise.all([
      choose(one, "delete"),
      choose(two, "keep"),
    ]);
    const outcomes = [a.kind, b.kind].sort();
    recordEvidence(info, "delete-vs-keep", { outcomes });
    // One page's choice was applied; the other's prompt was no longer current.
    expect(outcomes).toContain("prompt_superseded");
    const kept = (await databases(one)).includes(nameOf(A));
    expect(outcomes.includes("deleted")).toBe(!kept);
    expect(outcomes.includes("absent")).toBe(kept);
    await expect.poll(async () => Object.keys(await ledger(one))).toEqual([]);
    if (kept) expect(await rowsOf(one, A, "drafts")).toBe(2);
  });

  test("with the account's lock held by a third page, neither choice is applied; when it is released exactly one is", async ({
    context,
  }, info) => {
    const { one, two } = await twoTabs(context);
    const holder = await harnessPage(context);
    await holder.evaluate(async (name) => {
      const handle = await window.__atlasFixture?.session?.locks.acquire(name);
      if (!handle) throw new Error("lock not acquired");
      (window as unknown as { __held: { release(): void } }).__held = handle;
    }, `atlas-delete:${A}`);
    const pendingA = choose(one, "delete");
    const pendingB = choose(two, "keep");
    // Nothing happens while the critical section is held elsewhere.
    await one.waitForTimeout(600);
    expect(await databases(holder)).toContain(nameOf(A));
    expect((await ledger(holder))[A]?.status).toBe("awaiting_consent");
    await holder.evaluate(() =>
      (window as unknown as { __held: { release(): void } }).__held.release(),
    );
    const [a, b] = await Promise.all([pendingA, pendingB]);
    const outcomes = [a.kind, b.kind].sort();
    recordEvidence(info, "lock-held-then-released", { outcomes });
    expect(outcomes).toContain("prompt_superseded");
    await expect
      .poll(async () => Object.keys(await ledger(holder)))
      .toEqual([]);
  });
});

test.describe("E-W3: deleting with other tabs holding connections", () => {
  test("`versionchange` closes the other tab's connections, the delete completes, the name is no longer listed and the markers are gone", async ({
    context,
  }, info) => {
    const one = await harnessPage(context, "/__data");
    const two = await harnessPage(context, "/__data");
    await one.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct, { create: true });
      const published = data.markers.set(
        { account: acct, incarnationId: "incarnation-1" },
        "page:cursor",
      );
      const state = published.state;
      if (state !== "recorded") throw new Error(`the marker was ${state}`);
    }, A);
    await two.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct);
    }, A);
    const result = await one.evaluate(async (acct) => {
      const ports = window.__atlasData?.ports;
      if (!ports) throw new Error("no ports");
      await ports.database.closeOwnConnections(acct);
      return ports.database.delete(acct);
    }, A);
    const state = await two.evaluate(
      (acct) => ({
        latch: window.__atlasData?.latch(acct),
        open: window.__atlasData?.openCount(acct),
        notices: window.__atlasData?.versionChanges,
      }),
      A,
    );
    recordEvidence(info, "delete-with-other-tab", { result, state });
    expect(["deleted", "blocked_then_deleted"]).toContain(result);
    expect(state.latch).toBe("closed_for_deletion");
    expect(state.open).toBe(0);
    expect(await databases(one)).not.toContain(nameOf(A));
    expect(
      await one.evaluate(
        (acct) =>
          window.__atlasData?.markers.operations({
            account: acct,
            incarnationId: "incarnation-1",
          }),
        A,
      ),
    ).toEqual([]);
    // Housekeeping reached the raw storage too: neither the key nor the directory that listed it is left (R56; read by an oracle that
    // lists the page's keys itself, which no answer of the markers depends on).
    expect(
      await one.evaluate(
        (acct) =>
          Object.keys(localStorage)
            .filter(
              (key) =>
                key.startsWith("atlas-write-failing:") ||
                key.startsWith("atlas-write-dir:"),
            )
            .filter((key) => key.includes(`:${acct}:`)),
        A,
      ),
    ).toEqual([]);
  });

  test("a tab that CANNOT respond (its `versionchange` handler never closes) keeps the delete pending, and the completion is `blocked_then_deleted` once it closes", async ({
    context,
  }, info) => {
    const owner = await harnessPage(context, "/__data");
    const stuck = await harnessPage(context, "/__data");
    await owner.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct, { create: true });
      data.close(acct);
    }, A);
    // This tab opens a raw connection and ignores `versionchange`, as a frozen or unresponsive tab does.
    await stuck.evaluate(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => undefined;
            (window as unknown as { __stuck: IDBDatabase }).__stuck = db;
            resolve();
          };
        }),
      nameOf(A),
    );
    await owner.evaluate((acct) => {
      (window as unknown as { __result: string | null }).__result = null;
      void window.__atlasData?.ports.database.delete(acct).then((r) => {
        (window as unknown as { __result: string | null }).__result = r;
      });
    }, A);
    await owner.waitForTimeout(800);
    const whileBlocked = await owner.evaluate(
      () => (window as unknown as { __result: string | null }).__result,
    );
    expect(whileBlocked, "a blocked delete must stay pending").toBeNull();
    expect(await databases(owner)).toContain(nameOf(A));
    await stuck.evaluate(() =>
      (window as unknown as { __stuck: IDBDatabase }).__stuck.close(),
    );
    await owner.waitForFunction(
      () =>
        (window as unknown as { __result: string | null }).__result !== null,
      undefined,
      { timeout: 10_000 },
    );
    const after = await owner.evaluate(
      () => (window as unknown as { __result: string | null }).__result,
    );
    recordEvidence(info, "blocked-delete", { whileBlocked, after });
    expect(after).toBe("blocked_then_deleted");
    expect(await databases(owner)).not.toContain(nameOf(A));
  });
});

test.describe("E-W4: failure and recovery of the deletion", () => {
  test("an injected deleteDatabase error is `retry_later/delete_error`, the entry is kept, and a later retry completes the wipe", async ({
    context,
  }, info) => {
    await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 1 });
    await prep.close();
    const page = await boot(context);
    // Every deleteDatabase of an account database fails until switched off (a named injection: a real engine will not fail one on
    // request). It does not depend on the timing of the kernel's own retries.
    await page.evaluate(() => {
      const w = window as unknown as {
        __failDeletes: boolean;
        __failed: number;
      };
      w.__failDeletes = true;
      w.__failed = 0;
      const original = indexedDB.deleteDatabase.bind(indexedDB);
      indexedDB.deleteDatabase = (name: string) => {
        if (
          w.__failDeletes &&
          name.startsWith("atlas-") &&
          !name.includes("probe")
        ) {
          w.__failed += 1;
          const request = {} as IDBOpenDBRequest;
          queueMicrotask(() =>
            (request.onerror as ((e: Event) => void) | null)?.(
              new Event("error"),
            ),
          );
          return request;
        }
        return original(name);
      };
    });
    await logout(page);
    await page.waitForFunction(
      () => ((window as unknown as { __failed: number }).__failed ?? 0) >= 1,
    );
    await page.waitForTimeout(500);
    // The failure is `retry_later/delete_error`: the database is NOT reported deleted, the work survives, and the entry stays.
    expect(await databases(page)).toContain(nameOf(A));
    // R57 (revision 33): the read opens the account, and an open is refused while the kernel's own attempt holds the account (`wipe_in_progress`),
    // which the kernel's retries make a recurring window (a Firefox run of the native focused selection hit it once: `no open store`, forty
    // repetitions of this case did not). The assertion is unchanged, that the work survives (one draft row); the read waits for the window.
    await expect
      .poll(() => rowsOf(page, A, "drafts").catch(() => null), {
        timeout: 15_000,
        message: "the draft survives the failed deletion",
      })
      .toBe(1);
    expect((await ledger(page))[A]).toBeDefined();
    await page.evaluate(() => {
      (window as unknown as { __failDeletes: boolean }).__failDeletes = false;
    });
    await page.evaluate(() =>
      window.__atlasFixture?.session?.booted?.session.wipe.recoverPending(),
    );
    await waitGone(page, A);
    await expect.poll(async () => Object.keys(await ledger(page))).toEqual([]);
    recordEvidence(info, "delete-error-then-retry", { ok: true });
  });

  test("a page closed mid-delete: boot recovery completes the wipe", async ({
    context,
  }, info) => {
    await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 1 });
    await prep.close();
    const page = await boot(context);
    // The delete never completes in this page (a request object that never fires), and the page is closed.
    await page.evaluate(() => {
      indexedDB.deleteDatabase = () => ({}) as IDBOpenDBRequest;
    });
    await logout(page);
    await expect
      .poll(async () => (await ledger(page))[A]?.status)
      .toBeDefined();
    // The page was closed before the delete could finish: the database and the ledger entry are both still there. (Without this,
    // a recovery that did nothing would look the same as one that worked.)
    await page.close();
    const between = await harnessPage(context);
    expect(await databases(between)).toContain(nameOf(A));
    expect((await ledger(between))[A]).toBeDefined();
    await between.close();
    const next = await boot(context);
    await waitGone(next, A);
    await expect.poll(async () => Object.keys(await ledger(next))).toEqual([]);
    recordEvidence(info, "closed-mid-delete", { ok: true });
  });

  test("an incarnation mismatch (the account signed back in meanwhile) stands down without deleting", async ({
    context,
  }, info) => {
    await stub(context, A);
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 2 });
    await prep.close();
    await seedAuth(context, signedOut(), {
      pending_deletions: {
        [A]: {
          operation_id: "00000000-0000-4000-8000-0000000000a1",
          account_id: A,
          incarnation_id: "an-earlier-incarnation",
          status: "pending",
          digest: null,
          approved_digest: null,
          count: null,
          created_at: iso(),
        },
      },
    });
    const page = await boot(context);
    await expect.poll(async () => Object.keys(await ledger(page))).toEqual([]);
    expect(await databases(page)).toContain(nameOf(A));
    expect(await rowsOf(page, A, "drafts")).toBe(2);
    recordEvidence(info, "incarnation-mismatch", { ok: true });
  });
});

test.describe("E-W5: nothing re-creates a wiped database", () => {
  test("a delayed commit, a draft write and a form-recovery save after a confirmed wipe do not re-create it", async ({
    context,
  }, info) => {
    const one = await harnessPage(context, "/__data");
    const two = await harnessPage(context, "/__data");
    await one.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct, { create: true });
      await data.open(acct, { create: false });
      // The creating connection's handle, as a late writer (an in-flight continuation) would still hold it.
      data.holdStore(acct);
    }, A);
    // Another tab runs the wipe.
    const wiped = await two.evaluate(async (acct) => {
      const ports = window.__atlasData?.ports;
      if (!ports) throw new Error("no ports");
      await ports.database.closeOwnConnections(acct);
      return ports.database.delete(acct);
    }, A);
    expect(["deleted", "blocked_then_deleted"]).toContain(wiped);
    const late = await one.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      const commit = await data.commitProbe(acct, 1, "late");
      const write = await data.tryRows(acct, "drafts");
      let put = "ok";
      try {
        await data.put(acct, "drafts", []);
      } catch (error) {
        put = (error as { cause?: string }).cause ?? "error";
      }
      const save = await data.formRecovery(acct).save({
        formContext: "f",
        tabInstanceId: "t",
        values: { a: "b" },
        savedAt: new Date().toISOString(),
      });
      // A STRICT plan (every draft write is one) goes through the other connection, the one that was opened to create: nothing
      // about it may re-create the database either.
      const strict = await data.enqueueDirect(
        acct,
        { endpoint: "/commands", targets: [], command: { kind: "late" } },
        { held: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { commit, write, put, save, strict, listed: await data.list() };
    }, A);
    recordEvidence(info, "no-resurrection", { wiped, late });
    expect(late.commit).not.toBe("applied");
    expect(late.write).toBe("closed");
    expect(late.put).toBe("closed");
    expect(late.save).toBe("failed");
    expect(late.strict).toEqual({ kind: "store_failure", reason: "closed" });
    expect(late.listed).not.toContain(nameOf(A));
    expect(await databases(two)).not.toContain(nameOf(A));
  });
});

test.describe("E-W6: form recovery and the closing write", () => {
  const save = (page: Page, account: string, title: string, tab = "tab-a") =>
    page.evaluate(
      ({ acct, t, tabId }) =>
        window.__atlasData?.formRecovery(acct).save({
          formContext: "form",
          tabInstanceId: tabId,
          values: { title: t },
          savedAt: new Date().toISOString(),
        }),
      { acct: account, t: title, tabId: tab },
    );

  test("saving is REFUSED once `closing` is set: in the old connection, a reopened connection and a brand-new tab", async ({
    context,
  }, info) => {
    const one = await harnessPage(context, "/__data");
    await one.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct, { create: true });
      await data.open(acct, { create: false });
    }, A);
    expect(await save(one, A, "before")).toBe("saved");
    await one.evaluate((acct) => window.__atlasData?.markClosing(acct), A);
    const oldConnection = await save(one, A, "after");
    // A reopened connection in the same tab.
    await one.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.runtime.dispose();
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
    }, A);
    const two = await harnessPage(context, "/__data");
    await two.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct);
    }, A);
    const brandNewTab = await save(two, A, "from a new tab", "tab-z");
    const rows = await two.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      await data.open(acct);
      return (await data.rows(acct, "form_recovery")) as Array<{
        tab_instance_id: string;
        fields: Record<string, string>;
      }>;
    }, A);
    recordEvidence(info, "closing-refuses", {
      oldConnection,
      brandNewTab,
      rows,
    });
    expect(oldConnection).toBe("refused");
    expect(brandNewTab).toBe("refused");
    expect(rows.map((r) => r.tab_instance_id)).toEqual(["tab-a"]);
    expect(rows[0]?.fields).toEqual({ title: "before" });
  });

  test("a recovery write inside the fence's window (no `closing` yet) is accepted and COUNTED: the live digest no longer equals the consent digest", async ({
    context,
  }) => {
    const page = await harnessPage(context, "/__data");
    await page.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setRuntimeIdentity({ account: acct, epoch: 1 });
      await data.openService(acct, { create: true });
    }, A);
    const result = await page.evaluate(async (acct) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      const ports = data.ports;
      const fence = await ports.coordination.setDraftFence(acct, "op-1");
      const saved = await data.formRecovery(acct).save({
        formContext: "f",
        tabInstanceId: "t",
        values: { a: "b" },
        savedAt: new Date().toISOString(),
      });
      return {
        fence: fence.consentDigest,
        saved,
        live: await ports.coordination.liveDigest(acct),
        baseline: await ports.coordination.baselineDigest(acct),
      };
    }, A);
    expect(result.saved).toBe("saved");
    expect(result.baseline).toBe(result.fence);
    expect(result.live).not.toBe(result.baseline);
  });
});

test.describe("E-R1: form recovery across a real reload (R1)", () => {
  test("several captures, a reload, newer text: it is saved (never reported saved while the store declined it), and discard after the reload clears a row far above the new port's counter", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const page = await context.newPage();
    await page.goto("/__data");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const snap = (title: string) => ({
      formContext: "task-edit:42",
      tabInstanceId: "tab-a",
      values: { title },
      savedAt: "2026-10-01T09:00:00.000Z",
    });
    const first = await page.evaluate(
      async ([a, one, two, three]) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setIdentity(a as string);
        data.setRuntimeIdentity({ account: a as string, epoch: 1 });
        await data.openService(a as string, { create: true });
        const port = data.formRecovery(a as string);
        return [
          await port.save(one as never),
          await port.save(two as never),
          await port.save(three as never),
        ];
      },
      [account, snap("one"), snap("two"), snap("three")],
    );
    expect(first).toEqual(["saved", "saved", "saved"]);

    // The page is reloaded: every in-memory counter is gone; the durable row stands at capture 3.
    await page.reload();
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const after = await page.evaluate(
      async ([a, four]) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setIdentity(a as string);
        data.setRuntimeIdentity({ account: a as string, epoch: 1 });
        await data.openService(a as string, { create: false });
        const port = data.formRecovery(a as string);
        const saved = await port.save(four as never);
        const loaded = await port.load("task-edit:42", "tab-a");
        const rows = (await data.rows(a as string, "form_recovery")) as Array<{
          capture_seq: number;
          writer_gen?: number;
          fields: Record<string, string>;
        }>;
        return {
          saved,
          loaded: loaded?.values,
          seq: rows[0]?.capture_seq,
          gen: rows[0]?.writer_gen,
        };
      },
      [account, snap("four")],
    );
    recordEvidence(info, "form-recovery-reload", after);
    expect(after.saved).toBe("saved");
    expect(after.loaded).toEqual({ title: "four" });
    // No reconciliation: the reloaded page claims the next writer generation and its first capture is that generation's first.
    expect(after.gen).toBe(2);
    expect(after.seq).toBe(1);

    await page.reload();
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const cleared = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      data.setRuntimeIdentity({ account: a, epoch: 1 });
      await data.openService(a, { create: false });
      const port = data.formRecovery(a);
      await port.discard("task-edit:42", "tab-a");
      return {
        loaded: await port.load("task-edit:42", "tab-a"),
        rows: (await data.rows(a, "form_recovery")) as Array<{
          terminal: boolean;
          capture_seq: number;
          writer_gen?: number;
        }>,
      };
    }, account);
    expect(cleared.loaded).toBeNull();
    expect(cleared.rows[0]?.terminal).toBe(true);
    // The discard of the third page context is in the third generation, after every capture of the earlier two.
    expect(cleared.rows[0]?.writer_gen).toBe(3);
  });

  test("E-R2: an older port's capture held in its quota estimate while a replacement port saves newer text: the newer text stands, and the older capture is one refused write, reported as not saved", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const page = await context.newPage();
    await page.goto("/__data");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    const result = await page.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no harness");
      data.setIdentity(a);
      data.setRuntimeIdentity({ account: a, epoch: 1 });
      await data.openService(a, { create: true });
      return data.recoveryOverlap(a);
    }, account);
    recordEvidence(info, "form-recovery-overlap", result);
    expect(result.replacement).toBe("saved");
    expect(result.older).toBe("failed");
    expect(result.final).toBe("newer capture");
    expect(result.row?.writer_gen).toBe(1);
    expect(result.row?.capture_seq).toBe(4);
  });
});

/**
 * E-R3 (R33, revision 18): a recovery copy is admitted for what it stores, and nothing is created before it is, in a real engine. The
 * PRODUCTION recovery port, plans and quota guard (the origin's IndexedDB ledger and the page's Web Locks) run over REAL IndexedDB; the one
 * thing injected is the estimate's free space (a real engine cannot be made to raise `QuotaExceededError` on request), named in every
 * report. FIXTURE evidence: no genuine quota is exhausted, there is no backend, and it is not real Safari or a device.
 */
test.describe("E-R3 (revision 18, R33): a recovery copy is admitted for the whole row, and a refused save leaves nothing, in a real engine", () => {
  const FLOOR = DATA_CONFIG.quotaReserveBytes / 2;
  const FORM = "task-edit:42";

  /** A page of the data harness with the account's service open, and the runtime identity set. */
  const opened = async (
    context: BrowserContext,
    account: string,
    create: boolean,
  ) => {
    const page = await context.newPage();
    await page.goto("/__data");
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await page.evaluate(
      async ([a, created]) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        data.setIdentity(a as string);
        data.setRuntimeIdentity({ account: a as string, epoch: 1 });
        await data.openService(a as string, { create: created as boolean });
      },
      [account, create] as const,
    );
    return page;
  };
  /** One save over the production guard with `free` bytes of injected estimate. */
  const save = (
    page: Page,
    account: string,
    free: number,
    title: string,
    form = FORM,
    tab = "tab-a",
  ) =>
    page.evaluate(
      async ({ a, f, t, ctx, tabId }) =>
        window.__atlasData?.formRecovery(a, { estimateFreeBytes: f }).save({
          formContext: ctx,
          tabInstanceId: tabId,
          values: { title: t },
          savedAt: "2026-10-01T09:00:00.000Z",
        }),
      { a: account, f: free, t: title, ctx: form, tabId: tab },
    );
  const rows = (page: Page, account: string) =>
    page.evaluate(
      async (a) =>
        (await window.__atlasData?.rows(a, "form_recovery")) as Array<{
          form_context: string;
          fields: Record<string, string>;
          writer_gen?: number;
          capture_seq: number;
          terminal: boolean;
        }>,
      account,
    );
  const counter = (page: Page, account: string) =>
    page.evaluate(
      async (a) =>
        (
          ((await window.__atlasData?.rows(a, "sync_state")) ?? []) as Array<{
            form_writer_gen?: number;
          }>
        )[0]?.form_writer_gen,
      account,
    );

  test("a first save refused below the floor creates NO row, claim included: the claim moved only the database's counter; with room the form is saved under the generation it claimed", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const page = await opened(context, account, true);
    const refused = await save(page, account, FLOOR - 1, "x");
    expect(refused).toBe("failed");
    // The claim is made at the call and may finish after the refusal.
    await expect.poll(() => counter(page, account)).toBe(1);
    expect(await rows(page, account)).toEqual([]);
    // A discard of a form that has no row would create one: it is admitted like a save, and below the floor it is not.
    await page.evaluate(
      (a) =>
        window.__atlasData
          ?.formRecovery(a, { estimateFreeBytes: 0 })
          .discard("never-saved", "tab-a"),
      account,
    );
    expect(await rows(page, account)).toEqual([]);
    // With room the same form is saved, under the generation the writer claimed (one claim per page context and form).
    const saved = await save(page, account, FLOOR + 5_000_000, "kept");
    expect(saved).toBe("saved");
    const stored = await rows(page, account);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      fields: { title: "kept" },
      writer_gen: 1,
      capture_seq: 2,
    });
    recordEvidence(info, "form-recovery-first-claim-refused", {
      namedInjection:
        "the estimate's free bytes are injected; the production guard, ledger and Web Locks are real",
      freeBytesInjected: { refused: FLOOR - 1, withRoom: FLOOR + 5_000_000 },
      rowsAfterRefusal: 0,
      counterAfterRefusal: 1,
      rowAfterRoom: stored[0],
    });
  });

  test("the whole row is sized: a 900,000-character form context with 500,000 bytes of room is refused and leaves no row (the review's schedule), and an ordinary context in the same room is saved", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const page = await opened(context, account, true);
    const room = FLOOR + 500_000;
    const wide = await save(
      page,
      account,
      room,
      "x",
      "f".repeat(900_000),
      "tab-wide",
    );
    expect(wide).toBe("failed");
    expect(await rows(page, account)).toEqual([]);
    const ordinary = await save(page, account, room, "x");
    expect(ordinary).toBe("saved");
    expect((await rows(page, account)).map((r) => r.form_context)).toEqual([
      FORM,
    ]);
    recordEvidence(info, "form-recovery-whole-row", {
      freeBytesInjected: room,
      contextCharacters: 900_000,
      wideOutcome: wide,
      ordinaryOutcome: ordinary,
    });
  });

  test("two real page contexts claim a form that has no row, both refused; when room returns, the LATER context's text and generation stand, and the earlier context's late save is refused (R1 with no row to move)", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const first = await opened(context, account, true);
    const second = await opened(context, account, false);
    expect(await save(first, account, FLOOR - 1, "one")).toBe("failed");
    await expect.poll(() => counter(first, account)).toBe(1);
    expect(await save(second, account, FLOOR - 1, "two")).toBe("failed");
    await expect.poll(() => counter(second, account)).toBe(2);
    expect(await rows(first, account)).toEqual([]);
    // The later context writes first; the earlier one, in a lower generation, is refused rather than overwriting it.
    expect(await save(second, account, FLOOR + 5_000_000, "two again")).toBe(
      "saved",
    );
    expect(await save(first, account, FLOOR + 5_000_000, "one, late")).toBe(
      "failed",
    );
    const stored = await rows(second, account);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      fields: { title: "two again" },
      writer_gen: 2,
    });
    recordEvidence(info, "form-recovery-two-contexts-no-row", {
      namedInjection:
        "the estimate's free bytes are injected; two real pages share one real IndexedDB database and one real ledger",
      generations: { first: 1, second: 2 },
      final: stored[0],
    });
  });

  /**
   * E-R3 mixed claims (R1, revision 19): ONE ORDER FOR EVERY CLAIM, in a real engine. Three real page contexts (separate pages, separate real
   * database connections) share one account database and one logical form and tab. A capture waits in its quota admission (the harness's
   * `recoveryRun({ held })` gate: it controls SCHEDULING, not quota, and is named in every report that uses it) while another context claims
   * the form, in the schedule of the review of revision 18: A and B claim while the row is ABSENT, A's save lands, then C claims the EXISTING
   * row. The production recovery port, plans and Dexie adapter run over real IndexedDB; this is fixture evidence, not a real quota, a real
   * freeze or a device.
   */
  const MIXED_FORM = "mixed-claims";
  const run = (page: Page, account: string, name: string, held: boolean) =>
    page.evaluate(
      ({ a, n, h }) => window.__atlasData?.recoveryRun(a, n, { held: h }),
      { a: account, n: name, h: held },
    );
  const start = (
    page: Page,
    name: string,
    calls: Array<{ kind: "save"; text: string } | { kind: "discard" }>,
  ) =>
    page.evaluate(({ n, c }) => window.__atlasData?.recoveryStart(n, c), {
      n: name,
      c: calls,
    });
  const reached = (page: Page, name: string) =>
    page.evaluate((n) => window.__atlasData?.recoveryReached(n), name);
  const release = (page: Page, name: string) =>
    page.evaluate((n) => window.__atlasData?.recoveryRelease(n), name);
  const results = (page: Page, name: string): Promise<string[]> =>
    page.evaluate(
      async (n) => (await window.__atlasData?.recoveryResults(n)) ?? [],
      name,
    );
  const loadedText = (page: Page, account: string) =>
    page.evaluate((a) => window.__atlasData?.recoveryLoad(a), account);
  const mixedRow = async (page: Page, account: string) =>
    (await rows(page, account)).find((r) => r.form_context === MIXED_FORM);
  const capture = (text: string) => ({ kind: "save", text }) as const;
  const discard = { kind: "discard" } as const;
  const naming = {
    gate: "a quota admission that waits (scheduling only: it admits everything once released; it is not a quota)",
    claims:
      "separate real pages, one real IndexedDB database, one form and tab",
  };

  test("mixed claims, control: three contexts that all claim an EXISTING row keep the newest text and generation", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const a = await opened(context, account, true);
    const b = await opened(context, account, false);
    const c = await opened(context, account, false);
    await run(a, account, "a", false);
    await run(b, account, "b", true);
    await run(c, account, "c", false);
    await start(a, "a", [capture("seed")]);
    const seeded = await results(a, "a");
    await start(b, "b", [capture("old one"), capture("old two")]);
    await reached(b, "b");
    await start(c, "c", [capture("newest")]);
    const newest = await results(c, "c");
    const beforeRelease = await mixedRow(c, account);
    await release(b, "b");
    const late = await results(b, "b");
    const finalRow = await mixedRow(c, account);
    const finalText = await loadedText(c, account);
    recordEvidence(info, "form-recovery-mixed-control-existing", {
      ...naming,
      seeded,
      newest,
      late,
      beforeRelease,
      finalRow,
      finalText,
    });
    expect(seeded).toEqual(["saved"]);
    expect(newest).toEqual(["saved"]);
    expect(late).toEqual(["failed", "failed"]);
    expect(finalText).toBe("newest");
    expect(finalRow).toEqual(beforeRelease);
    expect(finalRow?.writer_gen).toBe(3);
  });

  test("mixed claims, control: two contexts that claim while the row is ABSENT: the later claimant's text and generation stand", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const a = await opened(context, account, true);
    const b = await opened(context, account, false);
    await run(a, account, "a", true);
    await run(b, account, "b", true);
    await start(a, "a", [capture("first")]);
    await reached(a, "a");
    await start(b, "b", [capture("second")]);
    await reached(b, "b");
    await release(a, "a");
    const first = await results(a, "a");
    await release(b, "b");
    const second = await results(b, "b");
    const finalRow = await mixedRow(a, account);
    recordEvidence(info, "form-recovery-mixed-control-absent", {
      ...naming,
      first,
      second,
      finalRow,
    });
    expect(first).toEqual(["saved"]);
    expect(second).toEqual(["saved"]);
    expect(finalRow).toMatchObject({
      fields: { text: "second" },
      writer_gen: 2,
    });
  });

  for (const variant of ["save", "discard"] as const)
    test(`mixed claims (the review's schedule, ${variant}): an absent claimant whose captures wait cannot ${variant === "save" ? "overwrite" : "restore discarded text over"} a LATER claimant of the row the first landed (generations 1, 2, 3)`, async ({
      context,
    }, info) => {
      const account = crypto.randomUUID();
      const a = await opened(context, account, true);
      const b = await opened(context, account, false);
      const c = await opened(context, account, false);
      await run(a, account, "a", true);
      await run(b, account, "b", true);
      await run(c, account, "c", false);
      await start(a, "a", [capture("first")]);
      await reached(a, "a");
      // B's captures are made now, before C exists, and wait behind B's admission.
      await start(b, "b", [capture("old one"), capture("old two")]);
      await reached(b, "b");
      await release(a, "a");
      const landed = await results(a, "a");
      const afterA = await mixedRow(c, account);
      // C claims the row that A landed: its generation is above B's, which has landed nothing.
      await start(c, "c", variant === "save" ? [capture("newest")] : [discard]);
      const claimant = await results(c, "c");
      const beforeRelease = await mixedRow(c, account);
      const textBefore = await loadedText(c, account);
      await release(b, "b");
      const late = await results(b, "b");
      const finalRow = await mixedRow(c, account);
      const finalText = await loadedText(c, account);
      recordEvidence(info, `form-recovery-mixed-${variant}`, {
        ...naming,
        landed,
        afterA,
        claimant,
        beforeRelease,
        textBefore,
        late,
        finalRow,
        finalText,
        counter: await counter(c, account),
      });
      expect(landed).toEqual(["saved"]);
      expect(afterA).toMatchObject({ writer_gen: 1 });
      expect(beforeRelease).toMatchObject({ writer_gen: 3 });
      expect(textBefore).toBe(variant === "save" ? "newest" : null);
      expect(late).toEqual(["failed", "failed"]);
      // Final, and never re-numbered above the newer text: the stored row is untouched, and so is what a reload would show.
      expect(finalRow).toEqual(beforeRelease);
      expect(finalText).toBe(textBefore);
      expect(claimant).toEqual(variant === "save" ? ["saved"] : ["done"]);
    });

  test("mixed claims (an older claimant's pending DISCARD): it does not erase a later claimant's newer input", async ({
    context,
  }, info) => {
    const account = crypto.randomUUID();
    const a = await opened(context, account, true);
    const b = await opened(context, account, false);
    const c = await opened(context, account, false);
    await run(a, account, "a", true);
    await run(b, account, "b", true);
    await run(c, account, "c", false);
    await start(a, "a", [capture("seed")]);
    await reached(a, "a");
    await start(b, "b", [capture("old one"), discard]);
    await reached(b, "b");
    await release(a, "a");
    await results(a, "a");
    await start(c, "c", [capture("newest")]);
    const claimant = await results(c, "c");
    const beforeRelease = await mixedRow(c, account);
    await release(b, "b");
    const late = await results(b, "b");
    const finalRow = await mixedRow(c, account);
    const finalText = await loadedText(c, account);
    recordEvidence(info, "form-recovery-mixed-older-discard", {
      ...naming,
      claimant,
      beforeRelease,
      late,
      finalRow,
      finalText,
    });
    expect(claimant).toEqual(["saved"]);
    expect(late[0]).toBe("failed");
    expect(finalRow).toEqual(beforeRelease);
    expect(finalText).toBe("newest");
  });
});

/**
 * E-W7 (R12, revision 8): a FAILED closing write, in a real engine. The session's own wipe, the production deletion and coordination
 * ports and the production recovery port run over REAL IndexedDB; the one thing injected is a named `DOMException` thrown by
 * `IDBObjectStore.put` for the `sync_state` write that carries `draft_fence.closing = true` (the rest of the page's writes are
 * untouched). The "late writer" is a brand-new page context opened after the digest read: it cannot have heard the broadcast, so only the
 * durable flag can stop it. FIXTURE evidence: a stubbed backend, a named injected fault; not a genuine storage failure or quota exhaustion,
 * not a real logout against the released backend, not real Safari.
 */
test.describe("E-W7: a failed closing write never lets a deletion go on without the durable flag (R12)", () => {
  const FAULTS = ["AbortError", "UnknownError", "QuotaExceededError"] as const;

  /** Makes the next `times` closing writes of this page throw `fault` (and counts them in `window.__closing`). */
  const injectClosingFault = (page: Page, fault: string, times: number) =>
    page.evaluate(
      ({ name, limit }) => {
        const scope = window as unknown as {
          __closing?: { injected: number; restore(): void };
        };
        const put = IDBObjectStore.prototype.put;
        const state = {
          injected: 0,
          restore() {
            IDBObjectStore.prototype.put = put;
          },
        };
        scope.__closing = state;
        IDBObjectStore.prototype.put = function (
          this: IDBObjectStore,
          value: unknown,
          ...rest: [IDBValidKey?]
        ) {
          const row = value as { draft_fence?: { closing?: boolean } } | null;
          if (
            this.name === "sync_state" &&
            row?.draft_fence?.closing === true &&
            state.injected < limit
          ) {
            state.injected += 1;
            throw new DOMException("injected closing fault", name);
          }
          return put.call(this, value, ...rest);
        } as typeof IDBObjectStore.prototype.put;
      },
      { name: fault, limit: times },
    );

  /** A page context that opens AFTER the digest read and saves a recovery copy through the production port. */
  const lateSave = async (
    context: BrowserContext,
    account: string,
    title: string,
  ): Promise<string> => {
    const other = await context.newPage();
    try {
      await other.goto("/__data");
      await other.waitForFunction(() => window.__atlasData !== undefined);
      return await other.evaluate(
        async ({ acct, t }) => {
          const data = window.__atlasData;
          if (!data) throw new Error("no data harness");
          data.setRuntimeIdentity({ account: acct, epoch: 1 });
          await data.openService(acct);
          const saved = await data.formRecovery(acct).save({
            formContext: "late-form",
            tabInstanceId: "late-tab",
            values: { title: t },
            savedAt: new Date().toISOString(),
          });
          data.runtime.dispose();
          return String(saved);
        },
        { acct: account, t: title },
      );
    } finally {
      await other.close();
    }
  };

  for (const fault of FAULTS) {
    test(`${fault}, once: it is asked again, the flag is durable BEFORE the digest is read, the late writer is REFUSED and the confirmed work is deleted`, async ({
      context,
    }, info) => {
      await stub(context, A);
      await seedAuth(context, settled(A));
      const prep = await harnessPage(context);
      await arrange(prep, A, { drafts: 3, recovery: ["form-1"] });
      await prep.close();
      const page = await boot(context);
      const late: string[] = [];
      await page.exposeFunction("reviewLateSave", async () => {
        const result = await lateSave(context, A, "unconsented work");
        late.push(result);
        return result;
      });
      await injectClosingFault(page, fault, 1);
      // The late writer acts straight after the production digest read.
      await page.evaluate(() => {
        const session = window.__atlasFixture?.session?.booted?.session as
          | {
              wipe: {
                ports: {
                  coordination: {
                    liveDigest(account: string): Promise<string>;
                  };
                };
              };
            }
          | undefined;
        if (!session) throw new Error("no session");
        const coordination = session.wipe.ports.coordination;
        const read = coordination.liveDigest.bind(coordination);
        coordination.liveDigest = async (account) => {
          const value = await read(account);
          await (
            window as unknown as { reviewLateSave(): Promise<string> }
          ).reviewLateSave();
          return value;
        };
      });
      const started = await logout(page);
      expect(started?.kind).toBe("started");
      await waitGone(page, A);
      const injected = await page.evaluate(
        () =>
          (window as unknown as { __closing?: { injected: number } }).__closing
            ?.injected,
      );
      recordEvidence(info, `closing-transient-${fault}`, {
        fault,
        injected,
        late,
        databases: await databases(page),
      });
      expect(injected).toBe(1);
      expect(late).toEqual(["refused"]);
      expect(await databases(page)).not.toContain(nameOf(A));
    });

    test(`${fault}, every time: nothing is read, closed or deleted; the entry, the fence and the work stay; a writer that gets in is counted, and the retry asks about it`, async ({
      context,
    }, info) => {
      await stub(context, A);
      await seedAuth(context, settled(A));
      const prep = await harnessPage(context);
      await arrange(prep, A, { drafts: 3, recovery: ["form-1"] });
      await prep.close();
      const page = await boot(context);
      await injectClosingFault(page, fault, 1_000);
      const started = await logout(page);
      expect(started?.kind).toBe("started");
      // The kernel asks three times (the third after its first back-off), then reports `retry_later` and leaves everything where it is.
      await page.waitForFunction(
        () =>
          ((window as unknown as { __closing?: { injected: number } }).__closing
            ?.injected ?? 0) >= 3,
        undefined,
        { timeout: 30_000 },
      );
      await expect
        .poll(async () => Object.values(await ledger(page))[0]?.status, {
          timeout: 15_000,
        })
        .toBe("pending");
      expect(await databases(page)).toContain(nameOf(A));
      expect(await rowsOf(page, A, "drafts")).toBe(3);
      expect(await rowsOf(page, A, "form_recovery")).toBe(1);
      const fenceBefore = (await fenceOf(page, A)) as {
        closing?: boolean;
        operation_ids?: string[];
      } | null;
      expect(fenceBefore?.closing).not.toBe(true);
      expect(fenceBefore?.operation_ids).toHaveLength(1);
      // The flag is not set, so a recovery writer is (correctly) not refused: its copy is work the person did not confirm.
      const accepted = await lateSave(context, A, "unconsented work");
      expect(accepted).toBe("saved");
      // The fault goes; the next entry repeats step 3a and RECOMPUTES the population: it asks, it does not delete.
      await page.evaluate(() =>
        (
          window as unknown as { __closing?: { restore(): void } }
        ).__closing?.restore(),
      );
      const operationId = Object.values(await ledger(page))[0]
        ?.operation_id as string;
      const outcome = await page.evaluate(
        async ({ acct, op }) => {
          const session = window.__atlasFixture?.session?.booted?.session;
          if (!session) throw new Error("no session");
          return session.wipe.run(acct as never, op as never);
        },
        { acct: A, op: operationId },
      );
      const after = {
        outcome,
        databases: await databases(page),
        ledger: await ledger(page),
        fence: (await fenceOf(page, A)) as { closing?: boolean } | null,
        refused: await lateSave(context, A, "even later"),
      };
      recordEvidence(info, `closing-persistent-${fault}`, {
        fault,
        accepted,
        ...after,
      });
      expect(outcome).toMatchObject({ kind: "awaiting_consent", count: 5 });
      expect(after.databases).toContain(nameOf(A));
      expect(after.fence?.closing).toBe(true);
      expect(Object.values(after.ledger)[0]?.status).toBe("awaiting_consent");
      // And now that the flag IS durable, another writer is refused.
      expect(after.refused).toBe("refused");
    });
  }

  test("the control: no fault, the flag is set at the first ask and the late writer is refused", async ({
    context,
  }, info) => {
    await stub(context, A);
    await seedAuth(context, settled(A));
    const prep = await harnessPage(context);
    await arrange(prep, A, { drafts: 3, recovery: ["form-1"] });
    await prep.close();
    const page = await boot(context);
    const late: string[] = [];
    await page.exposeFunction("reviewLateSave", async () => {
      const result = await lateSave(context, A, "unconsented work");
      late.push(result);
      return result;
    });
    await page.evaluate(() => {
      const session = window.__atlasFixture?.session?.booted?.session as
        | {
            wipe: {
              ports: {
                coordination: { liveDigest(account: string): Promise<string> };
              };
            };
          }
        | undefined;
      if (!session) throw new Error("no session");
      const coordination = session.wipe.ports.coordination;
      const read = coordination.liveDigest.bind(coordination);
      coordination.liveDigest = async (account) => {
        const value = await read(account);
        await (
          window as unknown as { reviewLateSave(): Promise<string> }
        ).reviewLateSave();
        return value;
      };
    });
    const started = await logout(page);
    expect(started?.kind).toBe("started");
    await waitGone(page, A);
    recordEvidence(info, "closing-control", { late });
    expect(late).toEqual(["refused"]);
  });
});
