// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { DeviceRow, Result } from "../../src/session/api";
import type { FakePage, Fixture } from "../support/session/harness";
import { checkProperties } from "../support/session/properties";
import {
  holdAnswers,
  leaseIds,
  newWorld,
  signedInPage,
} from "../support/session/scenarios";

/**
 * F-WD-* (WEB-08d review R3, revision 2): `SendOptions.withdraw` on the ordinary change requests, through the real kernel send path
 * over the fake world. Withdrawn before it is issued, wherever the request was waiting (its lease lock, the cover transaction, the
 * issue lock), a request is never sent and the call is `not_sent`; nothing is left behind. Withdrawn after it is issued, nothing is
 * aborted: the answer is handled as before (the server may have applied it). Fixture evidence against the stand-in, not integration.
 */
type Call = (page: FakePage, withdraw: AbortSignal) => Promise<Result<unknown>>;

async function otherDevice(f: Fixture, page: FakePage): Promise<DeviceRow> {
  const read = await f.runWith(page.session.operations.readDevices());
  if (!read.ok) throw new Error("devices read failed");
  const other = read.value.devices.find((d) => !d.current);
  if (!other) throw new Error("no other device");
  return other;
}

/** Each ordinary change request, with the server requests it makes. */
const OPERATIONS: Array<{
  name: string;
  path: RegExp;
  prepare(f: Fixture, page: FakePage, account: string): Promise<Call>;
}> = [
  {
    name: "nameDevice",
    path: /\/devices\/[^/]+\/name$/,
    prepare: async (f, page) => {
      const device = await otherDevice(f, page);
      return (p, withdraw) =>
        p.session.operations.nameDevice(device.id, "Den", { withdraw });
    },
  },
  {
    name: "revokeOtherSession",
    path: /\/sessions\/[^/]+$/,
    prepare: async (f, page) => {
      const sessions = await f.runWith(page.session.operations.listSessions());
      if (!sessions.ok) throw new Error("sessions read failed");
      const other = sessions.value.sessions.find((s) => !s.current);
      if (!other) throw new Error("no other session");
      return (p, withdraw) =>
        p.session.operations.revokeOtherSession(other.id, { withdraw });
    },
  },
  {
    name: "retireOtherDevice",
    path: /\/devices\/[^/]+$/,
    prepare: async (f, page) => {
      const device = await otherDevice(f, page);
      return (p, withdraw) =>
        p.session.operations.retireOtherDevice(device, { withdraw });
    },
  },
  {
    name: "changePassword",
    path: /\/password$/,
    prepare: async () => (p, withdraw) =>
      p.session.operations.changePassword(
        { current: "pw", next: "a-new-password" },
        { withdraw },
      ),
  },
  {
    name: "unlinkOidc",
    path: /\/oidc\/identities$/,
    prepare: async () => (p, withdraw) =>
      p.session.operations.unlinkOidc("https://idp.example.test", {
        withdraw,
      }),
  },
];

async function setup(operation: (typeof OPERATIONS)[number]) {
  const f = await newWorld();
  f.server.beq25 = true;
  const l = await signedInPage(f);
  f.server.createSession(l.account, "second-device");
  const call = await operation.prepare(f, l.page, l.account);
  const sent = () =>
    f.server.requests.filter((r) => operation.path.test(r.path)).length;
  const issued = () =>
    f.world.logs.filter((e) => e.type === "trace.request.issued").length;
  return { f, l, call, sent, issued };
}

