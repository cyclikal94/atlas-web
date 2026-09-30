import type { Page } from "@playwright/test";
import { expect, pressTab, test } from "./helpers";

interface Model {
  phase: "offline" | "resyncing" | "interrupted" | "synced";
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt?: string;
}
const setSync = (page: Page, model: Model) =>
  page.evaluate(
    (next) =>
      (
        window as unknown as { __atlasFixture: { setSync(m: unknown): void } }
      ).__atlasFixture.setSync(next),
    model,
  );
const opened = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __atlasFixture: { opened: string[] } })
        .__atlasFixture.opened,
  );
const status = (page: Page) =>
  page.locator('[role="status"][aria-live="polite"]');
const alert = (page: Page) => page.locator('[role="alert"]');

test.describe("sync/offline status chrome (B14, fixture)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const states: Array<[string, RegExp, string]> = [
    ["phase=synced", /^Up to date/, "ok"],
    ["phase=synced&pending=2", /^2 waiting to send/, "busy"],
    ["phase=synced&conflicts=1", /^1 needs a decision/, "error"],
    ["phase=resyncing&pending=1", /^1 waiting to send/, "busy"],
    ["phase=resyncing", /^Catching up/, "busy"],
    ["phase=interrupted", /^Updates stopped/, "warn"],
    ["phase=offline", /^Offline/, "muted"],
    ["phase=offline&pending=3&conflicts=2", /^2 needs a decision/, "error"],
  ];
  for (const [query, label, tone] of states) {
    test(`renders ${query}`, async ({ page }) => {
      await page.goto(`/today?${query}`);
      const chip = page.getByRole("button", {
        name: /Open (sync queue|conflicts)/,
      });
      await expect(chip).toBeVisible();
      await expect(chip).toContainText(label);
      await expect(chip).toHaveAttribute("data-sync-tone", tone);
      // Tone is never colour alone: the dot is decorative and the words carry the state.
      expect(
        await chip.locator('[aria-hidden="true"]').count(),
      ).toBeGreaterThan(0);
    });
  }

  test("the chip opens the destination the model selects, whatever the phase", async ({
    page,
  }) => {
    await page.goto("/today?phase=offline&pending=3");
    await page.getByRole("button", { name: /Open sync queue/ }).click();
    await setSync(page, {
      phase: "offline",
      pendingCount: 3,
      conflictCount: 1,
    });
    await page.getByRole("button", { name: /Open conflicts/ }).click();
    expect(await opened(page)).toEqual(["queue", "conflicts"]);
  });

  test("the chip is reachable and operable from the keyboard", async ({
    page,
  }) => {
    await page.goto("/today?pending=1");
    const chip = page.getByRole("button", { name: /Open sync queue/ });
    await chip.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(await opened(page)).toEqual(["queue", "queue"]);
  });

  test("announces nothing on first render, then politely on a phase or count change", async ({
    page,
  }) => {
    await page.goto("/today?pending=1&conflicts=1");
    await page.waitForTimeout(300);
    await expect(status(page)).toHaveText("");
    await expect(alert(page)).toHaveText("");
    await setSync(page, {
      phase: "offline",
      pendingCount: 1,
      conflictCount: 1,
    });
    await expect(status(page)).toHaveText("Receiving updates: offline.");
    await expect(alert(page)).toHaveText("");
    await setSync(page, {
      phase: "offline",
      pendingCount: 4,
      conflictCount: 1,
    });
    await expect(status(page)).toHaveText("4 waiting to send.");
  });

  test("announces assertively only when the conflict count increases", async ({
    page,
  }) => {
    await page.goto("/today");
    await setSync(page, { phase: "synced", pendingCount: 0, conflictCount: 1 });
    await expect(alert(page)).toContainText("1 needs a decision.");
    await setSync(page, { phase: "synced", pendingCount: 0, conflictCount: 0 });
    await expect(status(page)).toHaveText("Nothing waiting to send.");
    await expect(alert(page)).toContainText("1 needs a decision.");
  });

  test("rapid model changes are coalesced into one announcement carrying the latest state", async ({
    page,
  }) => {
    await page.goto("/today");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { __atlasFixture: { setSync(m: unknown): void } }
      ).__atlasFixture;
      for (let count = 1; count <= 20; count += 1)
        fixture.setSync({
          phase: "synced",
          pendingCount: count,
          conflictCount: 0,
        });
    });
    await expect(status(page)).toHaveText("20 waiting to send.");
  });

  test("the accessible name states the status and the action", async ({
    page,
  }) => {
    await page.goto("/today?pending=2");
    await expect(
      page.getByRole("button", {
        name: "2 waiting to send, Receiving updates: up to date. Open sync queue.",
      }),
    ).toBeVisible();
  });

  test("the sub-label on the chip's inset surface is legible (finding F3): computed contrast is at least 4.5", async ({
    page,
  }) => {
    await page.goto("/today?pending=2");
    const ratio = await page.evaluate(() => {
      const chip = document.querySelector(
        "[data-sync-tone] > span > span.font-num",
      ) as HTMLElement;
      const parse = (value: string) =>
        value
          .match(/\d+(\.\d+)?/g)
          ?.slice(0, 3)
          .map(Number) as number[];
      const channel = (v: number) =>
        v / 255 <= 0.03928
          ? v / 255 / 12.92
          : ((v / 255 + 0.055) / 1.055) ** 2.4;
      const lum = ([r, g, b]: number[]) =>
        0.2126 * channel(r as number) +
        0.7152 * channel(g as number) +
        0.0722 * channel(b as number);
      const button = chip.closest("button") as HTMLElement;
      const fg = lum(parse(getComputedStyle(chip).color));
      const bg = lum(parse(getComputedStyle(button).backgroundColor));
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("the in-dialog sync control (B14, fixture)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("is inside the Appearance dialog, reachable in the focus trap, and activating it closes the dialog then opens the destination", async ({
    page,
  }) => {
    await page.goto("/settings/appearance?pending=2");
    const dialog = page.getByRole("dialog", { name: "Appearance" });
    const chip = dialog.getByRole("button", { name: /Open sync queue/ });
    await expect(chip).toBeVisible();
    let reached = false;
    for (let index = 0; index < 6 && !reached; index += 1) {
      await pressTab(page);
      reached = await chip.evaluate(
        (element) => element === document.activeElement,
      );
    }
    expect(reached).toBe(true);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(await opened(page)).toEqual(["queue"]);
  });
});
