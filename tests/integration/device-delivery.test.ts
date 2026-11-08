// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { engineWorld } from "../support/data/engine-world";
import {
  type DeliveryIo,
  type DeviceReading,
  driveUntilHeld,
  HELD,
  judgeDelivery,
} from "./device-delivery";

/**
 * WEB-18 revision 3 (review 3 F-R9; design assessment C-1, C-5, Q2, Q3): the shared device wait of the integration cases.
 *
 * 1. `judgeDelivery` on readings it must accept and readings it must refuse, each for its own reason (I-2, I-4).
 * 2. The very loop the spec runs (`driveUntilHeld`) against the REAL sync engine under fake time, in the schedule that failed in review
 *    3: a write lands while a healthy step is held, and the step ends in the idle poll. "The device holds the write" is "a request
 *    that STARTED after the write has been answered" (a request issued before the write cannot carry it). The negative control is the
 *    old shape (one nudge, then a passive wait): it must NOT see the write for 30 virtual seconds, which also pins the engine rule the
 *    fix is written around (a `nudge("now")` during a step that ends in the idle poll does not shorten that poll; the notification
 *    form of the rule is pinned in tests/data/pending-wake.test.ts). The driven loop must see it within one interval of the release.
 * 3. The source guard (I-8): `integration.tasks-18.spec.ts` never nudges sync itself, waits through the helper at G6's two waits, G7b's
 *    barrier and every root it opens, and keeps each task's receipt revision. Its negative controls are the shapes it exists to refuse.
 */

const want1 = { revision: 14, tasks: [{ taskId: "t-a", title: "A" }] };

describe("judgeDelivery", () => {
  test("held only when the applied revision has reached the want AND every named row is cached", () => {
    expect(
      judgeDelivery(want1, { applied: 14, held: ["t-a"], engine: "idle" }),
    ).toBe(HELD);
    expect(
      judgeDelivery(want1, { applied: 20, held: ["t-a"], engine: "idle" }),
    ).toBe(HELD);
    expect(
      judgeDelivery(
        { tasks: [{ taskId: "t-a" }] },
        { applied: 0, held: ["t-a"], engine: "idle" },
      ),
    ).toBe(HELD);
    expect(
      judgeDelivery(
        { revision: 3, tasks: [] },
        { applied: 3, held: [], engine: "idle" },
      ),
    ).toBe(HELD);
  });

  test("a revision behind the want is waiting, and says so, even with every row cached", () => {
    expect(
      judgeDelivery(want1, { applied: 13, held: ["t-a"], engine: "running" }),
    ).toBe("waiting: applied revision 13 of 14; engine running");
  });

  test("a missing row is waiting, and names it, even with the revision reached", () => {
    expect(
      judgeDelivery(
        {
          revision: 14,
          tasks: [
            { taskId: "t-a", title: "A" },
            { taskId: "t-b", title: "B" },
            { taskId: "t-c" },
          ],
        },
        {
          applied: 14,
          held: ["t-a"],
          engine: "backing_off",
          steps: ["10ms data.sync_tick {}"],
        },
      ),
    ).toBe(
      "waiting: missing 2 of 3 (“B”, t-c); engine backing_off; last steps 10ms data.sync_tick {}",
    );
  });

  test("an empty want is refused: a wait that names nothing would return at once", () => {
    expect(
      judgeDelivery({ tasks: [] }, { applied: 9, held: [], engine: "idle" }),
    ).toMatch(/^nothing to wait for/);
  });
});

