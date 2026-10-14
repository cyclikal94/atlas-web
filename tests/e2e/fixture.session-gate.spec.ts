import type { BrowserContext, Page } from "@playwright/test";
import { expect, pressTab, test } from "./helpers";

/**
 * S-GATE (plan 13.5): the level-0 resume gate, the exposure and the level-1 neutral states in a real engine, through the
 * fixture-only session harness (the PRODUCTION composition: real IndexedDB store, Web Locks, BroadcastChannel, page and
 * protected-surface adapters) with a settled account seeded straight into `atlas-auth` and the network stubbed by `page.route`.
 * There is no backend: this is FIXTURE evidence about DOM contract, `inert` and the top layer.
 *
 * LIMITATION, stated where it applies: visibility is driven by overriding `document.visibilityState` and dispatching
 * `visibilitychange` (the engine's own event would need a second visible window per engine). Real freeze, bfcache and
 * assistive-technology behaviour are WEB-08c's.
 */
const iso = () => new Date().toISOString();
const settled = (account: string, epoch: number, session: string) => ({
  schema: 1,
  latest_epoch: epoch,
  fence_seq: 0,
  attempt: null,
  settled: {
    account_id: account,
    epoch,
    settled_at: iso(),
    session_id: session,
  },
  fences: {},
  leases: {},
});
const withInvalidSession = (state: ReturnType<typeof settled>) => ({
  ...state,
  fence_seq: 1,
  fences: {
    [state.settled.account_id]: [
      {
        seq: 1,
        epoch: state.settled.epoch,
        obs_id: "fence-1",
        kind: "invalid_session",
        reason: "unauthenticated",
        created_at: iso(),
      },
    ],
  },
});

interface Stub {
  identity: { account: string; session: string };
  apiRequests: string[];
}

/** Stubs /health and the identity read; records every API request. There is no backend behind this. */
async function stub(context: BrowserContext): Promise<Stub> {
  const state: Stub = {
    identity: { account: "acct-a", session: "s1" },
    apiRequests: [],
  };
  await context.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", api_version: "0.28.0" }),
    }),
  );
  await context.route("**/api/experimental/v1/**", (route) => {
    const url = new URL(route.request().url());
    state.apiRequests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname.endsWith("/browser-sessions/current"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account_id: state.identity.account,
          session_id: state.identity.session,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          csrf_token: `csrf.${state.identity.session}`,
        }),
      });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });
  return state;
}

/**
 * Write `auth_state` with a page that runs no session (boot off), as another tab or a previous visit would have left it.
 * The harness module is imported dynamically, so `goto` can return before it exists: wait for it, and fail loudly if it is
 * still missing (a silent no-op here once left a page with an empty record, about one run in fifty on Firefox).
 */
async function seed(context: BrowserContext, state: unknown): Promise<void> {
  const page = await context.newPage();
  await page.goto("/__session?boot=off");
  await page.waitForFunction(
    () => window.__atlasFixture?.session !== undefined,
  );
  await page.evaluate(async (value) => {
    const harness = window.__atlasFixture?.session;
    if (!harness) throw new Error("the session harness is not loaded");
    await harness.seedAuthState(value);
  }, state);
  await page.close();
}

