import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";
import {
  ACCOUNTS,
  challengeFor,
  expect,
  exposeSession,
  freshVerifier,
  ORIGIN,
  proxy,
  raw,
  rawSignIn as rawSignInUnpaced,
  records,
  signIn as signInUnpaced,
  test,
  untilRecord,
  untilView,
  type Who,
} from "./helpers";

/**
 * WEB-08c, Layer 4, R5 of the review of 11 October 2026: the composed RESTART journeys the plan named I-L8 and I-L11, against the RELEASED
 * backend (the pinned release, SHA-256 verified by the runner) on a disposable SQLite database, behind the delaying proxy, in a real engine,
 * with the PRODUCTION boot composition and the PRODUCTION sync leader on the session harness page (`?leader=production`).
 *
 * Each case seeds the account's REAL local data first: its database (made by the production leader's first snapshot; the rail's verified
 * label is read from it) and an unsent draft (a `form_recovery` row, saved through the data harness on the same page registry). Then an
 * uncertain logout or retirement, then EVERY PAGE OF THE BROWSER IS CLOSED, then a new page opens. What the matrix decides is asserted on
 * the wire (the identical keyed call), in the durable record and in the browser's own database list (wiped or kept, the draft with it).
 *
 *   I-L8  T18 A–D (logout), T19 P, Q1/Q2, Q3 and S3/S4 (self-retirement), T9 (both orders), T10 (the same-device retry);
 *   I-L11 trace 7 of the delivery slices: the consent-digest recheck's mismatch branch, the initiator crashing BEFORE and AFTER the durable
 *         `awaiting_consent` write, answered "Delete them" and "Keep for now", and no later takeover resurrecting a kept deletion.
 *
 * What a browser cannot reach is reconciled to the fake world in `docs/lifecycle-evidence.md` (T10's different-device branch and T19 S7: any
 * re-authentication in this browser adds a session to its own device; S1, S2, S6, S8: a subscription, a native handoff, retention cleanup and
 * a session expiry are not driven through this API in a test run). Anything the proxy injects is PROXY-INJECTED; a crash is the page being
 * closed with a named, test-only IndexedDB fault (no product hook). It closes NO backend gate (BE-Q19, BE-Q11-B7, BE-CH2), and it is not
 * PostgreSQL, HTTPS, real Safari, a device or assistive technology.
 */
const LOGOUT_PATH = "/^\\/api\\/experimental\\/v1\\/sessions\\/[^/]+$/";
const RETIRE_PATH = "/^\\/api\\/experimental\\/v1\\/devices\\/[^/]+$/";

// The released backend allows 10 password attempts per account per minute: the same paced ledger as the other specs, keyed by stack.
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
const rawSignIn = async (who: Who, deviceId?: string) => {
  await budget(who);
  return rawSignInUnpaced(who, deviceId);
};

test.beforeEach(async ({ context }, info) => {
  void context;
  info.setTimeout(180_000);
});

const name = (who: Who) => ACCOUNTS[who].username;

/**
 * Whether the account's name was EVER in the document of a page of this context since it loaded (checked on every mutation): the
 * "never rendered" assertion across a restart, not a sample.
 */
async function watchName(context: BrowserContext, value: string) {
  await context.addInitScript((needle) => {
    const w = window as unknown as { __seen?: boolean };
    w.__seen = false;
    const look = () => {
      if ((document.documentElement?.textContent ?? "").includes(needle))
        w.__seen = true;
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, value);
}
const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen?: boolean }).__seen);

/** The harness page with the PRODUCTION leader, booted, `window.__s` exposed. */
async function leaderPage(context: BrowserContext, route = "/today") {
  const page = await context.newPage();
  await page.goto(
    `/__session?route=${encodeURIComponent(route)}&leader=production`,
  );
  await exposeSession(page);
  return page;
}
async function railShows(page: Page, who: Who, timeout = 30_000) {
  await expect(
    page.locator("#protected-root:not([inert])").getByRole("button", {
      name: `${name(who)}, switch account`,
    }),
  ).toBeVisible({ timeout });
}
const identity = (page: Page) =>
  page.evaluate(
    () =>
      window.__s.identity.get() as {
        account_id: string;
        epoch: number;
        session_id: string;
      } | null,
  );
async function signedIn(page: Page, who: Who) {
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  const id = await identity(page);
  if (!id) throw new Error("no identity after sign-in");
  await railShows(page, who);
  return id;
}
/** Sign in again until it settles (a NOT_SENT or a busy lock while the recovery runs is retried, as a person would). */
async function signInAgain(page: Page, who: Who) {
  await expect
    .poll(async () => (await signIn(page, who)).kind, { timeout: 60_000 })
    .toBe("settled");
}