/** The engine world as the loop's world: "held" means a request issued after `writeAt` requests has been answered. */
async function deliveryWorld() {
  const w = await engineWorld();
  const answered = new Set<number>();
  let issued = 0;
  let release: (answer: Response) => void = () => undefined;
  // The first request (the step that runs while the case writes) is held; every later one is answered at once.
  w.script.push(() => {
    const n = ++issued;
    return new Promise<Response>((resolve) => {
      release = (answer) => {
        answered.add(n);
        resolve(answer);
      };
    });
  });
  for (let i = 0; i < 200; i += 1)
    w.script.push(() => {
      const n = ++issued;
      answered.add(n);
      return w.emptyPage(`cursor-${n}`);
    });
  let writeAt: number | null = null;
  const holds = () =>
    writeAt !== null && [...answered].some((n) => n > (writeAt as number));
  const io: DeliveryIo = {
    nudge: async () => {
      w.engine.nudge("now");
      await w.settle();
    },
    read: async (): Promise<DeviceReading> => ({
      applied: 0,
      held: holds() ? ["write"] : [],
      engine: w.state().kind,
    }),
    sleep: (ms) => w.advance(ms),
    now: () => w.env.world.time,
  };
  return {
    w,
    io,
    holds,
    /** The helper's write reaches the server now. */
    write: () => {
      writeAt = issued;
    },
    release: (answer: Response) => release(answer),
  };
}
const wantWrite = { tasks: [{ taskId: "write" }] };

describe("driveUntilHeld against the real sync engine (fake time)", () => {
  test("negative control and engine pin: one nudge during a held healthy step, then a passive wait, does not see the write in 30 s", async () => {
    const d = await deliveryWorld();
    d.w.start();
    await d.w.settle();
    expect(d.w.requests).toHaveLength(1);
    d.write();
    // The old shape: one nudge, sent while the step runs ...
    d.w.engine.nudge("now");
    await d.w.settle();
    d.release(d.w.emptyPage("cursor-1"));
    await d.w.settle();
    expect(d.w.state().kind).toBe("idle");
    // ... then a passive wait of 30 s: no request starts, so the write never arrives.
    for (let t = 0; t < 30_000; t += 250) {
      await d.w.advance(250);
      expect(d.holds()).toBe(false);
    }
    expect(d.w.requests).toHaveLength(1);
    // The engine's own idle poll (60 s) is what would bring it.
    await d.w.advance(31_000);
    expect(d.w.requests).toHaveLength(2);
    expect(d.holds()).toBe(true);
    d.w.engine.stop();
  });

  test("the driven loop sees the same write within one interval of the release", async () => {
    const d = await deliveryWorld();
    d.w.start();
    await d.w.settle();
    d.write();
    const released = d.w.env.world.time + 400;
    // The step's answer comes 400 ms in, while the loop is already nudging (its first nudge is lost to the held step).
    d.w.timers.setTimeout(() => d.release(d.w.emptyPage("cursor-1")), 400);
    expect(
      await driveUntilHeld(d.io, wantWrite, { timeout: 30_000, interval: 500 }),
    ).toBe(HELD);
    expect(d.w.env.world.time - released).toBeLessThanOrEqual(500);
    expect(d.w.requests.length).toBeGreaterThanOrEqual(2);
    d.w.engine.stop();
  });

  test("an engine that keeps failing ends the wait at its limit, and the message says what the engine is doing", async () => {
    const w = await engineWorld();
    for (let i = 0; i < 50; i += 1) w.script.push(w.status(503));
    w.start();
    await w.settle();
    const verdict = await driveUntilHeld(
      {
        nudge: async () => {
          w.engine.nudge("now");
          await w.settle();
        },
        read: async () => ({ applied: 0, held: [], engine: w.state().kind }),
        sleep: (ms) => w.advance(ms),
        now: () => w.env.world.time,
      },
      wantWrite,
      { timeout: 5_000, interval: 500 },
    );
    expect(verdict).toMatch(
      /^waiting: missing 1 of 1 \(write\); engine backing_off \(after \d+ ms of 5000\)$/,
    );
    w.engine.stop();
  });
});