async function open(context: BrowserContext, route = "/today"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/__session?route=${encodeURIComponent(route)}`);
  await page.waitForFunction(() => {
    const root = document.getElementById("protected-root");
    return (
      root && !root.hasAttribute("inert") && root.querySelector("h1") !== null
    );
  });
  return page;
}

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

const gated = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById("protected-root");
    const gate = document.getElementById(
      "resume-gate",
    ) as HTMLDialogElement | null;
    return {
      inert:
        root?.hasAttribute("inert") === true &&
        (root as HTMLElement & { inert: boolean }).inert === true,
      ariaHidden: root?.getAttribute("aria-hidden"),
      gateOpen: gate?.open === true,
      gateModal: gate?.matches(":modal") === true,
      title: document.title,
    };
  });

/**
 * WEB-08c revision 3 (R8, HF-13): DIAGNOSTIC ONLY, no assertion depends on it. Every programmatic `focus()`/`blur()` (with its stack), every
 * focus change and every open/close of a dialog is recorded in the page from before the application boots, so a failed focus assertion
 * names the writer that moved focus (the campaign-7 trace could not: Playwright's DOM snapshots carry no focus).
 */
async function recordFocusWriters(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const log: Array<Record<string, unknown>> = [];
    (window as unknown as { __focusWriters?: unknown }).__focusWriters = log;
    const describe = (el: Element | null | undefined): string | null => {
      if (!el) return null;
      if (el === document.body) return "BODY";
      const key = el.getAttribute("data-focus-key");
      return `${el.tagName}${el.id ? `#${el.id}` : ""}${key ? `[${key}]` : ""}${el.closest("#protected-root") ? "{protected}" : ""}${el.closest("[data-neutral-state]") ? "{neutral}" : ""}`;
    };
    const push = (entry: Record<string, unknown>) => {
      if (log.length < 2_000)
        log.push({
          t: Math.round(performance.now() * 10) / 10,
          active: describe(document.activeElement),
          ...entry,
        });
    };
    const stack = () =>
      (new Error().stack ?? "").split("\n").slice(2, 7).join(" | ");
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, o) {
      focus.call(this, o);
      push({ op: "focus()", el: describe(this), stack: stack() });
    };
    const blur = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function (this: HTMLElement) {
      blur.call(this);
      push({ op: "blur()", el: describe(this), stack: stack() });
    };
    for (const name of ["showModal", "close"] as const) {
      const original = HTMLDialogElement.prototype[name];
      HTMLDialogElement.prototype[name] = function (
        this: HTMLDialogElement,
        ...args: never[]
      ) {
        (original as (...a: never[]) => void).apply(this, args);
        push({ op: `dialog.${name}`, el: describe(this) });
      } as never;
    }
    document.addEventListener(
      "focusin",
      (e) => push({ op: "focusin", el: describe(e.target as Element) }),
      true,
    );
  });
}

test.describe("S-GATE: exposure and the resume gate with real inert and the real top layer", () => {
  test.beforeEach(async ({ context }) => {
    await recordFocusWriters(context);
  });
  // WEB-08c revision 2 (HF-13, pool request-d461b22caa2343fc898f): DIAGNOSTIC ONLY, no assertion is affected. When a case fails, every open
  // session-harness page's kernel trace is attached, so an unexplained resume (focus not returned once in 62 pool runs) can be read next time.
  // Revision 3 adds the page's record of focus writers (above).
  test.afterEach(async ({ context }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    for (const [index, page] of context.pages().entries()) {
      const trace = await page
        .evaluate(() => window.__atlasFixture?.session?.trace ?? null)
        .catch(() => null);
      if (trace)
        await testInfo.attach(`kernel-trace-page-${index}.json`, {
          body: JSON.stringify(trace, null, 1),
          contentType: "application/json",
        });
      const writers = await page
        .evaluate(
          () =>
            (window as unknown as { __focusWriters?: unknown })
              .__focusWriters ?? null,
        )
        .catch(() => null);
      if (writers)
        await testInfo.attach(`focus-writers-page-${index}.json`, {
          body: JSON.stringify(writers, null, 1),
          contentType: "application/json",
        });
    }
  });
  test("a settled account is shown by a page loaded with no API call of its own (row 6, ordinary continuation)", async ({
    context,
  }) => {
    const network = await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    // The page believes it is offline: nothing may be asked of the API to show an eligible account.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
    });
    const page = await open(context);
    expect(await page.locator("#protected-root h1").count()).toBeGreaterThan(0);
    expect((await gated(page)).inert).toBe(false);
    await page.waitForTimeout(300);
    expect(network.apiRequests).toEqual([]);
  });

  test("hidden: the root is inert and aria-hidden, the gate is the topmost modal dialog, the title is neutral", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context, "/settings/appearance");
    await expect(
      page.getByRole("dialog", { name: "Appearance" }),
    ).toBeVisible();
    expect(await page.title()).toMatch(/Atlas/);
    await setVisibility(page, "hidden");
    expect(await gated(page)).toEqual({
      inert: true,
      ariaHidden: "true",
      gateOpen: true,
      gateModal: true,
      title: "Atlas",
    });
    // The open protected modal dialog is covered: what is at the centre of the viewport is the gate.
    const covered = await page.evaluate(() => {
      const top = document.elementFromPoint(
        window.innerWidth / 2,
        window.innerHeight / 2,
      );
      return top?.closest("#resume-gate") !== null;
    });
    expect(covered).toBe(true);
  });

  test("hidden: Tab reaches nothing in the protected tree, and the accessibility tree outside the gate is empty", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    await setVisibility(page, "hidden");
    for (let step = 0; step < 6; step += 1) {
      await pressTab(page);
      const inside = await page.evaluate(
        () =>
          document
            .getElementById("protected-root")
            ?.contains(document.activeElement) === true,
      );
      expect(inside, `Tab ${step + 1}`).toBe(false);
    }
    const snapshot = await page.locator("body").ariaSnapshot();
    expect(snapshot).toContain("Checking your account");
    expect(snapshot).not.toMatch(/Primary|Today|Tasks|Sync|Settings/);
  });

  test("visible: the gate STAYS UP in the same task; only the exposure lifts it, and focus returns to the control that had it", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    // WEB-08c revision 3 (R8, HF-13): the focus step's precondition is ASSERTED (the keyed link exists, is connected and is the active
    // element in the same task), and asserted again in the task of the hide, where the position is saved. Nothing else changed.
    const focused = await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
      return {
        exists: link !== null,
        connected: link?.isConnected === true,
        active: link !== null && document.activeElement === link,
      };
    });
    expect(focused, "precondition: the keyed link has focus").toEqual({
      exists: true,
      connected: true,
      active: true,
    });
    const atHide = await page.evaluate(() => {
      const before =
        document.activeElement?.getAttribute("data-focus-key") ?? null;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return before;
    });
    expect(atHide, "precondition: the keyed link has focus at the hide").toBe(
      "first-nav",
    );
    const stillUp = await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      // Read in the SAME task: nothing has had a chance to lift the gate.
      const root = document.getElementById("protected-root");
      return {
        inert: root?.hasAttribute("inert"),
        gateOpen: (document.getElementById("resume-gate") as HTMLDialogElement)
          .open,
      };
    });
    expect(stillUp).toEqual({ inert: true, gateOpen: true });
    await page.waitForFunction(
      () => !document.getElementById("protected-root")?.hasAttribute("inert"),
    );
    expect((await gated(page)).gateOpen).toBe(false);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
    expect(await page.title()).toMatch(/Atlas/);
  });

  test("HF-13 (revision 3): a heading attempt still waiting from the mount cannot take focus after the lift has restored the keyed control (the page's animation frames held from boot, then run)", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    // NAMED HOLD (test-only): every animation frame the page asks for is queued, not run, until the test runs the queue. The protected
    // surface waits for the router's heading with animation frames, so the mount's heading attempt stays waiting through the whole
    // focus/hide/resume/lift sequence: the order campaign 7's failure needs, made deterministic. Waits below poll on a timer, never a frame.
    await context.addInitScript(() => {
      const frames = { hold: true, queue: [] as FrameRequestCallback[] };
      (window as unknown as { __frames?: typeof frames }).__frames = frames;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        if (!frames.hold) return raf(callback);
        frames.queue.push(callback);
        return frames.queue.length;
      };
    });
    const page = await context.newPage();
    await page.goto(`/__session?route=${encodeURIComponent("/today")}`);
    await page.waitForFunction(
      () => {
        const root = document.getElementById("protected-root");
        return (
          root &&
          !root.hasAttribute("inert") &&
          root.querySelector("h1") !== null
        );
      },
      undefined,
      { polling: 50 },
    );
    // Precondition of this schedule: the heading is rendered, a frame is waiting and the heading has NOT been focused by the mount.
    const waiting = await page.evaluate(() => ({
      queued:
        (window as unknown as { __frames?: { queue: unknown[] } }).__frames
          ?.queue.length ?? 0,
      headingFocused:
        document.activeElement === document.querySelector("#protected-root h1"),
    }));
    expect(waiting.queued, "precondition: a frame is waiting").toBeGreaterThan(
      0,
    );
    expect(waiting.headingFocused, "precondition: heading not focused").toBe(
      false,
    );
    const focused = await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
      return link !== null && document.activeElement === link;
    });
    expect(focused, "precondition: the keyed link has focus").toBe(true);
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await page.waitForFunction(
      () => !document.getElementById("protected-root")?.hasAttribute("inert"),
      undefined,
      { polling: 50 },
    );
    // The original immediate assertion.
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
    ).toBe("first-nav");
    // Every frame held since boot now runs, in the order asked, as the browser's next frame would run them.
    const ran = await page.evaluate(() => {
      const frames = (
        window as unknown as {
          __frames?: { hold: boolean; queue: FrameRequestCallback[] };
        }
      ).__frames;
      if (!frames) return 0;
      frames.hold = false;
      const due = frames.queue.splice(0);
      for (const callback of due) callback(performance.now());
      return due.length;
    });
    expect(ran).toBeGreaterThan(0);
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-focus-key"),
      ),
      "no obsolete heading attempt takes focus after the restoring lift",
    ).toBe("first-nav");
  });

  test("a fence recorded while the page was hidden prevents the lift: level 1, the reconnect card, nothing protected remains", async ({
    context,
  }) => {
    const network = await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    await setVisibility(page, "hidden");
    // Another tab records a detected invalidation while this one is hidden.
    await seed(context, withInvalidSession(settled("acct-a", 1, "s1")));
    await setVisibility(page, "visible");
    await expect(
      page.getByRole("heading", { level: 1, name: "Reconnect to keep going" }),
    ).toBeVisible();
    expect(
      await page.locator("#protected-root").evaluate((root) => root.innerHTML),
    ).toBe("");
    const state = await gated(page);
    expect(state.inert).toBe(true);
    expect(state.gateOpen).toBe(false);
    expect(state.title).toBe("Atlas");
    // Nothing was deleted or wiped, and the page made no state-changing request.
    expect(network.apiRequests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    // The alert message is exposed as an alert.
    await expect(page.getByRole("alert")).toContainText(
      "We noticed a change to this session",
    );
  });

  test("the auth store becomes unreadable AFTER display: the protected tree is unmounted and unexposed in the same step as the read-failure card (fails closed)", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    expect(await page.locator("#protected-root h1").count()).toBeGreaterThan(0);
    // Close this page's own connection to `atlas-auth`: every later transaction fails, as a revoked or broken store does.
    await page.evaluate(() => {
      const booted = window.__atlasFixture?.session?.booted;
      if (!booted) throw new Error("the session is not booted");
      booted.store.close();
      booted.session.actions.retry();
    });
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "We couldn't check your account",
      }),
    ).toBeVisible();
    const after = await page.evaluate(() => {
      const root = document.getElementById("protected-root") as
        | (HTMLElement & { inert: boolean })
        | null;
      return {
        inert: root?.inert,
        ariaHidden: root?.getAttribute("aria-hidden"),
        protectedHeadings: root?.querySelectorAll("h1").length,
        protectedContent: root?.innerHTML,
        visibleText: root?.innerText ?? "",
        title: document.title,
      };
    });
    // Nothing protected remains: not merely hidden, not merely inert: unmounted, and the title is neutral.
    expect(after).toEqual({
      inert: true,
      ariaHidden: "true",
      protectedHeadings: 0,
      protectedContent: "",
      visibleText: "",
      title: "Atlas",
    });
    await expect(page.getByRole("alert")).toContainText(
      "Nothing is shown until we can.",
    );
  });

  test("an account change while hidden: the old tree is gone, the new one is announced without a name, focus is on its heading", async ({
    context,
  }) => {
    const network = await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
    });
    await setVisibility(page, "hidden");
    network.identity = { account: "acct-b", session: "s2" };
    await seed(context, settled("acct-b", 2, "s2"));
    await setVisibility(page, "visible");
    await page.waitForFunction(
      () => !document.getElementById("protected-root")?.hasAttribute("inert"),
    );
    await expect(
      page.getByText("This window now shows a different account."),
    ).toHaveCount(1);
    const focus = await page.evaluate(() => ({
      key: document.activeElement?.getAttribute("data-focus-key") ?? null,
      tag: document.activeElement?.tagName,
    }));
    // Focus is never restored across an account change: it lands on the new tree's heading.
    expect(focus).toEqual({ key: null, tag: "H1" });
  });

  test("the gate dialog itself is exposed correctly: labelled, a status message, focus on its heading, Escape does not dismiss it", async ({
    context,
  }) => {
    await stub(context);
    await seed(context, settled("acct-a", 1, "s1"));
    const page = await open(context);
    await setVisibility(page, "hidden");
    const gate = page.locator("#resume-gate");
    await expect(gate).toHaveAttribute(
      "aria-labelledby",
      "resume-gate-heading",
    );
    // Read `document.activeElement` itself: Playwright's `toBeFocused` also reports "inactive" when the WINDOW lacks focus, which
    // WebKit does after many pages have been opened in one run, and which says nothing about the element that holds focus.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe("resume-gate-heading");
    await page.keyboard.press("Escape");
    expect((await gated(page)).gateOpen).toBe(true);
    await expect(gate.getByRole("status")).toHaveCount(1);
  });
});