/** The browser's database names, and whether the account has one. */
const databaseNames = (page: Page) =>
  page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? ""),
  );
const hasDatabase = async (page: Page, account: string) =>
  (await databaseNames(page)).some((n) => n.includes(account));
/** The rows of a store of the account's database, read directly (never creating one); [] when the database does not exist. */
const rowsOf = (page: Page, account: string, store: string) =>
  page.evaluate(
    async ({ acct, storeName }) => {
      const found = (await indexedDB.databases()).find((d) =>
        (d.name ?? "").includes(acct),
      );
      if (!found?.name) return [];
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(found.name as string);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        if (!db.objectStoreNames.contains(storeName)) return [];
        return await new Promise<unknown[]>((resolve, reject) => {
          const request = db
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    { acct: account, storeName: store },
  );

/** An unsent draft of the account (an unfinished form), saved on the page's own registry; its marker is returned. */
async function seedDraft(page: Page, account: string, marker: string) {
  await page.evaluate(
    async ({ acct, text }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct);
      await data.put(acct, "form_recovery", [
        {
          form_context: `i-l8-${text}`,
          tab_instance_id: "tab",
          fields: { title: text },
          redacted: [],
          saved_at: new Date().toISOString(),
          capture_seq: 1,
          terminal: false,
          content_digest: `digest-${text}`,
        },
      ]);
    },
    { acct: account, text: marker },
  );
  await expect
    .poll(async () =>
      JSON.stringify(await rowsOf(page, account, "form_recovery")),
    )
    .toContain(marker);
}

/** The account's real local data: its database (the leader's snapshot; the rail's verified label comes from it) and a draft. */
async function seededAccount(page: Page, who: Who, draft: string) {
  const id = await signedIn(page, who);
  await expect.poll(() => hasDatabase(page, id.account_id)).toBe(true);
  await seedDraft(page, id.account_id, draft);
  return id;
}

const logout = (page: Page) =>
  page.evaluate(async () => {
    const unsynced = await window.__s.operations.summariseLocalWork();
    if (!unsynced) throw new Error("nobody is settled");
    return (await window.__s.operations.logout({ unsynced })) as {
      kind: string;
      operation_id?: string;
    };
  });
/** The current device's row (with its state token), read as the confirmation dialog does. */
const readCurrentDevice = async (page: Page) => {
  const read = await page.evaluate(async () => {
    let last = await window.__s.operations.readDevices();
    for (let i = 0; i < 40 && !last.ok && last.error === "not_sent"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      last = await window.__s.operations.readDevices();
    }
    return last;
  });
  if (!read.ok) throw new Error(`devices read failed: ${JSON.stringify(read)}`);
  const current = read.value.devices.find((d) => d.current);
  if (!current) throw new Error("no current device");
  return current;
};
const retire = (
  page: Page,
  row: Awaited<ReturnType<typeof readCurrentDevice>>,
) =>
  page.evaluate(async (r) => {
    const unsynced = await window.__s.operations.summariseLocalWork();
    if (!unsynced) throw new Error("nobody is settled");
    return (await window.__s.operations.retireThisDevice({
      read: r,
      unsynced,
    })) as { kind: string; operation_id?: string };
  }, row);

const operationFence = async (page: Page) =>
  Object.values((await records(page)).auth_state.fences)
    .flat()
    .find((f) => f.kind === "operation") as
    | { kind: string; operation_id?: string; envelope?: unknown }
    | undefined;

/** Every request a page makes to a path, with its idempotency key and what the browser was answered. */
function keyedCalls(page: Page, method: string, pattern: RegExp) {
  const seenCalls: Array<{
    path: string;
    key: string | undefined;
    status: number | null;
  }> = [];
  page.on("requestfinished", async (request: Request) => {
    const url = new URL(request.url());
    if (request.method() !== method || !pattern.test(url.pathname)) return;
    const response = await request.response();
    seenCalls.push({
      path: url.pathname,
      key: (await request.allHeaders())["idempotency-key"],
      status: response?.status() ?? null,
    });
  });
  return seenCalls;
}

/** Every page of the browser closes (the person closes every tab); nothing of this browser is left running. */
async function closeEveryPage(context: BrowserContext) {
  for (const page of context.pages()) await page.close();
}

/** The backend's own answer for a session: does it still exist? (Read through a separate raw session of the same account.) */
async function sessionAlive(who: Who, sessionId: string) {
  const probe = await rawSignIn(who);
  const listed = await raw("GET", "/sessions", {
    cookie: probe.cookie,
    headers: { "x-csrf-token": probe.csrf },
  });
  const alive = (
    listed.json as { sessions: Array<{ id: string }> }
  ).sessions.some((s) => s.id === sessionId);
  await raw("DELETE", `/sessions/${probe.sessionId}`, {
    cookie: probe.cookie,
    headers: { "x-csrf-token": probe.csrf },
  });
  return alive;
}

/** A sign-in exchange for `who` on `deviceId` whose grant is NOT redeemed; the verifier is kept so the grant itself can be redeemed later. */
async function issueGrant(who: Who, deviceId: string) {
  await budget(who);
  const verifier = freshVerifier();
  const exchanged = await raw("POST", "/browser-sessions", {
    body: {
      username: ACCOUNTS[who].username,
      password: ACCOUNTS[who].password,
      device_id: deviceId,
      attempt_challenge: await challengeFor(verifier),
    },
  });
  expect(exchanged.status).toBe(200);
  const grant = (exchanged.json as { grant?: string }).grant ?? "";
  expect(grant).not.toBe("");
  return { grant, verifier };
}

/** `POST /browser-sessions/activate` with exactly this grant and verifier, then `current()` with the cookie it set (if any). */
async function activateGrant(issued: { grant: string; verifier: string }) {
  const activated = await raw("POST", "/browser-sessions/activate", {
    body: { grant: issued.grant, verifier: issued.verifier },
  });
  const [pair] = (activated.setCookie[0] ?? "").split(";");
  const cookie = activated.status === 200 ? (pair ?? "") : "";
  if (cookie === "")
    return { status: activated.status, cookie, sessionId: "", current: null };
  const current = await raw("GET", "/browser-sessions/current", {
    cookie,
    headers: { "x-atlas-session": "1" },
  });
  const body = current.json as { session_id?: string } | null;
  return {
    status: activated.status,
    cookie,
    sessionId: body?.session_id ?? "",
    current: current.json,
  };
}

// ---- I-L8: T18 logout, every page closed --------------------------------------------------------------------------------------------

test.describe("I-L8: T18 logout with every page closed, recovered from the envelope (rendered data and a draft)", () => {
  test("I-L8 T18 A: the DELETE never reached the server (PROXY-INJECTED: held, never forwarded); every page closed; the reopened page sends the IDENTICAL keyed call with the still-valid session: confirmed_applied wipes the database and the draft, then signs out; the account is never rendered", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "alice", "t18a-draft");
    const hold = await proxy.addRule({
      method: "DELETE",
      path: LOGOUT_PATH,
      action: "hold_request",
      ordinal: 1,
    });
    const started = await logout(page);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    expect((await operationFence(page))?.kind).toBe("operation");
    await closeEveryPage(context);
    await proxy.removeRule(hold.id); // the held request is never forwarded: it never reached the server
    expect(await sessionAlive("alice", x.session_id)).toBe(true);

    await watchName(context, name("alice"));
    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/sessions\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "signed_out", undefined, 60_000);
    expect(calls.map((c) => c.key)).toContain(started.operation_id);
    expect(calls.find((c) => c.key === started.operation_id)?.path).toContain(
      `/sessions/${x.session_id}`,
    );
    expect(await hasDatabase(reopened, x.account_id)).toBe(false);
    expect((await records(reopened)).pending_deletions).toEqual({});
    expect((await records(reopened)).auth_state.settled).toBeNull();
    expect(await seen(reopened)).toBe(false);
    expect(await sessionAlive("alice", x.session_id)).toBe(false);
  });

  test("I-L8 T18 B: the DELETE never reached the server and the session was then revoked elsewhere; every page closed; reopened: 401 says nothing about OP1, the person signs in again, the identical call answers superseded: NO wipe (the database and the draft stay), the new session is kept and the account is displayed again", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "bob", "t18b-draft");
    const hold = await proxy.addRule({
      method: "DELETE",
      path: LOGOUT_PATH,
      action: "hold_request",
      ordinal: 1,
    });
    const started = await logout(page);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    await closeEveryPage(context);
    await proxy.removeRule(hold.id);
    // S1 is removed by ANOTHER route (a fresh key): the ledger has no row for OP1.
    const other = await rawSignIn("bob");
    const removed = await raw("DELETE", `/sessions/${x.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    expect([200, 204]).toContain(removed.status);

    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/sessions\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "neutral", "1a.confirming", 60_000);
    await signInAgain(reopened, "bob");
    await untilRecord(
      reopened,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the operation fence resolves",
    );
    const identical = calls.filter((c) => c.key === started.operation_id);
    expect(identical.length).toBeGreaterThanOrEqual(1);
    expect(
      identical.every((c) => c.path.endsWith(`/sessions/${x.session_id}`)),
    ).toBe(true);
    expect((await records(reopened)).pending_deletions).toEqual({});
    // superseded: nothing was wiped.
    expect(await hasDatabase(reopened, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).toContain("t18b-draft");
    await untilView(reopened, "displaying", undefined, 60_000);
    await railShows(reopened, "bob");
    const now = await identity(reopened);
    expect(now?.epoch).toBeGreaterThan(x.epoch);
  });

  test("I-L8 T18 C: committed, the response lost (PROXY-INJECTED: dropped after forwarding), the cookie dead; every page closed; reopened: the person signs in again, the identical call under the NEW session replays confirmed_applied: the database and the draft are wiped, the new session is kept and a FRESH database is made", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "carol", "t18c-draft");
    const drop = await proxy.addRule({
      method: "DELETE",
      path: LOGOUT_PATH,
      action: "drop_after_forward",
      ordinal: 1,
    });
    const started = await logout(page);
    expect(started.kind).toBe("started");
    await expect
      .poll(async () =>
        (await proxy.log()).some(
          (e) => e.rule === drop.id && e.status !== undefined,
        ),
      )
      .toBe(true);
    await closeEveryPage(context);
    await proxy.removeRule(drop.id);
    expect(await sessionAlive("carol", x.session_id)).toBe(false);

    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/sessions\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "neutral", "1a.confirming", 60_000);
    await signInAgain(reopened, "carol");
    await untilRecord(
      reopened,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the operation resolves after the re-authentication",
    );
    const replay = calls.find((c) => c.key === started.operation_id);
    expect(replay?.path).toContain(`/sessions/${x.session_id}`);
    expect(replay?.status).toBe(200);
    expect((await records(reopened)).pending_deletions).toEqual({});
    const kept = (await records(reopened)).auth_state.settled;
    expect(kept?.epoch).toBeGreaterThan(x.epoch);
    await untilView(reopened, "displaying", undefined, 60_000);
    await railShows(reopened, "carol");
    // The old draft is gone with the old database; the database now is a FRESH one.
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).not.toContain("t18c-draft");
    expect(await sessionAlive("carol", kept?.session_id ?? "")).toBe(true);
  });

  test("I-L8 T18 D: as C, but ANOTHER account signs in when the person returns: it renders; X's fence, database and draft are untouched and nothing is sent under the other account's credentials; then X signs in and C's path wipes X", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "dave", "t18d-draft");
    const drop = await proxy.addRule({
      method: "DELETE",
      path: LOGOUT_PATH,
      action: "drop_after_forward",
      ordinal: 1,
    });
    const started = await logout(page);
    expect(started.kind).toBe("started");
    await expect
      .poll(async () =>
        (await proxy.log()).some(
          (e) => e.rule === drop.id && e.status !== undefined,
        ),
      )
      .toBe(true);
    await closeEveryPage(context);
    await proxy.removeRule(drop.id);

    await watchName(context, name("dave"));
    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/sessions\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "neutral", "1a.confirming", 60_000);
    // The person signs in as Y instead.
    await signInAgain(reopened, "erin");
    await untilView(reopened, "displaying", undefined, 60_000);
    await railShows(reopened, "erin");
    await reopened.waitForTimeout(2_000);
    expect(calls, "nothing is sent under Y's credentials").toEqual([]);
    expect((await operationFence(reopened))?.kind).toBe("operation");
    expect(await hasDatabase(reopened, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).toContain("t18d-draft");
    expect(await seen(reopened), "X is never rendered").toBe(false);
    // X signs in: C's path.
    await signInAgain(reopened, "dave");
    await untilRecord(
      reopened,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "X's operation resolves only now",
    );
    expect(calls.find((c) => c.key === started.operation_id)?.status).toBe(200);
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).not.toContain("t18d-draft");
  });
});

// ---- I-L8: T19 self-retirement, every page closed -----------------------------------------------------------------------------------

test.describe("I-L8: T19 self-retirement with every page closed (rendered data and a draft)", () => {
  test("I-L8 T19 P1–P4: applied, the response lost (PROXY-INJECTED), every page closed; reopened: 401, the person signs in again on this device, the identical call replays confirmed_applied from the ledger: the old database and draft are wiped, the recovery session is kept", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "frank", "t19p-draft");
    const row = await readCurrentDevice(page);
    const drop = await proxy.addRule({
      method: "DELETE",
      path: RETIRE_PATH,
      action: "drop_after_forward",
      ordinal: 1,
    });
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await expect
      .poll(async () =>
        (await proxy.log()).some(
          (e) => e.rule === drop.id && e.status !== undefined,
        ),
      )
      .toBe(true);
    await closeEveryPage(context);
    await proxy.removeRule(drop.id);

    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/devices\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "neutral", "1a.confirming", 60_000);
    await signInAgain(reopened, "frank");
    await untilRecord(
      reopened,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the retirement resolves",
    );
    const replay = calls.find((c) => c.key === started.operation_id);
    expect(replay?.status).toBe(200);
    expect((await records(reopened)).pending_deletions).toEqual({});
    const kept = (await records(reopened)).auth_state.settled;
    expect(kept?.epoch).toBeGreaterThan(x.epoch);
    await untilView(reopened, "displaying", undefined, 60_000);
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).not.toContain("t19p-draft");
    expect(await sessionAlive("frank", kept?.session_id ?? "")).toBe(true);
  });

  test("I-L8 T19 Q1/Q2: not processed (PROXY-INJECTED: held, never forwarded), the cookie still valid, every page closed; reopened: the identical call at once with the existing session: applied, the database and draft wiped, signed out; no re-authentication was needed", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "grace", "t19q-draft");
    const row = await readCurrentDevice(page);
    const hold = await proxy.addRule({
      method: "DELETE",
      path: RETIRE_PATH,
      action: "hold_request",
      ordinal: 1,
    });
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    await closeEveryPage(context);
    await proxy.removeRule(hold.id);

    await watchName(context, name("grace"));
    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/devices\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "signed_out", undefined, 60_000);
    expect(calls.find((c) => c.key === started.operation_id)?.status).toBe(200);
    expect(await hasDatabase(reopened, x.account_id)).toBe(false);
    expect((await records(reopened)).pending_deletions).toEqual({});
    expect(await seen(reopened)).toBe(false);
  });

  test("I-L8 T19 Q3 (and T10's same-device retry): not processed, the session then revoked; every page closed; reopened: the person re-authenticates on this device, which changes its state: the identical call is rejected_stale (409), the recovery session is NEVER deleted, nothing is wiped (database and draft stay), 'This device changed after you confirmed'", async ({
    context,
    provokes,
  }) => {
    provokes(401, 409);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "heidi", "t19q3-draft");
    const row = await readCurrentDevice(page);
    const hold = await proxy.addRule({
      method: "DELETE",
      path: RETIRE_PATH,
      action: "hold_request",
      ordinal: 1,
    });
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    await closeEveryPage(context);
    await proxy.removeRule(hold.id);
    const other = await rawSignIn("heidi");
    await raw("DELETE", `/sessions/${x.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });

    const reopened = await context.newPage();
    const calls = keyedCalls(reopened, "DELETE", /\/devices\/[^/]+$/);
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await untilView(reopened, "neutral", "1a.confirming", 60_000);
    await signInAgain(reopened, "heidi");
    await untilView(reopened, "neutral", "1a.device_changed", 60_000);
    const identical = calls.filter((c) => c.key === started.operation_id);
    expect(identical).toHaveLength(1); // rejected_stale is never retried
    expect(identical[0]?.status).toBe(409);
    expect((await records(reopened)).pending_deletions).toEqual({});
    const kept = (await records(reopened)).auth_state.settled;
    expect(kept?.epoch).toBeGreaterThan(x.epoch);
    expect(await sessionAlive("heidi", kept?.session_id ?? "")).toBe(true);
    expect(await hasDatabase(reopened, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(reopened, x.account_id, "form_recovery")),
    ).toContain("t19q3-draft");
  });

  // WEB-08c revision 2 (R5 of the review of 11 October 2026; design assessment Q-S3/Q-S4): revision 1 ran S3 and S4 as one loop, checked only
  // that the captured grant STRING was non-empty (it would pass if the rejected retirement had cancelled the grant) and made S4 a fresh
  // exchange instead of redeeming the grant it had issued. Each variant now has its own fresh baseline; the verifier is kept, and the issued
  // grant itself is redeemed: after the rejection (S3) or before it (S4). The cancelled-grant control shows the redemption oracle detects a
  // destroyed grant.
  test("I-L8 T19 S3: a grant G1 for this device issued after the read, NOT redeemed, then the retirement: rejected_stale, nothing deleted, and G1 (with its own verifier) still activates a session that current() identifies", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "ivan", "t19s3-draft");
    const deviceId = (await records(page)).device?.device_id ?? "";
    const row = await readCurrentDevice(page);
    const g1 = await issueGrant("ivan", deviceId);
    const calls = keyedCalls(page, "DELETE", /\/devices\/[^/]+$/);
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await untilView(page, "neutral", "1a.device_changed", 60_000);
    const keyed = calls.filter((c) => c.key === started.operation_id);
    expect(keyed).toHaveLength(1); // rejected_stale is never retried with a fresh token
    expect(keyed[0]?.status).toBe(409);
    expect(await hasDatabase(page, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(page, x.account_id, "form_recovery")),
    ).toContain("t19s3-draft");
    expect(await sessionAlive("ivan", x.session_id)).toBe(true);
    // G1 survived: exactly G1 with V1 activates, and the new session is identified by current().
    const redeemed = await activateGrant(g1);
    expect(redeemed.status).toBe(200);
    expect(redeemed.current).toMatchObject({
      account_id: x.account_id,
      session_id: redeemed.sessionId,
    });
    await page
      .getByRole("button", { name: "Review this device" })
      .click()
      .catch(() => undefined);
    await untilView(page, "displaying", undefined, 60_000);
  });

  test("I-L8 T19 S4: the grant G1 issued for this device after the read is REDEEMED (session S) before the retirement is processed: rejected_stale, nothing deleted, no fresh-token retry, and S still works afterwards", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "ivan", "t19s4-draft");
    const deviceId = (await records(page)).device?.device_id ?? "";
    const row = await readCurrentDevice(page);
    const g1 = await issueGrant("ivan", deviceId);
    const redeemed = await activateGrant(g1);
    expect(redeemed.status).toBe(200);
    const calls = keyedCalls(page, "DELETE", /\/devices\/[^/]+$/);
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await untilView(page, "neutral", "1a.device_changed", 60_000);
    const keyed = calls.filter((c) => c.key === started.operation_id);
    expect(keyed).toHaveLength(1);
    expect(keyed[0]?.status).toBe(409);
    expect(await hasDatabase(page, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(page, x.account_id, "form_recovery")),
    ).toContain("t19s4-draft");
    // The session made from G1 is still usable after the rejection.
    const after = await raw("GET", "/browser-sessions/current", {
      cookie: redeemed.cookie,
      headers: { "x-atlas-session": "1" },
    });
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({
      account_id: x.account_id,
      session_id: redeemed.sessionId,
    });
    expect(await sessionAlive("ivan", x.session_id)).toBe(true);
    await page
      .getByRole("button", { name: "Review this device" })
      .click()
      .catch(() => undefined);
    await untilView(page, "displaying", undefined, 60_000);
  });

  test("I-L8 T19 S3/S4 controls: an issued grant activates at once (healthy); a grant whose attempt was CANCELLED with its verifier is refused (the S3 redemption oracle detects a destroyed grant)", async () => {
    const healthy = await activateGrant(
      await issueGrant("ivan", `raw-${freshVerifier().slice(0, 10)}`),
    );
    expect(healthy.status).toBe(200);
    const doomed = await issueGrant(
      "ivan",
      `raw-${freshVerifier().slice(0, 10)}`,
    );
    const cancelled = await raw("POST", "/browser-sessions/activate/cancel", {
      body: { verifier: doomed.verifier },
    });
    expect(cancelled.status).toBe(200);
    const refused = await activateGrant(doomed);
    expect(refused.status).not.toBe(200);
    expect(refused.cookie).toBe("");
  });
});

