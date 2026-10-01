import { appendFileSync, mkdirSync } from "node:fs";
import {
  bootHarness,
  expect,
  liftedAt,
  proxy,
  signIn,
  test,
  untilHeld,
  untilRecord,
  untilView,
  watchLift,
} from "./helpers";

/**
 * P-3 and P-5 (plan 12.3): MEASUREMENTS against the released backend on loopback, not budgets. Skipped unless ATLAS_PROFILE=1
 * (`pnpm profile:session`). P-3 is the stamped path (cover, clean release, lease deletion) versus a bare `fetch` of the same
 * request; P-5 is the lock-publication SEED for WEB-08c: from a page's clean answer to another page's grant.
 */
test.skip(
  !process.env.ATLAS_PROFILE,
  "not run: measurements are taken by `pnpm profile:session`",
);

const OUT = ".agtx/evidence/WEB-08a/profiling";
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
  info.project.name.replace("integration-", "");

test("P-3: an authenticated GET /sessions through the stamped path versus a bare fetch", async ({
  context,
}, info) => {
  const page = await bootHarness(context);
  expect((await signIn(page, "alice")).kind).toBe("settled");
  await untilView(page, "displaying");
  const result = await page.evaluate(async () => {
    const current = await (
      await fetch("/api/experimental/v1/browser-sessions/current", {
        headers: { "X-Atlas-Session": "1" },
      })
    ).json();
    const csrf = current.csrf_token as string;
    const bare = async () => {
      const started = performance.now();
      const response = await fetch("/api/experimental/v1/sessions", {
        headers: { "X-CSRF-Token": csrf },
        credentials: "same-origin",
      });
      await response.json();
      return performance.now() - started;
    };
    const stamped = async () => {
      const started = performance.now();
      const answer = await window.__retry(() =>
        window.__s.operations.listSessions(),
      );
      if (!answer.ok)
        throw new Error(`stamped call failed: ${JSON.stringify(answer)}`);
      return performance.now() - started;
    };
    const bareSamples: number[] = [];
    const stampedSamples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await bare();
      await stamped();
    }
    for (let i = 0; i < 150; i += 1) {
      // Interleaved, so a drifting machine affects both alike.
      bareSamples.push(await bare());
      stampedSamples.push(await stamped());
    }
    return { bareSamples, stampedSamples };
  });
  record(
    "P-3 bare fetch GET /sessions (loopback, through the proxy)",
    engineOf(info),
    result.bareSamples,
  );
  record(
    "P-3 stamped GET /sessions (cover, clean release, lease deletion)",
    engineOf(info),
    result.stampedSamples,
  );
  const pct = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.floor(p * xs.length)] ?? 0;
  record(
    "P-3 added latency of the stamped path (stamped minus bare, per percentile)",
    engineOf(info),
    [
      pct(result.stampedSamples, 0.5) - pct(result.bareSamples, 0.5),
      pct(result.stampedSamples, 0.95) - pct(result.bareSamples, 0.95),
    ],
    {
      reading:
        "samples[0] is the p50 difference, samples[1] the p95 difference; the record's own p50/p95 fields are of these two numbers and are not meaningful",
    },
  );
});

test("P-5: lock publication latency seed: a page's clean answer to another page's grant", async ({
  context,
}, info) => {
  const first = await bootHarness(context);
  expect((await signIn(first, "bob")).kind).toBe("settled");
  await untilView(first, "displaying");
  const samples: number[] = [];
  for (let i = 0; i < 25; i += 1) {
    const rule = await proxy.addRule({
      method: "GET",
      path: "/^\\/api\\/experimental\\/v1\\/sessions$/",
      action: "hold",
      ordinal: 1,
    });
    await first.evaluate(() => {
      window.__t.pending = window.__retry(() =>
        window.__s.operations.listSessions(),
      );
    });
    await untilHeld(rule.id);
    const second = await bootHarness(context);
    await watchLift(second);
    await second.waitForTimeout(200);
    const released = Date.now();
    await proxy.release(rule.id);
    await expect
      .poll(() => liftedAt(second), { timeout: 15_000 })
      .not.toBeNull();
    samples.push(((await liftedAt(second)) ?? released) - released);
    // Close it only when it is quiescent: a page closed with its resume verification in flight leaves an unresolved lease, which the
    // protocol (correctly, row 9) makes the next request of the other page refuse.
    await untilRecord(
      second,
      (state) => Object.keys(state.leases).length === 0,
      "page 2 has no lease outstanding",
    );
    await second.close();
    await proxy.removeRule(rule.id);
  }
  record(
    "P-5 surrender-to-grant seed (clean answer, page 1 -> page 2)",
    engineOf(info),
    samples,
    {
      note: "a SEED for WEB-08c: Date.now() in the page against the test process on one machine (1 ms resolution); never a threshold",
    },
  );
});
