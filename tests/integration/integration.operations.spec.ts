import type { Page } from "@playwright/test";
import {
  bootHarness,
  expect,
  proxy,
  raw,
  rawSignIn,
  records,
  signIn,
  test,
  untilRecord,
  untilView,
} from "./helpers";

/**
 * I-06 and I-07 (plan 14.3): explicit logout and self-retirement against the RELEASED backend. The wipe runs with the default
 * "no local stores yet" data adapters (decision D-14): what it does to a real cache needs WEB-09a's adapter, and is not claimed.
 */
// WEB-09a registered the real local-work port: a confirmation carries what the page itself reports (the summary the person was
// shown), not a fixed "nothing" value; the callbacks below ask for it in the page, as the confirmation dialog does.

interface Seen {
  method: string;
  path: string;
  status: number;
  requestHeaders: Record<string, string>;
  body: unknown;
}
function watch(page: Page, pattern: RegExp): Seen[] {
  const seen: Seen[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!pattern.test(url.pathname)) return;
    const entry: Seen = {
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
      requestHeaders: {},
      body: null,
    };
    seen.push(entry);
    void response
      .request()
      .allHeaders()
      .then((h) => {
        entry.requestHeaders = h;
      });
    void response.json().then(
      (j) => {
        entry.body = j;
      },
      () => undefined,
    );
  });
  return seen;
}

