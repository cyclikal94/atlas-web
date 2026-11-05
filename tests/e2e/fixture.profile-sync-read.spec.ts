import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { observeW2Capture } from "../../scripts/lib/profile-w2-capture.mjs";
import {
  captureBody,
  PERSON,
} from "../../scripts/validation/profile-programme-fixture.mjs";
import { bootSession, seedSettled, stubNetwork } from "./data-sync-helpers";
import { readSyncBytes } from "./profile-sync-read";

/**
 * WEB-09c revision 5 (design assessment DA-E3, A2, Q3): the W2 capture writer keeps the `/sync` response body's exact BYTES. The writer's
 * reader (`readSyncBytes`, tests/e2e/profile-sync-read.ts) reads a body through a booted page's stamped wrapper; here the network is the
 * scripted stub that the cold replays also serve captures through (`stubNetwork`, a `Buffer` body), so each case checks both directions:
 * the bytes the stub serves reach the test unchanged, whatever they are. `Response.text()` would drop a byte order mark and replace
 * invalid UTF-8 before anything could be hashed. Each body is then put to the capture observer, as the writer does, which refuses the ones
 * the production receive path refuses. The bodies are the synthetic programme's captures (scripts/validation/profile-programme-fixture.mjs)
 * and literal edits of them; no backend is involved and nothing here is a measurement.
 */
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const healthy = Buffer.from(captureBody("chromium", 1));
const cursorAt = healthy.indexOf(Buffer.from('"next_cursor":"')) + 15;
const CASES: Array<{
  title: string;
  body: Buffer;
  limit: number;
  observed: RegExp | null;
}> = [
  {
    title: "a limit-1 capture is read as its exact bytes",
    body: healthy,
    limit: 1,
    observed: null,
  },
  {
    title:
      "a limit-80 capture with its companion batch is read as its exact bytes",
    body: Buffer.from(captureBody("firefox", 80)),
    limit: 80,
    observed: null,
  },
  {
    title: "non-ASCII and escaped text is read as its exact bytes",
    body: Buffer.from(
      captureBody("webkit", 1).replace(
        /"next_cursor":"d1\./,
        '"next_cursor":"d1.é😀\\u00e9\\ud83d\\ude00.',
      ),
    ),
    limit: 1,
    observed: null,
  },
  {
    title:
      "a byte order mark is kept, and the observer refuses it as production does",
    body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), healthy]),
    limit: 1,
    observed:
      /production scanner refuses the capture \(syntax: expected '\{', at byte 0\)/,
  },
  {
    title:
      "invalid UTF-8 in the cursor is kept as it is, and the observer refuses it",
    body: Buffer.concat([
      healthy.subarray(0, cursorAt),
      Buffer.from([0xff]),
      healthy.subarray(cursorAt),
    ]),
    limit: 1,
    observed: /^the capture is not UTF-8$/,
  },
];

for (const c of CASES)
  test(c.title, async ({ context }) => {
    // The cold replays' set-up (`oneColdRun`): the scripted network, a settled account, a booted session page.
    const net = await stubNetwork(context);
    await seedSettled(context);
    const page = await bootSession(context);
    // The session reads its identity after boot: wait for it (bounded), as a reader of this page's account must.
    const identityOf = () =>
      page.evaluate(async () => {
        const fixture = (
          window as unknown as {
            __atlasFixture?: {
              session?: {
                ready: Promise<{
                  session: {
                    identity: {
                      get(): { account_id: string; epoch: number } | null;
                    };
                  };
                } | null>;
              };
            };
          }
        ).__atlasFixture;
        return (await fixture?.session?.ready)?.session.identity.get() ?? null;
      });
    await expect
      .poll(identityOf, {
        message: "the booted page's identity",
        timeout: 15_000,
      })
      .not.toBeNull();
    const identity = await identityOf();
    const before = net.requests.length;
    net.script.push(() => ({ status: 200, body: c.body }));
    const read = await readSyncBytes(
      page,
      identity?.account_id as string,
      identity?.epoch as number,
      null,
      c.limit,
    );
    expect(read.error).toBeNull();
    expect(read.status).toBe(200);
    expect(net.requests.length - before, "one /sync request").toBe(1);
    expect(read.bytes.length, "the size").toBe(c.body.length);
    expect(sha256(read.bytes), "the SHA-256").toBe(sha256(c.body));
    expect(Buffer.compare(read.bytes, c.body), "the bytes").toBe(0);
    const problems = observeW2Capture(read.bytes, {
      person: PERSON,
      limit: c.limit,
    }).problems;
    if (c.observed === null) expect(problems).toEqual([]);
    else expect(problems.join(" | ")).toMatch(c.observed);
  });
