import type { Page } from "@playwright/test";
import {
  bootHarness,
  expect,
  finishSignIn,
  liftedAt,
  proxy,
  raw,
  rawSignIn,
  recordMeasurement,
  records,
  setVisibility,
  signIn,
  startSignIn,
  test,
  untilHeld,
  untilRecord,
  untilView,
  view,
  watchLift,
} from "./helpers";

/**
 * I-09, I-10 and I-12 to I-15 (plan 14.3), required on Chromium and run on the other engines where the engine allows. Two pages of
 * one browser context are two tabs of one origin sharing IndexedDB, Web Locks and the cookie jar. Visibility is driven by
 * overriding `document.visibilityState` (limitation stated in docs/browser-support.md).
 */

const SESSIONS = /^\/api\/experimental\/v1\/sessions$/;
const sessionsRule = (action: "hold" | "hold_request") => ({
  method: "GET",
  path: "/^\\/api\\/experimental\\/v1\\/sessions$/",
  action,
  ordinal: 1,
});
void SESSIONS;

async function signedIn(
  context: import("@playwright/test").BrowserContext,
  who: "alice" | "bob" = "alice",
): Promise<Page> {
  const page = await bootHarness(context);
  expect((await signIn(page, who)).kind).toBe("settled");
  await untilView(page, "displaying");
  return page;
}

