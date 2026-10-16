import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import type { FocusProbe } from "./focus-probe/probe";
import { expect, test } from "./helpers";

/**
 * WEB-14a revision 20, R26/R27 (independent review of 15-16 October 2026; design assessment of 16 October 2026, RC1, I1-I12, Q1/Q3,
 * S1-S18/S30): the Q4 focus transitions across the REAL session gate. The harness page (tests/e2e/focus-probe/, served here by a private
 * loopback Vite dev server, as the reviewer's probe was) runs the production
 * protected-surface adapter (synchronous commit, `inert`, the modal resume gate) over the real banners, the restored RecoveryBanner and an
 * app Dialog, so the ENGINE decides whether focus is possible. The independent reviewer's five-schedule probe
 * (`.agtx/evidence/review-r19-20261015/gate-focus.spec.ts`: three schedules failed in all three engines on revision 19) is promoted here
 * with its requirement assertions hard, and extended to the failure, refused and discard-failed states, the neutral root, the keyed
 * same-account lift, app dialogs, holds, DA-F1 and DA-F2 (Kieran, 16 October 2026: the later failure's recovery action wins over an older
 * pending restored field). Every case first asserts that the gate holds focus while closed, then the Q4 destination after exposure, with
 * no action asked of the coordinator and the input unchanged. FIXTURE evidence: states are published directly; no save, reload or backend.
 */
type Probe = FocusProbe;
const call = <K extends keyof Probe>(
  page: Page,
  name: K,
  ...args: Parameters<Probe[K]>
) =>
  page.evaluate(
    ([name, args]) =>
      (
        (window as unknown as { __focusProbe: Probe }).__focusProbe[
          name
        ] as unknown as (...a: unknown[]) => unknown
      )(...(args as unknown[])),
    [name, args] as const,
  );

const NONE = {
  accept: 0,
  retrySave: 0,
  discardAndReload: 0,
  reloadAnyway: 0,
  notNow: 0,
};
const PROMPT = { kind: "available", dismissed: false } as const;
const FAILED = { kind: "save_failed", refused: false } as const;

const shell = (page: Page) => page.locator("#protected-root");
const gateHeading = (page: Page) =>
  page.getByRole("heading", { name: "Checking your account" });
const title = (page: Page) =>
  shell(page).getByRole("textbox", { name: "Title" });
const inShell = (page: Page, name: string) =>
  shell(page).getByRole("button", { name });
const region = (page: Page) =>
  shell(page).getByRole("region", { name: "Update" });
/** Two frames: the adapter's heading attempts and any late focus have run. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

/** Focus is inside the app dialog (Radix gives it to the dialog's first control). */
const inDialog = (page: Page) =>
  page.evaluate(
    () =>
      document
        .querySelector('[role="dialog"]')
        ?.contains(document.activeElement) === true,
  );

async function unchanged(page: Page) {
  expect(await call(page, "calls")).toEqual(NONE);
  await expect(title(page)).toHaveValue("Unfinished");
}

let server: ViteDevServer | null = null;
let probeUrl = "";
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    logLevel: "error",
    cacheDir: join(
      process.env.TMPDIR ?? tmpdir(),
      `vite-focus-probe-${process.pid}`,
    ),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const local = server.resolvedUrls?.local[0];
  if (!local) throw new Error("the focus probe server has no address");
  probeUrl = new URL("tests/e2e/focus-probe/index.html", local).href;
});
test.afterAll(async () => {
  await server?.close();
  server = null;
});

test.beforeEach(async ({ page }) => {
  await page.goto(probeUrl);
  await page.waitForFunction(() => "__focusProbe" in window);
});
test.afterEach(async ({ page }, info) => {
  await info.attach("focus-trace", {
    body: JSON.stringify(await call(page, "trace"), null, 2),
    contentType: "application/json",
  });
});

