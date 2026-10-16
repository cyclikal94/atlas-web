import type { Page } from "@playwright/test";
import { provokedIdbWarnings, test } from "./auth-helpers";
import { AuthStub } from "./auth-stub";
import { expect, pressTab, runAxe } from "./helpers";
import {
  expectPaintedContrast,
  recordPaintedContrast,
  surfaceScreenshot,
} from "./surface-checks";

/**
 * WEB-08b, A2 / A3 / A4 (Layer A, rendered): the PUBLIC surfaces (sign-in, join) in the production build, in a real engine, with
 * a stubbed network, at 320, 390, 768 and 1280 px in dark and light: no horizontal scroll, axe clean INCLUDING colour contrast in
 * real layout, 44 px targets, a visible focus ring, the heading as the focus target. Screenshots (Chromium) and the painted-contrast
 * records belong to this invocation and test (`surfaceScreenshot`, `recordPaintedContrast`: review 14's R27); the historical
 * `.agtx/evidence/WEB-08b/design/` folder is no longer written. This is design and accessibility evidence only: it is not Kieran's
 * visual or copy sign-off, not assistive-technology evidence and not integration evidence.
 */
const WIDTHS: Array<[number, number]> = [
  [320, 640],
  [390, 844],
  [768, 1024],
  [1280, 800],
];
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
          // A FRESH document each time: a fragment-only navigation does not reload the page. READINESS CORRECTION (WEB-10a revision 7,
          // Kieran's decision of 15 October 2026; labelled for review): the previous page is left BEFORE the browser goes online. Going
          // online first started that page's online re-check of the sign-in record (an IndexedDB read) and the navigation at once
          // aborted it, which Firefox reports as a console warning (review 7's retained join-offline failure). That interruption is
          // now a case of its own below ("going online and leaving at once"), not a side effect of this loop's reset.
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

          if (engine === "chromium")
            await surfaceScreenshot(page, testInfo, {
              name: surface.name,
              width,
              scheme,
            });
        }
      });
    }
  });
}

/**
 * WEB-10a revision 7 (review 7's retained Firefox join-offline warning; Kieran's decision of 15 October 2026): the interruption the
 * width loop used to cause by accident, made deliberate and deterministic. On `online` the join page re-checks the sign-in record
 * (`evaluate` → `readRecords`, a `readwrite` transaction of `atlas-auth` that writes nothing). Here that transaction is HELD OPEN (the
 * test keeps issuing `count()` reads on it) and the page is left at once: the transaction is aborted by the navigation, it made no write
 * request (so, IndexedDB being atomic, nothing durable changed), and the next page boots and shows the form. Firefox's console warning
 * for exactly that abort is declared as provoked; any other warning still fails.
 */
test.describe("join-offline: going online and leaving at once", () => {
  test("the interrupted online re-check is a read: no write request, and the next page boots normally", async ({
    page,
    context,
    provokes,
  }, info) => {
    provokes("idb-navigation-abort");
    // Reported as they happen (a binding called during `pagehide` is lost in Chromium): created, each write request, completed/aborted.
    const reports: Array<{ kind: string; id: number; held?: boolean }> = [];
    await context.exposeBinding("__authTxReport", (_source, report) => {
      reports.push(report);
    });
    await context.addInitScript(() => {
      const w = window as unknown as {
        __authTxReport?: (report: object) => void;
        __holdNextAuthTx?: boolean;
      };
      const ids = new Map<IDBTransaction, number>();
      let next = 0;
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        ...args: Parameters<typeof transaction>
      ) {
        const tx = transaction.apply(this, args);
        if (this.name !== "atlas-auth") return tx;
        const held = w.__holdNextAuthTx === true;
        if (held) w.__holdNextAuthTx = false;
        next += 1;
        const id = next;
        ids.set(tx, id);
        const done = () => w.__authTxReport?.({ kind: "done", id });
        tx.addEventListener("complete", done);
        tx.addEventListener("abort", done);
        if (held) {
          // Kept active by reads of its own: the test's hold, not the application's.
          const store = tx.objectStore(tx.objectStoreNames[0] as string);
          const spin = () => {
            store.count().onsuccess = spin;
          };
          spin();
        }
        w.__authTxReport?.({ kind: "created", id, held });
        return tx;
      } as typeof transaction;
      for (const name of ["put", "add", "delete", "clear"] as const) {
        const original = IDBObjectStore.prototype[name] as (
          ...a: unknown[]
        ) => IDBRequest;
        (IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] =
          function (this: IDBObjectStore, ...a: unknown[]) {
            const id = ids.get(this.transaction);
            if (id !== undefined) w.__authTxReport?.({ kind: "write", id });
            return original.apply(this, a);
          };
      }
    });
    const stub = new AuthStub();
    await stub.install(context);
    await readyJoin(page, stub, null);
    const offlineReason = page.getByText(
      "Creating an account needs a connection.",
    );
    await context.setOffline(true);
    await offlineReason.waitFor();
    // Ordinary going online (no navigation; the positive control the hand-off keeps): the explanation goes, the form can be sent again,
    // and every sign-in-record transaction the page made since completes with no write request.
    const sinceOnline = reports.length;
    await context.setOffline(false);
    await expect(offlineReason).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    await expect
      .poll(() => {
        const made = reports
          .slice(sinceOnline)
          .filter((r) => r.kind === "created");
        return (
          made.length > 0 &&
          made.every((c) =>
            reports.some((r) => r.kind === "done" && r.id === c.id),
          )
        );
      })
      .toBe(true);
    expect(
      reports.slice(sinceOnline).filter((r) => r.kind === "write"),
    ).toEqual([]);
    await context.setOffline(true);
    await offlineReason.waitFor();
    await page.evaluate(() => {
      (window as unknown as { __holdNextAuthTx?: boolean }).__holdNextAuthTx =
        true;
    });
    await context.setOffline(false);
    // Barrier: the online re-check's transaction exists and is held open.
    await expect
      .poll(() => reports.some((r) => r.kind === "created" && r.held))
      .toBe(true);
    const held = reports.find((r) => r.kind === "created" && r.held)
      ?.id as number;
    const before = reports.length;
    await page.goto("about:blank");
    const atLeave = reports.slice(0, before);
    const open = atLeave
      .filter((r) => r.kind === "created")
      .map((r) => r.id)
      .filter((id) => !atLeave.some((r) => r.kind === "done" && r.id === id));
    // The held transaction was still open when the page was left, and no transaction open then had made a write request.
    expect(open).toContain(held);
    expect(
      reports.filter((r) => r.kind === "write" && open.includes(r.id)),
    ).toEqual([]);
    // The next page boots and works: the form, and offline the same explanation.
    await readyJoin(page, stub, null);
    await context.setOffline(true);
    await page.getByText("Creating an account needs a connection.").waitFor();
    await context.setOffline(false);
    if (info.project.name === "production-firefox")
      expect(provokedIdbWarnings(info.testId)).toBeGreaterThan(0);
  });
});

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
    }, info) => {
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
      recordPaintedContrast(info, scheme, {
        engine: info.project.name,
        signIn,
        join,
      });
    });
  });
}