test.describe("I-06: the logout ledger", () => {
  test("DELETE /sessions/{id} with an Idempotency-Key answers confirmed_applied; the wipe runs; the envelope goes; settled is cleared; the same call under a second session replays the same outcome", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const deletes = watch(page, /\/sessions\/[^/]+$/);
    expect((await signIn(page, "dave")).kind).toBe("settled");
    await untilView(page, "displaying");
    const before = (await records(page)).auth_state.settled;
    const second = await rawSignIn("dave");
    const started = await page.evaluate(async () => {
      const unsynced = await window.__s.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return window.__s.operations.logout({ unsynced });
    });
    expect(started.kind).toBe("started");
    await untilRecord(
      page,
      (s) => s.settled === null && Object.keys(s.fences).length === 0,
      "the operation completes and settled is cleared",
    );
    await untilView(page, "signed_out");
    // On the wire: the keyed DELETE of THIS session, answered with an outcome (SA-03).
    const call = deletes.find((entry) => entry.method === "DELETE");
    expect(call?.path.endsWith(`/sessions/${before?.session_id}`)).toBe(true);
    expect(call?.requestHeaders["idempotency-key"]).toBe(
      (started as { operation_id: string }).operation_id,
    );
    expect(call?.status).toBe(200);
    expect(call?.body).toMatchObject({ outcome: "confirmed_applied" });
    // The ledger is empty: nothing pending, no consent prompt.
    expect((await records(page)).pending_deletions).toEqual({});
    // The same call, from a second session of the same account, replays the same outcome (the server keeps the ledger).
    const replay = await raw("DELETE", `/sessions/${before?.session_id}`, {
      cookie: second.cookie,
      headers: {
        "x-csrf-token": second.csrf,
        "idempotency-key": (started as { operation_id: string }).operation_id,
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ outcome: "confirmed_applied" });
  });

  test("a session removed by another route BEFORE the keyed call is superseded: no wipe, and an invalid_session('removed_elsewhere') fence for the recovery", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    expect((await signIn(page, "dave")).kind).toBe("settled");
    await untilView(page, "displaying");
    const initial = (await records(page)).auth_state.settled;
    const other = await rawSignIn("dave");
    // Hold the logout's request BEFORE it reaches the backend, so another route can remove the session first.
    const hold = await proxy.addRule({
      method: "DELETE",
      path: "/^\\/api\\/experimental\\/v1\\/sessions\\/[^/]+$/",
      action: "hold_request",
      ordinal: 1,
    });
    const started = await page.evaluate(async () => {
      const unsynced = await window.__s.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return window.__s.operations.logout({ unsynced });
    });
    expect(started.kind).toBe("started");
    await expect.poll(async () => (await proxy.held())[hold.id] ?? 0).toBe(1);
    const removed = await raw("DELETE", `/sessions/${initial?.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    expect([200, 204]).toContain(removed.status);
    // The held call now reaches the backend authenticated as a session that no longer exists: a 401 is an observation, never an outcome.
    await proxy.release(hold.id);
    await untilView(page, "neutral", "1a.confirming");
    expect((await records(page)).auth_state.settled).not.toBeNull();
    // The person signs in again; the recovery replays the IDENTICAL keyed call under the new session.
    await expect
      .poll(async () => (await signIn(page, "dave")).kind, { timeout: 30_000 })
      .toBe("settled");
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the operation fence resolves",
    );
    const state = (await records(page)).auth_state;
    const fences = Object.values(state.fences).flat();
    expect(
      fences.some(
        (f) => f.kind === "invalid_session" && f.reason === "removed_elsewhere",
      ),
    ).toBe(true);
    expect(state.settled?.epoch).toBeGreaterThan(initial?.epoch ?? 0); // the new sign-in is kept
    expect((await records(page)).pending_deletions).toEqual({}); // superseded: nothing was wiped
  });
});

test.describe("I-07: self-retirement of the current device", () => {
  const readCurrent = async (page: Page) => {
    // NOT_SENT (a hold or a closing write in force for a moment) counts no attempt: retry it as a queue would.
    const read = await page.evaluate(async () => {
      let last = await window.__s.operations.readDevices();
      for (let i = 0; i < 40 && !last.ok && last.error === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await window.__s.operations.readDevices();
      }
      return last;
    });
    if (!read.ok)
      throw new Error(`devices read failed: ${JSON.stringify(read)}`);
    const current = read.value.devices.find((d) => d.current);
    if (!current) throw new Error("no current device");
    return current;
  };

  test("the approved state is unchanged: confirmed_applied, the sessions are revoked, the person is signed out, the wipe ran", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const calls = watch(page, /\/devices\/[^/]+$/);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    await untilView(page, "displaying");
    const row = await readCurrent(page);
    expect(row.state_token).toMatch(/^v1\./);
    const started = await page.evaluate(async (r) => {
      const unsynced = await window.__s.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return window.__s.operations.retireThisDevice({ read: r, unsynced });
    }, row);
    expect(started.kind).toBe("started");
    await untilRecord(
      page,
      (s) => s.settled === null && Object.keys(s.fences).length === 0,
      "the retirement completes",
    );
    const call = calls.find((c) => c.method === "DELETE");
    expect(call?.requestHeaders["atlas-device-state"]).toBe(row.state_token); // sent verbatim, never derived
    expect(call?.body).toMatchObject({ outcome: "confirmed_applied" });
    expect((await records(page)).pending_deletions).toEqual({});
  });

  test("STALE: a new sign-in on the same device between the read and the delete: 409 operation_conflict, rejected_stale, nothing deleted, never retried", async ({
    context,
    provokes,
  }) => {
    provokes(409);
    const page = await bootHarness(context);
    const calls = watch(page, /\/devices\/[^/]+$/);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    await untilView(page, "displaying");
    const row = await readCurrent(page);
    const deviceId = (await records(page)).device?.device_id ?? "";
    // The state the token approved changes: a further session under the SAME device id.
    await rawSignIn("bob", deviceId);
    const started = await page.evaluate(async (r) => {
      const unsynced = await window.__s.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return window.__s.operations.retireThisDevice({ read: r, unsynced });
    }, row);
    expect(started.kind).toBe("started");
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the stale outcome resolves the fence",
    );
    await page.waitForTimeout(500);
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1); // rejected_stale is NEVER retried against changed state
    expect(deletes[0]?.status).toBe(409);
    expect(deletes[0]?.body).toMatchObject({ code: "operation_conflict" });
    expect((await records(page)).auth_state.settled).not.toBeNull(); // nothing was cleared or wiped
    expect((await records(page)).pending_deletions).toEqual({});
    await untilView(page, "neutral", "1a.device_changed");
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "This device changed after you confirmed",
      }),
    ).toBeVisible();
  });

  test("LOST RESPONSE: the backend commits, the connection drops, the calling session is revoked; after re-authenticating on the same device the identical call replays confirmed_applied, the wipe runs, and the newer sign-in is kept", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    await untilView(page, "displaying");
    const row = await readCurrent(page);
    const initial = (await records(page)).auth_state.settled;
    const rule = await proxy.addRule({
      method: "DELETE",
      path: "/^\\/api\\/experimental\\/v1\\/devices\\/[^/]+$/",
      action: "drop_after_forward",
      ordinal: 1,
    });
    expect(rule.id).toBeTruthy();
    const started = await page.evaluate(async (r) => {
      const unsynced = await window.__s.operations.summariseLocalWork();
      if (!unsynced) throw new Error("nobody is settled");
      return window.__s.operations.retireThisDevice({ read: r, unsynced });
    }, row);
    expect(started.kind).toBe("started");
    // The connection dropped: the person cannot know. The fence and the envelope stay; the card is the honest one.
    await untilView(page, "neutral", "1a.confirming");
    expect(
      Object.values((await records(page)).auth_state.fences)
        .flat()
        .some((f) => f.kind === "operation"),
    ).toBe(true);
    // Re-authenticate on the SAME device.
    await expect
      .poll(async () => (await signIn(page, "alice")).kind, { timeout: 30_000 })
      .toBe("settled");
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .every((f) => f.kind !== "operation"),
      "the operation resolves after the re-authentication",
    );
    const state = (await records(page)).auth_state;
    expect(state.settled?.epoch).toBeGreaterThan(initial?.epoch ?? 0); // the recovery session is kept
    expect((await records(page)).pending_deletions).toEqual({});
    // The recovery session is alive: it was never deleted.
    await untilView(page, "displaying");
    const listed = await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    expect(listed.ok).toBe(true);
  });
});
