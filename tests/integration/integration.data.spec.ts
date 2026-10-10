import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  ACCOUNTS,
  bootHarness,
  expect,
  ORIGIN,
  type ProxyRule,
  proxy,
  type RawSession,
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

/**
 * WEB-09a integration (plan 8.3 to 8.7): the data layer's PRODUCTION code (the production session, its adapters, the Dexie store,
 * the sync engine, the outbox dispatcher and the profile read) in a real engine against the RELEASED backend (v0.27.0-rc.1) on a
 * disposable SQLite database, behind the delaying proxy. The sync engine and the dispatcher are started by the FIXTURE test leader
 * (production starts neither until WEB-09b supplies leadership), and the snapshot is a FIXTURE seeder (the real first snapshot is
 * WEB-09b's). Anything the proxy injects is labelled so. Not release evidence; PostgreSQL, HTTPS and devices are not exercised.
 */
const API = "/api/experimental/v1";

// The released backend allows 10 password attempts per account in a fixed 60 s window (and 120 requests per source). These specs sign in
// far more often than that, so EVERY sign-in here (in a page or raw) first waits until fewer than 8 attempts of that account are less
// than a minute old. The ledger is a file keyed by the stack's port (a failed test restarts the worker, which would lose memory).
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

// The five accounts of the released backend are shared by every spec of a stack, and each allows only 10 password attempts a minute.
// The main account of a test rotates over four of them (bob stays the OTHER account of the two-account tests), so no one account is
// asked for more than a few sign-ins in a minute and a test almost never waits for the budget below. The rotation counter is a file for
// the same reason as the ledger.
const ROTATION: Who[] = ["alice", "carol", "dave", "erin"];
const ROTATION_FILE = join(
  tmpdir(),
  `atlas-account-rotation-${new URL(ORIGIN || "http://x").port}.txt`,
);
let main: Who = "alice";
const me = (): Who => main;
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
  info.setTimeout(90_000);
});

