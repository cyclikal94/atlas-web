import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import {
  expect,
  exposeSession,
  ORIGIN,
  proxy,
  type RawSession,
  raw,
  rawSignIn as rawSignInUnpaced,
  records,
  signIn as signInUnpaced,
  test,
  untilHeld,
  untilRecord,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-09b focused ADAPTER integration: the PRODUCTION leader (`?leader=production`: the election, the engine, the dispatcher and the
 * recovery job, composed by the boot sequence) in a real engine against the RELEASED backend (v0.27.0-rc.1) on a disposable SQLite
 * database, behind the delaying proxy. No fixture seeder and no fixture leader is used. Anything the proxy injects is labelled
 * PROXY-INJECTED. This is not BE-Q19 acceptance, not WEB-08c's composed lifecycle acceptance, not PostgreSQL and not device evidence.
 *
 *   I-N1  a fresh account's first sync: the leader creates the database, stages and activates the snapshot, and a real change then
 *         arrives as an ordinary delta page on top;
 *   I-N2  a PROXY-INJECTED 410 on a delta page: the cache is hidden and a replacement snapshot is activated with the backend's own cursors;
 *   I-N3  an interrupted snapshot (review cycle 1, R9): the proxy HOLDS page 2; the page reloads; the reloaded leader ADOPTS the staged
 *         attempt and its first request carries the staged real cursor; the activation completes;
 *   I-N4  T24 A against the backend: a real revocation elsewhere, a real 401 fence, a password sign-in again, then a recovery-class
 *         catch-up while hidden, `finish`, and the account displayed again;
 *   I-N5  T24 B (review cycle 1, R9): the same, with a PROXY-INJECTED 410 on the first recovery page: a replacement snapshot is built
 *         and activated while the account stays hidden, and only then does `finish` clear the fence;
 *   I-N6  two pages: only the leader's page reads `/sync`; when it closes the other page leads and the next real change arrives there.
 */
const API = "/api/experimental/v1";

// The released backend throttles password sign-ins (10 per account per minute): the same paced ledger as the data specs, keyed by stack.
const LEDGER = join(
  tmpdir(),
  `atlas-signin-ledger-${new URL(ORIGIN || "http://x").port}.json`,
);
async function budget(who: Who): Promise<void> {
  for (;;) {
    let all: Record<string, number[]> = {};
    try {
      all = JSON.parse(readFileSync(LEDGER, "utf8")) as Record<
        string,
        number[]
      >;
    } catch {
      all = {};
    }
    const now = Date.now();
    const recent = (all[who] ?? []).filter((t) => now - t < 60_000);
    if (recent.length < 8) {
      all[who] = [...recent, now];
      writeFileSync(LEDGER, JSON.stringify(all));
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, 60_000 - (now - (recent[0] ?? now)) + 250),
    );
  }
}
const signIn = async (page: Page, who: Who) => {
  await budget(who);
  return signInUnpaced(page, who);
};
const rawSignIn = async (who: Who) => {
  await budget(who);
  return rawSignInUnpaced(who);
};
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = join(
  tmpdir(),
  `atlas-snapshot-rotation-${new URL(ORIGIN || "http://x").port}.txt`,
);
let main: Who = "alice";
test.beforeEach(async ({ context }, info) => {
  void context;
  let n = 0;
  try {
    n = Number(readFileSync(ROTATION_FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(ROTATION_FILE, String(n + 1));
  main = ROTATION[n % ROTATION.length] as Who;
  info.setTimeout(120_000);
});

/** A session harness page with the PRODUCTION leader, booted, the session exposed as `window.__s`. */
async function leaderPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__session?route=%2Ftoday&leader=production");
  await exposeSession(page);
  await page.waitForFunction(() => window.__atlasData !== undefined);
  return page;
}
const identity = (page: Page) =>
  page.evaluate(
    () =>
      window.__s.identity.get() as { account_id: string; epoch: number } | null,
  );
async function signedIn(page: Page, who: Who) {
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = await identity(page);
  if (!id) throw new Error("no identity after sign-in");
  return id;
}
/** The harness's own READ handle (it never creates): rows of the account's database, or [] while there is none. */
const rowsOf = (page: Page, account: string, store: string) =>
  page.evaluate(
    async ([a, s]) => {
      const data = window.__atlasData;
      if (!data) return [];
      if (!data.stores.has(a)) {
        data.setIdentity(a);
        const opened = await data.open(a);
        if (opened !== "opened" && opened !== "created") return [];
      }
      return data.rows(a, s as never);
    },
    [account, store] as const,
  ) as Promise<Array<Record<string, unknown>>>;
const syncOf = async (page: Page, account: string) =>
  (await rowsOf(page, account, "sync_state"))[0] ?? null;
const leaderOf = (page: Page) =>
  page.evaluate(() => window.__atlasFixture?.session?.leader());

interface Exchange {
  cursor: string | null;
  status: number;
  phase?: string;
  hasMore?: boolean;
  next?: string;
}
function recordSync(page: Page): Exchange[] {
  const seen: Exchange[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() !== "GET" ||
      !url.pathname.endsWith("/sync")
    )
      return;
    let body: {
      next_cursor?: string;
      has_more?: boolean;
      phase?: string;
    } | null = null;
    if (response.status() === 200) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
    seen.push({
      cursor: url.searchParams.get("cursor"),
      status: response.status(),
      ...(body?.phase ? { phase: body.phase } : {}),
      ...(body?.has_more === undefined ? {} : { hasMore: body.has_more }),
      ...(body?.next_cursor ? { next: body.next_cursor } : {}),
    });
  });
  return seen;
}
const rawCommand = (session: RawSession, commands: unknown[]) =>
  raw("POST", "/commands", {
    cookie: session.cookie,
    headers: {
      "x-csrf-token": session.csrf,
      "idempotency-key": crypto.randomUUID(),
    },
    body: { commands },
  });