// ---- I-L8: T9 and T10 -----------------------------------------------------------------------------------------------------------------

test.describe("I-L8: T9, a newer sign-in on the same device while the retirement is delayed", () => {
  test("I-L8 T9 (processed AFTER the newer session exists): the held DELETE reaches the backend after another page signed in on this device: rejected_stale (409), nothing deleted, 'This device changed'; the newer session is untouched", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "judy", "t9a-draft");
    const row = await readCurrentDevice(page);
    const hold = await proxy.addRule({
      method: "DELETE",
      path: RETIRE_PATH,
      action: "hold_request",
      ordinal: 1,
    });
    const calls = keyedCalls(page, "DELETE", /\/devices\/[^/]+$/);
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    // Tab B signs in on this device (a new session) before the request is processed.
    const tabB = await leaderPage(context);
    await signInAgain(tabB, "judy");
    const b = (await records(tabB)).auth_state.settled;
    expect(b?.epoch).toBeGreaterThan(x.epoch);
    await proxy.release(hold.id);
    await proxy.removeRule(hold.id);
    await untilView(page, "neutral", "1a.device_changed", 60_000);
    expect(calls.find((c) => c.key === started.operation_id)?.status).toBe(409);
    expect(await sessionAlive("judy", b?.session_id ?? "")).toBe(true);
    expect(await hasDatabase(page, x.account_id)).toBe(true);
    expect(
      JSON.stringify(await rowsOf(page, x.account_id, "form_recovery")),
    ).toContain("t9a-draft");
  });

  test("I-L8 T9 (processed BEFORE the newer session; its answer held until after it settles): the late answer sets no cookie; the retired account's old data is wiped; the newer settlement is kept, its session alive, and a fresh database follows", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    const x = await seededAccount(page, "kate", "t9b-draft");
    const row = await readCurrentDevice(page);
    const hold = await proxy.addRule({
      method: "DELETE",
      path: RETIRE_PATH,
      action: "hold",
      ordinal: 1,
    });
    const started = await retire(page, row);
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    // The delete committed (its answer is held). Tab B signs in on this device afterwards: a new incarnation of the device.
    const tabB = await leaderPage(context);
    await signInAgain(tabB, "kate");
    const b = (await records(tabB)).auth_state.settled;
    expect(b?.epoch).toBeGreaterThan(x.epoch);
    await proxy.release(hold.id);
    await proxy.removeRule(hold.id);
    await untilRecord(
      tabB,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the operation's consequence is applied",
    );
    expect((await records(tabB)).pending_deletions).toEqual({});
    expect((await records(tabB)).auth_state.settled?.epoch).toBe(b?.epoch);
    expect(await sessionAlive("kate", b?.session_id ?? "")).toBe(true);
    await untilView(tabB, "displaying", undefined, 60_000);
    expect(
      JSON.stringify(await rowsOf(tabB, x.account_id, "form_recovery")),
    ).not.toContain("t9b-draft");
  });
});