/** A stamped call made in the page, repeated while the session refuses it for a moment (`not_sent`: the resume verification just after display). */
const stamped = <T>(
  page: Page,
  account: { account_id: string; epoch: number },
  call: "me" | "people",
) =>
  page.evaluate(
    async ({ w, c }) => {
      const client = window.__s.api.client("ordinary", w.account_id, w.epoch);
      for (let attempt = 0; ; attempt += 1) {
        try {
          const { data } = await (c === "me"
            ? client.GET("/me")
            : client.GET("/people"));
          return data as unknown;
        } catch (error) {
          if (
            (error as { kind?: string }).kind !== "not_sent" &&
            !String(error).includes("not_sent")
          )
            throw error;
          if (attempt >= 60) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    { w: account, c: call },
  ) as Promise<T>;

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

test.describe("I-P1: the verified profile read", () => {
  test("GET /me through the stamped client returns the account's own username, and the label appears in the rail slot", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const body = await stamped<{ id: string; username: string } | undefined>(
      page,
      id,
      "me",
    );
    expect(body?.id).toBe(id.account_id);
    expect(body?.username).toBe(ACCOUNTS[me()].username);
    // The production data provider verifies once per (account, epoch) and the rail shows ONLY the verified username.
    await expect(
      page.getByText(ACCOUNTS[me()].username, { exact: true }).first(),
    ).toBeVisible();
    const asked = (await proxy.log()).filter((e) => e.path === `${API}/me`);
    expect(asked.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- helpers for the outbox and sync specs --------------------------------------------------------------------------------------
interface CommandRequest {
  path: string;
  key: string | null;
  kinds: string[];
  body: unknown;
}
/** Records every command request the PAGE sends (header and body, as the browser sent them). */
function recordCommands(page: Page): CommandRequest[] {
  const seen: CommandRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      !/\/(commands|task-commands|reminder-commands)$/.test(url.pathname)
    )
      return;
    let body: unknown = null;
    try {
      body = JSON.parse(request.postData() ?? "null");
    } catch {
      body = null;
    }
    const commands =
      (body as { commands?: Array<{ kind?: string }> } | null)?.commands ?? [];
    seen.push({
      path: url.pathname.replace(API, ""),
      key: request.headers()["idempotency-key"] ?? null,
      kinds: commands.map((c) => c.kind ?? "?"),
      body,
    });
  });
  return seen;
}

const uuid = () => crypto.randomUUID();
const create = (id: string, name: string) => ({
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

interface QueueRow {
  local_id: string;
  status: string;
  attempts: number;
  last_error_stage: string | null;
}
const queue = (page: Page, account: string) =>
  page.evaluate((a) => window.__atlasData?.queue(a), account) as Promise<
    QueueRow[]
  >;
const rowsOf = (
  page: Page,
  account: string,
  store: "cache" | "pending_effects" | "resource_versions" | "sync_state",
) =>
  page.evaluate(({ a, s }) => window.__atlasData?.rows(a, s), {
    a: account,
    s: store,
  }) as Promise<Array<Record<string, unknown>>>;

async function leader(
  page: Page,
  account: string,
  options: {
    startOutbox?: boolean;
    sync?: boolean;
    /** Shorter clocks for the dispatcher only (labelled in the evidence): the production values are minutes. */
    config?: Record<string, number>;
  } = {},
) {
  const snapshot = await page.evaluate(
    (a) => window.__atlasData?.prepareAccount(a),
    account,
  );
  await page.evaluate(
    async ({ a, begin, sync, config }) => {
      const data = window.__atlasData;
      if (!data) throw new Error("no data harness");
      await data.startOutbox(a, { start: begin, config });
      if (sync) await data.startSync(a);
    },
    {
      a: account,
      begin: options.startOutbox ?? true,
      sync: options.sync ?? false,
      config: options.config,
    },
  );
  return snapshot;
}

const people = async (
  page: Page,
  who: { account_id: string; epoch: number },
) => {
  const body = await stamped<
    { items?: Array<{ id: string; label: string }> } | undefined
  >(page, who, "people");
  return body?.items ?? [];
};

test.describe("I-O1: queued drafts against the released backend", () => {
  test("create_person, create_field and edit drafts are sent FIFO with Idempotency-Key = local_id; receipts acknowledge them; real delta pages clear the overlay", async ({
    context,
  }, info) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const sent = recordCommands(page);
    const snapshot = await leader(page, id.account_id, {
      startOutbox: false,
      sync: true,
    });
    const P = uuid();
    const F = uuid();
    // Queue first, send after: three drafts in one order, with the dependants waiting on the create.
    const enqueued = await page.evaluate(
      async ({ person, field }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        const a = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: person,
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              { kind: "create_person", id: person, name: "I-O1 Person" },
            ],
          },
          displayPatch: { [person]: { label: "I-O1 Person" } },
        });
        const b = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: field,
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              {
                kind: "create_field",
                id: field,
                person_id: person,
                label: "Phone",
                value: "0123",
              },
            ],
          },
          displayPatch: { [field]: { label: "Phone" } },
          dependsOnExtra: [a.localId],
        } as never);
        const c = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: person,
              role: "primary",
              basis: "resource",
              versionChecked: true,
            },
          ],
          command: {
            commands: [
              {
                kind: "edit",
                id: person,
                expected_version: { $base: person },
                expected_policy_version: 1,
                label: "I-O1 Renamed",
                value: "",
              },
            ],
          },
          displayPatch: { [person]: { label: "I-O1 Renamed" } },
        });
        return [a, b, c];
      },
      { person: P, field: F },
    );
    expect(enqueued.map((e) => e?.kind)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    const ids = enqueued.map((e) => e?.localId as string);
    // Nothing is sent until the dispatcher starts.
    expect(sent).toEqual([]);
    await page.evaluate(() => window.__atlasData?.beginOutbox());
    await expect
      .poll(() => sent.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3);
    expect(sent.slice(0, 3).map((s) => s.key)).toEqual(ids);
    expect(sent.slice(0, 3).map((s) => s.kinds[0])).toEqual([
      "create_person",
      "create_field",
      "edit",
    ]);
    expect(sent.slice(0, 3).every((s) => s.path === "/commands")).toBe(true);
    // The edit carried the version the create left: the record the outbox kept, not a guess.
    const editBody = sent[2]?.body as {
      commands: Array<{ expected_version: number }>;
    };
    expect(editBody.commands[0]?.expected_version).toBe(1);
    // Receipts acknowledged them, and REAL delta pages named the resources, so the overlay cleared and the drafts left.
    await expect
      .poll(
        async () => ({
          drafts: (await queue(page, id.account_id)).length,
          effects: (await rowsOf(page, id.account_id, "pending_effects"))
            .length,
        }),
        { timeout: 60_000 },
      )
      .toEqual({ drafts: 0, effects: 0 });
    const cache = await rowsOf(page, id.account_id, "cache");
    const person = cache.find((r) => r.id === P);
    expect(person).toMatchObject({ kind: "person", label: "I-O1 Renamed" });
    expect(cache.some((r) => r.id === F)).toBe(true);
    // No request carried an unexpected limit above 80 (the engine never asks for more than the contract's page).
    const syncLimits = (await proxy.log())
      .filter((e) => e.path.startsWith(`${API}/sync`))
      .map((e) =>
        Number(new URL(e.path, "http://x").searchParams.get("limit")),
      );
    expect(syncLimits.every((l) => l >= 1 && l <= 80)).toBe(true);
    // The cursors the engine sent were the server's own, opaque and advancing.
    const cursors = (await proxy.log())
      .filter((e) => e.path.startsWith(`${API}/sync`))
      .map((e) => new URL(e.path, "http://x").searchParams.get("cursor"));
    // The seeder's own snapshot requests carry no cursor; the first request WITH one is the engine's, from the server's own position.
    expect(cursors.filter((c) => c !== null)[0]).toBe(snapshot?.cursor);
    expect(new Set(cursors).size).toBeGreaterThanOrEqual(1);
    info.annotations.push({
      type: "evidence",
      description: JSON.stringify({
        sent: sent.map((s) => [s.key, s.kinds[0]]),
        syncRequests: cursors.length,
      }),
    });
  });

  test("a forced LOST RESPONSE (proxy-injected drop after the backend committed) is retried with the same key and creates no duplicate", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const sent = recordCommands(page);
    await leader(page, id.account_id);
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/commands`,
      ordinal: 1,
      action: "drop_after_forward",
    });
    const P = uuid();
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(P, "I-O1 Lost Response") as never,
    );
    expect(out?.kind).toBe("queued");
    // The first response is destroyed AFTER the backend committed: a counted failure, the draft stays in flight, and the retry
    // (2 s back-off) carries the identical key and body.
    await expect
      .poll(() => sent.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    expect(sent[1]?.key).toBe(sent[0]?.key);
    expect(JSON.stringify(sent[1]?.body)).toBe(JSON.stringify(sent[0]?.body));
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).find(
            (d) => d.local_id === out?.localId,
          )?.status,
        { timeout: 30_000 },
      )
      .toBe("acknowledged");
    const list = await people(page, id);
    expect(list.filter((p) => p.label === "I-O1 Lost Response")).toHaveLength(
      1,
    );
    const log = (await proxy.log()).filter(
      (e) => e.method === "POST" && e.path === `${API}/commands`,
    );
    expect(log.map((e) => e.status)).toEqual([200, 200]);
    expect(log[0]?.rule).toBe(rule.id);
  });
});

// ---- I-O2: the specified states, from the answers the real backend gives -------------------------------------------------------
const rawCommand = (
  session: RawSession,
  commands: unknown[],
  key = crypto.randomUUID(),
) =>
  raw("POST", "/commands", {
    cookie: session.cookie,
    headers: { "x-csrf-token": session.csrf, "idempotency-key": key },
    body: { commands },
  });

async function acknowledged(
  page: Page,
  account: string,
  localId: string,
  timeout = 30_000,
) {
  await expect
    .poll(
      async () =>
        (await queue(page, account)).find((d) => d.local_id === localId)
          ?.status ?? "gone",
      { timeout },
    )
    .toMatch(/acknowledged|gone/);
}

test.describe("I-O2: real answers become the specified draft states", () => {
  test("409 operation_conflict (the same key, a DIFFERENT body) is operation_conflict and is never resent", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const sent = recordCommands(page);
    await leader(page, id.account_id, { sync: true });
    const key = uuid();
    const first = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      { ...create(uuid(), "I-O2 First"), localId: key } as never,
    );
    expect(first?.kind).toBe("queued");
    await expect
      .poll(async () => (await queue(page, id.account_id)).length, {
        timeout: 60_000,
      })
      .toBe(0);
    // The same local id (the same Idempotency-Key) with another body: the server's own rule for a reused key.
    const again = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      { ...create(uuid(), "I-O2 Second"), localId: key } as never,
    );
    expect(again?.kind).toBe("queued");
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).find((d) => d.local_id === key)
            ?.status,
        { timeout: 30_000 },
      )
      .toBe("operation_conflict");
    const before = sent.length;
    await page.waitForTimeout(3_000);
    // Never resubmitted under the same key.
    expect(sent.length).toBe(before);
    expect(sent.filter((s) => s.key === key)).toHaveLength(2);
    const row = (await queue(page, id.account_id)).find(
      (d) => d.local_id === key,
    );
    expect(row?.attempts).toBe(1);
  });

  test("409 conflict (a stale expected_version) pauses ONLY that draft; an independent draft behind it is still sent", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    await leader(page, id.account_id, { sync: true });
    const P = uuid();
    const created = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(P, "I-O2 Stale") as never,
    );
    expect(created?.kind).toBe("queued");
    await expect
      .poll(
        async () =>
          (await rowsOf(page, id.account_id, "cache")).some((r) => r.id === P),
        { timeout: 60_000 },
      )
      .toBe(true);
    // Someone else (a second session of the same account) edits it: the server's version moves on, and this page has not seen it.
    const other = await rawSignIn(me());
    const projection = (
      (
        await raw("GET", `/people/${P}`, {
          cookie: other.cookie,
          headers: { "x-csrf-token": other.csrf },
        })
      ).json as { person: { version: number; policy_version: number } }
    ).person;
    const edited = await rawCommand(other, [
      {
        kind: "edit",
        id: P,
        expected_version: projection.version,
        expected_policy_version: projection.policy_version,
        label: "I-O2 Edited elsewhere",
        value: "",
      },
    ]);
    expect(edited.status, JSON.stringify([projection, edited.json])).toBe(200);
    const stale = await page.evaluate(
      async ({ person, policy }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        const a = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: person,
              role: "primary",
              basis: "resource",
              versionChecked: true,
            },
          ],
          command: {
            commands: [
              {
                kind: "edit",
                id: person,
                expected_version: { $base: person },
                expected_policy_version: policy,
                label: "I-O2 Mine",
                value: "",
              },
            ],
          },
        });
        const b = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: crypto.randomUUID(),
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              {
                kind: "create_person",
                id: crypto.randomUUID(),
                name: "I-O2 Independent",
              },
            ],
          },
        });
        return [a, b];
      },
      { person: P, policy: projection.policy_version },
    );
    expect(stale.map((e) => e?.kind)).toEqual(["queued", "queued"]);
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).find(
            (d) => d.local_id === stale[0]?.localId,
          )?.status,
        { timeout: 30_000 },
      )
      .toBe("version_conflict");
    await acknowledged(page, id.account_id, stale[1]?.localId as string);
    const row = (await queue(page, id.account_id)).find(
      (d) => d.local_id === stale[0]?.localId,
    );
    expect(row?.last_error_stage).toBe("conflict");
  });

  test("403 or 404 for another account's resource, and 422 for an invalid body, are rejected, RETAINED, and never silently deleted", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    await leader(page, id.account_id);
    const bob = await rawSignIn("bob");
    const bobsPerson = uuid();
    expect(
      (
        await rawCommand(bob, [
          { kind: "create_person", id: bobsPerson, name: "Bob's person" },
        ])
      ).status,
    ).toBe(200);
    // Bob's own create above went through the proxy too: only what the dispatcher sends from here on is judged.
    const already = (await proxy.log()).length;
    const out = await page.evaluate(
      async ({ foreign }) => {
        const data = window.__atlasData;
        if (!data) throw new Error("no harness");
        const edit = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: foreign,
              role: "primary",
              basis: "resource",
              versionChecked: true,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              {
                kind: "edit",
                id: foreign,
                expected_version: { $base: foreign },
                expected_policy_version: 1,
                label: "Not mine",
                value: "",
              },
            ],
          },
        });
        const invalid = await data.enqueue({
          endpoint: "/commands",
          targets: [
            {
              resourceId: crypto.randomUUID(),
              role: "primary",
              basis: "resource",
              versionChecked: false,
              seedIfUntracked: 1,
            },
          ],
          command: {
            commands: [
              {
                kind: "create_person",
                id: crypto.randomUUID(),
                name: "x".repeat(400),
              },
            ],
          },
        });
        return [edit, invalid];
      },
      { foreign: bobsPerson },
    );
    expect(out.map((o) => o?.kind)).toEqual(["queued", "queued"]);
    for (const o of out)
      await expect
        .poll(
          async () =>
            (await queue(page, id.account_id)).find(
              (d) => d.local_id === o?.localId,
            )?.status,
          { timeout: 30_000 },
        )
        .toBe("rejected");
    // Retained across a reload: a fresh page of the same browser reads them from the durable store, not from memory.
    await page.close();
    const again = await bootHarness(context);
    await untilView(again, "displaying");
    const after = await again.evaluate(async (a) => {
      const data = window.__atlasData;
      if (!data) return [];
      await data.startOutbox(a, { start: false });
      return data.queue(a);
    }, id.account_id);
    expect(after.filter((d) => d.status === "rejected")).toHaveLength(2);
    const log = (await proxy.log())
      .slice(already)
      .filter((e) => e.method === "POST" && e.path === `${API}/commands`);
    const statuses = log.map((e) => e.status);
    // Alice's foreign edit is a 403 or 404; the invalid body a 400 or 422 (whichever the released backend gives): all definitive, none a retry.
    expect(
      statuses.every((st) => st !== undefined && st >= 400 && st < 500),
    ).toBe(true);
    expect(log).toHaveLength(2);
  });
});

// ---- I-O3: the compatibility gate (decision D-21) against the real /health --------------------------------------------------------
const commandsLog = async (since = 0) =>
  (await proxy.log())
    .slice(since)
    .filter((e) => e.method === "POST" && e.path === `${API}/commands`);
/** What the PAGE was answered (the proxy's `status` is the backend's own, before any rewrite). */
const deliveredStatus = (entry: {
  events: Array<{ event: string; status?: number }>;
}) => entry.events.find((e) => e.event === "delivered")?.status;
const dispatcherState = (page: Page) =>
  page.evaluate(() => window.__atlasData?.outboxState() ?? null);

test.describe("I-O3: queued writes wait for a supported server", () => {
  const cases: Array<
    [
      string,
      Pick<ProxyRule, "action" | "set" | "delete">,
      Record<string, unknown>,
    ]
  > = [
    [
      "0.28.0",
      { action: "rewrite_json", set: { api_version: "0.28.0" } },
      { kind: "paused", reason: "compat_unsupported" },
    ],
    [
      "0.26.9",
      { action: "rewrite_json", set: { api_version: "0.26.9" } },
      { kind: "paused", reason: "compat_unsupported" },
    ],
    [
      "missing",
      { action: "rewrite_json", delete: ["api_version"] },
      { kind: "paused", reason: "compat_missing" },
    ],
  ];
  for (const [label, rule, state] of cases) {
    test(`/health reports api_version ${label} (proxy-rewritten): the draft is kept, NO command is sent, and a later boot against a supported server sends it`, async ({
      context,
    }) => {
      const first = await bootHarness(context);
      const id = await signedIn(first, me());
      await leader(first, id.account_id, { startOutbox: false });
      const queued = await first.evaluate(
        (spec) => window.__atlasData?.enqueue(spec),
        create(uuid(), `I-O3 ${label}`) as never,
      );
      expect(queued?.kind).toBe("queued");
      await first.close();

      const held = await proxy.addRule({
        method: "GET",
        path: "/health",
        ...rule,
      });
      const before = (await proxy.log()).length;
      const second = await bootHarness(context);
      await untilView(second, "displaying");
      await leader(second, id.account_id);
      await expect.poll(() => dispatcherState(second)).toMatchObject(state);
      // Not a moment's grace: nothing leaves while the fact is unsupported.
      await second.waitForTimeout(3_000);
      expect(await commandsLog(before)).toEqual([]);
      expect(
        (await queue(second, id.account_id)).map((d) => [d.local_id, d.status]),
      ).toEqual([[queued?.localId, "queued"]]);
      await second.close();

      await proxy.removeRule(held.id);
      const third = await bootHarness(context);
      await untilView(third, "displaying");
      await leader(third, id.account_id);
      await acknowledged(third, id.account_id, queued?.localId as string);
      expect(await commandsLog(before)).toHaveLength(1);
    });
  }

  test("an unreachable /health (a proxy-injected 502) holds queued writes QUIETLY, and they go out when the page asks again and the server answers", async ({
    context,
    provokes,
  }) => {
    provokes(502);
    const first = await bootHarness(context);
    const id = await signedIn(first, me());
    await leader(first, id.account_id, { startOutbox: false });
    const queued = await first.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O3 unreachable") as never,
    );
    await first.close();
    const held = await proxy.addRule({
      method: "GET",
      path: "/health",
      action: "rewrite_status",
      status: 502,
    });
    const before = (await proxy.log()).length;
    const page = await bootHarness(context);
    await untilView(page, "displaying");
    await expect
      .poll(() => page.evaluate(() => window.__s.compat.get()))
      .toEqual({ status: "unreachable" });
    await leader(page, id.account_id);
    await expect
      .poll(() => dispatcherState(page))
      .toMatchObject({ kind: "held", reason: "compat_unconfirmed" });
    await page.waitForTimeout(3_000);
    expect(await commandsLog(before)).toEqual([]);
    await proxy.removeRule(held.id);
    // Connectivity "returns": the session checks the version again, and the dispatcher's own subscription wakes it.
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect
      .poll(() => page.evaluate(() => window.__s.compat.get()))
      .toMatchObject({ status: "supported" });
    await acknowledged(page, id.account_id, queued?.localId as string);
  });
});

// ---- I-O4: injected gateway failures: back-off, then the sustained pause, resumed only by `online` or "Retry now" --------------
// The production clocks are used (2 s doubling to 60 s; paused after 180 s of continuous failure), so the paused case takes minutes.
test.describe("I-O4: a failing /commands (a proxy-injected 503) is retried with back-off, then paused", () => {
  const failing = async () => {
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/commands`,
      action: "rewrite_status",
      status: 503,
    });
    return { rule, before: (await proxy.log()).length };
  };

  test("after the sustained duration the draft is PAUSED and nothing more is sent; the page coming back online resumes it with the SAME key and body, and the backend (which committed on the first try) answers with its stored reply: exactly one person exists", async ({
    context,
    provokes,
  }) => {
    test.setTimeout(420_000);
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const sent = recordCommands(page);
    await leader(page, id.account_id);
    const { rule, before } = await failing();
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O4 Gateway") as never,
    );
    expect(out?.kind).toBe("queued");
    await expect
      .poll(() => dispatcherState(page), { timeout: 30_000 })
      .toMatchObject({ kind: "backing_off" });
    await expect
      .poll(() => dispatcherState(page), {
        timeout: 360_000,
        intervals: [2_000],
      })
      .toMatchObject({ kind: "needs_retry", count: 1 });
    const attempts = await commandsLog(before);
    expect(attempts.length).toBeGreaterThanOrEqual(5);
    expect(attempts.map(deliveredStatus).every((st) => st === 503)).toBe(true);
    // The backend itself committed on the first and replayed every later attempt (its own answer was 200 each time).
    expect(attempts.map((e) => e.status).every((st) => st === 200)).toBe(true);
    // Paused: nothing more is sent until the person (or the network) says so.
    await page.waitForTimeout(5_000);
    expect(await commandsLog(before)).toHaveLength(attempts.length);
    await proxy.removeRule(rule.id);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await acknowledged(page, id.account_id, out?.localId as string);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(new Set(sent.map((s) => JSON.stringify(s.body))).size).toBe(1);
    const list = await people(page, id);
    expect(list.filter((p) => p.label === "I-O4 Gateway")).toHaveLength(1);
  });

  test('"Retry now" while the draft is still backing off sends it at once, with the same key; the backend answers with its stored reply', async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const sent = recordCommands(page);
    await leader(page, id.account_id);
    const { rule, before } = await failing();
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O4 Retry now") as never,
    );
    expect(out?.kind).toBe("queued");
    await expect
      .poll(async () => (await commandsLog(before)).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    await proxy.removeRule(rule.id);
    await page.evaluate(() => window.__atlasData?.retryOutbox());
    await acknowledged(page, id.account_id, out?.localId as string, 15_000);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    const list = await people(page, id);
    expect(list.filter((p) => p.label === "I-O4 Retry now")).toHaveLength(1);
  });
});