describe("F-WD-1: withdrawn before it is issued, a request is never sent", () => {
  test.each(OPERATIONS)(
    "$name: a signal already aborted sends nothing and is `not_sent`",
    async (operation) => {
      const { f, l, call, sent } = await setup(operation);
      const controller = new AbortController();
      controller.abort();
      const result = await f.runWith(call(l.page, controller.signal));
      expect(result).toEqual({ ok: false, error: "not_sent" });
      await f.world.runUntilIdle();
      expect(sent()).toBe(0);
      expect(leaseIds(f)).toEqual([]);
      expect(checkProperties(f)).toEqual([]);
    },
  );

  test.each(OPERATIONS)(
    "$name: withdrawn after every step of its admission before the issue, it is never sent; at or after the issue it is answered",
    async (operation) => {
      // A sweep over the world's schedule: for each k, a fresh world delivers k events after the call, then the intent is withdrawn.
      // While `request.issued` has not been logged the outcome must be `not_sent` with nothing on the wire; once it has, the request
      // is not aborted and its answer is returned as usual. The sweep ends at the first k where the request had been issued.
      let beforeIssue = 0;
      for (let k = 0; k < 400; k += 1) {
        const { f, l, call, sent, issued } = await setup(operation);
        const issuedBefore = issued();
        const controller = new AbortController();
        let outcome: Result<unknown> | "pending" = "pending";
        void call(l.page, controller.signal).then((value) => {
          outcome = value;
        });
        await f.world.settle();
        for (let step = 0; step < k; step += 1)
          if (!(await f.world.step())) break;
        const wasIssued = issued() > issuedBefore;
        controller.abort();
        await f.world.runUntilIdle();
        expect(outcome).not.toBe("pending");
        if (!wasIssued) {
          beforeIssue += 1;
          expect(outcome, `k=${k}`).toEqual({ ok: false, error: "not_sent" });
          expect(sent(), `k=${k}`).toBe(0);
          expect(issued(), `k=${k}`).toBe(issuedBefore);
          expect(leaseIds(f), `k=${k}`).toEqual([]);
          expect(checkProperties(f), `k=${k}`).toEqual([]);
          continue;
        }
        expect(sent(), `k=${k}`).toBe(1);
        expect(outcome, `k=${k}`).not.toEqual({
          ok: false,
          error: "not_sent",
        });
        expect(outcome, `k=${k}`).not.toEqual({ ok: false, error: "offline" });
        break;
      }
      // The admission takes several deliveries (the lease lock, the cover transaction, the issue lock): more than one point is swept.
      expect(beforeIssue).toBeGreaterThan(1);
    },
  );

  test("control: the same call, never withdrawn, is sent once and answered", async () => {
    const { f, l, call, sent } = await setup(
      OPERATIONS[0] as (typeof OPERATIONS)[number],
    );
    const result = await f.runWith(call(l.page, new AbortController().signal));
    expect(result).toEqual({ ok: true, value: "named" });
    expect(sent()).toBe(1);
    expect(checkProperties(f)).toEqual([]);
  });
});

describe("F-WD-2: withdrawing never aborts a request already issued", () => {
  test.each([
    ["nameDevice", { ok: true, value: "named" }],
    ["retireOtherDevice", { ok: true, value: "confirmed_applied" }],
    ["revokeOtherSession", { ok: true, value: "revoked" }],
  ] as const)(
    "%s: withdrawn while its answer is held, the answer is still returned and the server applied it",
    async (name, expected) => {
      const operation = OPERATIONS.find((o) => o.name === name);
      if (!operation) throw new Error(name);
      const { f, l, call, sent } = await setup(operation);
      const hold = holdAnswers(f, (r) => operation.path.test(r.path));
      const controller = new AbortController();
      let outcome: Result<unknown> | "pending" = "pending";
      void call(l.page, controller.signal).then((value) => {
        outcome = value;
      });
      await f.world.runUntilIdle();
      expect(sent()).toBe(1);
      expect(outcome).toBe("pending");
      controller.abort();
      await f.world.runUntilIdle();
      expect(outcome).toBe("pending");
      hold.release();
      hold.stop();
      await f.world.runUntilIdle();
      expect(outcome).toEqual(expected);
      expect(sent()).toBe(1);
      expect(leaseIds(f)).toEqual([]);
      expect(checkProperties(f)).toEqual([]);
    },
  );
});
