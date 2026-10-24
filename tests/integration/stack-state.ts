import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WEB-08c revision 14 (review 14 R17, family `integration-stack-throttle-isolation`): the helper state a stack's specs keep in files.
 * No Playwright import, so the rules below are unit-tested directly (tests/static/integration-runner-ownership.test.ts); the specs use
 * them through ./helpers.
 */

/**
 * A file of THIS stack's helper state: a spec's sign-in ledger or account rotation. scripts/integration/run.mjs gives every stack a
 * fresh directory (ATLAS_INTEGRATION_STATE_DIR) that is removed with its backend, so pacing survives a Playwright worker restart
 * within the stack and a later stack never inherits it, even on a reused port. Without that directory (a `--serve` exploration run
 * by hand) it falls back to TMPDIR, keyed by the preview's port as before.
 */
export function stackFile(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = env.ATLAS_INTEGRATION_STATE_DIR;
  if (dir) return join(dir, name);
  const port = new URL(env.ATLAS_INTEGRATION_URL || "http://x").port;
  return join(tmpdir(), name.replace(/(\.[a-z]+)$/, `-${port}$1`));
}

/**
 * The paced specs' sign-in ledger (one per stack, shared by every spec of the stack that paces): EVERY paced sign-in first waits
 * until fewer than 8 attempts of that account are less than a minute old (the released backend allows 10 per account in a fixed
 * 60 s window). An absent ledger is empty; an unreadable or malformed one stops the test (R17: it is never taken as empty).
 * The ledger paces; it is not the stack's budget proof: the runner records every request that reached the backend through the
 * proxy and fails the stack on any 429 (scripts/integration/stacks.mjs `throttleRecord`).
 */
export async function paceSignIn(
  who: string,
  ledger = stackFile("atlas-signin-ledger.json"),
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<void> {
  for (;;) {
    let all: Record<string, number[]> = {};
    let text: string | null = null;
    try {
      text = readFileSync(ledger, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every(
          (times) =>
            Array.isArray(times) &&
            times.every((t) => typeof t === "number" && Number.isFinite(t)),
        )
      )
        throw new Error(`the sign-in ledger ${ledger} is malformed`);
      all = parsed as Record<string, number[]>;
    }
    const now = clock.now();
    const recent = (all[who] ?? []).filter((t) => now - t < 60_000);
    if (recent.length < 8) {
      all[who] = [...recent, now];
      writeFileSync(ledger, JSON.stringify(all));
      return;
    }
    await clock.sleep(60_000 - (now - (recent[0] ?? now)) + 250);
  }
}