test.describe("revision 20: Q4 focus across the real session gate", () => {
  test("S1 control: an ordinary attach with no request focuses the page heading", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await frames(page);
    await expect(shell(page)).not.toHaveAttribute("inert", "");
    await expect(
      shell(page).getByRole("heading", { name: "Today" }),
    ).toBeFocused();
    await unchanged(page);
  });

  test("S2 control: the prompt published after exposure focuses 'Save and reload'", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "publish", PROMPT);
    await expect(inShell(page, "Save and reload")).toBeFocused();
    await unchanged(page);
  });

  test("S3: the prompt already published at the first attach focuses 'Save and reload' once the gate lifts", async ({
    page,
  }) => {
    await call(page, "mount", { before: PROMPT });
    await frames(page);
    await expect(
      inShell(page, "Save and reload"),
      "Q4 state 1 after the adapter's initial attach",
    ).toBeFocused();
    await unchanged(page);
  });

  test("S6: a restored banner mounted during the attach focuses the form's first field once the gate lifts", async ({
    page,
  }) => {
    await call(page, "mount", { restored: true });
    await frames(page);
    await expect(
      title(page),
      "Q4 state 3 after the adapter's initial attach",
    ).toBeFocused();
    await unchanged(page);
  });

  test("S4: the prompt published while the existing tree is gated focuses 'Save and reload' when that same tree lifts", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await title(page).focus();
    await page.evaluate(() => {
      const field = document.querySelector('[aria-label="Title"]');
      (field as unknown as { __probeSame: boolean }).__probeSame = true;
    });
    await call(page, "gate");
    await call(page, "publish", PROMPT);
    await frames(page);
    await expect(gateHeading(page), "the gate owns focus").toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(
      inShell(page, "Save and reload"),
      "Q4 state 1 after the same-tree lift",
    ).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (
            document.querySelector('[aria-label="Title"]') as unknown as {
              __probeSame?: boolean;
            }
          ).__probeSame,
      ),
      "the same tree: not remounted",
    ).toBe(true);
    await unchanged(page);
  });

  for (const [name, state, target] of [
    ["save failed", FAILED, "Retry save"],
    ["save refused", { kind: "save_failed", refused: true }, null],
    ["discard failed", { kind: "discard_failed" }, "Try again"],
  ] as const)
    test(`S9, ${name}: presented while the existing tree is gated, it takes its focus at the lift, choosing nothing`, async ({
      page,
    }) => {
      await call(page, "mount", {});
      await call(page, "gate");
      await call(page, "publish", state);
      await frames(page);
      await expect(gateHeading(page)).toBeFocused();
      await call(page, "attach");
      await frames(page);
      await expect(
        target ? inShell(page, target) : region(page),
        "Q4 state 2 after the same-tree lift",
      ).toBeFocused();
      await unchanged(page);
    });

  test("S9, save failed before the first attach: 'Retry save' has focus once the gate lifts", async ({
    page,
  }) => {
    await call(page, "mount", { before: FAILED });
    await frames(page);
    await expect(
      inShell(page, "Retry save"),
      "Q4 state 2 after the adapter's initial attach",
    ).toBeFocused();
    await unchanged(page);
  });

  test("S5 control: a same-account lift with no new request restores the keyed control, not an earlier presentation", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "publish", PROMPT);
    await expect(inShell(page, "Save and reload")).toBeFocused();
    await inShell(page, "Opener").focus();
    await call(page, "gate");
    await frames(page);
    await call(page, "attach");
    await frames(page);
    await expect(inShell(page, "Opener")).toBeFocused();
    await unchanged(page);
  });

  test("S5: a same-account lift with a NEW request focuses it over the keyed control", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await inShell(page, "Opener").focus();
    await call(page, "gate");
    await call(page, "publish", FAILED);
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(inShell(page, "Retry save")).toBeFocused();
    await unchanged(page);
  });

  test("S10: a neutral-root failure behind the modal resume gate (no `inert` on the neutral root) takes focus when the gate closes over the neutral root", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "neutral", true);
    await call(page, "publish", FAILED);
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "unmount");
    await frames(page);
    await expect(
      page.locator("#neutral-root").getByRole("button", { name: "Retry save" }),
      "Q4 state 2 on the neutral root after the gate closes",
    ).toBeFocused();
    expect(await call(page, "calls")).toEqual(NONE);
  });

  test("S11: a failure pending in the gated shell and on the neutral root is focused once, in the shell, at the lift", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "neutral", true);
    await call(page, "publish", FAILED);
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(
      inShell(page, "Retry save"),
      "the shell's banner, not the neutral root's",
    ).toBeFocused();
    await call(page, "neutral", false);
    await frames(page);
    await expect(inShell(page, "Retry save")).toBeFocused();
    await unchanged(page);
  });

  test("S8, DA-F1: the prompt and a restored field both gated: the restored field wins at the lift and keeps focus", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "publish", PROMPT);
    await call(page, "restored", true);
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(title(page), "DA-F1").toBeFocused();
    await call(page, "dialog", true);
    await call(page, "dialog", false);
    await frames(page);
    await expect(title(page)).toBeFocused();
    await unchanged(page);
  });

  test("S30, DA-F2 (Kieran, 16 October 2026): a save failure after a restored field still pending: 'Retry save' wins at the lift and keeps focus", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "restored", true);
    await call(page, "publish", FAILED);
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(
      inShell(page, "Retry save"),
      "DA-F2: the later failure's recovery action",
    ).toBeFocused();
    await call(page, "hold", true);
    await call(page, "hold", false);
    await frames(page);
    await expect(
      inShell(page, "Retry save"),
      "DA-F2: the older restored request never takes focus later",
    ).toBeFocused();
    await unchanged(page);
  });

  test("S15: an app dialog keeps focus over a failure presented while it is open; when it closes 'Retry save' has focus and keeps it", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await inShell(page, "Opener").focus();
    await call(page, "dialog", true);
    await expect.poll(() => inDialog(page)).toBe(true);
    await call(page, "publish", FAILED);
    await frames(page);
    expect(await inDialog(page), "the open dialog keeps focus").toBe(true);
    await call(page, "dialog", false);
    await expect(
      inShell(page, "Retry save"),
      "the failure's recovery action has focus once the dialog closes",
    ).toBeFocused();
    // The dialog's return to its opener (Radix, a task after the unmount) does not take it back: a bounded window for a focus that
    // must NOT happen, not a wait for readiness.
    await page.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
    await expect(
      inShell(page, "Retry save"),
      "the dialog's return to its opener does not take focus back",
    ).toBeFocused();
    await unchanged(page);
  });

  test("S15 control: with nothing pending, the app dialog returns focus to its opener", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await inShell(page, "Opener").focus();
    await call(page, "dialog", true);
    await expect.poll(() => inDialog(page)).toBe(true);
    await call(page, "dialog", false);
    await expect(inShell(page, "Opener")).toBeFocused();
  });

  test("S14: a restored field held by its form's hold is focused when the hold is released", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "hold", true);
    await call(page, "restored", true);
    await frames(page);
    await expect(title(page)).not.toBeFocused();
    await call(page, "hold", false);
    await expect(title(page)).toBeFocused();
    await unchanged(page);
  });

  test("S17: the gate closes again in the same step that lifted it: the gate keeps focus; the request is fulfilled at the next lift", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "publish", PROMPT);
    await page.evaluate(() => {
      const probe = (window as unknown as { __focusProbe: Probe }).__focusProbe;
      probe.attach();
      probe.gate();
    });
    await frames(page);
    await expect(gateHeading(page)).toBeFocused();
    await call(page, "attach");
    await frames(page);
    await expect(inShell(page, "Save and reload")).toBeFocused();
    await unchanged(page);
  });

  test("S18: a different account replaces the gated tree: the old tree's request goes with it; the new tree's own banner takes focus", async ({
    page,
  }) => {
    await call(page, "mount", {});
    await call(page, "gate");
    await call(page, "publish", PROMPT);
    await page.evaluate(() => {
      const old = document.querySelector('[data-focus-key="probe-opener"]');
      (window as unknown as { __probeOld: Element | null }).__probeOld =
        old?.closest("main") ?? null;
    });
    await call(page, "attach", "b");
    await frames(page);
    await expect(inShell(page, "Save and reload")).toBeFocused();
    expect(
      await page.evaluate(() => {
        const old = (window as unknown as { __probeOld: Element | null })
          .__probeOld;
        return {
          oldConnected: old?.isConnected ?? null,
          focusInOld: old?.contains(document.activeElement) ?? null,
        };
      }),
    ).toEqual({ oldConnected: false, focusInOld: false });
    expect(await call(page, "calls")).toEqual(NONE);
  });
});