// ---- I-O5: account switch and logout with a non-empty queue -------------------------------------------------------------------------
const logoutConfirmed = (page: Page) =>
  page.evaluate(async () => {
    const unsynced = await window.__s.operations.summariseLocalWork();
    if (!unsynced) throw new Error("nobody is settled");
    const started = await window.__s.operations.logout({ unsynced });
    return { started: started.kind, count: unsynced.count };
  });
const chooseConsent = (page: Page, choice: "delete" | "keep") =>
  page.evaluate(async (c) => {
    const current = window.__s.view.get() as { consent?: { ticket: string } };
    if (!current.consent) throw new Error("no consent prompt is showing");
    return window.__s.wipe.resolveConsent(current.consent.ticket as never, c);
  }, choice);
const databaseNames = (page: Page) =>
  page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? ""),
  );
const hasDatabase = async (page: Page, account: string) =>
  (await databaseNames(page)).some((n) => n.includes(account));
const ledgerOf = async (page: Page) => (await records(page)).pending_deletions;
const LOGOUT_PATH = "/^\\/api\\/experimental\\/v1\\/sessions\\/[^/]+$/";

/** An unfinished form saved while the logout request is in flight (a recovery write is allowed until the closing write). */
const saveFormDuringLogout = (page: Page, account: string) =>
  page.evaluate(async (acct) => {
    const data = window.__atlasData;
    if (!data) throw new Error("no data harness");
    data.setIdentity(acct);
    await data.open(acct);
    await data.put(acct, "form_recovery", [
      {
        form_context: "i-o5-form",
        tab_instance_id: "tab",
        fields: { title: "unfinished" },
        redacted: [],
        saved_at: new Date().toISOString(),
        capture_seq: 1,
        terminal: false,
        content_digest: "digest-i-o5",
      },
    ]);
  }, account);

