import { appendFileSync, mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./helpers";

/**
 * P-2 and P-4 (plan 12.3): MEASUREMENTS, not budgets. Real Chromium, Firefox and WebKit through the session harness, no backend.
 * Skipped unless ATLAS_PROFILE=1 (`pnpm profile:session`). Every figure is recorded with the engine and the machine; none is an
 * acceptance number: WEB-09a owns per-request write cost and unresolved-lease frequency, WEB-08c owns waits against a
 * back-to-back leader, WEB-15 owns the version matrix.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:session`",
);

const OUT = ".agtx/evidence/WEB-08a/profiling";
const WARMUP = 20;
const SAMPLES = 300;

function record(
  name: string,
  engine: string,
  samples: number[],
  extra: Record<string, unknown> = {},
): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
    Number.NaN;
  mkdirSync(OUT, { recursive: true });
  appendFileSync(
    `${OUT}/measurements.jsonl`,
    `${JSON.stringify({ name, engine, n: samples.length, p50_ms: +q(0.5).toFixed(3), p95_ms: +q(0.95).toFixed(3), max_ms: +(sorted.at(-1) ?? 0).toFixed(3), ...extra })}\n`,
  );
}
const engineOf = (info: { project: { name: string } }) =>
  info.project.name.replace("fixture-", "");

const settled = (
  account: string,
  epoch: number,
  fences: Record<string, unknown[]> = {},
) => ({
  schema: 1,
  latest_epoch: epoch,
  fence_seq: Object.values(fences).flat().length,
  attempt: null,
  settled: {
    account_id: account,
    epoch,
    settled_at: new Date().toISOString(),
    session_id: "s1",
  },
  fences,
  leases: {},
});

async function stubNetwork(context: BrowserContext): Promise<void> {
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.28.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        account_id: "acct-a",
        session_id: "s1",
        expires_at: new Date(Date.now() + 864e5).toISOString(),
        csrf_token: "csrf.s1",
      }),
    }),
  );
}

/** One page of the harness with no session (`boot=off`): only the production store. */
async function storePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  return page;
}

/**
 * `count` transactions back to back in one page, each a read-modify-write that adds and deletes a lease-shaped entry, which is
 * the shape of a cover transaction and of the clean release that follows it. Returns latency (ms) from `transact` to `complete`.
 */
const timeTransactions = (
  page: Page,
  durability: "strict" | "default",
  count: number,
  kind: "cover" | "recording",
) =>
  page.evaluate(
    async ({ durability: d, count: n, kind: k }) => {
      const harness = window.__atlasFixture?.session;
      if (!harness) throw new Error("no harness");
      const store = await harness.openStore();
      const out: number[] = [];
      for (let i = 0; i < n; i += 1) {
        const started = performance.now();
        await store.transact(
          (records) => {
            const state = structuredClone(records.auth_state);
            if (k === "cover") {
              state.leases[`lease-${i}`] = {
                account_id: "acct-a",
                epoch: 1,
                boot_id: "b",
                created_at: "x",
                class: "ordinary",
              } as never;
              delete state.leases[`lease-${i - 1}`];
            } else {
              state.fence_seq += 1;
              state.fences["acct-a"] = [
                {
                  seq: state.fence_seq,
                  epoch: 1,
                  obs_id: `o${i}`,
                  kind: "invalid_session",
                  reason: "unauthenticated",
                  created_at: "x",
                } as never,
              ];
            }
            return { write: { auth_state: state }, result: null };
          },
          { durability: d },
        ).complete;
        out.push(performance.now() - started);
      }
      store.close();
      return out;
    },
    { durability, count, kind },
  );

