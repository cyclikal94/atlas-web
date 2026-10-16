import type { BrowserContext, Page } from "@playwright/test";
import { installDisplayOracle } from "../e2e/display-oracle";
import {
  ACCOUNTS,
  expect,
  exposeSession,
  OIDC,
  paceSignIn,
  provider,
  proxy,
  raw,
  rawSignIn as rawSignInUnpaced,
  records,
  signIn as signInUnpaced,
  swapCookie,
  test,
  untilRecord,
  untilView,
  type Who,
} from "./helpers";
import { followNavigation } from "./web08b-support";

/**
 * WEB-08c, Layer 4: composed lifecycle journeys against the RELEASED backend (v0.27.0-rc.1, SHA-256 verified by the runner) on a disposable
 * SQLite database, behind the delaying proxy, in a real engine: the PRODUCTION boot composition on the session harness page (its protected
 * tree with WF-SWITCH-01/02, the account card, "Confirm it's you" and the neutral states), mostly with the PRODUCTION sync leader
 * (`?leader=production`). Anything the proxy injects is labelled PROXY-INJECTED. Each account's username is its marker (the rail's verified
 * label is the account-specific content a person sees; the feature screens are placeholders).
 *
 * It does NOT close the backend gates BE-Q19, BE-Q11-B7 or BE-CH2 (no completion record exists; this runs against the pinned release), and it
 * is not PostgreSQL, HTTPS, real Safari, a device or assistive-technology evidence. The module-level counterparts it builds on are cited, not
 * repeated: I-04 (T8), I-05 (credential_mismatch), I-06/I-07 (the logout and retirement ledgers), I-08 (password change), I-14 (switch and
 * return, rows 7/8), I-15 (hiding aborts a real activate), I-N4/I-N5 (T24), I-O5/I-W1/I-S1 (WEB-09a's queue, consent and late answers).
 */
const API = "/api/experimental/v1";

// The released backend allows 10 password attempts per account per minute: the same paced ledger as the other specs, keyed by stack.
const budget = (who: Who) => paceSignIn(who);
const signIn = async (page: Page, who: Who) => {
  await budget(who);
  return signInUnpaced(page, who);
};
const rawSignIn = async (who: Who) => {
  await budget(who);
  return rawSignInUnpaced(who);
};

test.beforeEach(async ({ context }, info) => {
  void context;
  info.setTimeout(150_000);
});

/** The harness page with the PRODUCTION leader, booted, `window.__s` exposed. */
async function leaderPage(context: BrowserContext, route = "/today") {
  const page = await context.newPage();
  await page.goto(
    `/__session?route=${encodeURIComponent(route)}&leader=production`,
  );
  await exposeSession(page);
  return page;
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
  return id;
}
const name = (who: Who) => ACCOUNTS[who].username;
const password = (who: Who) => ACCOUNTS[who].password;

/** The rail's control names the VERIFIED label of the displayed account; it is the account-specific content of the shell. */
async function railShows(page: Page, who: Who, timeout = 30_000) {
  await expect(
    page.locator("#protected-root:not([inert])").getByRole("button", {
      name: `${name(who)}, switch account`,
    }),
  ).toBeVisible({ timeout });
}
async function expectAbsent(page: Page, value: string) {
  const text = await page.evaluate(
    () => document.documentElement.textContent ?? "",
  );
  expect(text, "DOM text").not.toContain(value);
  expect(await page.title(), "title").not.toContain(value);
  expect(await page.locator("body").ariaSnapshot(), "a11y").not.toContain(
    value,
  );
}
async function openSwitchFromRail(page: Page, who: Who) {
  await page
    .getByRole("button", { name: `${name(who)}, switch account` })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Switch account" }),
  ).toBeVisible();
}
/**
 * ONE click, then the account card. WEB-08c revision 2, HF-1: revision 1 repeated the click (a navigation lost in the post-settlement session
 * re-check); the product correction HF1-SHARED-CONFIRMATION-20261013 removes the identity reads that caused it, so the original single click
 * is restored, unadapted (WEB08D-NAVIGATION-FRESHNESS-20261011: WEB-09d verifies it again in the integrated client).
 */
async function openSettings(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Settings" })
    .first()
    .click();
  await expect(page.locator("[data-account-card]")).toBeVisible({
    timeout: 30_000,
  });
}
/** WF-SWITCH-02's form, for "another account" (the username typed). */
async function switchToNew(page: Page, who: Who) {
  await page
    .getByRole("dialog", { name: "Switch account" })
    .getByRole("option")
    .last()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Sign in to another account",
  });
  await budget(who);
  await dialog.getByLabel("Username").fill(name(who));
  await dialog.getByLabel("Password").fill(password(who));
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
}
const proxyLog = async (since = 0) => (await proxy.log()).slice(since);
const deliveredStatus = (entry: {
  events: Array<{ event: string; status?: number }>;
}) => entry.events.find((e) => e.event === "delivered")?.status;