/** Logs alice out with a held DELETE and a form saved while it is in flight, so the wipe must ask again. Returns when the prompt shows. */
async function logoutUntilReconfirm(page: Page, account: string) {
  const hold = await proxy.addRule({
    method: "DELETE",
    path: LOGOUT_PATH,
    action: "hold_request",
    ordinal: 1,
  });
  const result = await logoutConfirmed(page);
  expect(result.started).toBe("started");
  await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
  // The fence is durable BEFORE the network call: the held DELETE is in flight and the account's operation fence is already recorded.
  const fences = (await records(page)).auth_state.fences[account] ?? [];
  expect(fences.map((f) => f.kind)).toContain("operation");
  await saveFormDuringLogout(page, account);
  await proxy.release(hold.id);
  await untilView(page, "neutral", "wipe.consent");
  return result;
}

test.describe("I-O5: a queue is the account's own, across switch and logout", () => {
  test("alice's queued draft is NOT sent while bob is settled (nothing goes out under bob's credentials); it is sent, once, when alice signs in again; bob never sees it", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    await leader(page, alice.account_id, { startOutbox: false });
    const mine = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O5 Alice queued") as never,
    );
    expect(mine?.kind).toBe("queued");

    // The switch: a direct sign-in of another account (the person did not log out). Alice's records are untouched.
    await page.evaluate(() => window.__atlasData?.stopOutbox());
    const before = (await proxy.log()).length;
    expect((await signIn(page, "bob")).kind).toBe("settled");
    await untilView(page, "displaying");
    const bob = await identity(page);
    if (!bob) throw new Error("no identity after the switch");
    expect(bob.account_id).not.toBe(alice.account_id);
    await leader(page, bob.account_id);
    const bobs = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O5 Bob own") as never,
    );
    await acknowledged(page, bob.account_id, bobs?.localId as string);
    await page.waitForTimeout(2_000);
    // Exactly ONE command left the page while bob was settled: bob's own. Alice's draft never went out.
    expect(await commandsLog(before)).toHaveLength(1);
    expect((await people(page, bob)).map((p) => p.label)).toContain(
      "I-O5 Bob own",
    );
    expect((await people(page, bob)).map((p) => p.label)).not.toContain(
      "I-O5 Alice queued",
    );

    // Alice signs in again (a fresh attempt): her kept queue is sent, once.
    await page.evaluate(() => window.__atlasData?.stopOutbox());
    expect((await signIn(page, me())).kind).toBe("settled");
    await untilView(page, "displaying");
    const again = await identity(page);
    if (!again) throw new Error("no identity after switching back");
    expect(again.account_id).toBe(alice.account_id);
    await leader(page, again.account_id);
    await acknowledged(page, again.account_id, mine?.localId as string);
    expect(await commandsLog(before)).toHaveLength(2);
    expect((await people(page, again)).map((p) => p.label)).toContain(
      "I-O5 Alice queued",
    );
    const bobRaw = await rawSignIn("bob");
    const seenByBob = await raw("GET", "/people", {
      cookie: bobRaw.cookie,
      headers: { "x-csrf-token": bobRaw.csrf },
    });
    expect(
      (seenByBob.json as { items: Array<{ label: string }> }).items.map(
        (p) => p.label,
      ),
    ).not.toContain("I-O5 Alice queued");
  });

  test("I-W1: a CONFIRMED logout (the person was told the count and agreed) deletes the account's database and the queue; nothing was sent, and signing in again finds an empty queue", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    await leader(page, alice.account_id, { startOutbox: false });
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O5 Confirmed") as never,
    );
    expect(out?.kind).toBe("queued");
    const before = (await proxy.log()).length;
    expect(await logoutConfirmed(page)).toEqual({
      started: "started",
      count: 1,
    });
    await untilView(page, "signed_out");
    await expect.poll(() => hasDatabase(page, alice.account_id)).toBe(false);
    await expect.poll(() => ledgerOf(page)).toEqual({});
    expect(await commandsLog(before)).toEqual([]);
    const again = await signedIn(page, me());
    await leader(page, again.account_id, { startOutbox: false });
    expect(await queue(page, again.account_id)).toEqual([]);
  });

  test("I-W1: work that arrives while the logout is in flight is asked about AGAIN (the real consent schedule): KEEP leaves the database and the queue, and nothing was sent", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    await leader(page, alice.account_id, { startOutbox: false });
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O5 Keep") as never,
    );
    expect(out?.kind).toBe("queued");
    const before = (await proxy.log()).length;
    const result = await logoutUntilReconfirm(page, alice.account_id);
    expect(result.count).toBe(1);
    const view = (await page.evaluate(() => window.__s.view.get())) as {
      consent?: { count: number };
    };
    expect(view.consent?.count).toBe(2);
    expect((await ledgerOf(page))[alice.account_id]?.status).toBe(
      "awaiting_consent",
    );
    await chooseConsent(page, "keep");
    await expect.poll(() => ledgerOf(page)).toEqual({});
    expect(await hasDatabase(page, alice.account_id)).toBe(true);
    expect(await commandsLog(before)).toEqual([]);
    // Signed in again, the same draft is still there, and still queued.
    await untilView(page, "signed_out");
    const again = await signedIn(page, me());
    await leader(page, again.account_id, { startOutbox: false });
    expect((await queue(page, again.account_id)).map((d) => d.status)).toEqual([
      "queued",
    ]);
  });

  test("I-W1: the same prompt, answered DELETE: the database and the ledger entry go, and nothing was sent", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    await leader(page, alice.account_id, { startOutbox: false });
    const out = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O5 Discard") as never,
    );
    expect(out?.kind).toBe("queued");
    const before = (await proxy.log()).length;
    await logoutUntilReconfirm(page, alice.account_id);
    await chooseConsent(page, "delete");
    await expect.poll(() => hasDatabase(page, alice.account_id)).toBe(false);
    await expect.poll(() => ledgerOf(page)).toEqual({});
    await untilView(page, "signed_out");
    expect(await commandsLog(before)).toEqual([]);
  });
});

