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
      body: JSON.stringify({ status: "ok", api_version: "0.29.0" }),
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

test.describe("S-GATE: exposure and the resume gate with real inert and the real top layer", () => {
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
    await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>(
        'nav[aria-label="Primary"] a',
      );
      link?.setAttribute("data-focus-key", "first-nav");
      link?.focus();
    });
    await setVisibility(page, "hidden");
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