test.describe("I-L1: WF-SWITCH A→B→A against the backend (rows 7/8, check (h), amendment 25 case (f))", () => {
  test("I-L1: the switch through the rail and Settings: A is not perceivable during 1c or under B; nothing carrying A's session is accepted while B is settled; A's retained row is named by A's own verified profile", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const a = await signedIn(page, "frank");
    await railShows(page, "frank");
    const since = (await proxy.log()).length;
    await openSwitchFromRail(page, "frank");
    const held = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "hold",
    });
    await switchToNew(page, "grace");
    await expect
      .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(
      page.getByRole("heading", { level: 1, name: "Finishing sign-in" }),
    ).toBeVisible({ timeout: 30_000 });
    await expectAbsent(page, name("frank"));
    await proxy.release(held.id);
    await proxy.removeRule(held.id);
    await railShows(page, "grace");
    await expectAbsent(page, name("frank"));
    const b = await identity(page);
    expect(b?.account_id).not.toBe(a.account_id);
    // grace's own verified read was made under grace's session (the outgoing account's QUEUE under the incoming identity is WEB-09a's
    // I-O5, cited and run in the same final integration run).
    const meReads = (await proxyLog(since)).filter(
      (e) => e.method === "GET" && e.path === `${API}/me`,
    );
    expect(meReads.length).toBeGreaterThanOrEqual(1);

    // Settings → "Switch account": frank is a RETAINED account, named by its own verified profile record.
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    const retained = page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]');
    await expect(retained).toContainText(name("frank"));
    await expect(retained).toContainText("Used on this computer before");
    await retained.click();
    const dialog = page.getByRole("dialog", {
      name: `Sign in as ${name("frank")}`,
    });
    await expect(dialog.getByLabel("Username")).toHaveValue(name("frank"));
    await budget("frank");
    await dialog.getByLabel("Password").fill(password("frank"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("frank")}` })
      .click();
    await railShows(page, "frank");
    await expectAbsent(page, name("grace"));
    const back = await identity(page);
    expect(back?.account_id).toBe(a.account_id);
    expect(back?.epoch).toBeGreaterThan(b?.epoch ?? 0);
  });
});

// ---- I-L12: Q-L1, the production A→B→A switch with a queued outgoing command (R5 of the review of 11 October 2026) ----------------------

/** A people command as the data layer queues it (`create_person`, Idempotency-Key = local id): a dispatchable, ready-to-send draft. */
const createPerson = (id: string, name: string) => ({
  endpoint: "/commands",
  targets: [
    {
      resourceId: id,
      role: "primary" as const,
      basis: "resource" as const,
      versionChecked: false,
      seedIfUntracked: 1,
    },
  ],
  command: { commands: [{ kind: "create_person", id, name }] },
  displayPatch: { [id]: { label: name } },
});

/** Every POST of a command this page sends: its idempotency key, CSRF token and exact body bytes (the request observer). */
function observeCommands(page: Page) {
  const seen: Array<{
    at: number;
    key: string | null;
    csrf: string | null;
    body: string;
  }> = [];
  page.on("request", (request) => {
    if (
      request.method() !== "POST" ||
      !new URL(request.url()).pathname.endsWith("/commands")
    )
      return;
    const headers = request.headers();
    seen.push({
      at: Date.now(),
      key: headers["idempotency-key"] ?? null,
      csrf: headers["x-csrf-token"] ?? null,
      body: request.postData() ?? "",
    });
  });
  return seen;
}

/** The labels of `who`'s people as the BACKEND has them (a raw session of that account). */
async function backendPeople(who: Who): Promise<string[]> {
  const session = await rawSignIn(who);
  const answer = await raw("GET", "/people", {
    cookie: session.cookie,
    headers: { "x-csrf-token": session.csrf },
  });
  await raw("DELETE", `/sessions/${session.sessionId}`, {
    cookie: session.cookie,
    headers: { "x-csrf-token": session.csrf },
  });
  return (
    (answer.json as { items?: Array<{ label: string }> }).items ?? []
  ).map((p) => p.label);
}

const enqueueThroughProduction = (page: Page, spec: unknown) =>
  page.evaluate(
    (given) =>
      (
        window as unknown as {
          __atlasFixture: {
            session: { enqueue(spec: unknown): Promise<unknown> };
          };
        }
      ).__atlasFixture.session.enqueue(given),
    spec,
  ) as Promise<{ kind: string; localId?: string }>;

test.describe("I-L12: Q-L1, A→B→A through the PRODUCTION leader with a ready queued command of A", () => {
  test("I-L12: A's queued command (PROXY-INJECTED: its first attempt refused by a gateway before the backend) is never sent while B is settled; B's own command is sent and accepted; after the return A's command is replayed ONCE with the identical body and key under A's new session, and the backend applied it once, to A only", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const sent = observeCommands(page);
    const a = await signedIn(page, "kate");
    await railShows(page, "kate");
    // A's first send attempt is refused by a gateway that never forwards it (`refuse`, qualified in delaying-proxy.test.ts): nothing is
    // applied, and the draft stays queued in A's database under the PRODUCTION leader's dispatcher, which is not stopped by the test.
    const refused = await proxy.addRule({
      method: "POST",
      path: `${API}/commands`,
      action: "refuse",
      status: 503,
      json: {
        code: "unavailable",
        message: "gateway",
        request_id: "proxy",
        details: [],
      },
      ordinal: 1,
    });
    const aId = crypto.randomUUID();
    const queued = await enqueueThroughProduction(
      page,
      createPerson(aId, "I-L12 A queued"),
    );
    expect(queued.kind).toBe("queued");
    await expect
      .poll(
        async () =>
          (await proxy.log()).filter(
            (e) =>
              e.rule === refused.id &&
              e.events.some((v: { event: string }) => v.event === "refused"),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const first = sent.filter((r) => r.key === queued.localId);
    expect(first).toHaveLength(1);
    await proxy.removeRule(refused.id);

    // A → B through the rail, the activation held: A is not perceivable during 1c.
    await openSwitchFromRail(page, "kate");
    const held = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "hold",
    });
    await switchToNew(page, "quinn");
    await expect
      .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expectAbsent(page, name("kate"));
    await proxy.release(held.id);
    await proxy.removeRule(held.id);
    await railShows(page, "quinn");
    const b = await identity(page);
    expect(b?.account_id).not.toBe(a.account_id);
    const switchedAt = Date.now();
    // First, with B settled and its leader bound: nothing of A leaves the page (a leader that binds or dispatches the wrong queue sends A's
    // ready draft at once: the dispatcher re-evaluates its queue from the oldest draft when it starts).
    await page.waitForTimeout(5_000);
    const beforeB = sent.filter((r) => r.at >= switchedAt);
    expect(beforeB.map((r) => r.key)).not.toContain(queued.localId);
    expect(beforeB.some((r) => r.body.includes("I-L12 A queued"))).toBe(false);
    expect(await backendPeople("quinn")).not.toContain("I-L12 A queued");
    // B's own ready command is sent and accepted (so "A was not sent" cannot pass because dispatch is broken for everyone).
    const bId = crypto.randomUUID();
    const bQueued = await enqueueThroughProduction(
      page,
      createPerson(bId, "I-L12 B own"),
    );
    expect(bQueued.kind).toBe("queued");
    await expect
      .poll(() => backendPeople("quinn"), { timeout: 60_000 })
      .toContain("I-L12 B own");
    // And still nothing of A, now that B's dispatcher has certainly run.
    const duringB = sent.filter((r) => r.at >= switchedAt);
    expect(duringB.map((r) => r.key)).not.toContain(queued.localId);
    expect(duringB.some((r) => r.body.includes("I-L12 A queued"))).toBe(false);
    expect(
      duringB.filter((r) => r.key === bQueued.localId).length,
    ).toBeGreaterThanOrEqual(1);
    expect(await backendPeople("quinn")).not.toContain("I-L12 A queued");
    expect(await backendPeople("kate")).not.toContain("I-L12 A queued");

    // B → A from Settings: the retained account, a fresh attempt. A's queue is A's again and its command is replayed once.
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]')
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Sign in as ${name("kate")}`,
    });
    await budget("kate");
    await dialog.getByLabel("Password").fill(password("kate"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("kate")}` })
      .click();
    await railShows(page, "kate");
    const back = await identity(page);
    expect(back?.account_id).toBe(a.account_id);
    await expect
      .poll(() => backendPeople("kate"), { timeout: 120_000 })
      .toContain("I-L12 A queued");
    await page.waitForTimeout(3_000);
    const replays = sent.filter(
      (r) => r.key === queued.localId && r.at > switchedAt,
    );
    expect(
      replays,
      "A's command replayed exactly once after the return",
    ).toHaveLength(1);
    expect(replays[0]?.body, "byte-identical body").toBe(first[0]?.body);
    // Stamped with A's NEW session (a fresh attempt): neither the first attempt's token nor B's.
    const bToken = sent.find((r) => r.key === bQueued.localId)?.csrf;
    expect(replays[0]?.csrf).not.toBe(first[0]?.csrf);
    expect(replays[0]?.csrf).not.toBe(bToken);
    // The backend applied A's command once, to A only.
    const kates = await backendPeople("kate");
    expect(kates.filter((l) => l === "I-L12 A queued")).toHaveLength(1);
    expect(await backendPeople("quinn")).not.toContain("I-L12 A queued");
    expect(kates).not.toContain("I-L12 B own");
  });
});

/** A's ready command, its first attempt refused before the backend (PROXY-INJECTED), so it waits in A's queue. Returns what was observed. */
async function queuedBehindRefusal(page: Page, label: string) {
  const sent = observeCommands(page);
  const refused = await proxy.addRule({
    method: "POST",
    path: `${API}/commands`,
    action: "refuse",
    status: 503,
    json: {
      code: "unavailable",
      message: "gateway",
      request_id: "proxy",
      details: [],
    },
    ordinal: 1,
  });
  const queued = await enqueueThroughProduction(
    page,
    createPerson(crypto.randomUUID(), label),
  );
  expect(queued.kind).toBe("queued");
  await expect
    .poll(() => sent.filter((r) => r.key === queued.localId).length, {
      timeout: 30_000,
    })
    .toBe(1);
  await proxy.removeRule(refused.id);
  return { sent, queued, first: sent.filter((r) => r.key === queued.localId) };
}

test.describe("I-L12 outgoing-session variants (Q-L3)", () => {
  test("I-L12b: the switch to B is REFUSED at the activation (PROXY-INJECTED 503 device_capacity, never forwarded): A stays settled and is displayed again; A's queued command is then sent ONCE under A's original session and applied once; B gets nothing", async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const page = await leaderPage(context);
    const a = await signedIn(page, "kate");
    await railShows(page, "kate");
    const w = await queuedBehindRefusal(page, "I-L12b A queued");
    const refuse = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "refuse",
      status: 503,
      json: {
        code: "device_capacity",
        message: "full",
        request_id: "proxy",
        details: [],
      },
      ordinal: 1,
    });
    await openSwitchFromRail(page, "kate");
    const refusedAt = Date.now();
    await switchToNew(page, "quinn");
    await railShows(page, "kate", 60_000);
    await proxy.removeRule(refuse.id);
    expect((await identity(page))?.account_id).toBe(a.account_id);
    await expect
      .poll(() => backendPeople("kate"), { timeout: 120_000 })
      .toContain("I-L12b A queued");
    const after = w.sent.filter(
      (r) => r.key === w.queued.localId && r.at >= refusedAt,
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.body).toBe(w.first[0]?.body);
    // The same session as the first attempt: the refused switch changed nothing.
    expect(after[0]?.csrf).toBe(w.first[0]?.csrf);
    expect(
      (await backendPeople("kate")).filter((l) => l === "I-L12b A queued"),
    ).toHaveLength(1);
    expect(await backendPeople("quinn")).not.toContain("I-L12b A queued");
  });

  test("I-L12c: every page is CLOSED while B is settled: the reopened page shows B and sends nothing of A's kept queue; back to A, the command is sent ONCE with the identical body and applied once to A only", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const a = await signedIn(page, "kate");
    await railShows(page, "kate");
    const w = await queuedBehindRefusal(page, "I-L12c A queued");
    await openSwitchFromRail(page, "kate");
    await switchToNew(page, "quinn");
    await railShows(page, "quinn");
    for (const open of context.pages()) await open.close();
    const reopened = await leaderPage(context);
    const sent = observeCommands(reopened);
    await railShows(reopened, "quinn", 60_000);
    await reopened.waitForTimeout(5_000);
    expect(sent.map((r) => r.key)).not.toContain(w.queued.localId);
    expect(sent.some((r) => r.body.includes("I-L12c A queued"))).toBe(false);
    expect(await backendPeople("quinn")).not.toContain("I-L12c A queued");
    expect(await backendPeople("kate")).not.toContain("I-L12c A queued");
    // A's queue was kept across the restart, byte for byte.
    expect(
      JSON.stringify(await rowsOf(reopened, a.account_id, "draft_commands")),
    ).toContain("I-L12c A queued");
    await openSettings(reopened);
    await reopened
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    await reopened
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]')
      .click();
    const dialog = reopened.getByRole("dialog", {
      name: `Sign in as ${name("kate")}`,
    });
    await budget("kate");
    await dialog.getByLabel("Password").fill(password("kate"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("kate")}` })
      .click();
    await railShows(reopened, "kate", 60_000);
    await expect
      .poll(() => backendPeople("kate"), { timeout: 120_000 })
      .toContain("I-L12c A queued");
    const replays = sent.filter((r) => r.key === w.queued.localId);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.body).toBe(w.first[0]?.body);
    expect(
      (await backendPeople("kate")).filter((l) => l === "I-L12c A queued"),
    ).toHaveLength(1);
    expect(await backendPeople("quinn")).not.toContain("I-L12c A queued");
  });
});