// ---- I-C1 / I-C2: ordinary delta sync against the released backend ----------------------------------------------------------------
interface SyncExchange {
  cursor: string | null;
  limit: number | null;
  status: number;
  next: string | null;
  hasMore: boolean | null;
  phase: string | null;
}
/** Every `GET /sync` the page makes, with what the BROWSER was answered (the body is read from the response the page received). */
function recordSync(page: Page): SyncExchange[] {
  const seen: SyncExchange[] = [];
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
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : null,
      status: response.status(),
      next: body?.next_cursor ?? null,
      hasMore: body?.has_more ?? null,
      phase: body?.phase ?? null,
    });
  });
  return seen;
}
const nudgeSync = (page: Page) =>
  page.evaluate(() => window.__atlasData?.nudgeSync());
const syncState = (page: Page, account: string) =>
  page.evaluate((a) => window.__atlasData?.syncState(a), account) as Promise<{
    cursor: string | null;
    phase: string;
    cache_status: string;
    read_retry_states: Record<string, { state: string; failures?: number }>;
  } | null>;

test.describe("I-C1: real changes arrive through ordinary delta pages", () => {
  test("ten real creates (ten batches) are read in several `has_more` pages: cursors are opaque and advance, `limit` is always at most 80, and the cache holds every one", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const pages = recordSync(page);
    await leader(page, id.account_id, { sync: true });
    const seeded = await syncState(page, id.account_id);
    expect(seeded?.phase).toBe("delta");
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    pages.length = 0;
    const startAt = (await proxy.log()).length;

    const other = await rawSignIn(me());
    const made = Array.from({ length: 10 }, (_, n) => ({
      id: uuid(),
      name: `I-C1 Person ${n}`,
    }));
    // One command per request: the page size counts BATCHES (one per request), so ten requests are ten batches to read.
    for (const p of made) {
      const answered = await rawCommand(other, [
        { kind: "create_person", id: p.id, name: p.name },
      ]);
      expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    }
    await nudgeSync(page);
    await expect
      .poll(
        async () => {
          const cache = await rowsOf(page, id.account_id, "cache");
          return made.every((p) => cache.some((r) => r.id === p.id));
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    const got = pages.filter((p) => p.status === 200);
    expect(got.length, JSON.stringify(pages)).toBeGreaterThanOrEqual(2);
    // Pagination: the first page said there is more; each request carries the previous answer's cursor; the last says there is not.
    expect(got[0]?.hasMore).toBe(true);
    expect(got[got.length - 1]?.hasMore).toBe(false);
    for (let n = 1; n < got.length; n += 1)
      expect(got[n]?.cursor, `request ${n} carries the previous cursor`).toBe(
        got[n - 1]?.next,
      );
    // Opaque and advancing: strings the client never builds, distinct from one another, within the contract's length.
    const cursors = got.map((p) => p.next as string);
    expect(new Set(cursors).size).toBe(cursors.length);
    for (const c of cursors) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(512);
    }
    expect(got.every((p) => p.phase === "delta")).toBe(true);
    // `limit` in what the page asked AND in the proxy's own log is always at most 80.
    expect(
      got.every((p) => p.limit !== null && p.limit >= 1 && p.limit <= 80),
    ).toBe(true);
    const logged = (await proxy.log())
      .slice(startAt)
      .filter((e) => e.method === "GET" && e.path.includes("/sync"));
    expect(logged.length).toBeGreaterThanOrEqual(got.length);
    for (const entry of logged) {
      const limit = Number(
        new URL(entry.path, "http://x").searchParams.get("limit"),
      );
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(80);
    }
    // The durable cursor is the last answer's: the next poll resumes from it.
    expect((await syncState(page, id.account_id))?.cursor).toBe(
      cursors[cursors.length - 1],
    );
    expect(
      (await rowsOf(page, id.account_id, "cache")).filter((r) =>
        String(r.label).startsWith("I-C1 Person"),
      ),
    ).toHaveLength(10);
  });
});