/** The guard of I-8 and C-2/C-3/C-7, over the spec's text. */
function guardSpec(text: string): string[] {
  const problems: string[] = [];
  if (/nudgeSync/.test(text))
    problems.push("the spec nudges sync itself (only device-delivery.ts may)");
  const calls = text.match(/untilDeviceHolds\(/g)?.length ?? 0;
  const asserted =
    text.match(/expect\(\s*await untilDeviceHolds\(/g)?.length ?? 0;
  if (calls !== asserted)
    problems.push(`${calls - asserted} untilDeviceHolds call(s) not asserted`);
  const g6 = /test\.describe\("I-18-G6[\s\S]*?\n}\);\n/.exec(text)?.[0] ?? "";
  if ((g6.match(/untilDeviceHolds\(/g)?.length ?? 0) !== 2)
    problems.push("I-18-G6 does not wait through the helper at both waits");
  const g7b = /test\("G7b[\s\S]*?\n {2}}\);\n/.exec(text)?.[0] ?? "";
  if (
    !/expect\(\s*await untilDeviceHolds\([\s\S]*?\{ revision, tasks: \[\] \}/.test(
      g7b,
    )
  )
    problems.push("I-18-G7b's barrier does not wait through the helper");
  for (const opener of ["openDialog", "openEditor"]) {
    const body =
      new RegExp(`async function ${opener}\\([^)]*\\) \\{\\n([^\\n]*)`).exec(
        text,
      )?.[1] ?? "";
    if (!/await untilRootHeld\(/.test(body))
      problems.push(`${opener} does not first wait for the root on the device`);
  }
  if (!/revision: \(out\.body as \{ revision: number \}\)\.revision/.test(text))
    problems.push("makeTask drops its receipt's revision");
  return problems;
}

describe("the source guard over integration.tasks-18.spec.ts", () => {
  const spec = readFileSync(
    new URL("./integration.tasks-18.spec.ts", import.meta.url),
    "utf8",
  );

  test("the spec as it stands passes", () => {
    expect(guardSpec(spec)).toEqual([]);
  });

  test("negative control: a bare nudge followed by a passive wait (review 3's F-R9 shape) is refused", () => {
    const bad = spec.replace(
      '    const a = await makeTask(page, id, "I-18-G6 A");',
      '    await page.evaluate(() => window.__atlasData?.nudgeSync());\n    const a = await makeTask(page, id, "I-18-G6 A");',
    );
    expect(bad).not.toBe(spec);
    expect(guardSpec(bad)).toContain(
      "the spec nudges sync itself (only device-delivery.ts may)",
    );
  });

  test("negative control: G6's first wait without the helper is refused", () => {
    const start = spec.indexOf(
      "    expect(\n      await untilDeviceHolds(\n        page,\n        id.account_id,\n        { revision: r.revision, tasks: [r] },",
    );
    const end =
      spec.indexOf(").toBe(HELD);\n", start) + ").toBe(HELD);\n".length;
    expect(start).toBeGreaterThan(0);
    const bad = `${spec.slice(0, start)}${spec.slice(end)}`;
    expect(guardSpec(bad)).toContain(
      "I-18-G6 does not wait through the helper at both waits",
    );
  });

  test("negative controls: an unasserted wait, G7b's barrier, an opener and the receipt revision are each refused", () => {
    const unasserted = spec.replace(
      "    expect(\n      await untilDeviceHolds(\n        page,\n        id.account_id,\n        { revision, tasks: [] },",
      "    void (\n      await untilDeviceHolds(\n        page,\n        id.account_id,\n        { revision, tasks: [] },",
    );
    expect(unasserted).not.toBe(spec);
    expect(guardSpec(unasserted)).toEqual(
      expect.arrayContaining([
        "1 untilDeviceHolds call(s) not asserted",
        "I-18-G7b's barrier does not wait through the helper",
      ]),
    );
    const opener = spec.replace(
      "async function openEditor(page: Page, id: Id, root: Made) {\n  await untilRootHeld(page, id, root);\n",
      "async function openEditor(page: Page, id: Id, root: Made) {\n",
    );
    expect(opener).not.toBe(spec);
    expect(guardSpec(opener)).toEqual([
      "openEditor does not first wait for the root on the device",
    ]);
    const receipt = spec.replace(
      "revision: (out.body as { revision: number }).revision,",
      "revision: 0,",
    );
    expect(receipt).not.toBe(spec);
    expect(guardSpec(receipt)).toEqual([
      "makeTask drops its receipt's revision",
    ]);
  });
});
