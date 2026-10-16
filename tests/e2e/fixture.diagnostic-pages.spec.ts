import type { Page } from "@playwright/test";
import { expect, fixturePageReady, test } from "./helpers";

/**
 * WEB-08d review r18 M1: the fixture's diagnostic pages (`/__neutral`, `/__controls`, `/__gate`) never render beside the shell, so
 * src/fixture/main.tsx loads them on demand and the fixture budget measures the signed-in shell alone. A page's code can then arrive
 * after the load event `page.goto` waits for (Chromium and Firefox; WebKit holds `load` for it), so every rendered check of these
 * pages waits for `fixturePageReady`.
 *
 * Each case HOLDS the page's own chunk: until it is released the page must not claim to be ready and the boot screen must still be
 * the one showing. Once released, the page is read at the moment the marker appears (a mutation observer installed before the page's
 * scripts records it in the microtask that follows), not after a retry, so the marker is shown to mean "mounted, with its effects run"
 * (the neutral and sign-in headings' focus included) rather than "about to render".
 */
interface DiagnosticPage {
  name: string;
  path: string;
  chunk: RegExp;
}

const PAGES: DiagnosticPage[] = [
  {
    name: "a neutral state",
    path: "/__neutral?state=1b&count=4",
    chunk: /\/assets\/neutral-page-[^/]+\.js$/,
  },
  {
    name: "the resume gate",
    path: "/__neutral?state=gate",
    chunk: /\/assets\/neutral-page-[^/]+\.js$/,
  },
  {
    name: "the sign-in-again form",
    path: "/__neutral?state=1b&form=1",
    chunk: /\/assets\/neutral-page-[^/]+\.js$/,
  },
  {
    name: "the controls gallery",
    path: "/__controls",
    chunk: /\/assets\/ControlsGallery-[^/]+\.js$/,
  },
  {
    name: "the gate gallery",
    path: "/__gate?state=gate",
    chunk: /\/assets\/GateGallery-[^/]+\.js$/,
  },
];

interface Shown {
  ready: string | null;
  booting: string | null;
  heading: string | null;
  focus: string | null;
  inputs: number;
  text: string;
}
type Observed = Window & {
  __diagnosticShown?: () => Shown;
  __diagnosticAtReady?: Shown;
};

/** Installs, before any page script, the reader and the observer that records what the page shows when the marker first appears. */
const observeReadiness = (page: Page) =>
  page.addInitScript(() => {
    const observed = window as Observed;
    observed.__diagnosticShown = () => {
      const active = document.activeElement;
      return {
        ready: document.documentElement.dataset.fixturePage ?? null,
        booting:
          document.querySelector("#neutral-root .neutral-gate__loading")
            ?.textContent ?? null,
        heading:
          document.querySelector("h1:not(#gate-heading)")?.textContent ?? null,
        focus: active
          ? `${active.tagName}${active.closest("#resume-gate") ? " in gate" : ""}`
          : null,
        inputs: document.querySelectorAll("input").length,
        text: document.body?.innerText ?? "",
      };
    };
    new MutationObserver(() => {
      const shown = observed.__diagnosticShown?.();
      if (shown?.ready && !observed.__diagnosticAtReady)
        observed.__diagnosticAtReady = shown;
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-fixture-page"],
    });
  });

/** What the page shows now, read in one evaluation. */
const shownNow = (page: Page) =>
  page.evaluate(() => (window as Observed).__diagnosticShown?.() ?? null);
/** What the page showed when the marker first appeared. */
const shownAtReady = (page: Page) =>
  page.evaluate(() => (window as Observed).__diagnosticAtReady ?? null);

test.describe("diagnostic pages load on demand and say when they are ready (WEB-08d r18 M1)", () => {
  for (const diagnostic of PAGES) {
    test(`${diagnostic.name}: not ready while its code is held, fully mounted when it says it is`, async ({
      page,
    }) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const requested = new Promise<void>((resolve) => {
        reached = resolve;
      });
      await observeReadiness(page);
      await page.route(diagnostic.chunk, async (route) => {
        reached();
        await held;
        await route.continue();
      });

      // WebKit counts a dynamic import begun during the entry's evaluation towards the load event (a held chunk holds `load`);
      // Chromium and Firefox fire `load` without it. So wait for the navigation to commit, then for the held request itself.
      await page.goto(diagnostic.path, { waitUntil: "commit" });
      await requested;
      const waiting = await shownNow(page);
      expect(waiting?.ready, "ready while its code is held").toBeNull();
      expect(waiting?.booting, "the boot screen while its code is held").toBe(
        "Opening Atlas…",
      );
      expect(await shownAtReady(page), "marked ready while held").toBeNull();

      release();
      await fixturePageReady(page);
      const shown = await shownAtReady(page);
      if (!shown) throw new Error("the marker appeared but was not observed");
      expect(shown.ready).toBe("ready");
      expect(shown.booting, "the boot screen once ready").toBeNull();
      if (diagnostic.path === "/__neutral?state=gate") {
        expect(shown.focus, "the gate owns focus").toBe("H1 in gate");
      } else if (diagnostic.path.startsWith("/__neutral")) {
        if (diagnostic.path.includes("form=1"))
          expect(shown.heading, "the page heading").toBe("Sign in again");
        else expect(shown.heading, "the page heading").not.toBeNull();
        expect(shown.focus, "the heading has focus once ready").toBe("H1");
      } else if (diagnostic.path === "/__controls") {
        expect(shown.heading).toBe("Controls");
        expect(shown.inputs, "the gallery's inputs").toBeGreaterThan(0);
      } else {
        expect(shown.heading).toBe("Gate");
        expect(shown.text).toMatch(/Refreshing your data/);
      }
    });
  }

  test("the shell neither fetches a diagnostic page's code nor marks itself as one", async ({
    page,
  }) => {
    await observeReadiness(page);
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (PAGES.some((diagnostic) => diagnostic.chunk.test(request.url())))
        fetched.push(request.url());
    });
    await page.goto("/settings");
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    expect(fetched).toEqual([]);
    expect((await shownNow(page))?.ready).toBeNull();
    expect(await shownAtReady(page)).toBeNull();
  });
});