test.describe("I-C2: GET /sync failures", () => {
  test("a REAL 401 (the session was revoked elsewhere) is auth_state: the engine pauses for the session and the failure is not counted as a read failure", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const settled = (await records(page)).auth_state.settled;
    const exchanges = recordSync(page);
    await leader(page, id.account_id, { sync: true });
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    exchanges.length = 0;
    const revoker = await rawSignIn(me());
    const revoked = await raw("DELETE", `/sessions/${settled?.session_id}`, {
      cookie: revoker.cookie,
      headers: { "x-csrf-token": revoker.csrf },
    });
    expect([200, 204]).toContain(revoked.status);
    await nudgeSync(page);
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "the 401 is recorded as an invalid_session fence",
    );
    // The session closed the account, so the engine WAITS (its service is no longer live): not backing off, not paused, not stopped.
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "waiting" });
    expect(exchanges.map((e) => e.status)).toEqual([401]);
    await page.waitForTimeout(2_500);
    expect(exchanges).toHaveLength(1);
  });

  test("a REAL credential mismatch (another account's cookie under this page's stamp) is auth_state and a fence; the one refused request is the last", async ({
    context,
    provokes,
  }) => {
    provokes(401, 403);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    await leader(page, id.account_id, { sync: true });
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    const exchanges = recordSync(page);
    const stranger = await rawSignIn("bob");
    await swapCookie(context, stranger);
    await nudgeSync(page);
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some(
            (f) => f.kind === "drift" || f.kind === "credential_unverified",
          ),
      "the mismatch is fenced",
    );
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "waiting" });
    // One refused request (401 or 403, whichever the backend gives a mismatched credential), none after it, nothing applied.
    expect(exchanges).toHaveLength(1);
    expect([401, 403]).toContain(exchanges[0]?.status);
    await page.waitForTimeout(2_500);
    expect(exchanges).toHaveLength(1);
  });
});

