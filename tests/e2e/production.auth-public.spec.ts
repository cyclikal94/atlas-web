import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "@playwright/test";
import {
  observeAuthWork,
  recordAuthTransactions,
  settleAuth,
  workOf,
} from "./auth-settlement";
import { AuthStub } from "./auth-stub";
import { expect, pressTab, runAxe } from "./helpers";
import { test } from "./intercepted-auth";
import { expectPaintedContrast } from "./surface-checks";

/**
 * WEB-14a revision 19, labelled HARNESS ADAPTATION (Kieran, 15 October 2026): the production build registers the app's service worker
 * (WEB-14a), and Playwright WebKit does not apply `context.route` to requests a worker passes on, so the AuthStub never answered there
 * and most WebKit cases failed (also on the unmodified revision-18 candidate). These specs test the authentication surfaces, not the
 * worker: they run without it. The worker in the production build is covered by production.pwa.spec.ts and production.offline.spec.ts.
 * Revision 34 (R37): the `test` of ./intercepted-auth now blocks worker registration for every AuthStub suite and refuses another
 * setting, in place of this file's own `test.use`.
 */

/**
 * WEB-08b, A2 / A3 / A4 (Layer A, rendered): the PUBLIC surfaces (sign-in, join) in the production build, in a real engine, with
 * a stubbed network, at 320, 390, 768 and 1280 px in dark and light: no horizontal scroll, axe clean INCLUDING colour contrast in
 * real layout, 44 px targets, a visible focus ring, the heading as the focus target. Screenshots (Chromium) go to
 * .agtx/evidence/WEB-08b/design/. This is design and accessibility evidence only: it is not Kieran's visual or copy sign-off,
 * not assistive-technology evidence and not integration evidence.
 */
const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
];
const EVIDENCE = ".agtx/evidence/WEB-08b/design";
const PASSWORD = "correct-horse-battery-9271";

interface Surface {
  name: string;
  /** The statuses this state provokes on purpose (the browser logs each as a console error). */
  provokes?: Array<number | "abort">;
  /** Leaves the page showing the state under test. */
  open(page: Page, stub: AuthStub): Promise<void>;
  /** The heading that should hold focus once the surface has settled. */
  focusHeading?: boolean;
}

/**
 * WEB-14a revision 23 (diagnosis of the campaign-2 WebKit failure of "sign-in-offline", .agtx/evidence/WEB-14a/revision-23/diagnostics/
 * offline-chunk-race): since accepted main's WEB-09b composition was merged, a signed-out page also starts the data leader, whose chunks
 * (`browser-leader`, `browser-env`, `dexie-adapter`) are dynamic imports loaded AFTER boot (WebKit often only after the heading shows).
 * With the worker blocked (the labelled revision-19 adaptation) they come from the network, so going offline while one is in flight
 * makes the browser log the failed load ("WebKit encountered an internal error", Chromium "ERR_INTERNET_DISCONNECTED"). The offline
 * surfaces are what these cases check, so they go offline once those loads are over: a condition, not a delay.
 */
const lazyChunksLoaded = (page: Page) =>
  page.waitForFunction(() => {
    const loaded = performance.getEntriesByType("resource").map((e) => e.name);
    return ["browser-leader", "browser-env", "dexie-adapter"].every((chunk) =>
      loaded.some((name) => name.includes(`/assets/${chunk}-`)),
    );
  });
const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name }).waitFor();

const readyJoin = async (
  page: Page,
  stub: AuthStub,
  household: { id: string; name: string } | null,
) => {
  const token = stub.addInvitation({ household });
  await page.goto(`/join#t=${token}`);
  await page.getByLabel("Username").waitFor();
};

