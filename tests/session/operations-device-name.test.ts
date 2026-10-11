// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DeviceRow } from "../../src/session/api";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  holdAnswers,
  leaseIds,
  newWorld,
  openPage,
  signedInPage,
  stateOf,
} from "../support/session/scenarios";

/**
 * F-NAME-* (WEB-08d): `operations.nameDevice`, BE-Q25 `PUT`/`DELETE /devices/{id}/name`, over the fake world with the stand-in's opt-in
 * BE-Q25 mode. An ordinary stamped call: the name is sent EXACTLY as given, the answer maps to `named`/`cleared`/`gone` or an `http`
 * refusal, and an answer that arrives after the identity moved on is `closed`. Fixture evidence against a stand-in of the contract, not
 * integration evidence (that is `integration.web08d-labels.spec.ts` against the released backend).
 */
const named = (f: Fixture) =>
  f.server.requests.filter((r) => /\/devices\/[^/]+\/name$/.test(r.path));

async function setup() {
  const f = await newWorld();
  f.server.beq25 = true;
  const l = await signedInPage(f);
  const device = await currentDevice(f, l.page);
  return { f, l, device };
}

async function devicesOf(f: Fixture, page: FakePage): Promise<DeviceRow[]> {
  const read = await f.runWith(page.session.operations.readDevices());
  if (!read.ok) throw new Error(`devices read failed: ${read.error}`);
  return [...read.value.devices];
}
async function currentDevice(f: Fixture, page: FakePage): Promise<DeviceRow> {
  const current = (await devicesOf(f, page)).find((d) => d.current);
  if (!current) throw new Error("no current device");
  return current;
}

describe("F-NAME-1: the request", () => {
  test("PUT carries the name exactly as given (inner spaces, a ZWJ sequence, markup), with the CSRF token and no Idempotency-Key; 204 is `named`", async () => {
    const { f, l, device } = await setup();
    const name = "Kitchen  <b>iPad</b> \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const result = await f.runWith(
      l.page.session.operations.nameDevice(device.id, name),
    );
    expect(result).toEqual({ ok: true, value: "named" });
    const [call] = named(f);
    expect(call?.method).toBe("PUT");
    expect(call?.path).toBe(
      `/api/experimental/v1/devices/${encodeURIComponent(device.id)}/name`,
    );
    expect(call?.body).toEqual({ name });
    expect(call?.headers["x-csrf-token"]).toMatch(/^csrf\./);
    expect(call?.headers["idempotency-key"]).toBeUndefined();
    expect(call?.headers["content-type"]).toBe("application/json");
    expect((await currentDevice(f, l.page)).name).toBe(name);
    expect(leaseIds(f)).toEqual([]);
    expect(checkProperties(f)).toEqual([]);
  });

  test("a name is never trimmed by the client: a value with edge white space is sent verbatim and the server's 422 is returned as it is", async () => {
    const { f, l, device } = await setup();
    const result = await f.runWith(
      l.page.session.operations.nameDevice(device.id, " Kitchen "),
    );
    expect(named(f)[0]?.body).toEqual({ name: " Kitchen " });
    expect(result).toMatchObject({
      ok: false,
      error: "http",
      status: 422,
      atlasError: { code: "invalid_value", request_id: "req-fixture" },
    });
    expect((await currentDevice(f, l.page)).name).toBeNull();
  });

  test("null is DELETE with no body: `cleared`, and clearing again is still `cleared` (idempotent)", async () => {
    const { f, l, device } = await setup();
    await f.runWith(l.page.session.operations.nameDevice(device.id, "Den"));
    for (let i = 0; i < 2; i += 1)
      expect(
        await f.runWith(l.page.session.operations.nameDevice(device.id, null)),
      ).toEqual({ ok: true, value: "cleared" });
    const deletes = named(f).filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.body ?? null).toBeNull();
    expect((await currentDevice(f, l.page)).name).toBeNull();
  });

  test("the name reaches the sessions list as `device_name` of that device's sessions", async () => {
    const { f, l, device } = await setup();
    await f.runWith(l.page.session.operations.nameDevice(device.id, "Den"));
    const sessions = await f.runWith(l.page.session.operations.listSessions());
    if (!sessions.ok) throw new Error("sessions read failed");
    expect(sessions.value.sessions.find((s) => s.current)?.device_name).toBe(
      "Den",
    );
  });
});