// PROXY-INJECTED: the released backend does not produce these on demand; the delaying proxy answers the page's `GET /sync` with the
// status below (after the backend has answered, with an empty JSON body). They prove the engine's mapping, not the backend's.
test.describe("I-C2 (proxy-injected statuses)", () => {
  const injectedSync = async (page: Page, account: string, status: number) => {
    const exchanges = recordSync(page);
    await leader(page, account, { sync: true });
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    exchanges.length = 0;
    const rule = await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      action: "rewrite_status",
      status,
    });
    await nudgeSync(page);
    return { exchanges, rule };
  };

  for (const status of [410, 400, 422]) {
    test(`${status} (proxy-injected) invalidates the cache and stops the engine for recovery (WEB-09b's job): exactly one request, never a retry loop`, async ({
      context,
      provokes,
    }) => {
      provokes(status);
      const page = await bootHarness(context);
      const id = await signedIn(page, me());
      const { exchanges } = await injectedSync(page, id.account_id, status);
      await expect
        .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
        .toMatchObject({ kind: "stopped", cause: "no_recovery" });
      expect((await syncState(page, id.account_id))?.cache_status).toBe(
        "invalid",
      );
      await page.waitForTimeout(2_500);
      expect(exchanges.map((e) => e.status)).toEqual([status]);
    });
  }

  test("409 (proxy-injected; the delta phase has no 409 access_changed) is an UNRECOGNISED response: counted, backed off, and the engine STOPS on the third (an explicit retry leaves it)", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const { exchanges } = await injectedSync(page, id.account_id, 409);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()), {
        timeout: 60_000,
      })
      .toMatchObject({ kind: "stopped", cause: "unrecognised" });
    expect(exchanges.map((e) => e.status)).toEqual([409, 409, 409]);
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ paused: true, unrecognised_streak: 3 });
    await page.waitForTimeout(3_000);
    expect(exchanges).toHaveLength(3);
  });

  test("REVISION R4: after the unrecognised stop, ONE explicit retry sends a request (it used to fall back into the persisted pause); the engine returns to idle and the stop is cleared", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const { exchanges, rule } = await injectedSync(page, id.account_id, 409);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()), {
        timeout: 60_000,
      })
      .toMatchObject({ kind: "stopped", cause: "unrecognised" });
    expect(exchanges.map((e) => e.status)).toEqual([409, 409, 409]);
    await proxy.removeRule(rule.id);
    await page.evaluate(() => window.__atlasData?.retrySync());
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()), {
        timeout: 30_000,
      })
      .toMatchObject({ kind: "idle" });
    // Exactly one further request was needed, and it was answered by the real backend.
    expect(exchanges.slice(3).map((e) => e.status)).toEqual([200]);
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ paused: false, unrecognised_streak: 0 });
  });

  test("REVISION R4: a sustained 503 pauses the sync caller (the production 180 s), nothing more is sent, and the page coming back online resumes it by itself", async ({
    context,
    provokes,
  }) => {
    test.setTimeout(420_000);
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const { exchanges, rule } = await injectedSync(page, id.account_id, 503);
    await expect
      .poll(() => syncState(page, id.account_id), {
        timeout: 360_000,
        intervals: [2_000],
      })
      .toMatchObject({ read_retry_states: { sync: { paused: true } } });
    expect(
      await page.evaluate(() => window.__atlasData?.engineState()),
    ).toMatchObject({
      kind: "paused",
    });
    expect(exchanges.every((e) => e.status === 503)).toBe(true);
    const sentWhilePaused = exchanges.length;
    await page.waitForTimeout(5_000);
    expect(exchanges).toHaveLength(sentWhilePaused);
    await proxy.removeRule(rule.id);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()), {
        timeout: 30_000,
      })
      .toMatchObject({ kind: "idle" });
    expect(exchanges.at(-1)?.status).toBe(200);
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ backing_off_since: null, paused: false });
  });

  test("503 (proxy-injected) is a counted READ failure with back-off (never an unrecognised one); it recovers by itself when the answers return", async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const { exchanges, rule } = await injectedSync(page, id.account_id, 503);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "backing_off" });
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ unrecognised_streak: 0, paused: false });
    expect(exchanges.every((e) => e.status === 503)).toBe(true);
    await proxy.removeRule(rule.id);
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()), {
        timeout: 30_000,
      })
      .toMatchObject({ kind: "idle" });
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ backing_off_since: null, paused: false });
  });
});

// ---- I-S1: the commit guard against the real session, with a REAL answer held on /sync ----------------------------------------------
/** An account's database read straight from IndexedDB (read-only), without the data layer: its cursor, and whether a resource is cached. */
const accountContents = (page: Page, account: string, resource: string) =>
  page.evaluate(
    async ({ a, r }) => {
      const names = (await indexedDB.databases())
        .map((d) => d.name ?? "")
        .filter((n) => n.includes(a));
      const name = names[0];
      if (names.length !== 1 || !name)
        return {
          exists: false,
          hasPerson: false,
          cursor: null as string | null,
        };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction(["sync_state", "cache"], "readonly");
        const get = <T>(store: string, key?: string) =>
          new Promise<T>((resolve, reject) => {
            const request =
              key === undefined
                ? tx.objectStore(store).getAll()
                : tx.objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result as T);
            request.onerror = () => reject(request.error);
          });
        const sync = await get<{ cursor: string | null } | undefined>(
          "sync_state",
          "singleton",
        );
        const cache = await get<Array<{ id: string }>>("cache");
        return {
          exists: true,
          hasPerson: cache.some((row) => row.id === r),
          cursor: sync?.cursor ?? null,
        };
      } finally {
        db.close();
      }
    },
    { a: account, r: resource },
  );