// ---- I-L11: trace 7, the consent recheck's mismatch branch with an initiator crash either side of `awaiting_consent` ---------------

/**
 * TEST-ONLY fault, named and scoped (as I-L10's): while `window.__failConsentWrite` is true, the `atlas-auth` write that would record
 * `awaiting_consent` is aborted inside its transaction, so nothing of it commits; every other write is untouched. No product hook exists.
 */
async function consentWriteFault(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __failConsentWrite?: boolean;
      __consentWritesFailed?: number;
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (
        w.__failConsentWrite &&
        this.transaction.db.name === "atlas-auth" &&
        JSON.stringify(args[0]).includes('"awaiting_consent"')
      ) {
        w.__consentWritesFailed = (w.__consentWritesFailed ?? 0) + 1;
        this.transaction.abort();
        throw new DOMException(
          "injected: the awaiting_consent write fails",
          "AbortError",
        );
      }
      return put.apply(this, args);
    } as typeof put;
  });
}
const ledgerStatus = async (page: Page, account: string) =>
  (
    (await records(page)).pending_deletions as Record<
      string,
      { status: string }
    >
  )[account]?.status;
const chooseConsent = (page: Page, choice: "delete" | "keep") =>
  page.evaluate(async (c) => {
    const current = window.__s.view.get() as { consent?: { ticket: string } };
    if (!current.consent) throw new Error("no consent prompt is showing");
    return window.__s.wipe.resolveConsent(current.consent.ticket as never, c);
  }, choice);