test.describe("P-2: IndexedDB micro-costs", () => {
  for (const [label, durability, kind] of [
    ["cover transaction (strict)", "strict", "cover"],
    ["exposure cover (default durability)", "default", "cover"],
    ["recording transaction (strict)", "strict", "recording"],
  ] as const) {
    test(`${label}: one page, then two contending pages`, async ({
      context,
    }, info) => {
      const engine = engineOf(info);
      const a = await storePage(context);
      await timeTransactions(a, durability, WARMUP, kind);
      record(
        `P-2 ${label}, one page`,
        engine,
        await timeTransactions(a, durability, SAMPLES, kind),
      );
      const b = await storePage(context);
      const [fromA, fromB] = await Promise.all([
        timeTransactions(a, durability, SAMPLES, kind),
        timeTransactions(b, durability, SAMPLES, kind),
      ]);
      record(`P-2 ${label}, two contending pages`, engine, [
        ...fromA,
        ...fromB,
      ]);
    });
  }

  test("expose() end to end: from becoming visible to the gate lifting (a settled account, no network beyond a stub)", async ({
    context,
  }, info) => {
    const engine = engineOf(info);
    await stubNetwork(context);
    const seed = await storePage(context);
    await seed.evaluate(
      (state) => window.__atlasFixture?.session?.seedAuthState(state),
      settled("acct-a", 1),
    );
    await seed.close();
    const page = await context.newPage();
    await page.goto("/__session?route=/today");
    await page.waitForFunction(() => {
      const root = document.getElementById("protected-root");
      return (
        root && !root.hasAttribute("inert") && root.querySelector("h1") !== null
      );
    });
    const samples = await page.evaluate(
      async ({ count, warmup }) => {
        const root = document.getElementById("protected-root") as HTMLElement;
        const out: number[] = [];
        const setVisibility = (state: string) => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => state,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        };
        for (let i = 0; i < count + warmup; i += 1) {
          setVisibility("hidden");
          const lifted = new Promise<number>((resolve) => {
            const observer = new MutationObserver(() => {
              if (!root.hasAttribute("inert")) {
                observer.disconnect();
                resolve(performance.now());
              }
            });
            observer.observe(root, {
              attributes: true,
              attributeFilter: ["inert"],
            });
          });
          const started = performance.now();
          setVisibility("visible");
          const at = await lifted;
          if (i >= warmup) out.push(at - started);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return out;
      },
      { count: SAMPLES, warmup: WARMUP },
    );
    record("P-2 expose() end to end (visible -> lifted)", engine, samples);
    expect(samples.length).toBe(SAMPLES);
  });
});

test.describe("P-4: boot to first exposure, offline (row 6)", () => {
  for (const [label, fences] of [
    ["an empty record", {}],
    [
      "a record with fences for two other accounts",
      {
        "acct-x": [
          {
            seq: 1,
            epoch: 1,
            obs_id: "x1",
            kind: "invalid_session",
            reason: "unauthenticated",
            created_at: "x",
          },
        ],
        "acct-y": [
          { seq: 2, epoch: 1, obs_id: "y1", kind: "drift", created_at: "x" },
        ],
      },
    ],
  ] as const) {
    test(`navigation start to the gate lifting with ${label}`, async ({
      browser,
    }, info) => {
      const engine = engineOf(info);
      const context = await browser.newContext();
      await stubNetwork(context);
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "onLine", {
          configurable: true,
          get: () => false,
        });
        (window as unknown as { __liftAt: number | null }).__liftAt = null;
        const arm = () => {
          const root = document.getElementById("protected-root");
          if (!root) return void requestAnimationFrame(arm);
          new MutationObserver(() => {
            if (
              !root.hasAttribute("inert") &&
              (window as unknown as { __liftAt: number | null }).__liftAt ===
                null
            )
              (window as unknown as { __liftAt: number | null }).__liftAt =
                performance.now();
          }).observe(root, { attributes: true, attributeFilter: ["inert"] });
        };
        arm();
      });
      const seed = await storePage(context);
      const record1 =
        fences && Object.keys(fences).length > 0
          ? settled("acct-a", 3, fences as never)
          : settled("acct-a", 1);
      await seed.evaluate(
        (state) => window.__atlasFixture?.session?.seedAuthState(state),
        record1,
      );
      await seed.close();
      const samples: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const page = await context.newPage();
        await page.goto("/__session?route=/today");
        await page.waitForFunction(
          () =>
            (window as unknown as { __liftAt: number | null }).__liftAt !==
            null,
        );
        if (i >= 5)
          samples.push(
            await page.evaluate(
              () => (window as unknown as { __liftAt: number }).__liftAt,
            ),
          );
        await page.close();
      }
      record(`P-4 boot to first exposure, offline, ${label}`, engine, samples, {
        note: "navigation start (performance.timeOrigin) to the gate lifting; includes module load, the canary and the protected-tree chunk",
      });
      await context.close();
    });
  }
});
