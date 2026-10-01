import { appendFileSync, writeFileSync } from "node:fs";
import type { Fixture } from "./harness";

/** Debug output for development (vitest swallows console output). Writes to $SCRATCH/scratch.txt. */
const file = () => `${process.env.SCRATCH ?? "/tmp"}/scratch.txt`;
export const reset = () => writeFileSync(file(), "");
export const say = (...parts: unknown[]) =>
  appendFileSync(
    file(),
    `${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`,
  );
export function tail(
  fixture: Fixture,
  from = 0,
  count = 60,
  drop: string[] = [
    "hint.post",
    "hint.deliver",
    "lock.published",
    "trace.evaluate",
  ],
) {
  const rows = fixture.world.logs
    .slice(from)
    .filter((x) => !drop.includes(x.type))
    .slice(-count)
    .map((x) => JSON.stringify({ ...x, result: undefined, t: undefined }));
  say(rows.join("\n"));
}