const SURFACES: Surface[] = [
  {
    name: "sign-in",
    focusHeading: true,
    open: async (page) => {
      await page.goto("/");
      await heading(page, "Sign in to Atlas");
    },
  },
  {
    name: "sign-in-wrong-password",
    provokes: [401],
    open: async (page, stub) => {
      stub.addAccount("kieran", PASSWORD);
      await page.goto("/");
      await page.getByLabel("Username").fill("kieran");
      await page.getByLabel("Password").fill("not-the-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "sign-in-bad-landing",
    open: async (page) => {
      await page.goto("/#atlas_grant=bad");
      await page
        .getByText("That sign-in link wasn't valid. Start again.")
        .waitFor();
    },
  },
  {
    name: "sign-in-offline",
    open: async (page) => {
      await page.goto("/");
      await heading(page, "Sign in to Atlas");
      await lazyChunksLoaded(page);
      await page.context().setOffline(true);
      await page.getByText("Signing in needs a connection.").waitFor();
    },
  },
  {
    name: "join-link-invalid",
    focusHeading: true,
    open: async (page) => {
      await page.goto("/join");
      await heading(page, /no longer valid/);
    },
  },
  {
    name: "join-loading",
    open: async (page, stub) => {
      stub.hold(({ path }) => path === "/registration/preview");
      const token = stub.addInvitation();
      await page.goto(`/join#t=${token}`);
      await page.locator("[aria-busy='true']").first().waitFor();
    },
  },
  {
    name: "join-household",
    focusHeading: true,
    open: (page, stub) => readyJoin(page, stub, { id: "h1", name: "Hartley" }),
  },
  {
    name: "join-standalone",
    focusHeading: true,
    open: (page, stub) => readyJoin(page, stub, null),
  },
  {
    name: "join-unavailable",
    provokes: [401],
    focusHeading: true,
    open: async (page) => {
      await page.goto(`/join#t=${"e".repeat(64)}`);
      await page.getByText(/expired or was already used/).waitFor();
    },
  },
  {
    name: "join-preview-error",
    provokes: [429],
    open: async (page, stub) => {
      const token = stub.addInvitation();
      stub.answerNext(({ path }) => path === "/registration/preview", {
        status: 429,
        body: {
          code: "rate_limited",
          message: "x",
          request_id: "req-1",
          details: [],
        },
      });
      await page.goto(`/join#t=${token}`);
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "join-username-taken",
    provokes: [409],
    open: async (page, stub) => {
      stub.addAccount("kieran", PASSWORD);
      await readyJoin(page, stub, null);
      await page.getByLabel("Username").fill("kieran");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByText("That username is taken. Choose another.").waitFor();
    },
  },
  {
    name: "join-lost-response",
    provokes: ["abort"],
    focusHeading: true,
    open: async (page, stub) => {
      await readyJoin(page, stub, null);
      stub.answerNext(({ path }) => path === "/browser-registration", "abort");
      await page.getByLabel("Username").fill("newbie");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByText(/lost the confirmation/).waitFor();
    },
  },
  {
    // Review R5: a different invitation is open while an earlier registration's answer is lost.
    name: "join-earlier-registration",
    provokes: ["abort"],
    open: async (page, stub) => {
      const first = stub.addInvitation();
      const second = stub.addInvitation({
        household: { id: "h1", name: "Hartley" },
      });
      stub.answerNext(({ path }) => path === "/browser-registration", "abort");
      const held = stub.hold(({ path }) => path === "/browser-registration", 1);
      await page.goto(`/join#t=${first}`);
      // The stub is shared by the four widths of one test, so count from where this open began.
      const before = stub.count("POST", "/browser-registration");
      await page.getByLabel("Username").fill("newbie");
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();
      await expect
        .poll(() => stub.count("POST", "/browser-registration"))
        .toBeGreaterThan(before);
      await page.evaluate((token) => {
        location.hash = `t=${token}`;
      }, second);
      await heading(page, "You're invited to join Hartley");
      held.release();
      await page.getByText(/You opened another invitation/).waitFor();
    },
  },
  {
    name: "join-offline",
    open: async (page, stub) => {
      await readyJoin(page, stub, null);
      await lazyChunksLoaded(page);
      await page.context().setOffline(true);
      await page.getByText("Creating an account needs a connection.").waitFor();
    },
  },
];

for (const scheme of ["dark", "light"] as const) {
  test.describe(`public surfaces, rendered checks, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const surface of SURFACES) {
      test(surface.name, async ({ page, context, provokes }, testInfo) => {
        provokes(...(surface.provokes ?? []));
        const engine = testInfo.project.name.replace("production-", "");
        const stub = new AuthStub();
        await stub.install(context);
        for (const [width, height] of WIDTHS) {
          // A FRESH document each time: a fragment-only navigation does not reload the page. Revision 22 (C4): the previous document
          // (offline, for the two offline surfaces) is left BEFORE the connection comes back, so its reconnect work is not started only to
          // be cut off by this navigation (the retained Firefox "transaction aborted due to page navigation" warnings); that schedule has
          // its own cases (S10) below.
          await page.goto("about:blank");
          await context.setOffline(false);
          await page.setViewportSize({ width, height });
          await surface.open(page, stub);
          const label = `${surface.name} at ${width}px, ${scheme}, ${engine}`;

          // 1. No horizontal scrolling.
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth <=
                document.documentElement.clientWidth,
            ),
            `${label}: horizontal scroll`,
          ).toBe(true);

          // 2. axe, including colour contrast in the real layout.
          const violations = await runAxe(page);
          expect(
            violations.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
            ),
            `${label}: axe`,
          ).toEqual([]);

          // 3. Targets are at least 44 px high.
          const small = await page.evaluate(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>(
                "main button, main a[href], main input",
              ),
            )
              .filter((el) => el.getBoundingClientRect().height > 0)
              .filter((el) => el.getBoundingClientRect().height < 43.5)
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`,
              ),
          );
          expect(small, `${label}: targets under 44px`).toEqual([]);

          // 4. The page's heading is the programmatic focus target for a state that has just appeared.
          if (surface.focusHeading)
            expect(
              await page.evaluate(() => document.activeElement?.tagName),
              `${label}: focus target`,
            ).toBe("H1");

          // 5. A visible focus ring on the first control reached by keyboard.
          if (
            (await page
              .locator("main :is(button, a[href], input):visible:enabled")
              .count()) > 0
          ) {
            await pressTab(page);
            const ring = await page.evaluate(() => {
              const active = document.activeElement as HTMLElement | null;
              if (!active || active === document.body) return null;
              const style = getComputedStyle(active);
              return {
                outline:
                  style.outlineStyle !== "none" &&
                  Number.parseFloat(style.outlineWidth) >= 2,
                shadow: style.boxShadow !== "none",
              };
            });
            expect(
              ring && (ring.outline || ring.shadow),
              `${label}: focus ring`,
            ).toBeTruthy();
          }

          if (engine === "chromium") {
            mkdirSync(`${EVIDENCE}/chromium`, { recursive: true });
            await page.screenshot({
              path: `${EVIDENCE}/chromium/${surface.name}-${width}-${scheme}.png`,
              fullPage: true,
            });
          }
        }
      });
    }
  });
}