async function createPeople(who: Who, count: number, label: string) {
  const other = await rawSignIn(who);
  const made = Array.from({ length: count }, (_, n) => ({
    id: crypto.randomUUID(),
    name: `${label} ${n}`,
  }));
  // One command per request: each is a batch of its own.
  for (const p of made) {
    const answered = await rawCommand(other, [
      { kind: "create_person", id: p.id, name: p.name },
    ]);
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
  }
  return made;
}
const holds = (page: Page, account: string, ids: string[]) =>
  expect
    .poll(
      async () => {
        const cache = await rowsOf(page, account, "cache");
        return ids.every((id) => cache.some((r) => r.id === id));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

test.describe("I-N: the production leader against the released backend", () => {
  test("I-N1 a fresh account's first sync: the leader creates the database, stages and activates the real snapshot, then a real change arrives as a delta page on top", async ({
    context,
  }) => {
    const before = await createPeople(main, 6, "I-N1 Person");
    const page = await leaderPage(context);
    const exchanges = recordSync(page);
    const id = await signedIn(page, main);
    await holds(
      page,
      id.account_id,
      before.map((p) => p.id),
    );
    const sync = await syncOf(page, id.account_id);
    expect(sync).toMatchObject({
      cache_status: "valid",
      phase: "delta",
      staging_position: null,
    });
    expect(await rowsOf(page, id.account_id, "cache_staging")).toEqual([]);
    // The first request was cursor-less, every snapshot page said `snapshot`, and each later page carried the previous cursor.
    const snapshot = exchanges.filter((e) => e.phase === "snapshot");
    expect(exchanges[0]?.cursor).toBeNull();
    expect(snapshot.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.at(-1)?.hasMore).toBe(false);
    for (let n = 1; n < snapshot.length; n += 1)
      expect(snapshot[n]?.cursor).toBe(snapshot[n - 1]?.next);
    expect(sync?.cursor).toBe(snapshot.at(-1)?.next);
    // A real change made elsewhere arrives through an ordinary delta page.
    const after = await createPeople(main, 1, "I-N1 Later");
    await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
    await holds(
      page,
      id.account_id,
      after.map((p) => p.id),
    );
    expect(exchanges.some((e) => e.phase === "delta")).toBe(true);
    const leader = await leaderOf(page);
    expect(leader?.role).toBe("leader");
  });

  test("I-N2 PROXY-INJECTED 410 on a delta page: the cache is invalidated and a replacement snapshot is activated with the backend's own cursors", async ({
    context,
    provokes,
  }) => {
    provokes(410);
    const page = await leaderPage(context);
    const exchanges = recordSync(page);
    const id = await signedIn(page, main);
    await expect
      .poll(async () => (await syncOf(page, id.account_id))?.cache_status, {
        timeout: 60_000,
      })
      .toBe("valid");
    const first = (await syncOf(page, id.account_id))
      ?.recovery_generation as number;
    const rule = await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      ordinal: 1,
      action: "rewrite_status",
      status: 410,
    });
    const marked = exchanges.length;
    await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
    await expect
      .poll(() => exchanges.slice(marked).some((e) => e.status === 410), {
        timeout: 30_000,
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          const s = await syncOf(page, id.account_id);
          return (
            s?.cache_status === "valid" &&
            (s?.recovery_generation as number) > first
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const later = exchanges.slice(marked);
    const restart = later.findIndex((e) => e.status === 410);
    expect(later[restart + 1]?.cursor).toBeNull();
    expect(later.slice(restart + 1).some((e) => e.phase === "snapshot")).toBe(
      true,
    );
    await proxy.removeRule(rule.id);
  });

  test("I-N3 an interrupted snapshot: the proxy HOLDS page 2; the page reloads; the reloaded leader adopts the staged attempt, its first request carries the staged real cursor, and the activation completes", async ({
    context,
  }) => {
    // Enough content for several snapshot pages at the initial page limit.
    const people = await createPeople(main, 10, "I-N3 Person");
    const rule = await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      ordinal: 2,
      action: "hold",
    });
    const page = await leaderPage(context);
    const asked: Array<string | null> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname.endsWith("/sync"))
        asked.push(url.searchParams.get("cursor"));
    });
    const id = await signedIn(page, main);
    await untilHeld(rule.id ?? "", 1);
    const staged = await syncOf(page, id.account_id);
    expect(staged?.cache_status).not.toBe("valid");
    expect(typeof staged?.staging_position).toBe("string");
    // The held request is page 2, made at the staged position (the backend's own cursor of page 1).
    expect(asked[0]).toBeNull();
    expect(asked[1]).toBe(staged?.staging_position);
    const heldCursor = asked[1];
    const generation = staged?.recovery_generation;
    // The page reloads while page 2 is held: the reloaded leader adopts (within the one-hour lifetime) and asks for that position.
    const marker = asked.length;
    await page.goto("/__session?route=%2Ftoday&leader=production");
    await exposeSession(page);
    await page.waitForFunction(() => window.__atlasData !== undefined);
    await untilView(page, "displaying", undefined, 60_000);
    await holds(
      page,
      id.account_id,
      people.map((p) => p.id),
    );
    expect(asked[marker]).toBe(heldCursor);
    const done = await syncOf(page, id.account_id);
    expect(done).toMatchObject({
      cache_status: "valid",
      phase: "delta",
      staging_position: null,
      recovery_generation: generation,
    });
    expect(await rowsOf(page, id.account_id, "cache_staging")).toEqual([]);
    await proxy.release(rule.id ?? "");
    await proxy.removeRule(rule.id ?? "");
  });

  test("I-N4 T24 A: a real revocation fences the account; after the password sign-in again a recovery-class catch-up runs while hidden, `finish` clears the fence and the account is displayed", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const exchanges = recordSync(page);
    const id = await signedIn(page, main);
    await expect
      .poll(async () => (await syncOf(page, id.account_id))?.cache_status, {
        timeout: 60_000,
      })
      .toBe("valid");
    const cursor = (await syncOf(page, id.account_id))?.cursor;
    const settled = (await records(page)).auth_state.settled;
    const revoker = await rawSignIn(main);
    const revoked = await raw("DELETE", `/sessions/${settled?.session_id}`, {
      cookie: revoker.cookie,
      headers: { "x-csrf-token": revoker.csrf },
    });
    expect([200, 204]).toContain(revoked.status);
    await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "the real 401 is recorded as an invalid_session fence",
    );
    const fencedAt = exchanges.length;
    // The person signs in again (a new epoch): the earlier epoch's entry makes the account recovery-eligible.
    expect((await signIn(page, main)).kind).toBe("settled");
    await untilView(page, "displaying", undefined, 60_000);
    const records_ = (await records(page)).auth_state;
    expect(Object.values(records_.fences).flat()).toEqual([]);
    // The fence was cleared by the recovery JOB: `begin` said eligible, a request of the RECOVERY class was issued under the new epoch,
    // `finish` answered `cleared`, and its release transaction re-evaluated the session (the kernel's and the job's own trace).
    const trace = (await page.evaluate(
      () => window.__atlasFixture?.session?.trace ?? [],
    )) as Array<{
      event: string;
      data?: {
        reason?: string;
        kind?: string;
        klass?: string;
        result?: string;
        mode?: string;
        epoch?: number;
      };
    }>;
    const at = (predicate: (e: (typeof trace)[number]) => boolean) =>
      trace.findIndex(predicate);
    const eligible = at(
      (e) => e.event === "data.recovery_begin" && e.data?.kind === "eligible",
    );
    const recoveryRead = at(
      (e) => e.event === "request.issued" && e.data?.klass === "recovery",
    );
    const cleared = at(
      (e) => e.event === "data.recovery_finish" && e.data?.result === "cleared",
    );
    const finished = at(
      (e) => e.event === "evaluate" && e.data?.reason === "recovery_finished",
    );
    expect(eligible, "begin said eligible").toBeGreaterThan(-1);
    expect(recoveryRead, "a recovery-class read followed").toBeGreaterThan(
      eligible,
    );
    expect(trace[recoveryRead]?.data?.epoch).toBe(id.epoch + 1);
    expect(cleared, "finish cleared the fence after the read").toBeGreaterThan(
      recoveryRead,
    );
    expect(finished).toBeGreaterThan(cleared);
    // No ordinary request was issued between the 401 and the clearance (the engine and dispatcher do not run while fenced).
    const fencedFrom = at(
      (e) => e.event === "evaluate" && e.data?.reason === "recorded",
    );
    expect(
      trace
        .slice(fencedFrom, cleared)
        .filter(
          (e) => e.event === "request.issued" && e.data?.klass === "ordinary",
        ),
    ).toEqual([]);
    // The recovery read from the saved cursor (no replacement snapshot), and the database was not re-created.
    const recovery = exchanges.slice(fencedAt);
    expect(recovery[0]?.cursor).toBe(cursor);
    expect(recovery.some((e) => e.phase === "snapshot")).toBe(false);
    expect((await syncOf(page, id.account_id))?.cache_status).toBe("valid");
  });

  test("I-N5 T24 B: after the re-authentication a PROXY-INJECTED 410 on the first recovery page makes a replacement snapshot that is built and activated while the account stays hidden; only then does `finish` clear the fence", async ({
    context,
    provokes,
  }) => {
    provokes(401, 410);
    const page = await leaderPage(context);
    const exchanges = recordSync(page);
    const id = await signedIn(page, main);
    await expect
      .poll(async () => (await syncOf(page, id.account_id))?.cache_status, {
        timeout: 60_000,
      })
      .toBe("valid");
    const cursor = (await syncOf(page, id.account_id))?.cursor;
    const generation = (await syncOf(page, id.account_id))
      ?.recovery_generation as number;
    const settled = (await records(page)).auth_state.settled;
    const revoker = await rawSignIn(main);
    const revoked = await raw("DELETE", `/sessions/${settled?.session_id}`, {
      cookie: revoker.cookie,
      headers: { "x-csrf-token": revoker.csrf },
    });
    expect([200, 204]).toContain(revoked.status);
    await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "the real 401 is recorded as an invalid_session fence",
    );
    // The first `/sync` after the re-authentication (the recovery's catch-up from the saved cursor) is answered 410 by the proxy.
    const rule = await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      ordinal: 1,
      action: "rewrite_status",
      status: 410,
    });
    const fencedAt = exchanges.length;
    expect((await signIn(page, main)).kind).toBe("settled");
    await untilView(page, "displaying", undefined, 60_000);
    expect(
      Object.values((await records(page)).auth_state.fences).flat(),
    ).toEqual([]);
    const recovery = exchanges.slice(fencedAt);
    expect(recovery[0]).toMatchObject({ cursor, status: 410 });
    expect(recovery[1]?.cursor).toBeNull();
    expect(recovery.slice(1).some((e) => e.phase === "snapshot")).toBe(true);
    const done = await syncOf(page, id.account_id);
    expect(done?.cache_status).toBe("valid");
    expect(done?.recovery_generation as number).toBeGreaterThan(generation);
    // Every read while fenced was of the RECOVERY class; the replacement was ACTIVATED before `finish` cleared, and the display
    // followed the release.
    const trace = (await page.evaluate(
      () => window.__atlasFixture?.session?.trace ?? [],
    )) as Array<{
      event: string;
      data?: {
        reason?: string;
        kind?: string;
        klass?: string;
        result?: string;
        value?: string;
        final?: boolean;
        epoch?: number;
      };
    }>;
    const at = (predicate: (e: (typeof trace)[number]) => boolean) =>
      trace.findIndex(predicate);
    const eligible = at(
      (e) => e.event === "data.recovery_begin" && e.data?.kind === "eligible",
    );
    // Each looked for AFTER the eligible `begin` (the account's own first activation, before the fence, precedes it).
    const following = (
      from: number,
      predicate: (e: (typeof trace)[number]) => boolean,
    ) => {
      const found = trace.slice(from + 1).findIndex(predicate);
      return found < 0 ? -1 : from + 1 + found;
    };
    const activated = following(
      eligible,
      (e) =>
        e.event === "data.recovery_commit" && e.data?.value === "activated",
    );
    const cleared = following(
      eligible,
      (e) => e.event === "data.recovery_finish" && e.data?.result === "cleared",
    );
    const finished = following(
      eligible,
      (e) => e.event === "evaluate" && e.data?.reason === "recovery_finished",
    );
    expect(eligible, "begin said eligible").toBeGreaterThan(-1);
    expect(activated, "the replacement was activated").toBeGreaterThan(
      eligible,
    );
    expect(cleared, "finish cleared after the activation").toBeGreaterThan(
      activated,
    );
    expect(finished).toBeGreaterThan(cleared);
    const reads = trace
      .slice(eligible, cleared)
      .filter((e) => e.event === "request.issued");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every((e) => e.data?.klass === "recovery")).toBe(true);
    await proxy.removeRule(rule.id ?? "");
  });

  test("I-N6 two pages: only the leader's page reads `/sync`; when it closes the other page leads and the next real change arrives there", async ({
    context,
  }) => {
    const one = await leaderPage(context);
    const id = await signedIn(one, main);
    await expect
      .poll(async () => (await syncOf(one, id.account_id))?.cache_status, {
        timeout: 60_000,
      })
      .toBe("valid");
    const two = await leaderPage(context);
    await untilView(two, "displaying", undefined, 60_000);
    const twoSync = recordSync(two);
    await expect
      .poll(async () => (await leaderOf(two))?.attachment, { timeout: 15_000 })
      .toBe("follower");
    await two.waitForTimeout(2_000);
    expect(twoSync).toEqual([]);
    await one.close();
    await expect
      .poll(async () => (await leaderOf(two))?.role, { timeout: 15_000 })
      .toBe("leader");
    const later = await createPeople(main, 1, "I-N6 Later");
    await two.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
    await holds(
      two,
      id.account_id,
      later.map((p) => p.id),
    );
    expect(twoSync.length).toBeGreaterThan(0);
  });
});