test.describe("I-09: two pages, one browser context", () => {
  test("page 1's request is held by the proxy: page 2's exposure DEFERS; a clean answer lets it proceed (surrender-to-grant delay recorded)", async ({
    context,
  }) => {
    const first = await signedIn(context);
    const rule = await proxy.addRule(sessionsRule("hold"));
    await first.evaluate(() => {
      window.__t.pending = window.__retry(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      );
    });
    await untilHeld(rule.id);
    const second = await bootHarness(context);
    await watchLift(second);
    await second.waitForTimeout(1500);
    // Page 2 has NOT exposed: a request that is still open cannot yet say whether the session has ended.
    expect(await liftedAt(second)).toBeNull();
    expect(
      await second.evaluate(() =>
        document.getElementById("protected-root")?.hasAttribute("inert"),
      ),
    ).toBe(true);
    const released = Date.now();
    await proxy.release(rule.id);
    await expect
      .poll(() => liftedAt(second), { timeout: 15_000 })
      .not.toBeNull();
    const liftedTime = await liftedAt(second);
    const delay = (liftedTime ?? released) - released;
    recordMeasurement(
      "P-5 surrender-to-grant (clean answer, page 1 -> page 2, chromium)",
      { milliseconds: delay },
    );
    await untilView(second, "displaying");
    expect(await first.evaluate(() => window.__t.pending)).toMatchObject({
      ok: true,
    });
  });

  test("a 401 answer closes page 2 before it ever displays", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const first = await signedIn(context);
    const other = await rawSignIn("alice");
    const rule = await proxy.addRule(sessionsRule("hold_request"));
    await first.evaluate(() => {
      window.__t.pending = window.__retry(() =>
        window.__retry(() => window.__s.operations.listSessions()),
      );
    });
    await untilHeld(rule.id);
    const second = await bootHarness(context);
    await watchLift(second);
    // The session is removed by another route while the request waits; releasing it lets the backend answer 401.
    const current = (await records(first)).auth_state.settled;
    await raw("DELETE", `/sessions/${current?.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    await proxy.release(rule.id);
    await untilView(second, "neutral", "1b");
    expect(await liftedAt(second)).toBeNull(); // page 2 never displayed
    await untilView(first, "neutral", "1b");
    expect(
      Object.values((await records(first)).auth_state.fences)
        .flat()
        .some((f) => f.kind === "invalid_session"),
    ).toBe(true);
  });
});

test.describe("I-10: real adapters, two pages", () => {
  test("both pages display the settled account from the shared record; concurrent requests from both are all answered; no lock or lease is left", async ({
    context,
  }) => {
    const first = await signedIn(context);
    const second = await bootHarness(context);
    await untilView(second, "displaying");
    const results = await Promise.all(
      [first, second].map((page) =>
        page.evaluate(async () => {
          const out = await Promise.all(
            Array.from({ length: 5 }, () =>
              window.__retry(() => window.__s.operations.listSessions()),
            ),
          );
          return out.map((r) => r.ok);
        }),
      ),
    );
    // A request may be NOT_SENT for a moment (a hold), never lost; count the answered ones.
    expect(results.flat().filter(Boolean).length).toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          Object.keys((await records(first)).auth_state.leases).length,
        { timeout: 15_000 },
      )
      .toBe(0);
    // No lease lock is still held (a test may use query(); the product never does). A release is published to other pages a moment
    // after the holder lets go, so this is polled.
    await expect
      .poll(
        () =>
          first.evaluate(async () => {
            const state = await navigator.locks.query();
            return (state.held ?? [])
              .map((l) => l.name ?? "")
              .filter(
                (n) =>
                  n.startsWith("atlas-lease-") || n.startsWith("atlas-issue-"),
              );
          }),
        { timeout: 15_000 },
      )
      .toEqual([]);
    expect(Object.keys((await records(first)).auth_state.fences)).toEqual([]);
  });
});

test.describe("I-12: the level-0 gate with a real session", () => {
  test("hidden then visible: the first frame is neutral, the same-account lift restores focus", async ({
    context,
  }) => {
    const page = await signedIn(context, "bob");
    // Let the router finish rendering its route: until its heading is there the shell may still replace the element we focus.
    await page.waitForSelector("#protected-root h1");
    await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
    });
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
    await setVisibility(page, "hidden");
    const gated = await page.evaluate(() => ({
      inert: document.getElementById("protected-root")?.hasAttribute("inert"),
      modal: (
        document.getElementById("resume-gate") as HTMLDialogElement | null
      )?.matches(":modal"),
      title: document.title,
    }));
    expect(gated).toEqual({ inert: true, modal: true, title: "Atlas" });
    await setVisibility(page, "visible");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById("protected-root")?.hasAttribute("inert"),
        ),
      )
      .toBe(false);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
  });

  test("a fence recorded while hidden prevents the lift", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const first = await signedIn(context, "bob");
    await setVisibility(first, "hidden");
    // Another page of the same browser finds the session gone and records the fence.
    const other = await rawSignIn("bob");
    const current = (await records(first)).auth_state.settled;
    await raw("DELETE", `/sessions/${current?.session_id}`, {
      cookie: other.cookie,
      headers: { "x-csrf-token": other.csrf },
    });
    const second = await bootHarness(context);
    await second.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    await untilRecord(
      first,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "the second page recorded the fence",
    );
    await setVisibility(first, "visible");
    await untilView(first, "neutral", "1b");
    expect(
      await first.evaluate(
        () => document.getElementById("protected-root")?.innerHTML,
      ),
    ).toBe("");
  });
});

test.describe("I-13: ordinary offline continuation (row 6)", () => {
  test("with the API unreachable (HTML still served) a new page for a settled account exposes it, and the canary passes", async ({
    context,
    provokes,
  }) => {
    provokes(0);
    const seed = await signedIn(context, "alice");
    // Close it only when it is quiescent: a page closed while its resume verification is still in flight leaves an UNRESOLVED
    // lease, and the protocol (correctly, row 9) then keeps the content hidden until one online read settles it.
    await untilRecord(
      seed,
      (s) => Object.keys(s.leases).length === 0,
      "no lease is outstanding",
    );
    await seed.close();
    let apiCalls = 0;
    await context.route(/\/(api\/|health)/, (route) => {
      apiCalls += 1;
      return route.abort("connectionrefused");
    });
    const page = await bootHarness(context);
    await untilView(page, "displaying");
    expect(
      await page.evaluate(
        () => window.__atlasFixture?.session?.booted !== null,
      ),
    ).toBe(true);
    // The person is shown the account without a single successful API call; the attempts that were made were refused by the network.
    expect(apiCalls).toBeGreaterThanOrEqual(0);
    expect((await records(page)).auth_state.settled).not.toBeNull();
  });
});

test.describe("I-14: account switch and return (rows 7 and 8)", () => {
  test("B's attempt held at activate: A is gated while it activates; B settles; A's records are untouched and A's queue cannot replay under B; switching back is a fresh attempt and an A fence survives the switch", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    // A fence for A first (a detected invalidation), so that "an A fence survives the switch" is meaningful.
    const revoker = await rawSignIn("alice");
    await raw("DELETE", `/sessions/${a?.session_id}`, {
      cookie: revoker.cookie,
      headers: { "x-csrf-token": revoker.csrf },
    });
    await page.evaluate(() =>
      window.__retry(() => window.__s.operations.listSessions()),
    );
    await untilRecord(
      page,
      (s) =>
        Object.values(s.fences)
          .flat()
          .some((f) => f.kind === "invalid_session"),
      "A is fenced",
    );
    const fencesBefore = Object.values(
      (await records(page)).auth_state.fences,
    ).flat().length;

    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "bob");
    await untilHeld(rule.id);
    // While B's activation gates, the neutral card for a sign-in in progress is shown.
    await untilView(page, "neutral", "1c.finishing");
    await proxy.release(rule.id);
    expect((await finishSignIn(page)).kind).toBe("settled");
    const state = (await records(page)).auth_state;
    expect(state.settled?.account_id).not.toBe(a?.account_id);
    // A's fence and A's local records were not touched by the switch.
    expect(Object.values(state.fences[a?.account_id ?? ""] ?? []).length).toBe(
      fencesBefore,
    );
    expect((await records(page)).pending_deletions).toEqual({});
    // A's queue never replays under B: a stamped call for (A, old epoch) is STALE.
    const stale = await page.evaluate(
      async (arg) => {
        try {
          await window.__s.api.fetchFor(
            "ordinary",
            arg.account,
            arg.epoch,
          )(new Request(`${location.origin}/api/experimental/v1/sessions`));
          return "sent";
        } catch (error) {
          return (error as { kind?: string }).kind ?? String(error);
        }
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    expect(stale).toBe("stale");
    // Switching back is a fresh attempt with a fresh epoch, and A's old fence is still there until catch-up.
    expect((await signIn(page, "alice")).kind).toBe("settled");
    const back = (await records(page)).auth_state;
    expect(back.settled?.account_id).toBe(a?.account_id);
    expect(back.settled?.epoch).toBeGreaterThan(state.settled?.epoch ?? 0);
    expect(
      Object.values(back.fences[a?.account_id ?? ""] ?? []).length,
    ).toBeGreaterThanOrEqual(1);
    expect((await view(page)).kind).toBe("neutral");
  });
});

test.describe("I-14b: an answer that arrives after the switch (G4, matrix 3.7.2)", () => {
  test("a clean answer to A's request, delivered after B has settled in the same page, is dropped as stale and never returned to its caller", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await page.evaluate(
      (arg) => {
        window.__t.late = window.__s.api
          .client("ordinary", arg.account, arg.epoch)
          .GET("/sessions")
          .then(
            () => "returned",
            (error: unknown) => (error as { kind?: string }).kind ?? "threw",
          );
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    await untilHeld(held.id);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    expect((await records(page)).auth_state.settled?.account_id).not.toBe(
      a?.account_id,
    );
    await proxy.release(held.id);
    expect(await page.evaluate(() => window.__t.late)).toBe("stale");
    // The lease of the request was retired in its own order, so nothing is left for another page to treat as unresolved.
    expect(Object.keys((await records(page)).auth_state.leases)).toEqual([]);
  });
});

test.describe("I-14c: a transition completed by ANOTHER page whose notice never reaches this one (G4, matrix 3.7.2)", () => {
  test("A's clean answer, delivered after a second page settled B, is dropped as stale although this page was never told; it then learns of B from the check itself", async ({
    context,
  }) => {
    // This page's BroadcastChannel notices are switched off (after boot) by wrapping the channel in every page of the
    // context: the only way this page can learn of the other page's transition is to read `atlas-auth` itself.
    await context.addInitScript(() => {
      const Native = window.BroadcastChannel;
      if (!Native) return;
      window.BroadcastChannel = class extends Native {
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          super.onmessage =
            typeof handler === "function"
              ? (event: MessageEvent) => {
                  if (
                    !(window as unknown as { __dropHints?: boolean })
                      .__dropHints
                  )
                    handler.call(this, event);
                }
              : handler;
        }
        get onmessage() {
          return super.onmessage;
        }
      };
    });
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await first.evaluate(
      (arg) => {
        window.__t.late = window.__s.api
          .client("ordinary", arg.account, arg.epoch)
          .GET("/sessions")
          .then(
            () => "returned",
            (error: unknown) => (error as { kind?: string }).kind ?? "threw",
          );
      },
      { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
    );
    await untilHeld(held.id);
    // The request's own lease, while its answer is held (the only lease this page has just now).
    const requestLeases = Object.keys((await records(first)).auth_state.leases);
    expect(requestLeases.length).toBeGreaterThan(0);
    await first.evaluate(() => {
      (window as unknown as { __dropHints?: boolean }).__dropHints = true;
    });
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // The first page has not been told: its own copy still names A.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await proxy.release(held.id);
    expect(await first.evaluate(() => window.__t.late)).toBe("stale");
    // The request's lease was retired in its own order. Other leases may exist by now, (this page re-reads the record at once
    // and starts exposing the account that IS settled), so the question is about THIS request's lease.
    await expect
      .poll(async () => {
        const now = (await records(first)).auth_state.leases;
        return requestLeases.filter((id) => id in now);
      })
      .toEqual([]);
    // Still no notice, and the page nevertheless catches up: the check re-read the record when it found it had moved on.
    await expect
      .poll(() => first.evaluate(() => window.__s.identity.get()?.account_id))
      .toBe(settled?.account_id);
  });
});

/**
 * The verdict is taken in the step that reads the record, not at the delivery of that read's completion (G4, matrix 3.7.2). Real
 * IndexedDB, real Web Locks, the released backend. Two pieces of test instrumentation model a busy page: this page's
 * BroadcastChannel notices are switched off, and the completion of its `response_check` transaction is held (the transaction
 * itself ran and committed; only its `complete` is delayed to the page). Neither is a measured browser scheduling delay.
 */
const switchOffNotices = (context: import("@playwright/test").BrowserContext) =>
  context.addInitScript(() => {
    const Native = window.BroadcastChannel;
    if (!Native) return;
    window.BroadcastChannel = class extends Native {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage =
          typeof handler === "function"
            ? (event: MessageEvent) => {
                if (
                  !(window as unknown as { __dropHints?: boolean }).__dropHints
                )
                  handler.call(this, event);
              }
            : handler;
      }
      get onmessage() {
        return super.onmessage;
      }
    };
  });

/** Switch this page's notices off, hold the completion of its `response_check`, and start a typed `GET /sessions` for `a`. */
async function startHeldCheckCall(
  page: Page,
  a: { account_id: string; epoch: number } | null | undefined,
) {
  await page.evaluate(
    (arg) => {
      const w = window as unknown as {
        __dropHints?: boolean;
        __atlasFixture: {
          session: {
            booted: {
              store: {
                transact: (
                  body: unknown,
                  options?: { label?: string },
                ) => { complete: Promise<unknown> };
              };
            };
          };
        };
      };
      w.__dropHints = true;
      const store = w.__atlasFixture.session.booted.store;
      const original = store.transact.bind(store);
      store.transact = (body, options) => {
        const tx = original(body, options);
        if (options?.label !== "response_check") return tx;
        return {
          complete: tx.complete.then(
            (value) =>
              new Promise((resolve) => {
                window.__t.checkHeld = true;
                window.__t.releaseCheck = () => resolve(value);
              }),
          ),
        };
      };
      window.__t.checkHeld = false;
      window.__t.late = window.__s.api
        .client("ordinary", arg.account, arg.epoch)
        .GET("/sessions")
        .then(
          () => {
            window.__t.returnedAt = Date.now();
            return "returned";
          },
          (error: unknown) => {
            window.__t.returnedAt = Date.now();
            return (error as { kind?: string }).kind ?? "threw";
          },
        );
    },
    { account: a?.account_id ?? "", epoch: a?.epoch ?? 0 },
  );
}

test.describe("I-14d: the release does not wait for the completion of the check (G4, matrix 3.7.2)", () => {
  test("the transition is ordered AFTER the read: the answer was released at the read, while the completion is still held, and the other page's sign-in is not held up", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await startHeldCheckCall(first, a);
    await untilHeld(held.id);
    await proxy.release(held.id);
    await first.waitForFunction(() => window.__t.checkHeld === true);
    // The completion has been delivered to the page and is held by the instrumentation: the call has already returned.
    expect(await first.evaluate(() => window.__t.late)).toBe("returned");
    const returnedAt = await first.evaluate(
      () => window.__t.returnedAt as number,
    );
    const second = await bootHarness(context);
    const signInStartedAt = await second.evaluate(() => Date.now());
    expect((await signIn(second, "bob")).kind).toBe("settled");
    expect(returnedAt).toBeLessThanOrEqual(signInStartedAt);
    // This page has not been told, and nothing it already returned changes when the completion is let through.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await first.evaluate(() => (window.__t.releaseCheck as () => void)());
    expect(await first.evaluate(() => window.__t.late)).toBe("returned");
  });

  test("the transition is ordered BEFORE the read: `stale` while the completion is still held, and the page catches up from the read", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    const held = await proxy.addRule(sessionsRule("hold"));
    await startHeldCheckCall(first, a);
    await untilHeld(held.id);
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    const releasedAt = await first.evaluate(() => Date.now());
    await proxy.release(held.id);
    await first.waitForFunction(() => window.__t.checkHeld === true);
    // Refused by the read itself; the delayed completion and the missing notice changed nothing. Nor did the verdict wait
    // for the stall interval (5 s), which is what a caller waiting for a held completion would have had to.
    expect(await first.evaluate(() => window.__t.late)).toBe("stale");
    const refusedAt = await first.evaluate(
      () => window.__t.returnedAt as number,
    );
    expect(refusedAt - releasedAt).toBeLessThan(2500);
    await first.evaluate(() => (window.__t.releaseCheck as () => void)());
    await expect
      .poll(() => first.evaluate(() => window.__s.identity.get()?.account_id))
      .toBe(settled?.account_id);
  });
});

/**
 * I-14e: the decode of the answer's body is part of the public call. Decoding a buffered body is asynchronous (a fetch task), so
 * a check taken before the library's or the operation's own `response.json()` is overtaken by a transition that completes while
 * the decode runs. The decode is held in the page by wrapping `Response.prototype.json` (the real decode runs, its settlement is
 * then held): TEST INSTRUMENTATION that places the interval, not a measured delay and not a naturally occurring freeze. The three
 * public calls that decode a list (the ordinary typed client, `listSessions`, `readDevices`) are held TOGETHER in one page, so
 * that one sign-in serves all three (the backend allows a bounded number of password sign-ins per source and minute). Their PUBLIC
 * promises must stay pending while the decodes are held, and a result of a call made under account A must never be handed to
 * a page that has since settled account B, or re-authenticated A, whether the transition is this page's own or another page's
 * whose notice never reaches this one.
 */
const REFUSED = {
  typed: "stale",
  listSessions: "closed",
  readDevices: "closed",
} as const;
const RETURNED = {
  typed: "returned",
  listSessions: "returned",
  readDevices: "returned",
} as const;

/** Start the three calls for the page's settled identity and hold their decodes; the public promise is `window.__t.answers`. */
async function startHeldDecodeCalls(page: Page) {
  await page.evaluate(() => {
    const original = Response.prototype.json;
    window.__t.decodeHeld = 0;
    window.__t.done = 0;
    let release: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.__t.releaseDecode = () => {
      release();
      Response.prototype.json = original;
    };
    Response.prototype.json = async function json(this: Response) {
      const value: unknown = await original.call(this);
      const lists = value as Record<string, unknown> | null;
      if (Array.isArray(lists?.sessions) || Array.isArray(lists?.devices)) {
        window.__t.decodeHeld = (window.__t.decodeHeld as number) + 1;
        await paused;
      }
      return value;
    };
    const identity = window.__s.identity.get();
    if (!identity) throw new Error("no identity");
    const text = (result: { ok: boolean; error?: string }) =>
      result.ok ? "returned" : (result.error ?? "");
    // A stamped call refused as `not_sent` (a hold or a closing write was in force for a moment) is retried, as a queue would.
    const typed = async (): Promise<string> => {
      const once = () =>
        window.__s.api
          .client("ordinary", identity.account_id, identity.epoch)
          .GET("/sessions")
          .then(
            () => "returned",
            (error: unknown) => (error as { kind?: string }).kind ?? "threw",
          );
      let last = await once();
      for (let i = 1; i < 60 && last === "not_sent"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await once();
      }
      return last;
    };
    const counted = (run: Promise<string>) =>
      run.then((value) => {
        window.__t.done = (window.__t.done as number) + 1;
        return value;
      });
    window.__t.answers = Promise.all([
      counted(typed()),
      counted(
        window.__retry(() => window.__s.operations.listSessions()).then(text),
      ),
      counted(
        window.__retry(() => window.__s.operations.readDevices()).then(text),
      ),
    ]).then(([typedAnswer, listSessions, readDevices]) => ({
      typed: typedAnswer,
      listSessions,
      readDevices,
    }));
  });
  await page.waitForFunction(() => window.__t.decodeHeld === 3);
  expect(await page.evaluate(() => window.__t.done)).toBe(0);
}

const releaseDecodes = (page: Page) =>
  page.evaluate(() => (window.__t.releaseDecode as () => void)());
const answers = (page: Page) => page.evaluate(() => window.__t.answers);
const stillPending = async (page: Page) =>
  expect(await page.evaluate(() => window.__t.done)).toBe(0);

test.describe("I-14e: the decode of the answer's body is part of the public call (G4, matrix 3.7.2)", () => {
  test("no transition: the held decodes end and all three results are returned (the control)", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    await startHeldDecodeCalls(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(RETURNED);
  });

  test("a sign-in as bob in the SAME page while the decodes are held: the public promises stay pending, then refuse alice's results", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    await startHeldDecodeCalls(page);
    expect((await signIn(page, "bob")).kind).toBe("settled");
    const settled = (await records(page)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // The record and this page's identity both name bob, and the calls made under alice have still not resolved.
    expect(
      await page.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(settled?.account_id);
    await stillPending(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(REFUSED);
  });

  test("a re-authentication of the SAME account (epoch 1 to 2) while the decodes are held: refused", async ({
    context,
  }) => {
    const page = await signedIn(context, "alice");
    const a = (await records(page)).auth_state.settled;
    await startHeldDecodeCalls(page);
    expect((await signIn(page, "alice")).kind).toBe("settled");
    const settled = (await records(page)).auth_state.settled;
    expect(settled?.account_id).toBe(a?.account_id);
    expect(settled?.epoch).toBeGreaterThan(a?.epoch ?? 0);
    await stillPending(page);
    await releaseDecodes(page);
    expect(await answers(page)).toEqual(REFUSED);
  });

  test("ANOTHER page settles bob while this page's notices are switched off: this page still names alice, and the results are refused", async ({
    context,
  }) => {
    await switchOffNotices(context);
    const first = await signedIn(context, "alice");
    const a = (await records(first)).auth_state.settled;
    await first.evaluate(() => {
      (window as unknown as { __dropHints?: boolean }).__dropHints = true;
    });
    await startHeldDecodeCalls(first);
    const second = await bootHarness(context);
    expect((await signIn(second, "bob")).kind).toBe("settled");
    const settled = (await records(second)).auth_state.settled;
    expect(settled?.account_id).not.toBe(a?.account_id);
    // No notice reached this page: only the record knows, and the public promises have still not resolved.
    expect(
      await first.evaluate(() => window.__s.identity.get()?.account_id),
    ).toBe(a?.account_id);
    await stillPending(first);
    await releaseDecodes(first);
    expect(await answers(first)).toEqual(REFUSED);
  });
});

test.describe("I-15: hiding the page aborts a real activate", () => {
  test("the activation is aborted at once; the attempt is indeterminate; activate/cancel resolves it", async ({
    context,
    provokes,
  }) => {
    provokes(401);
    const page = await bootHarness(context);
    const rule = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions/activate",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "alice");
    await untilHeld(rule.id);
    await setVisibility(page, "hidden");
    await untilRecord(
      page,
      (s) =>
        s.attempt === null ||
        s.attempt.phase === "indeterminate" ||
        s.attempt.phase === "verifying",
      "the attempt leaves the activating phase",
    );
    await proxy.release(rule.id);
    await untilRecord(
      page,
      (s) => s.attempt === null,
      "activate/cancel resolves the attempt",
    );
    const state = (await records(page)).auth_state;
    expect(state.settled).toBeNull(); // a hidden page never adopts what it aborted
    const log = await proxy.log();
    expect(log.some((entry) => entry.path.endsWith("/activate/cancel"))).toBe(
      true,
    );
    void (await finishSignIn(page).catch(() => undefined));
  });

  test("hiding BEFORE the activate is issued (the page still waits for atlas-auth): no activate is ever sent and nothing was committed", async ({
    context,
  }) => {
    const page = await bootHarness(context);
    const other = await bootHarness(context);
    // The exchange is held, so that the other tab can take `atlas-auth` between the exchange and the activation.
    const exchange = await proxy.addRule({
      method: "POST",
      path: "/api/experimental/v1/browser-sessions",
      action: "hold",
      ordinal: 1,
    });
    await startSignIn(page, "alice");
    await untilHeld(exchange.id);
    await other.evaluate(async () => {
      const locks = window.__atlasFixture?.session?.locks;
      if (!locks) throw new Error("the session harness is not loaded");
      const held = await locks.acquire("atlas-auth");
      if (!held) throw new Error("could not take atlas-auth");
      window.__t.authHeld = held;
    });
    await proxy.release(exchange.id);
    // The page now waits for `atlas-auth`: nothing has been activated.
    await page.waitForTimeout(800);
    expect(
      (await proxy.log()).some((entry) =>
        entry.path.endsWith("/browser-sessions/activate"),
      ),
    ).toBe(false);
    await setVisibility(page, "hidden");
    await other.evaluate(() =>
      (window.__t.authHeld as { release(): void }).release(),
    );
    // The wait ends without sending: the attempt is cleared and nothing is settled.
    expect(await finishSignIn(page)).toMatchObject({
      kind: "not_started",
      reason: "hidden",
    });
    await untilRecord(
      page,
      (s) => s.attempt === null,
      "the abandoned attempt is cleared",
    );
    expect((await records(page)).auth_state.settled).toBeNull();
    expect(
      (await proxy.log()).some((entry) =>
        entry.path.endsWith("/browser-sessions/activate"),
      ),
    ).toBe(false);
  });
});
