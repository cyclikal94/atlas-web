import type { BrowserContext, Page } from "@playwright/test";
import { stored } from "../pair/stored";
import {
  ACCOUNT,
  displayed,
  fresh,
  type LeaderNet,
  untilLeader,
} from "./data-leader-helpers";
import { expect, test } from "./helpers";

/**
 * WEB-09c revision 38 (R38-DIAG; design assessment C1/C2, Q1 and Q3): the development-pair page's DIAGNOSTIC compatibility policy through the
 * REAL production composition in each engine: the fixture session harness's descriptor (`?pairApi=<exact version>&pairSelection=<SHA-256>`,
 * only with `?leader=production`), boot's `diagnosticCompatibility`, the session's real `/health` check and its one compatibility store, the
 * production leader's outbox dispatcher gate (W5/W6) and the production outbox facade (W2). The stubbed `/health` answers the version a case
 * names; nothing else is altered and no receipt is seeded:
 *   - the released range (no descriptor) sends at 0.31.0 and keeps a draft queued, never attempted, at 0.32.0 (the exact F-O11 combination);
 *   - the exact policy for 0.30.0 sends at 0.30.0 and refuses 0.30.1 and 0.29.0 (it admits ONE version, never a wider range);
 *   - a malformed or incomplete descriptor is refused by the harness before boot (no session, no `/health`);
 *   - each DOCUMENT establishes its own policy: a follower without it is unsupported while the leader with it sends the follower's draft; once
 *     that leader is gone the follower leads and holds a new draft; reloaded with the policy it sends the held draft once.
 * FIXTURE evidence: the network is stubbed (data-leader-helpers.ts) and no backend runs; the approved diagnostic executable is not involved.
 */

const SELECTION = "a".repeat(64);
const RELEASED = ">=0.31.0 <0.32.0";

/** The `/health` answer for the context (registered after `leaderNetwork`'s, so it wins), and the count of requests it answered. */
async function healthAt(context: BrowserContext, version: string) {
  const asked = { count: 0 };
  await context.route("**/health", (route) => {
    asked.count += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: version }),
    });
  });
  return asked;
}

const policyQuery = (api: string | null, selection: string | null) =>
  `${api === null ? "" : `&pairApi=${encodeURIComponent(api)}`}${selection === null ? "" : `&pairSelection=${selection}`}`;

/** A production-leader session page, with (or without) the descriptor in its own address. */
async function page(
  context: BrowserContext,
  net: LeaderNet,
  name: string,
  policy: string | null,
  existing?: Page,
): Promise<Page> {
  const p = existing ?? (await context.newPage());
  net.label(p, name);
  await p.goto(
    `/__session?route=%2Ftoday&leader=production${policy === null ? "" : policyQuery(policy, SELECTION)}`,
  );
  await p.waitForFunction(
    () => window.__atlasFixture?.session?.booted !== undefined,
  );
  await p.evaluate(() => window.__atlasFixture?.session?.ready);
  await p.waitForFunction(() => window.__atlasData !== undefined);
  return p;
}

const recordOf = (p: Page) =>
  p.evaluate(() => window.__atlasFixture?.session?.compatibility ?? null);
/** The session's own verdict once its real `/health` check has been judged (never `unknown`); the last value is asserted. */
async function verdictOf(p: Page) {
  let verdict: unknown = null;
  await expect
    .poll(
      async () => {
        verdict = await p.evaluate(
          () => window.__atlasFixture?.session?.compat() ?? null,
        );
        return (verdict as { status?: string } | null)?.status ?? "none";
      },
      { timeout: 15_000, message: "the page's compatibility is judged" },
    )
    .not.toMatch(/^(none|unknown)$/);
  return verdict;
}
const outboxOf = (p: Page) =>
  p.evaluate(() => window.__atlasFixture?.session?.outboxState() ?? null);

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
async function save(p: Page, name: string): Promise<string> {
  const queued = (await p.evaluate(
    (given) =>
      (
        window as unknown as {
          __atlasFixture: {
            session: { enqueue(spec: unknown): Promise<unknown> };
          };
        }
      ).__atlasFixture.session.enqueue(given),
    createPerson(crypto.randomUUID(), name),
  )) as { kind: string; localId?: string };
  expect(queued.kind, JSON.stringify(queued)).toBe("queued");
  return queued.localId as string;
}
const draftOf = async (p: Page, localId: string) =>
  ((await stored(p, ACCOUNT, false, []))?.local?.drafts ?? []).find(
    (d) => d.local_id === localId,
  ) ?? null;