describe("F-NAME-2: answers", () => {
  test("404 not_found is `gone`: another account's device ID and an unlisted one; nothing is named", async () => {
    const { f, l } = await setup();
    const sam = [...f.server.accounts.values()].find(
      (a) => a.username === "sam",
    );
    if (!sam) throw new Error("no sam");
    f.server.createSession(sam.id, "sams-laptop");
    for (const id of ["sams-laptop", "never-seen"])
      expect(
        await f.runWith(l.page.session.operations.nameDevice(id, "Mine")),
      ).toEqual({ ok: true, value: "gone" });
    expect(f.server.deviceNames.size).toBe(0);
  });

  test("a 404 that is not an Atlas not_found (a proxy's page) is an `http` refusal, not `gone`", async () => {
    const { f, l, device } = await setup();
    f.server.addRule({
      match: (r) => r.path.endsWith("/name"),
      rewrite: {
        status: 404,
        body: "<html>no</html>",
        contentType: "text/html",
      },
    });
    expect(
      await f.runWith(l.page.session.operations.nameDevice(device.id, "Den")),
    ).toMatchObject({ ok: false, error: "http", status: 404 });
  });

  test("a 503 and a 200 are `http` refusals with their status (the outcome of a 5xx is unknown to the caller)", async () => {
    for (const status of [503, 200]) {
      const { f, l, device } = await setup();
      f.server.addRule({
        match: (r) => r.path.endsWith("/name"),
        rewrite: {
          status,
          body: {
            code: "temporarily_unavailable",
            message: "x",
            request_id: "req-503",
          },
        },
      });
      expect(
        await f.runWith(l.page.session.operations.nameDevice(device.id, "Den")),
      ).toMatchObject({ ok: false, error: "http", status });
    }
  });

  test("a connection lost before the server saw it is `offline`", async () => {
    const { f, l, device } = await setup();
    f.server.addRule({
      match: (r) => r.path.endsWith("/name"),
      dropBeforeForward: true,
    });
    expect(
      await f.runWith(l.page.session.operations.nameDevice(device.id, "Den")),
    ).toEqual({ ok: false, error: "offline" });
  });

  test("a 401 is an observation, never a refusal of the name: `auth_state`", async () => {
    const { f, l, device } = await setup();
    f.server.addRule({
      match: (r) => r.path.endsWith("/name"),
      rewrite: {
        status: 401,
        body: { code: "unauthenticated", message: "x", request_id: "r" },
      },
    });
    expect(
      await f.runWith(l.page.session.operations.nameDevice(device.id, "Den")),
    ).toEqual({ ok: false, error: "auth_state" });
  });
});

describe("F-NAME-3: account isolation (cross-account delayed results)", () => {
  test("A's naming answer held across a sign-in as B on the same page is `closed`, and B's list never shows A's name", async () => {
    const { f, l, device } = await setup();
    const hold = holdAnswers(f, (r) => r.path.endsWith("/name"));
    let outcome: unknown = "pending";
    void l.page.session.operations
      .nameDevice(device.id, "Alice's laptop")
      .then((value) => {
        outcome = value;
      });
    await f.world.runUntilIdle();
    expect(outcome).toBe("pending");
    expect((await f.signIn(l.page, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    const sam = stateOf(f).settled?.account_id;
    expect(sam).not.toBe(l.account);
    hold.release();
    hold.stop();
    await f.world.runUntilIdle();
    expect(outcome).toEqual({ ok: false, error: "closed" });
    // The server applied it for A (the request was A's); B's own reads carry nothing of it.
    const rows = await devicesOf(f, l.page);
    expect(rows.map((row) => row.name)).not.toContain("Alice's laptop");
    expect(JSON.stringify(rows)).not.toContain("Alice");
    expect(checkProperties(f)).toEqual([]);
  });

  test("the same when ANOTHER page settles B while the answer is held", async () => {
    const { f, l, device } = await setup();
    const other = await openPage(f);
    const hold = holdAnswers(f, (r) => r.path.endsWith("/name"));
    let outcome: unknown = "pending";
    void l.page.session.operations
      .nameDevice(device.id, "Alice's laptop")
      .then((value) => {
        outcome = value;
      });
    await f.world.runUntilIdle();
    expect((await f.signIn(other, "sam", "pw2")).kind).toBe("settled");
    await f.settle();
    hold.release();
    hold.stop();
    await f.world.runUntilIdle();
    expect(outcome).toEqual({ ok: false, error: "closed" });
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("F-NAME-4: a name is display metadata, never device state", () => {
  test("renaming between the read and the retirement does not stale it: the token is unchanged and the retirement applies; the name is then forgotten", async () => {
    const { f, l } = await setup();
    f.server.createSession(l.account, "second-device");
    const read = (await devicesOf(f, l.page)).find((d) => !d.current);
    if (!read) throw new Error("no other device");
    await f.runWith(l.page.session.operations.nameDevice(read.id, "Old"));
    const after = (await devicesOf(f, l.page)).find((d) => d.id === read.id);
    expect(after?.name).toBe("Old");
    expect(after?.state_token).toBe(read.state_token);
    expect(
      await f.runWith(l.page.session.operations.retireOtherDevice(read)),
    ).toEqual({ ok: true, value: "confirmed_applied" });
    expect(f.server.deviceNames.has(`${l.account}/${read.id}`)).toBe(false);
  });
});

describe("F-NAME-5: the capacity members pass through untouched", () => {
  test("a server without BE-Q25 members: absent stays absent (not null), so `unavailable` is never read as `unlimited`", async () => {
    const f = await newWorld();
    const l = await signedInPage(f);
    const sessions = await f.runWith(l.page.session.operations.listSessions());
    const devices = await f.runWith(l.page.session.operations.readDevices());
    if (!sessions.ok || !devices.ok) throw new Error("reads failed");
    expect(Object.hasOwn(sessions.value, "session_capacity")).toBe(false);
    expect(Object.hasOwn(devices.value, "sync_capacity")).toBe(false);
  });

  test("a BE-Q25 server: both members are returned exactly as sent, an unlimited reading included", async () => {
    const f = await newWorld();
    f.server.beq25 = true;
    f.server.capacityLimit = null;
    const l = await signedInPage(f);
    const sessions = await f.runWith(l.page.session.operations.listSessions());
    const devices = await f.runWith(l.page.session.operations.readDevices());
    if (!sessions.ok || !devices.ok) throw new Error("reads failed");
    expect(sessions.value.session_capacity).toEqual({
      limit: null,
      used: 1,
      remaining: null,
    });
    expect(devices.value.sync_capacity).toEqual({
      limit: null,
      used: 0,
      remaining: null,
    });
  });
});