for (const crash of ["before", "after"] as const)
  for (const answer of ["delete", "keep"] as const)
    test(`I-L11 trace 7: a second page's input arrives during the logout; the initiator crashes ${crash.toUpperCase()} the durable awaiting_consent write; the restart neither deletes nor renders, asks again, and '${answer === "delete" ? "Delete them" : "Keep for now"}' ${answer === "delete" ? "completes the canonical deletion through approved_digest (no loop)" : "keeps the database, and a later restart does not resurrect the deletion"}`, async ({
      context,
      provokes,
    }) => {
      provokes(401);
      await consentWriteFault(context);
      const who: Who =
        crash === "before"
          ? answer === "delete"
            ? "liam"
            : "mia"
          : answer === "delete"
            ? "nora"
            : "olga";
      const page = await leaderPage(context);
      const x = await seededAccount(page, who, `trace7-${crash}-${answer}`);
      const second = await leaderPage(context);
      await railShows(second, who);
      const hold = await proxy.addRule({
        method: "DELETE",
        path: LOGOUT_PATH,
        action: "hold",
        ordinal: 1,
      });
      const started = await logout(page);
      expect(started.kind).toBe("started");
      await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
      // The second page's captured input: work saved after the person confirmed (the digest no longer matches).
      await seedDraft(second, x.account_id, `trace7-late-${crash}-${answer}`);
      if (crash === "before")
        for (const p of context.pages())
          await p.evaluate(() => {
            (
              window as unknown as { __failConsentWrite: boolean }
            ).__failConsentWrite = true;
          });
      await proxy.release(hold.id);
      await proxy.removeRule(hold.id);
      if (crash === "before")
        await expect
          .poll(() =>
            Promise.all(
              context
                .pages()
                .map((p) =>
                  p.evaluate(
                    () =>
                      (window as unknown as { __consentWritesFailed?: number })
                        .__consentWritesFailed ?? 0,
                  ),
                ),
            ).then((counts) => counts.reduce((a, b) => a + b, 0)),
          )
          .toBeGreaterThanOrEqual(1);
      else
        await expect
          .poll(() => ledgerStatus(page, x.account_id), { timeout: 30_000 })
          .toBe("awaiting_consent");
      // The initiator (and every other page) is gone.
      await closeEveryPage(context);

      await watchName(context, name(who));
      const reopened = await leaderPage(context);
      if (crash === "before") {
        // Only the envelope survived the crash, and the backend already deleted the session: the page repeats the recovery order (1a, a
        // fresh sign-in, the identical call replays confirmed_applied), and only then re-checks the digest. Nothing is deleted or
        // rendered meanwhile.
        await untilView(reopened, "neutral", "1a.confirming", 60_000);
        expect(await hasDatabase(reopened, x.account_id)).toBe(true);
        expect(await seen(reopened)).toBe(false);
        // The outcome was recorded before the crash (`pending_deletions` is `pending`); the person's fresh sign-in runs the canonical
        // procedure FIRST (EC-42), which re-checks the digest, records `awaiting_consent` and asks; the attempt itself does not start.
        expect(await ledgerStatus(reopened, x.account_id)).toBe("pending");
        await budget(who);
        expect((await signInUnpaced(reopened, who)).kind).toBe("not_started");
      }
      await untilView(reopened, "neutral", "wipe.consent", 60_000);
      expect(await ledgerStatus(reopened, x.account_id)).toBe(
        "awaiting_consent",
      );
      expect(
        await hasDatabase(reopened, x.account_id),
        "nothing deleted yet",
      ).toBe(true);
      expect(await seen(reopened), "nothing protected rendered").toBe(false);
      await chooseConsent(reopened, answer);
      if (answer === "delete") {
        await expect
          .poll(() => hasDatabase(reopened, x.account_id))
          .toBe(false);
        await expect
          .poll(async () => (await records(reopened)).pending_deletions)
          .toEqual({});
        if (crash === "after")
          await untilView(reopened, "signed_out", undefined, 60_000);
        else {
          // The envelope is resolved by the recovery order: the person signs in, the identical call replays confirmed_applied, and there
          // is nothing left to delete; a FRESH database follows, without the deleted draft.
          await signInAgain(reopened, who);
          await untilRecord(
            reopened,
            (st) =>
              Object.values(st.fences)
                .flat()
                .every((f) => f.kind !== "operation"),
            "the envelope resolves",
          );
          await untilView(reopened, "displaying", undefined, 60_000);
          expect(
            JSON.stringify(
              await rowsOf(reopened, x.account_id, "form_recovery"),
            ),
          ).not.toContain(`trace7-late-${crash}-${answer}`);
        }
      } else {
        await expect
          .poll(async () => (await records(reopened)).pending_deletions)
          .toEqual({});
        expect(await hasDatabase(reopened, x.account_id)).toBe(true);
        // A later restart does not take the stale intent over and delete.
        await closeEveryPage(context);
        const again = await leaderPage(context);
        await again.waitForTimeout(2_000);
        expect((await records(again)).pending_deletions).toEqual({});
        expect(await hasDatabase(again, x.account_id)).toBe(true);
        expect(
          JSON.stringify(await rowsOf(again, x.account_id, "form_recovery")),
        ).toContain(`trace7-late-${crash}-${answer}`);
      }
    });