// ---- I-L13: Q-R1/Q-R2, T24's recovery branches composed with the switch and with retained work (R5 of the review of 11 October 2026) ----

/** The rows of one store of an account's database, read with plain IndexedDB (the database the production leader writes). */
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

/** An unfinished form of the account, saved as the form-recovery writer stores it (fixture: the data harness on this page's registry). */
async function seedForm(page: Page, account: string, text: string) {
  await page.evaluate(
    async ({ acct, value }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      data.setIdentity(acct);
      await data.open(acct);
      await data.put(acct, "form_recovery", [
        {
          form_context: `i-l13-${value}`,
          tab_instance_id: "tab",
          fields: { title: value },
          redacted: [],
          saved_at: new Date().toISOString(),
          capture_seq: 1,
          terminal: false,
          content_digest: `digest-${value}`,
        },
      ]);
    },
    { acct: account, value: text },
  );
}

const leaderTrace = (page: Page) =>
  page.evaluate(
    () =>
      (window.__atlasFixture?.session?.trace ?? []) as Array<{
        at: number;
        event: string;
        data?: Record<string, unknown>;
      }>,
  );

/** Revoke every session of `who` except the raw one used to do it (the backend's own 401 at the next request of the revoked one). */
async function revokeOthers(who: Who) {
  const other = await rawSignIn(who);
  const sessions = await raw("GET", "/sessions", {
    cookie: other.cookie,
    headers: { "x-csrf-token": other.csrf },
  });
  for (const row of (
    sessions.json as { sessions: Array<{ id: string; current: boolean }> }
  ).sessions.filter((s) => !s.current))
    await raw("DELETE", `/sessions/${row.id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
  await raw("DELETE", `/sessions/${other.sessionId}`, {
    cookie: other.cookie,
    headers: { "x-csrf-token": other.csrf },
  });
}

/**
 * The common start of I-L13: A displayed with a READY queued command (its first attempt PROXY-INJECTED: refused by a gateway, never applied)
 * and an unfinished form; A's session revoked elsewhere, so A is fenced (1b); the person signs in as B instead, from the 1b card.
 */
async function fencedWithWork(page: Page, a: Who, b: Who, tag: string) {
  const sent = observeCommands(page);
  const id = await signedIn(page, a);
  await railShows(page, a);
  const refused = await proxy.addRule({
    method: "POST",
    path: `${API}/commands`,
    action: "refuse",
    status: 503,
    json: {
      code: "unavailable",
      message: "gateway",
      request_id: "proxy",
      details: [],
    },
    ordinal: 1,
  });
  const queued = await enqueueThroughProduction(
    page,
    createPerson(crypto.randomUUID(), `I-L13 ${tag} A queued`),
  );
  expect(queued.kind).toBe("queued");
  await expect
    .poll(() => sent.filter((r) => r.key === queued.localId).length, {
      timeout: 30_000,
    })
    .toBe(1);
  await proxy.removeRule(refused.id);
  await seedForm(page, id.account_id, `i-l13-${tag}-form`);
  const formBefore = JSON.stringify(
    await rowsOf(page, id.account_id, "form_recovery"),
  );
  expect(formBefore).toContain(`i-l13-${tag}-form`);
  const bodiesBefore = JSON.stringify(
    await rowsOf(page, id.account_id, "draft_commands"),
  );
  expect(bodiesBefore).toContain(`I-L13 ${tag} A queued`);
  await revokeOthers(a);
  await page.evaluate(() => window.__atlasFixture?.session?.leaderNudge());
  await untilView(page, "neutral", "1b", 60_000);
  await page.getByRole("button", { name: "Reconnect" }).click();
  await budget(b);
  await page.getByLabel("Username").fill(name(b));
  await page.getByLabel("Password").fill(password(b));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await railShows(page, b);
  return {
    sent,
    id,
    queued,
    first: sent.filter((r) => r.key === queued.localId),
    formBefore,
    bodiesBefore,
  };
}

/** Back to A from Settings (a retained account, a fresh attempt). */
/**
 * Back to A from Settings (a retained account, a fresh attempt). `whileActivating` runs while A's activation answer is HELD (the page is
 * gated, so B's sync engine has stopped): a rule added there addresses the RETURN's recovery reads, not a poll of B's still-running engine
 * (campaign 2026-10-13T21-10-28.584Z-7a0b7a7b: a "first `/sync`" rule caught B's poll in Firefox and WebKit).
 */
async function returnTo(
  page: Page,
  a: Who,
  whileActivating?: () => Promise<void>,
) {
  await openSettings(page);
  await page
    .locator("[data-account-card]")
    .getByRole("button", { name: "Switch account" })
    .click();
  await page
    .getByRole("dialog", { name: "Switch account" })
    .locator('[data-switch-row="retained"]')
    .click();
  const dialog = page.getByRole("dialog", { name: `Sign in as ${name(a)}` });
  await budget(a);
  await dialog.getByLabel("Password").fill(password(a));
  const activation = whileActivating
    ? await proxy.addRule({
        method: "POST",
        path: `${API}/browser-sessions/activate`,
        action: "hold",
        ordinal: 1,
      })
    : null;
  await dialog.getByRole("button", { name: `Sign in as ${name(a)}` }).click();
  if (activation && whileActivating) {
    await expect
      .poll(async () => (await proxy.held())[activation.id] ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    await whileActivating();
    await proxy.release(activation.id);
    await proxy.removeRule(activation.id);
  }
}

test.describe("I-L13: T24 composed with A→B→A and retained work", () => {
  test("I-L13 R1 (T24 B, Q-R1): back to the fenced A, the recovery's first page is PROXY-INJECTED 410: a replacement snapshot is built and activated while A stays hidden, `finish` clears the fence, A is displayed; A's queued body and unfinished form are byte-identical, and the command is sent ONCE, only after the fence cleared, and applied once", async ({
    context,
    provokes,
  }) => {
    provokes(401, 410);
    // WEB-08c revision 3 (R5): the whole case runs under the continuous display oracle (qualified by fixture.lifecycle-oracle.spec.ts):
    // no page mounts or lifts an account, or shows either account's name, before its own last committed record shows that account settled
    // with no fence. It is what proves "A stays hidden during the replacement" over the whole interval; the end-state checks below remain.
    const oracle = await installDisplayOracle(context, {
      markers: [name("mia"), name("liam")],
    });
    const page = await leaderPage(context);
    const w = await fencedWithWork(page, "mia", "liam", "r1");
    let rule: { id: string } = { id: "" };
    const returnedAt = Date.now();
    await returnTo(page, "mia", async () => {
      rule = await proxy.addRule({
        method: "GET",
        path: `${API}/sync`,
        ordinal: 1,
        action: "rewrite_status",
        status: 410,
      });
    });
    await railShows(page, "mia", 60_000);
    await proxy.removeRule(rule.id);
    expect(
      Object.values((await records(page)).auth_state.fences).flat(),
    ).toEqual([]);
    await expect
      .poll(() => backendPeople("mia"), { timeout: 120_000 })
      .toContain("I-L13 r1 A queued");
    // The trace of this return: begin eligible → replacement activated → finish cleared → display; the command only after that.
    const trace = (await leaderTrace(page)).filter((e) => e.at >= returnedAt);
    const index = (pred: (e: (typeof trace)[number]) => boolean) =>
      trace.findIndex(pred);
    const activated = index(
      (e) =>
        e.event === "data.recovery_commit" && e.data?.value === "activated",
    );
    const cleared = index(
      (e) => e.event === "data.recovery_finish" && e.data?.result === "cleared",
    );
    const firstSend = index((e) => e.event === "data.outbox_send");
    expect(activated, "the replacement snapshot was activated").toBeGreaterThan(
      -1,
    );
    expect(cleared, "finish cleared after the activation").toBeGreaterThan(
      activated,
    );
    expect(
      firstSend,
      "the queued command was sent only after the fence cleared",
    ).toBeGreaterThan(cleared);
    const replays = w.sent.filter(
      (r) => r.key === w.queued.localId && r.at >= returnedAt,
    );
    expect(replays).toHaveLength(1);
    expect(replays[0]?.body).toBe(w.first[0]?.body);
    expect(
      (await backendPeople("mia")).filter((l) => l === "I-L13 r1 A queued"),
    ).toHaveLength(1);
    expect(await backendPeople("liam")).not.toContain("I-L13 r1 A queued");
    // The unfinished form survived the switch and the replacement, byte for byte.
    expect(
      JSON.stringify(await rowsOf(page, w.id.account_id, "form_recovery")),
    ).toBe(w.formBefore);
    await oracle.assertClean("I-L13 R1");
  });

  test("I-L13 R2 (T24 F/G, Q-R2): back to the fenced A, A's NEW session is revoked while the recovery's first read is held: the recovery's 401 records a current-epoch fence (1b), nothing of A's queue is sent, the work is kept; the next sign-in recovers and sends the command ONCE", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    // WEB-08c revision 3 (R5): under the continuous display oracle, as R1.
    const oracle = await installDisplayOracle(context, {
      markers: [name("nora"), name("kate")],
    });
    const page = await leaderPage(context);
    const w = await fencedWithWork(page, "nora", "kate", "r2");
    let hold: { id: string } = { id: "" };
    const returnedAt = Date.now();
    await returnTo(page, "nora", async () => {
      hold = await proxy.addRule({
        method: "GET",
        path: `${API}/sync`,
        ordinal: 1,
        action: "hold_request",
      });
    });
    await expect
      .poll(async () => (await proxy.held())[hold.id] ?? 0, { timeout: 60_000 })
      .toBe(1);
    const epoch = (await records(page)).auth_state.settled?.epoch ?? 0;
    // The recovery's read is in flight; A's new session ends on the server; the read reaches the backend only now: 401.
    await revokeOthers("nora");
    await proxy.release(hold.id);
    await proxy.removeRule(hold.id);
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session" && f.epoch === epoch),
      "the recovery's 401 is a CURRENT-epoch invalid_session fence",
    );
    await untilView(page, "neutral", "1b", 60_000);
    await page.waitForTimeout(3_000);
    expect(
      w.sent.filter((r) => r.key === w.queued.localId && r.at >= returnedAt),
      "nothing of A's queue is sent while A is fenced",
    ).toEqual([]);
    expect(await backendPeople("nora")).not.toContain("I-L13 r2 A queued");
    expect(
      JSON.stringify(await rowsOf(page, w.id.account_id, "draft_commands")),
    ).toBe(w.bodiesBefore);
    expect(
      JSON.stringify(await rowsOf(page, w.id.account_id, "form_recovery")),
    ).toBe(w.formBefore);
    // The person signs in again (1b's Reconnect): the recovery runs on the new epoch, then the command is sent once.
    const again = Date.now();
    await page.getByRole("button", { name: "Reconnect" }).click();
    await budget("nora");
    await page.getByLabel("Username").fill(name("nora"));
    await page.getByLabel("Password").fill(password("nora"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await railShows(page, "nora", 60_000);
    await expect
      .poll(() => backendPeople("nora"), { timeout: 120_000 })
      .toContain("I-L13 r2 A queued");
    const replays = w.sent.filter(
      (r) => r.key === w.queued.localId && r.at >= again,
    );
    expect(replays).toHaveLength(1);
    expect(replays[0]?.body).toBe(w.first[0]?.body);
    expect(
      (await backendPeople("nora")).filter((l) => l === "I-L13 r2 A queued"),
    ).toHaveLength(1);
    expect(await backendPeople("kate")).not.toContain("I-L13 r2 A queued");
    await oracle.assertClean("I-L13 R2");
  });
});

// ---- I-L14/I-L15: WEB-08c revision 3 (R5 of the review of 14 October 2026; design assessment S2, S3): the queue across the switch from an
// OFFLINE origin, and a lost answer taken over by another page across the switch ----

/**
 * OFFLINE at the application's boundary (as I-L10): every API request of the context fails before the network, and the page's
 * `navigator.onLine` answers false with the `offline` event; `onlineAgain` undoes both and fires `online`.
 */
async function offline(context: BrowserContext, page: Page) {
  await context.route(`**${API}/**`, (route) =>
    route.abort("internetdisconnected"),
  );
  await page.evaluate(() => {
    const w = window as unknown as { __offline?: boolean };
    w.__offline = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => w.__offline !== true,
    });
    window.dispatchEvent(new Event("offline"));
  });
}
async function onlineAgain(context: BrowserContext, page: Page) {
  await context.unroute(`**${API}/**`);
  await page.evaluate(() => {
    (window as unknown as { __offline?: boolean }).__offline = false;
    window.dispatchEvent(new Event("online"));
  });
}
const gatewayRefusal = (ordinal?: number) =>
  proxy.addRule({
    method: "POST",
    path: `${API}/commands`,
    action: "refuse",
    status: 503,
    json: {
      code: "unavailable",
      message: "gateway",
      request_id: "proxy",
      details: [],
    },
    ...(ordinal === undefined ? {} : { ordinal }),
  });
/** A → B through the rail, the activation held while A is checked absent; B's own command sent and accepted. Returns when it was. */
async function toBWithOwnCommand(page: Page, a: Who, b: Who) {
  await openSwitchFromRail(page, a);
  const held = await proxy.addRule({
    method: "POST",
    path: `${API}/browser-sessions/activate`,
    action: "hold",
  });
  await switchToNew(page, b);
  await expect
    .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  await expectAbsent(page, name(a));
  await proxy.release(held.id);
  await proxy.removeRule(held.id);
  await railShows(page, b);
  return Date.now();
}

test.describe("I-L14/I-L15: the queue across the switch, offline origin and lost answer (WEB-08c revision 3)", () => {
  test("I-L14 (S2): A's command is queued OFFLINE (nothing leaves the page; its body is durable); back online its first attempt is refused by a gateway (PROXY-INJECTED); A → B: nothing of A is sent while B is settled and B's own command is accepted; back to A: replayed ONCE, identical body and key, applied once to A only", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [name("liam"), name("mia")],
    });
    const page = await leaderPage(context);
    const sent = observeCommands(page);
    const a = await signedIn(page, "liam");
    await railShows(page, "liam");
    await offline(context, page);
    const queued = await enqueueThroughProduction(
      page,
      createPerson(crypto.randomUUID(), "I-L14 A offline"),
    );
    expect(queued.kind).toBe("queued");
    await page.waitForTimeout(3_000);
    expect(sent, "nothing leaves an offline page").toEqual([]);
    expect(
      JSON.stringify(await rowsOf(page, a.account_id, "draft_commands")),
    ).toContain("I-L14 A offline");
    // Back online behind a barrier: EVERY attempt is refused before the backend until B is settled, so the queue still holds A's command
    // at the switch (a one-shot refusal let the dispatcher's next attempt apply it to A before the switch: a correct send, but no switch).
    const barrier = await gatewayRefusal();
    await onlineAgain(context, page);
    await expect
      .poll(() => sent.filter((r) => r.key === queued.localId).length, {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    const first = sent.filter((r) => r.key === queued.localId);
    const switchedAt = await toBWithOwnCommand(page, "liam", "mia");
    await proxy.removeRule(barrier.id);
    expect(
      (await proxy.log()).filter(
        (e) =>
          e.method === "POST" &&
          e.path === `${API}/commands` &&
          !e.events.some((v: { event: string }) => v.event === "refused"),
      ),
      "nothing of A reached the backend before the switch",
    ).toEqual([]);
    await page.waitForTimeout(5_000);
    const bId = crypto.randomUUID();
    const bQueued = await enqueueThroughProduction(
      page,
      createPerson(bId, "I-L14 B own"),
    );
    expect(bQueued.kind).toBe("queued");
    await expect
      .poll(() => backendPeople("mia"), { timeout: 60_000 })
      .toContain("I-L14 B own");
    const duringB = sent.filter((r) => r.at >= switchedAt);
    expect(duringB.map((r) => r.key)).not.toContain(queued.localId);
    expect(duringB.some((r) => r.body.includes("I-L14 A offline"))).toBe(false);
    expect(await backendPeople("liam")).not.toContain("I-L14 A offline");
    await returnTo(page, "liam");
    await railShows(page, "liam", 60_000);
    await expect
      .poll(() => backendPeople("liam"), { timeout: 120_000 })
      .toContain("I-L14 A offline");
    await page.waitForTimeout(3_000);
    const replays = sent.filter(
      (r) => r.key === queued.localId && r.at > switchedAt,
    );
    expect(replays, "replayed exactly once after the return").toHaveLength(1);
    expect(replays[0]?.body, "byte-identical body").toBe(first[0]?.body);
    expect(
      (await backendPeople("liam")).filter((l) => l === "I-L14 A offline"),
    ).toHaveLength(1);
    expect(await backendPeople("mia")).not.toContain("I-L14 A offline");
    await oracle.assertClean("I-L14");
  });

  test("I-L15 (S3, Q-L2): the backend APPLIES A's command and its answer is lost (PROXY-INJECTED drop after forward); the leading page closes before any retry and the other page TAKES OVER (its retry refused by a gateway before A → B); nothing of A is sent while B is settled; back to A the retry carries the identical key and body and the backend applied the command ONCE, to A only", async ({
    context,
  }) => {
    const oracle = await installDisplayOracle(context, {
      markers: [name("nora"), name("quinn")],
    });
    const one = await leaderPage(context);
    const sentOne = observeCommands(one);
    const a = await signedIn(one, "nora");
    await railShows(one, "nora");
    const two = await leaderPage(context);
    const sentTwo = observeCommands(two);
    await railShows(two, "nora");
    const roleOf = (page: Page) =>
      page.evaluate(() => window.__atlasFixture?.session?.leader().role);
    expect(await roleOf(one)).toBe("leader");
    expect(await roleOf(two)).toBe("follower");
    const lost = await proxy.addRule({
      method: "POST",
      path: `${API}/commands`,
      action: "drop_after_forward",
      ordinal: 1,
    });
    const queued = await enqueueThroughProduction(
      one,
      createPerson(crypto.randomUUID(), "I-L15 A lost answer"),
    );
    expect(queued.kind).toBe("queued");
    await expect
      .poll(
        async () =>
          (await proxy.log()).filter(
            (e) =>
              e.rule === lost.id &&
              e.events.some((v: { event: string }) => v.event === "dropped"),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    // Every later attempt is refused before the backend until A → B has happened: the takeover's retry cannot be applied before the
    // switch. Then the leading page goes, before its own retry (a 2 s back-off).
    const barrier = await gatewayRefusal();
    await one.close();
    expect(
      sentOne.filter((r) => r.key === queued.localId),
      "the first page sent it once",
    ).toHaveLength(1);
    // The backend applied it once already.
    await expect
      .poll(() => backendPeople("nora"), { timeout: 30_000 })
      .toContain("I-L15 A lost answer");
    // The other page leads now and retries A's command (refused at the gateway): the in-flight draft survived the takeover.
    await expect.poll(() => roleOf(two), { timeout: 30_000 }).toBe("leader");
    await expect
      .poll(() => sentTwo.filter((r) => r.key === queued.localId).length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(1);
    const firstBody = sentOne.find((r) => r.key === queued.localId)?.body;
    expect(sentTwo.find((r) => r.key === queued.localId)?.body).toBe(firstBody);
    const switchedAt = await toBWithOwnCommand(two, "nora", "quinn");
    await proxy.removeRule(barrier.id);
    await two.waitForTimeout(5_000);
    const bQueued = await enqueueThroughProduction(
      two,
      createPerson(crypto.randomUUID(), "I-L15 B own"),
    );
    expect(bQueued.kind).toBe("queued");
    await expect
      .poll(() => backendPeople("quinn"), { timeout: 60_000 })
      .toContain("I-L15 B own");
    const duringB = sentTwo.filter((r) => r.at >= switchedAt);
    expect(duringB.map((r) => r.key)).not.toContain(queued.localId);
    expect(duringB.some((r) => r.body.includes("I-L15 A lost answer"))).toBe(
      false,
    );
    await returnTo(two, "nora");
    await railShows(two, "nora", 60_000);
    // A's retry, identical key and body; the backend's idempotency answers it without a second effect.
    await expect
      .poll(
        () =>
          sentTwo.filter((r) => r.key === queued.localId && r.at > switchedAt)
            .length,
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        async () =>
          (
            (await rowsOf(two, a.account_id, "drafts")) as Array<{
              local_id: string;
              status: string;
            }>
          ).find((d) => d.local_id === queued.localId)?.status ?? "gone",
        { timeout: 60_000 },
      )
      .not.toBe("sending");
    for (const r of sentTwo.filter((x) => x.key === queued.localId))
      expect(r.body, "identical body on every retry").toBe(firstBody);
    expect(
      (await backendPeople("nora")).filter((l) => l === "I-L15 A lost answer"),
      "one backend effect",
    ).toHaveLength(1);
    expect(await backendPeople("quinn")).not.toContain("I-L15 A lost answer");
    await oracle.assertClean("I-L15");
  });
});

test.describe("I-L2: T7/T20 against the real activate and activate/cancel", () => {
  for (const action of ["rewrite_status", "drop_after_forward"] as const)
    test(`I-L2 (${action}, PROXY-INJECTED): the switch's activation is lost after the backend committed it; the real cancel and current() resolve it exactly: A (its cookie unchanged) renders again with 'That sign-in didn't finish'; B is never adopted`, async ({
      context,
      provokes,
    }) => {
      provokes(502);
      const page = await leaderPage(context);
      const a = await signedIn(page, "heidi");
      await railShows(page, "heidi");
      const since = (await proxy.log()).length;
      await openSwitchFromRail(page, "heidi");
      const rule = await proxy.addRule({
        method: "POST",
        path: `${API}/browser-sessions/activate`,
        action,
        ...(action === "rewrite_status" ? { status: 502 } : {}),
      });
      await switchToNew(page, "ivan");
      await railShows(page, "heidi", 60_000);
      await proxy.removeRule(rule.id);
      await expect(
        page.locator('[data-notice="feedback-ended"]'),
      ).toContainText("That sign-in didn't finish");
      await expectAbsent(page, name("ivan"));
      const again = await identity(page);
      expect(again?.account_id).toBe(a.account_id);
      expect(again?.epoch).toBe(a.epoch);
      const log = await proxyLog(since);
      const cancel = log.filter(
        (e) =>
          e.method === "POST" &&
          e.path === `${API}/browser-sessions/activate/cancel`,
      );
      expect(cancel.length).toBeGreaterThanOrEqual(1);
      expect(cancel.every((e) => deliveredStatus(e) === 200)).toBe(true);
    });
});

test.describe("I-L3: T8, the lock holder destroyed mid-activation", () => {
  test("I-L3: the page that activates is closed while the backend's answer is held; another page resolves the owner-less attempt and shows A; the held answer changes nothing", async ({
    context,
  }) => {
    const one = await leaderPage(context);
    const a = await signedIn(one, "judy");
    const two = await leaderPage(context);
    await untilView(two, "displaying");
    const before = (await context.cookies()).map((c) => c.value).sort();
    const held = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions/activate`,
      action: "hold",
    });
    await railShows(one, "judy");
    await openSwitchFromRail(one, "judy");
    await switchToNew(one, "kate");
    await expect
      .poll(async () => (await proxy.held())[held.id] ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await one.close();
    await two.evaluate(() => window.__s.actions.retry());
    await untilView(two, "displaying", undefined, 60_000);
    expect((await identity(two))?.account_id).toBe(a.account_id);
    await proxy.release(held.id);
    await proxy.removeRule(held.id);
    await two.waitForTimeout(1_000);
    expect((await identity(two))?.account_id).toBe(a.account_id);
    expect((await context.cookies()).map((c) => c.value).sort()).toEqual(
      before,
    );
  });
});

test.describe("I-L4: T12, an interrupted switch", () => {
  test("I-L4 (PROXY-INJECTED drop of the exchange's answer): the attempt fails, A stays settled and rendered, nothing changed; the next try switches", async ({
    context,
  }) => {
    const page = await leaderPage(context);
    const a = await signedIn(page, "liam");
    await railShows(page, "liam");
    const cookies = (await context.cookies()).map((c) => c.value).sort();
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/browser-sessions`,
      action: "drop_after_forward",
    });
    await openSwitchFromRail(page, "liam");
    await switchToNew(page, "mia");
    await expect(
      page.getByRole("dialog", { name: "Sign in to another account" }),
    ).toContainText("We couldn't reach Atlas", { timeout: 30_000 });
    await proxy.removeRule(rule.id);
    expect((await identity(page))?.account_id).toBe(a.account_id);
    expect((await context.cookies()).map((c) => c.value).sort()).toEqual(
      cookies,
    );
    // (mia's username is still in the form the person typed it into; nothing of mia's ACCOUNT is shown: the dialog still offers to stay
    // as liam, the account that is settled.)
    await expect(
      page.getByRole("button", { name: `Cancel — stay as ${name("liam")}` }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", {
      name: "Sign in to another account",
    });
    await budget("mia");
    await dialog.getByLabel("Password").fill(password("mia"));
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await railShows(page, "mia");
  });
});

test.describe("I-L5: T13/T24 composed with switching", () => {
  test("I-L5: A is invalidated (a real 401: its session revoked elsewhere) → 1b; the person signs in as B instead; back to A from Settings: A's fence stands, 'Catching up', the production recovery job catches up with recovery-class reads, then A", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await leaderPage(context);
    await signedIn(page, "nora");
    await railShows(page, "nora");
    // Revoke nora's browser session from another client: the backend's own 401 at nora's next request.
    const other = await rawSignIn("nora");
    const sessions = await raw("GET", "/sessions", {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    const list = (
      sessions.json as { sessions: Array<{ id: string; current: boolean }> }
    ).sessions;
    for (const row of list.filter((s) => !s.current))
      await raw("DELETE", `/sessions/${row.id}`, {
        cookie: other.cookie,
        headers: { "x-csrf-token": other.csrf },
      });
    // A TRIGGER only: the page's own sync leader may meet the 401 first, and the navigation is then gone (Firefox, campaign
    // 2026-10-11T13-30-08.975Z-c180297a; the same race as I-L7 and I-L10).
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await untilView(page, "neutral", "1b", 60_000);
    await expectAbsent(page, name("nora"));
    await page.getByRole("button", { name: "Reconnect" }).click();
    await budget("olga");
    await page.getByLabel("Username").fill(name("olga"));
    await page.getByLabel("Password").fill(password("olga"));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await railShows(page, "olga");
    const since = (await proxy.log()).length;
    await openSettings(page);
    await page
      .locator("[data-account-card]")
      .getByRole("button", { name: "Switch account" })
      .click();
    await page
      .getByRole("dialog", { name: "Switch account" })
      .locator('[data-switch-row="retained"]')
      .click();
    const dialog = page.getByRole("dialog", {
      name: `Sign in as ${name("nora")}`,
    });
    await budget("nora");
    await dialog.getByLabel("Password").fill(password("nora"));
    await dialog
      .getByRole("button", { name: `Sign in as ${name("nora")}` })
      .click();
    await railShows(page, "nora", 60_000);
    const syncs = (await proxyLog(since)).filter(
      (e) => e.method === "GET" && e.path.startsWith(`${API}/sync`),
    );
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    await expectAbsent(page, name("olga"));
  });
});

test.describe("I-L6: T17 across two pages", () => {
  test("I-L6: a password change on page one (the backend's 204) ends every session; page one and page two show 1b; the old password is refused", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const one = await leaderPage(context);
    await signedIn(one, "pete");
    const two = await leaderPage(context);
    await untilView(two, "displaying");
    await openSettings(one);
    await one.getByRole("link", { name: /Signing in/ }).click();
    const dialog = one.getByRole("dialog", { name: "Signing in" });
    await dialog.getByLabel("Current password").fill(password("pete"));
    const fresh = `${password("pete")}-I-L6-new`;
    await dialog.getByLabel(/New password/).fill(fresh);
    await dialog.getByRole("button", { name: "Change password" }).click();
    for (const page of [one, two]) {
      await untilView(page, "neutral", "1b", 60_000);
      await expectAbsent(page, name("pete"));
    }
    const refused = await raw("POST", "/browser-sessions", {
      body: {
        username: name("pete"),
        password: password("pete"),
        device_id: crypto.randomUUID(),
        attempt_challenge: "x".repeat(43),
      },
    });
    expect(refused.status).toBe(401);
  });
});

test.describe("I-L7: T21 and K-1 against the backend", () => {
  test("I-L7: another account's live cookie under this page's stamp: the backend's credential_mismatch fences at once; the verification reads the other account: 1d; the verification is not repeated without end", async ({
    context,
    provokes,
  }) => {
    provokes(403);
    const page = await leaderPage(context);
    await signedIn(page, "quinn");
    await railShows(page, "quinn");
    const other = await rawSignIn("alice");
    await swapCookie(context, other);
    const since = (await proxy.log()).length;
    // A TRIGGER only: the page's own sync leader may make the next request first and detect the mismatch itself, after which the
    // navigation is gone (Firefox, campaign 2026-10-11T12-53-28.484Z-7b30b88e); either request is the backend's own answer.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await untilView(page, "neutral", "1d", 60_000);
    await expectAbsent(page, name("quinn"));
    await expectAbsent(page, name("alice"));
    await page.waitForTimeout(3_000);
    const settled = (await proxyLog(since)).filter(
      (e) => e.path === `${API}/browser-sessions/current`,
    ).length;
    await page.waitForTimeout(5_000);
    const later = (await proxyLog(since)).filter(
      (e) => e.path === `${API}/browser-sessions/current`,
    ).length;
    expect(later - settled).toBe(0);
    expect(settled).toBeLessThanOrEqual(6);
  });
});

test.describe("I-L9: G-23, 'Confirm it's you' against the backend's own five-minute rule (opt-in, REAL time)", () => {
  test("I-L9: after 305 s of real time Link is disabled with its reason; 'Confirm it's you' re-authenticates in place (a new session at a newer epoch); back on Signing in, Link is enabled and focused; the backend then LINKS single sign-on and, within the five minutes, UNLINKS it", async ({
    context,
  }) => {
    test.skip(
      process.env.ATLAS_INTEGRATION_REALTIME !== "1",
      "opt-in: about 5½ minutes of REAL time per engine (ATLAS_INTEGRATION_REALTIME=1)",
    );
    test.setTimeout(600_000);
    const page = await leaderPage(context);
    const first = await signedIn(page, "bob");
    await page.waitForTimeout(305_000);
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    const dialog = page.getByRole("dialog", { name: "Signing in" });
    await expect(
      dialog.getByRole("button", { name: "Link single sign-on" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Confirm it's you" }).click();
    const region = dialog.getByRole("region", { name: "Confirm it's you" });
    await budget("bob");
    await region.getByLabel("Password").fill(password("bob"));
    await region.getByRole("button", { name: "Confirm it's you" }).click();
    await expect(page).toHaveURL(/\/settings\/signing-in$/, {
      timeout: 60_000,
    });
    const link = page
      .getByRole("dialog", { name: "Signing in" })
      .getByRole("button", { name: "Link single sign-on" });
    await expect(link).toBeEnabled({ timeout: 30_000 });
    await expect(link).toBeFocused({ timeout: 30_000 });
    const after = await identity(page);
    expect(after?.account_id).toBe(first.account_id);
    expect(after?.epoch).toBeGreaterThan(first.epoch);

    // R5 of the review of 11 October 2026 (plan §6.5): the confirmation is what makes the backend's link AND unlink possible.
    test.skip(
      !OIDC,
      "the link and unlink need the stub OpenID Connect provider (run with --oidc on)",
    );
    await provider.subject(`il9-${Date.now().toString(36)}`);
    await followNavigation(page, () => link.click());
    await untilView(page, "displaying");
    await expect(
      page.locator('[data-notice="feedback-message"]'),
    ).toContainText("Single sign-on is now linked to your account.", {
      timeout: 30_000,
    });
    const readMe = async () => {
      const probe = await rawSignIn("bob");
      return (
        await raw("GET", "/me", {
          cookie: probe.cookie,
          headers: { "x-csrf-token": probe.csrf },
        })
      ).json as { oidc_issuers: string[] };
    };
    expect((await readMe()).oidc_issuers).toEqual([OIDC?.issuer]);
    // Within the five minutes the confirmation started, the link is removed: the backend removes it and ends the session (1b).
    await openSettings(page);
    await page.getByRole("link", { name: /Signing in/ }).click();
    await page
      .getByRole("dialog", { name: "Signing in" })
      .getByRole("button", { name: /^Remove / })
      .click();
    await untilView(page, "neutral", "1b", 60_000);
    expect((await readMe()).oidc_issuers).toEqual([]);
  });
});

test.describe("I-L10: T23 E/F/L composed: a recording that cannot be saved, every page gone, an offline reopening", () => {
  test("I-L10: a real 401 whose recording write fails (named IndexedDB fault, test-only): every page is closed; a new page offline shows the interrupted-request card (1e) and nothing of A; online it verifies: the backend's 401 → 1b", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    // TEST-ONLY fault, named and scoped: while `window.__failAuthRecords` is true, the `atlas-auth` write that would ADD an
    // `invalid_session` fence (the recording of the observation, matrix 3.6.1 step 2) is aborted inside its transaction, so nothing of it
    // commits; every other write (the request's own cover and lease) is untouched. No product hook exists; nothing ships.
    await context.addInitScript(() => {
      const w = window as unknown as { __failAuthRecords?: boolean };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (
          w.__failAuthRecords &&
          this.transaction.db.name === "atlas-auth" &&
          args[1] === "auth_state" &&
          JSON.stringify(args[0]).includes('"invalid_session"')
        ) {
          this.transaction.abort();
          throw new DOMException(
            "injected: the recording write fails",
            "AbortError",
          );
        }
        return put.apply(this, args);
      } as typeof put;
    });
    const page = await leaderPage(context);
    await signedIn(page, "carol");
    await railShows(page, "carol");
    // The named fault is armed BEFORE carol's session ends: the page's own sync leader may meet the 401 first (it matches only the write
    // that adds an `invalid_session` fence, so nothing earlier is affected).
    await page.evaluate(() => {
      (window as unknown as { __failAuthRecords: boolean }).__failAuthRecords =
        true;
    });
    // carol's session ends elsewhere (the backend's own 401 at the next request).
    const other = await rawSignIn("carol");
    const sessions = await raw("GET", "/sessions", {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    for (const row of (
      sessions.json as { sessions: Array<{ id: string; current: boolean }> }
    ).sessions.filter((s) => !s.current))
      await raw("DELETE", `/sessions/${row.id}`, {
        cookie: other.cookie,
        headers: { "x-csrf-token": other.csrf },
      });
    // A TRIGGER only: the leader's own request may detect it first, and the navigation is then gone.
    await page
      .getByRole("navigation")
      .getByRole("link", { name: "Settings" })
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
    await expect
      .poll(
        () =>
          untilView(page, "neutral")
            .then(() => true)
            .catch(() => false),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    await expectAbsent(page, name("carol"));
    await page.close();
    // A new page, OFFLINE (emulated at the application's boundary: `navigator.onLine` false and every API request failing before the
    // network, so the static application still loads): the lease left by the unrecorded request keeps the account hidden (row 9).
    await context.route(`**${API}/**`, (route) =>
      route.abort("internetdisconnected"),
    );
    const reopened = await context.newPage();
    await reopened.addInitScript(() => {
      const w = window as unknown as { __online?: boolean };
      Object.defineProperty(navigator, "onLine", {
        get: () => w.__online === true,
        configurable: true,
      });
    });
    await reopened.goto(
      `/__session?route=${encodeURIComponent("/today")}&leader=production`,
    );
    await exposeSession(reopened);
    await expect
      .poll(
        async () =>
          (await reopened.evaluate(() => window.__s.view.get())) as {
            kind: string;
            state?: string;
          },
        { timeout: 30_000 },
      )
      .toMatchObject({ kind: "neutral", state: "1e.interrupted_offline" });
    await expectAbsent(reopened, name("carol"));
    // Online again: one verification; the backend's own 401 → 1b.
    await context.unroute(`**${API}/**`);
    await reopened.evaluate(() => {
      (window as unknown as { __online: boolean }).__online = true;
      window.dispatchEvent(new Event("online"));
    });
    await untilView(reopened, "neutral", "1b", 60_000);
    await expectAbsent(reopened, name("carol"));
  });
});