test.describe("modes the design pass checks beyond width and theme", () => {
  test("forced colours and reduced motion keep the sign-in and join surfaces usable", async ({
    page,
    context,
  }) => {
    const stub = new AuthStub();
    await stub.install(context);
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    await page.goto("/");
    await heading(page, "Sign in to Atlas");
    for (const name of ["Username", "Password"])
      await expect(page.getByLabel(name)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    // Borders survive forced colours: the field has a real, non-zero border.
    expect(
      await page
        .getByLabel("Username")
        .evaluate((el) =>
          Number.parseFloat(getComputedStyle(el).borderTopWidth),
        ),
    ).toBeGreaterThan(0);
    await readyJoin(page, stub, { id: "h", name: "Hartley" });
    await expect(
      page.getByRole("button", { name: "Create account and join Hartley" }),
    ).toBeVisible();
    expect(await runAxe(page)).toEqual([]);
  });

  test("400% zoom (a 320 px viewport at 1280 CSS px) keeps the sign-in form in one column with no horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 256 });
    await page.goto("/");
    await heading(page, "Sign in to Atlas");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("keyboard only: the sign-in form is reached, filled and submitted without a pointer, in the order username, password, sign in", async ({
    page,
    context,
    provokes,
  }) => {
    provokes(401);
    const stub = new AuthStub();
    stub.addAccount("kieran", PASSWORD);
    await stub.install(context);
    await page.goto("/");
    await heading(page, "Sign in to Atlas");
    await pressTab(page);
    await expect(page.getByLabel("Username")).toBeFocused();
    await page.keyboard.type("kieran");
    await pressTab(page);
    await expect(page.getByLabel("Password")).toBeFocused();
    await page.keyboard.type("not-the-password");
    await page.keyboard.press("Enter");
    // The refusal is announced and focus is on the field it belongs to.
    await expect(page.getByRole("alert")).toContainText(
      "That username or password isn't right.",
    );
    await expect(page.getByLabel("Password")).toBeFocused();
    await expect(page.getByLabel("Password")).toHaveValue("");
    expect(stub.count("POST", "/browser-sessions")).toBe(1);
  });

  test("keyboard only: the join form is completed without a pointer", async ({
    page,
    context,
  }) => {
    const stub = new AuthStub();
    await stub.install(context);
    await readyJoin(page, stub, { id: "h", name: "Hartley" });
    await pressTab(page);
    await expect(page.getByLabel("Username")).toBeFocused();
    await page.keyboard.type("newbie");
    await pressTab(page);
    await expect(page.getByLabel("Password")).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Enter");
    // The account was created and the browser signed in: the application replaces the join page, and /join is gone.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .not.toBe("/join");
    expect(stub.count("POST", "/browser-registration")).toBe(1);
  });
});

for (const scheme of ["dark", "light"] as const) {
  test.describe(`A-4 painted contrast on the public surfaces, ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("sign-in and join: the input border is field-edge at 3:1 or better, and the primary action text is 4.5:1 or better", async ({
      page,
      context,
    }) => {
      const stub = new AuthStub();
      await stub.install(context);
      await page.goto("/");
      await heading(page, "Sign in to Atlas");
      const signIn = await expectPaintedContrast(
        page.getByLabel("Username"),
        page.getByRole("button", { name: "Sign in", exact: true }),
        scheme,
        `sign-in (${scheme})`,
      );
      await readyJoin(page, stub, null);
      const join = await expectPaintedContrast(
        page.getByLabel("Password"),
        page.getByRole("button", { name: "Create account" }),
        scheme,
        `join (${scheme})`,
      );
      mkdirSync(EVIDENCE, { recursive: true });
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        `${EVIDENCE}/painted-contrast.jsonl`,
        `${JSON.stringify({ scheme, engine: test.info().project.name, signIn, join })}\n`,
      );
    });
  });
}

/**
 * WEB-14a revision 22 (design assessment C4, schedule S10): the retained Firefox warning "An IndexedDB transaction that was not yet
 * complete has been aborted due to page navigation" on the offline public surfaces. Diagnosis (author, scratch recorder over the unchanged
 * production build, all three engines): `online` starts the session's reconnect work, whose `atlas-auth` transactions (the evaluation's
 * record read and `resolve()`'s read under `atlas-auth`, both readwrite) were cut off when the test navigated to about:blank at once;
 * Chromium and WebKit abort them silently. None of them had asked for a write. These cases hold that schedule deterministically (another
 * page of the origin keeps a readwrite transaction on `records` open, so the reconnect transactions exist but cannot finish), and require:
 * the cut-off transactions asked for no write, and the durable records are byte-for-byte what they were. The control lets the reconnect
 * work finish first: nothing is cut off and nothing is declared.
 */
test.describe("revision 22, C4: a reconnect immediately followed by leaving the page", () => {
  /** A same-origin page that runs no application: it reads and holds the `atlas-auth` records without booting a session. */
  async function originPage(context: BrowserContext) {
    await context.route("**/__r22-origin-page", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>origin page</title>",
      }),
    );
    const other = await context.newPage();
    await other.goto("/__r22-origin-page");
    return other;
  }
  const readRecords = (other: Page) =>
    other.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const open = indexedDB.open("atlas-auth");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("records", "readonly");
            const store = tx.objectStore("records");
            const keys = store.getAllKeys();
            const values = store.getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(
                JSON.stringify(
                  keys.result.map((key, index) => [key, values.result[index]]),
                ),
              );
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
  /** Keeps a readwrite transaction on `records` open until `release`. */
  const block = (other: Page) =>
    other.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const w = window as unknown as {
            __blocking: boolean;
            __blocked: Promise<void>;
          };
          const open = indexedDB.open("atlas-auth");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("records", "readwrite");
            const store = tx.objectStore("records");
            w.__blocking = true;
            const spin = () => {
              if (!w.__blocking) return;
              store.get("auth_state").onsuccess = spin;
            };
            spin();
            w.__blocked = new Promise<void>((done) => {
              tx.oncomplete = () => {
                db.close();
                done();
              };
            });
            resolve();
          };
        }),
    );
  const release = (other: Page) =>
    other.evaluate(() => {
      const w = window as unknown as {
        __blocking: boolean;
        __blocked: Promise<void>;
      };
      w.__blocking = false;
      return w.__blocked;
    });
  const FIREFOX_ABORT =
    /^\[JavaScript Warning: "An IndexedDB transaction that was not yet complete has been aborted due to page navigation\." \{file: "[^"]+" line: \d+\}\]$/;

  for (const surface of ["sign-in", "join"] as const) {
    test(`S10 [cut off] ${surface}: the reconnect transactions cut off by leaving the page asked for no write, and the durable records are unchanged`, async ({
      page,
      context,
      provokes,
    }) => {
      provokes(FIREFOX_ABORT);
      await observeAuthWork(context);
      const log = await recordAuthTransactions(context);
      const stub = new AuthStub();
      await stub.install(context);
      if (surface === "sign-in") {
        await page.goto("/");
        await heading(page, "Sign in to Atlas");
      } else await readyJoin(page, stub, null);
      // Opened while online: an offline context cannot load it.
      const other = await originPage(context);
      await lazyChunksLoaded(page);
      await context.setOffline(true);
      await page
        .getByText(
          surface === "sign-in"
            ? "Signing in needs a connection."
            : "Creating an account needs a connection.",
        )
        .waitFor();
      await settleAuth(stub, [page], { instruments: [other] });
      const before = await readRecords(other);
      const leaving = page.url();
      await block(other);
      const begun = log.filter((t) => t.url === leaving).length;
      await context.setOffline(false);
      // The reconnect work exists before the page is left: its transactions are created and waiting behind the held one.
      await expect
        .poll(async () => (await workOf(page)).authTx, { timeout: 20_000 })
        .toBeGreaterThan(0);
      await page.goto("about:blank");
      await release(other);
      const cut = log
        .slice(begun)
        .filter((t) => t.url === leaving && t.end !== "complete");
      expect(cut.length, "reconnect transactions cut off").toBeGreaterThan(0);
      expect(
        cut.map((t) => ({ stores: t.stores, writes: t.writes })),
        "a cut-off transaction asked for no write",
      ).toEqual(cut.map(() => ({ stores: ["records"], writes: 0 })));
      expect(await readRecords(other), "the durable records").toBe(before);
    });

    test(`S10 [control] ${surface}: reconnect work that finishes before the page is left: nothing is cut off and nothing is declared`, async ({
      page,
      context,
    }) => {
      await observeAuthWork(context);
      const log = await recordAuthTransactions(context);
      const stub = new AuthStub();
      await stub.install(context);
      if (surface === "sign-in") {
        await page.goto("/");
        await heading(page, "Sign in to Atlas");
      } else await readyJoin(page, stub, null);
      // Opened while online: an offline context cannot load it.
      const other = await originPage(context);
      await lazyChunksLoaded(page);
      await context.setOffline(true);
      await page
        .getByText(
          surface === "sign-in"
            ? "Signing in needs a connection."
            : "Creating an account needs a connection.",
        )
        .waitFor();
      await settleAuth(stub, [page], { instruments: [other] });
      const before = await readRecords(other);
      const leaving = page.url();
      const begun = log.filter((t) => t.url === leaving).length;
      await context.setOffline(false);
      await expect
        .poll(() => log.filter((t) => t.url === leaving).length, {
          timeout: 20_000,
        })
        .toBeGreaterThan(begun);
      await settleAuth(stub, [page], { instruments: [other] });
      const reconnect = log.slice(begun).filter((t) => t.url === leaving);
      await page.goto("about:blank");
      expect(
        log.filter((t) => t.url === leaving && t.end !== "complete"),
        "nothing cut off",
      ).toEqual([]);
      // The same reconnect work, allowed to finish, writes nothing: what the cut-off case loses is a read.
      expect(
        reconnect.map((t) => ({ end: t.end, writes: t.writes })),
        "a completed reconnect transaction asked for no write",
      ).toEqual(reconnect.map(() => ({ end: "complete", writes: 0 })));
      expect(await readRecords(other), "the durable records").toBe(before);
    });
  }
});