test.describe("I-S1: an answer that arrives after the account moved on is not applied", () => {
  async function holdOneSyncRead(page: Page, account: string) {
    await leader(page, account, { sync: true });
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    const before = await syncState(page, account);
    // Something real to read: another session of the same account creates a person.
    const other = await rawSignIn(me());
    const personId = uuid();
    const made = await rawCommand(other, [
      { kind: "create_person", id: personId, name: "I-S1 Late" },
    ]);
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const hold = await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      action: "hold",
      ordinal: 1,
    });
    await nudgeSync(page);
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    return { hold, before, personId };
  }

  test("the account is SWITCHED while the answer is held: the late page is dropped (nothing applied, the cursor unmoved); when the account returns, the change is read again and applied once", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    const { hold, before, personId } = await holdOneSyncRead(
      page,
      alice.account_id,
    );
    // The switch (alice's records are untouched; bob settles) happens WHILE the engine's request is in flight, then the held answer is
    // let through. The engine is NOT stopped: it is the commit guard that has to refuse the page.
    expect((await signIn(page, "bob")).kind).toBe("settled");
    await untilView(page, "displaying");
    await proxy.release(hold.id);
    await page.waitForTimeout(1_500);
    const entry = (await proxy.log()).find(
      (e) => e.rule === hold.id && e.path.includes("/sync"),
    );
    expect(entry?.events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["held", "delivered"]),
    );
    // Alice's database, read straight from IndexedDB while bob is displayed: the cursor did not move and the person is not in it.
    const left = await accountContents(page, alice.account_id, personId);
    expect(left).toMatchObject({ exists: true, hasPerson: false });
    expect(left.cursor).toBe(before?.cursor);

    await page.evaluate(() => window.__atlasData?.stopSync());
    expect((await signIn(page, me())).kind).toBe("settled");
    await untilView(page, "displaying");
    await page.evaluate(
      (a) => window.__atlasData?.startSync(a),
      alice.account_id,
    );
    await nudgeSync(page);
    await expect
      .poll(
        async () =>
          (await rowsOf(page, alice.account_id, "cache")).filter(
            (r) => r.id === personId,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
  });

  test("the account is LOGGED OUT and wiped while the answer is held: the late page is dropped and no database is re-created", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const alice = await signedIn(page, me());
    const { hold } = await holdOneSyncRead(page, alice.account_id);
    expect(await logoutConfirmed(page)).toMatchObject({ started: "started" });
    await untilView(page, "signed_out");
    await expect.poll(() => hasDatabase(page, alice.account_id)).toBe(false);
    await proxy.release(hold.id);
    await page.waitForTimeout(2_000);
    expect(await hasDatabase(page, alice.account_id)).toBe(false);
    expect(await ledgerOf(page)).toEqual({});
  });
});

// ---- I-P1 (continued): a profile that does not belong to the account is never shown -------------------------------------------------
test.describe("I-P1: a mismatched identity is rejected", () => {
  test("a /me answer naming ANOTHER id (proxy-rewritten) shows nothing; after the person signs in again (a new epoch) the verified read is made again and the username appears", async ({
    context,
  }) => {
    const rewrite = await proxy.addRule({
      method: "GET",
      path: `${API}/me`,
      action: "rewrite_json",
      set: { id: crypto.randomUUID() },
    });
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    await expect
      .poll(
        async () =>
          (await proxy.log()).filter((e) => e.path === `${API}/me`).length,
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1_500);
    await expect(
      page.getByText(ACCOUNTS[me()].username, { exact: true }),
    ).toHaveCount(0);
    const askedBefore = (await proxy.log()).filter(
      (e) => e.path === `${API}/me`,
    ).length;

    await proxy.removeRule(rewrite.id);
    expect((await signIn(page, me())).kind).toBe("settled");
    await untilView(page, "displaying");
    const again = await identity(page);
    expect(again?.account_id).toBe(id.account_id);
    expect(again?.epoch).toBeGreaterThan(id.epoch);
    await expect(
      page.getByText(ACCOUNTS[me()].username, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    expect(
      (await proxy.log()).filter((e) => e.path === `${API}/me`).length,
    ).toBeGreaterThan(askedBefore);
  });
});

// PROXY-INJECTED (`replace_response`): an Atlas-formatted error BODY with its `code`, which `rewrite_status` (an empty body) cannot
// carry. The released backend does not produce these on demand; they prove the client's mapping of the code, not the backend's.
const atlasBody = (code: string) => ({
  code,
  message: "injected by the delaying proxy",
  request_id: "11111111-1111-4111-8111-111111111111",
  details: [],
});

test.describe("proxy-injected Atlas error bodies (replace_response)", () => {
  async function injectSync(
    page: Page,
    account: string,
    status: number,
    code: string,
  ) {
    const exchanges = recordSync(page);
    await leader(page, account, { sync: true });
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "idle" });
    exchanges.length = 0;
    await proxy.addRule({
      method: "GET",
      path: `${API}/sync`,
      action: "replace_response",
      status,
      json: atlasBody(code),
    });
    await nudgeSync(page);
    return exchanges;
  }

  test("I-C2: GET /sync 503 device_capacity stops the engine, blocking, with no retry", async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const exchanges = await injectSync(
      page,
      id.account_id,
      503,
      "device_capacity",
    );
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "stopped", cause: "device_capacity" });
    await page.waitForTimeout(2_500);
    expect(exchanges.map((e) => e.status)).toEqual([503]);
  });

  test("I-C2: GET /sync 409 access_changed (an Atlas-formatted body) is an UNRECOGNISED response in the delta phase: counted and backed off", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    const exchanges = await injectSync(
      page,
      id.account_id,
      409,
      "access_changed",
    );
    await expect
      .poll(() => page.evaluate(() => window.__atlasData?.engineState()))
      .toMatchObject({ kind: "backing_off" });
    expect(
      (await syncState(page, id.account_id))?.read_retry_states.sync,
    ).toMatchObject({ unrecognised_streak: 1, paused: false });
    expect(exchanges.map((e) => e.status)[0]).toBe(409);
  });

  test("I-O2: POST /commands 503 slice_capacity BLOCKS the draft (retained, never resent), and an independent draft behind it is still sent", async ({
    context,
    provokes,
  }) => {
    provokes(503);
    const page = await bootHarness(context);
    const id = await signedIn(page, me());
    await leader(page, id.account_id);
    const rule = await proxy.addRule({
      method: "POST",
      path: `${API}/commands`,
      action: "replace_response",
      status: 503,
      json: atlasBody("slice_capacity"),
      ordinal: 1,
    });
    const first = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O2 Capacity") as never,
    );
    await expect
      .poll(
        async () =>
          (await queue(page, id.account_id)).find(
            (d) => d.local_id === first?.localId,
          )?.status,
        { timeout: 30_000 },
      )
      .toBe("blocked");
    // The rule was for ONE request: the next draft goes through the real backend.
    const second = await page.evaluate(
      (spec) => window.__atlasData?.enqueue(spec),
      create(uuid(), "I-O2 After capacity") as never,
    );
    await acknowledged(page, id.account_id, second?.localId as string);
    expect(
      (await queue(page, id.account_id)).find(
        (d) => d.local_id === first?.localId,
      )?.status,
    ).toBe("blocked");
    expect(rule.id).toBeTruthy();
    const sentFirst = (await commandsLog()).filter((e) => e.rule === rule.id);
    expect(sentFirst).toHaveLength(1);
  });
});
