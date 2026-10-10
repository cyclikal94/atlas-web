import { DARK, expect, LIGHT, runAxe, test } from "./helpers";

/**
 * Layer B: the real production build served by `vite preview`. It contains only the neutral app. This is not
 * integration evidence: no backend is involved.
 */

test.describe("neutral shell", () => {
  test("shows the sign-in surface and nothing about any account, and the protected root stays inert, hidden and empty (B6)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Use single sign-on instead" }),
    ).toBeVisible();
    const root = page.locator("#protected-root");
    await expect(root).toHaveAttribute("inert", "");
    await expect(root).toHaveAttribute("aria-hidden", "true");
    expect(await root.evaluate((element) => element.childElementCount)).toBe(0);
    expect(await page.locator("[data-portal-root]").count()).toBe(0);
    await expect(page).toHaveTitle("Sign in · Atlas");
  });

  test("the production build carries no fixture entry or marker", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    expect(
      await page.evaluate(() => document.documentElement.dataset.atlasFixture),
    ).toBeUndefined();
    expect(
      (await request.get("/fixture.html")).headers()["content-type"] ?? "",
    ).not.toContain("fixture");
    const html = await (await request.get("/fixture.html")).text();
    expect(html).not.toContain("ATLAS_FIXTURE_ONLY");
    expect(html).not.toContain("/src/fixture/");
  });

  test("a fragment this client does not recognise is left alone through boot (B11)", async ({
    page,
  }) => {
    await page.goto("/#section-2");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe("#section-2");
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => location.href.endsWith("/#section-2")),
    ).toBe(true);
  });

  test("a recognised fragment (the OIDC grant) is stripped at boot, valid or not, and the page says it wasn't valid", async ({
    page,
  }) => {
    await page.goto("/#atlas_grant=abc123");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe("");
    expect(await page.evaluate(() => location.href)).not.toContain("abc123");
    await expect(
      page.getByText("That sign-in link wasn't valid. Start again."),
    ).toBeVisible();
  });

  test("does not rewrite history on load", async ({ page }) => {
    await page.addInitScript(() => {
      const count = { replace: 0, push: 0 };
      (window as unknown as { __history: typeof count }).__history = count;
      const { replaceState, pushState } = history;
      history.replaceState = (...args) => {
        count.replace += 1;
        return replaceState.apply(history, args);
      };
      history.pushState = (...args) => {
        count.push += 1;
        return pushState.apply(history, args);
      };
    });
    await page.goto("/deep/link?x=1#frag");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __history: unknown }).__history,
      ),
    ).toEqual({ replace: 0, push: 0 });
  });

  test("a deep link is served the shell, then the sign-in surface, without touching the path", async ({
    page,
  }) => {
    await page.goto("/tasks/example");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/tasks/example");
  });

  for (const [scheme, colours] of [
    ["dark", DARK],
    ["light", LIGHT],
  ] as const) {
    test(`has no axe violations, including rendered contrast (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto("/");
      await expect(
        page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
      ).toBe(colours.canvas);
      expect(await runAxe(page)).toEqual([]);
      await context.close();
    });
  }
});

test.describe("capability check (B7)", () => {
  const compatible = "Atlas can't open in this browser";

  test("a fully capable browser shows the sign-in surface, not the compatibility screen", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: compatible })).toHaveCount(
      0,
    );
  });

  const cases: Array<[string, () => void, RegExp]> = [
    [
      "no Web Locks",
      () =>
        Object.defineProperty(navigator, "locks", {
          value: undefined,
          configurable: true,
        }),
      /does not provide Web Locks/,
    ],
    [
      "no IndexedDB",
      () =>
        Object.defineProperty(window, "indexedDB", {
          value: undefined,
          configurable: true,
        }),
      /cannot use this browser's local storage/,
    ],
    [
      "no inert support",
      () => {
        Reflect.deleteProperty(HTMLElement.prototype, "inert");
      },
      /too old to keep your data hidden/,
    ],
    [
      "an insecure context",
      () =>
        Object.defineProperty(window, "isSecureContext", {
          value: false,
          configurable: true,
        }),
      /secure connection \(HTTPS\)/,
    ],
  ];

  for (const [name, breakIt, message] of cases) {
    test(`${name} shows the compatibility screen, and never the shell`, async ({
      page,
    }) => {
      await page.addInitScript(breakIt);
      await page.goto("/");
      await expect(
        page.getByRole("heading", { level: 1, name: compatible }),
      ).toBeVisible();
      await expect(page.getByText(message)).toBeVisible();
      await expect(
        page.getByText(
          /current or previous version of Chrome, Edge, Firefox or Safari/,
        ),
      ).toBeVisible();
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(page.getByLabel("Username")).toHaveCount(0);
      expect(
        await page
          .locator("#protected-root")
          .evaluate((element) => element.childElementCount),
      ).toBe(0);
      expect(await runAxe(page)).toEqual([]);
    });
  }

  test("Web Locks that never grant shows the compatibility screen after the probe time-out", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "locks", {
        value: { request: () => new Promise(() => {}) },
        configurable: true,
      });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: compatible }),
    ).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/does not provide Web Locks/)).toBeVisible();
  });

  test("IndexedDB that fails to open shows the compatibility screen", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        value: {
          open() {
            throw new DOMException("denied", "SecurityError");
          },
          deleteDatabase() {},
        },
        configurable: true,
      });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: compatible }),
    ).toBeVisible();
  });
});

test.describe("no flash of the wrong theme (B3)", () => {
  /**
   * Holds the application bundle open, so React has not mounted, then reads the computed background from the
   * still-loading document. The pre-paint script and the stylesheet alone must already have chosen the theme.
   */
  async function backgroundWhileBundleHeld(
    browser: import("@playwright/test").Browser,
    options: { colorScheme: "light" | "dark"; stored?: string },
  ) {
    const context = await browser.newContext({
      colorScheme: options.colorScheme,
    });
    if (options.stored) {
      await context.addInitScript(
        (value) => localStorage.setItem("atlas.appearance.v1", value),
        options.stored,
      );
    }
    const page = await context.newPage();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    const navigation = page.goto("/", { waitUntil: "commit" });
    await page.waitForFunction(
      () => document.body !== null && document.styleSheets.length > 0,
    );
    const reading = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      theme: document.documentElement.getAttribute("data-theme"),
      react: document.querySelector("#neutral-root h1")?.textContent,
      meta: document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
      gate: document.querySelector(".neutral-gate") !== null,
    }));
    release();
    await navigation;
    await context.close();
    return reading;
  }

  const cases = [
    {
      name: "stored light, system dark",
      colorScheme: "dark",
      stored: "light",
      canvas: LIGHT.canvas,
      meta: "#F7F8F9",
      theme: "light",
    },
    {
      name: "stored dark, system light",
      colorScheme: "light",
      stored: "dark",
      canvas: DARK.canvas,
      meta: "#08090A",
      theme: "dark",
    },
    {
      name: "nothing stored, system light",
      colorScheme: "light",
      stored: undefined,
      canvas: LIGHT.canvas,
      meta: "#F7F8F9",
      theme: null,
    },
    {
      name: "nothing stored, system dark",
      colorScheme: "dark",
      stored: undefined,
      canvas: DARK.canvas,
      meta: "#08090A",
      theme: null,
    },
    {
      name: "a corrupt stored value follows the system",
      colorScheme: "light",
      stored: "banana",
      canvas: LIGHT.canvas,
      meta: "#F7F8F9",
      theme: null,
    },
  ] as const;

  for (const testCase of cases) {
    test(testCase.name, async ({ browser }) => {
      const reading = await backgroundWhileBundleHeld(browser, testCase);
      expect(reading.html).toBe(testCase.canvas);
      expect(reading.body).toBe(testCase.canvas);
      expect(reading.theme).toBe(testCase.theme);
      expect(reading.meta).toBe(testCase.meta);
      expect(
        reading.gate,
        "the static boot gate is showing while React has not mounted",
      ).toBe(true);
      expect(reading.react ?? "Atlas").toBe("Atlas");
    });
  }
});

test.describe("offline fonts (B9)", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`loads Geist from the origin only, with every other request blocked (${scheme})`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      const blocked: string[] = [];
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseURL as string).origin)
          return route.continue();
        blocked.push(url.href);
        return route.abort();
      });
      await page.goto("/");
      await expect(
        page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
      ).toBeVisible();
      const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        const faces = await document.fonts.load(
          '600 30px "Geist Variable"',
          "Atlas 0123",
        );
        return {
          count: faces.length,
          statuses: faces.map((face) => face.status),
          check: document.fonts.check('16px "Geist Variable"', "Atlas"),
        };
      });
      expect(blocked).toEqual([]);
      expect(loaded.count).toBeGreaterThan(0);
      expect(loaded.statuses.every((status) => status === "loaded")).toBe(true);
      expect(loaded.check).toBe(true);
      await context.close();
    });
  }

  test("makes no request off the origin, ever", async ({ page, baseURL }) => {
    const origin = new URL(baseURL as string).origin;
    const offOrigin: string[] = [];
    page.on("request", (request) => {
      if (
        !request.url().startsWith(origin) &&
        !request.url().startsWith("data:")
      )
        offOrigin.push(request.url());
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Sign in to Atlas" }),
    ).toBeVisible();
    expect(offOrigin).toEqual([]);
  });
});

test.describe("the screens before the application mounts (A4)", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`the static boot gate has no axe violations, including rendered contrast (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
        await held;
        await route.continue();
      });
      const navigation = page.goto("/", { waitUntil: "commit" });
      await page.waitForSelector(".neutral-gate");
      expect(await page.locator("#neutral-root h1").textContent()).toBe(
        "Atlas",
      );
      expect(await runAxe(page)).toEqual([]);
      release();
      await navigation;
      await context.close();
    });

    test(`the compatibility screen has no axe violations (${scheme})`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "locks", {
          value: undefined,
          configurable: true,
        }),
      );
      await page.goto("/");
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Atlas can't open in this browser",
        }),
      ).toBeVisible();
      expect(await runAxe(page)).toEqual([]);
      await context.close();
    });
  }
});