/** The draft is sent ONCE with its local id as the key (by `from`) and its receipt admitted (W6); the outbox's real answer. */
async function sentOnce(
  p: Page,
  net: LeaderNet,
  localId: string,
  from: string,
) {
  await expect
    .poll(async () => (await draftOf(p, localId))?.receipt_revision ?? null, {
      timeout: 15_000,
      message: "the draft's receipt is admitted",
    })
    .not.toBeNull();
  expect(net.commands.filter((c) => c.key === localId)).toEqual([
    { page: from, path: "/commands", key: localId },
  ]);
}
/** The production dispatcher is paused unsupported and the draft is kept queued, never attempted; nothing carried its key. */
async function heldUnsupported(p: Page, net: LeaderNet, localId: string) {
  await expect
    .poll(() => outboxOf(p), {
      timeout: 15_000,
      message: "the production dispatcher pauses, unsupported",
    })
    .toEqual({ kind: "paused", reason: "compat_unsupported" });
  expect(await draftOf(p, localId)).toMatchObject({
    status: "queued",
    attempts: 0,
    receipt_revision: null,
  });
  expect(net.commands.filter((c) => c.key === localId)).toEqual([]);
}

test.describe("WEB-09c r38: the development-pair page's compatibility policy through the production composition (R38-DIAG)", () => {
  test("released range (no descriptor), /health 0.31.0: supported; the production dispatcher sends a saved draft once and admits its receipt", async ({
    context,
  }) => {
    const net = await fresh(context);
    await healthAt(context, "0.31.0");
    const p = await page(context, net, "leader", null);
    await displayed(p);
    expect(await recordOf(p)).toBeNull();
    expect(await verdictOf(p)).toEqual({
      status: "supported",
      version: "0.31.0",
    });
    await sentOnce(p, net, await save(p, "R38 released"), "leader");
  });

  test("released range (no descriptor), /health 0.32.0: unsupported; the draft is kept queued, never attempted, and nothing is sent", async ({
    context,
  }) => {
    const net = await fresh(context);
    await healthAt(context, "0.32.0");
    const p = await page(context, net, "leader", null);
    await displayed(p);
    expect(await verdictOf(p)).toEqual({
      status: "unsupported",
      version: "0.32.0",
      supported: RELEASED,
    });
    await heldUnsupported(p, net, await save(p, "R38 released held"));
    expect(net.commands).toEqual([]);
  });

  test("exact policy 0.30.0, /health 0.30.0: recorded beside the released range; supported; sent once and receipted", async ({
    context,
  }) => {
    const net = await fresh(context);
    const asked = await healthAt(context, "0.30.0");
    const p = await page(context, net, "leader", "0.30.0");
    await displayed(p);
    expect(await recordOf(p)).toEqual({
      selection: SELECTION,
      apiVersion: "0.30.0",
      released: RELEASED,
      effective: ">=0.30.0 <0.30.1",
    });
    expect(await verdictOf(p)).toEqual({
      status: "supported",
      version: "0.30.0",
    });
    // The verdict is the real /health's, not assumed from the descriptor.
    expect(asked.count).toBeGreaterThan(0);
    await sentOnce(p, net, await save(p, "R38 exact"), "leader");
  });

  for (const health of ["0.30.1", "0.29.0"])
    test(`exact policy 0.30.0, /health ${health}: unsupported (one version only); held, nothing sent`, async ({
      context,
    }) => {
      const net = await fresh(context);
      await healthAt(context, health);
      const p = await page(context, net, "leader", "0.30.0");
      await displayed(p);
      expect(await verdictOf(p)).toEqual({
        status: "unsupported",
        version: health,
        supported: ">=0.30.0 <0.30.1",
      });
      await heldUnsupported(p, net, await save(p, `R38 exact ${health}`));
      expect(net.commands).toEqual([]);
    });

  for (const [what, query] of [
    ["a version without a selection", policyQuery("0.30.0", null)],
    ["a selection without a version", policyQuery(null, SELECTION)],
    ["a partial version", policyQuery("0.30", SELECTION)],
    ["a pre-release version", policyQuery("0.30.0-rc.1", SELECTION)],
    ["a range instead of a version", policyQuery(">=0.30.0", SELECTION)],
    ["a selection that is not a SHA-256", policyQuery("0.30.0", "ABC")],
  ] as const)
    test(`a malformed descriptor (${what}) is refused before boot: no session, no /health`, async ({
      context,
    }) => {
      await fresh(context);
      const asked = await healthAt(context, "0.30.0");
      const p = await context.newPage();
      const errors: string[] = [];
      p.on("pageerror", (error) => errors.push(error.message));
      await p.goto(`/__session?route=%2Ftoday&leader=production${query}`);
      await p.waitForFunction(
        () => window.__atlasFixture?.session !== undefined,
      );
      await expect
        .poll(() => errors.length, { message: "the harness refuses it" })
        .toBeGreaterThan(0);
      expect(errors.join("\n")).toMatch(
        /pairApi=|pairSelection=|Not an exact API version/,
      );
      expect(
        await p.evaluate(() => ({
          booted: window.__atlasFixture?.session?.booted ?? null,
          compatibility: window.__atlasFixture?.session?.compatibility ?? null,
          compat: window.__atlasFixture?.session?.compat() ?? null,
        })),
      ).toEqual({ booted: null, compatibility: null, compat: null });
      expect(asked.count, "no session asked /health").toBe(0);
    });

  test("a descriptor without the production leader is refused before boot", async ({
    context,
  }) => {
    await fresh(context);
    const asked = await healthAt(context, "0.30.0");
    const p = await context.newPage();
    const errors: string[] = [];
    p.on("pageerror", (error) => errors.push(error.message));
    await p.goto(
      `/__session?route=%2Ftoday${policyQuery("0.30.0", SELECTION)}`,
    );
    await p.waitForFunction(() => window.__atlasFixture?.session !== undefined);
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/needs \?leader=production/);
    expect(
      await p.evaluate(() => window.__atlasFixture?.session?.booted ?? null),
    ).toBeNull();
    expect(asked.count).toBe(0);
  });

  test("per document: a follower without the policy is unsupported while the leader with it sends the follower's draft; leading after the takeover it holds a new draft; reloaded with the policy it sends that draft once", async ({
    context,
  }) => {
    const net = await fresh(context);
    await healthAt(context, "0.30.0");
    const leader = await page(context, net, "leader", "0.30.0");
    await displayed(leader);
    expect(await verdictOf(leader)).toEqual({
      status: "supported",
      version: "0.30.0",
    });
    const follower = await page(context, net, "follower", null);
    expect(
      (await untilLeader(follower, (v) => v.attachment === "follower"))
        .attachment,
    ).toBe("follower");
    expect(await recordOf(follower)).toBeNull();
    expect(await verdictOf(follower)).toEqual({
      status: "unsupported",
      version: "0.30.0",
      supported: RELEASED,
    });
    // The follower's save is sent by the LEADER's dispatcher (its policy), once.
    await sentOnce(leader, net, await save(follower, "R38 follower"), "leader");
    // The leader leaves: the follower takes the leadership with ITS OWN (released) policy, which the other document's never widened.
    await leader.close();
    expect(
      (await untilLeader(follower, (v) => v.attachment === "leader"))
        .attachment,
    ).toBe("leader");
    const held = await save(follower, "R38 held after the takeover");
    await heldUnsupported(follower, net, held);
    // Reloaded WITH the policy: a new document establishes it before boot and sends the held draft once, as itself.
    await page(context, net, "reloaded", "0.30.0", follower);
    expect(await recordOf(follower)).toEqual({
      selection: SELECTION,
      apiVersion: "0.30.0",
      released: RELEASED,
      effective: ">=0.30.0 <0.30.1",
    });
    expect(await verdictOf(follower)).toEqual({
      status: "supported",
      version: "0.30.0",
    });
    await sentOnce(follower, net, held, "reloaded");
    expect(net.commands).toHaveLength(2);
  });
});
