// @vitest-environment node
import { describe, expect, test } from "vitest";
import { startDeviceMirror } from "../../src/data/engine/device-mirror";
import { createProfileSource } from "../../src/data/engine/profile-source";
import {
  parseAccountIdentity,
  parseCurrentDeviceId,
} from "../../src/data/model/identity-bodies";
import {
  currentDeviceThrough,
  readMeThrough,
} from "../../src/data/ui/identity-reads";
import { createApiClient } from "../../src/lib/api-client";
import type { Session } from "../../src/session";
import { identityReadWorld } from "../support/data/identity-reads";
import { ACCOUNT, pageWorld } from "../support/data/page-world";

/**
 * R18 (revision 9): a `200` whose body is not the contract's is an UNRECOGNISED answer, never a verification. TypeScript's response
 * type is not validation. The two consumers check what they use: the profile its `id` and `username`, the device mirror the one
 * current row of the sessions list and its `device_id`. FIXTURE evidence: scripted bodies.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  device_id: "device-1",
  current: true,
  authentication: "local",
  created_at: "2026-10-01T00:00:00Z",
  expires_at: "2026-11-01T00:00:00Z",
  ...over,
});

describe("parseAccountIdentity", () => {
  test("the contract's body gives the trimmed username", () => {
    expect(
      parseAccountIdentity(
        { id: ACCOUNT, username: "  Alice ", has_password: true },
        ACCOUNT,
      ),
    ).toBe("Alice");
  });

  test.each([
    ["an id that is another account's", { id: "other", username: "x" }],
    ["no username", { id: ACCOUNT }],
    ["a numeric username", { id: ACCOUNT, username: 42 }],
    ["a null username", { id: ACCOUNT, username: null }],
    ["an object username", { id: ACCOUNT, username: { name: "x" } }],
    ["a blank username", { id: ACCOUNT, username: "   " }],
    ["an overlong username", { id: ACCOUNT, username: "x".repeat(201) }],
    ["no id", { username: "x" }],
    ["a numeric id", { id: 1, username: "x" }],
    ["null", null],
    ["a string", "Alice"],
    ["an array", []],
    ["undefined", undefined],
  ])("%s is not a profile", (_name, body) => {
    expect(parseAccountIdentity(body, ACCOUNT)).toBeNull();
  });
});

describe("parseCurrentDeviceId", () => {
  test("the one current row's device id", () => {
    expect(
      parseCurrentDeviceId([
        row({ id: "s0", device_id: "device-0", current: false }),
        row(),
      ]),
    ).toBe("device-1");
  });

  test.each([
    ["not an array", { sessions: [] }],
    ["undefined", undefined],
    ["null", null],
    ["a string", "sessions"],
    ["no current row", [row({ current: false })]],
    ["an empty list", []],
    ["two current rows", [row(), row({ id: "s2", device_id: "device-2" })]],
    ["a null row", [null]],
    ["a null row beside a current one", [row(), null]],
    ["a numeric row", [42]],
    ["a truthy current that is not a boolean", [row({ current: "yes" })]],
    ["a numeric current", [row({ current: 1 })]],
    ["a missing current", [{ id: "s1", device_id: "device-1" }]],
    ["a null device id", [row({ device_id: null })]],
    ["a numeric device id", [row({ device_id: 42 })]],
    ["a missing device id", [row({ device_id: undefined })]],
    ["a blank device id", [row({ device_id: "  " })]],
    ["an object device id", [row({ device_id: { id: "d" } })]],
  ])("%s is not an answer to verify a device with", (_name, sessions) => {
    expect(parseCurrentDeviceId(sessions)).toBeNull();
  });
});

describe("the production adapters", () => {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const meThrough = (body: unknown) =>
    readMeThrough({
      api: {
        client: () =>
          createApiClient(
            async () => respond(200, body),
            "http://localhost/api/experimental/v1",
          ),
      },
    } as unknown as Session)(ACCOUNT, 1);
  const devices = (sessions: unknown) =>
    currentDeviceThrough({
      operations: {
        listSessions: async () => ({ ok: true, value: { sessions } }),
      },
    } as unknown as Session)();

  test("the profile adapter: the contract's body is the answer, a mistyped or foreign one is unrecognised", async () => {
    const body = { id: ACCOUNT, username: "Alice" };
    expect(await meThrough(body)).toEqual({ kind: "ok", value: body });
    for (const bad of [
      { id: ACCOUNT },
      { id: ACCOUNT, username: 42 },
      { id: "someone-else", username: "Alice" },
    ])
      expect(await meThrough(bad)).toEqual({ kind: "unrecognised" });
  });

  test("the device adapter: a malformed list or row is unrecognised (a null row used to throw and count as a network failure)", async () => {
    expect(await devices([row()])).toEqual({ kind: "ok", value: "device-1" });
    for (const bad of [
      [null],
      [row({ device_id: null })],
      [row({ device_id: 42 })],
      [row({ current: "yes" })],
      [row({ current: false })],
    ])
      expect(await devices(bad)).toEqual({ kind: "unrecognised" });
  });
});

describe("the consumers: a malformed body is counted, never verified, and the history stays until a valid success", () => {
  type Scripted = Array<{ kind: "ok"; value: unknown } | { kind: "failure" }>;

  const profileOver = async (answers: Scripted) => {
    const w = await pageWorld({ epoch: 1 });
    const reads = identityReadWorld(w);
    let asked = 0;
    const source = createProfileSource({
      ...reads,
      identity: w.identity,
      readMe: async () => {
        asked += 1;
        return (answers.shift() ?? { kind: "failure" }) as never;
      },
    });
    const stop = source.start();
    const advance = async (ms: number) => {
      await w.env.world.advance(ms);
      for (let i = 0; i < 12; i += 1) await w.env.settle();
    };
    return { w, source, stop, advance, asked: () => asked };
  };

  test("a failure, then a body without a username, then a valid body: the label appears only with the last, and the entry is gone after it", async () => {
    const t = await profileOver([
      { kind: "failure" },
      { kind: "ok", value: { id: ACCOUNT } },
      { kind: "ok", value: { id: ACCOUNT, username: "Alice" } },
    ]);
    await t.advance(120_000);
    expect(t.source.labelFor(t.w.identity.get())).toBe("Alice");
    expect(t.asked()).toBe(3);
    expect(t.w.sync().read_retry_states["profile:1"]).toBeUndefined();
    t.stop();
  });

  test("a body that is not a profile is NOT asked about only once: three in a row pause the caller, with the label absent", async () => {
    const t = await profileOver(
      Array.from({ length: 10 }, () => ({
        kind: "ok" as const,
        value: { id: ACCOUNT, username: 42 },
      })),
    );
    await t.advance(3_600_000);
    expect(t.asked()).toBe(3);
    expect(t.source.labelFor(t.w.identity.get())).toBeNull();
    expect(t.w.sync().read_retry_states["profile:1"]).toMatchObject({
      paused: true,
      unrecognised_streak: 3,
    });
    t.stop();
  });

  const mirrorOver = async (lists: unknown[]) => {
    const w = await pageWorld({ epoch: 1 });
    const reads = identityReadWorld(w);
    let asked = 0;
    const stop = startDeviceMirror({
      ...reads,
      identity: w.identity,
      currentDeviceId: async () => {
        asked += 1;
        return (await currentDeviceThrough({
          operations: {
            listSessions: async () => ({
              ok: true,
              value: { sessions: lists.shift() ?? [] },
            }),
          },
        } as unknown as Session)()) as never;
      },
    });
    const advance = async (ms: number) => {
      await w.env.world.advance(ms);
      for (let i = 0; i < 12; i += 1) await w.env.settle();
    };
    return { w, stop, advance, asked: () => asked };
  };

  test.each([
    ["a null device id", [row({ device_id: null })]],
    ["a numeric device id", [row({ device_id: 42 })]],
    ["a truthy current that is not true", [row({ current: "yes" })]],
    ["a null row", [null]],
  ])(
    "%s never marks the device verified, and is counted as unrecognised",
    async (_name, list) => {
      const t = await mirrorOver(Array.from({ length: 10 }, () => list));
      await t.advance(3_600_000);
      expect(t.asked()).toBe(3);
      expect(t.w.sync().device_verified).toBe(false);
      expect(t.w.sync().device_id).toBeNull();
      expect(t.w.sync().read_retry_states["device:1"]).toMatchObject({
        paused: true,
        unrecognised_streak: 3,
      });
      t.stop();
    },
  );

  test("a malformed list, then a valid one: the device is verified by the valid one, with the earlier history cleared", async () => {
    const t = await mirrorOver([[row({ device_id: null })], [row()]]);
    await t.advance(120_000);
    expect(t.w.sync()).toMatchObject({
      device_id: "device-1",
      device_verified: true,
    });
    expect(t.w.sync().read_retry_states["device:1"]).toBeUndefined();
    t.stop();
  });
});
