import type { Page } from "@playwright/test";
import {
  build,
  checkForUpdate,
  displayed,
  expect,
  focus,
  type Generations,
  mark,
  marked,
  openApp,
  precaches,
  quiet,
  reloadQuietly,
  seedAccount,
  test,
  updateRegion,
  workerActive,
} from "./pwa-world";

/**
 * WEB-14a P-R1: live-generation asset retention with no fixed cap (WEB-04 8, capability row 473). Tab 1 stays on generation A (it dismisses
 * the banner) while tab 2 applies B and then C, and the server keeps only C's files. Tab 1 can still load a file of A it never loaded
 * before (the worker answers it from A's retained precache; the server is never asked), because tab 1 reported that it runs A. B, which no
 * tab runs, is purged once the 10-second grace after it stopped being active has passed and a report is handled; A is purged only once
 * tab 1 has closed; the active generation is never purged. Production constants (the grace is waited for in real time). FIXTURE evidence.
 */
const PURGE_GRACE_MS = 10_000;

/** One of A's files that C does not have and that `page` has not loaded. */
async function unloadedFileOf(
  page: Page,
  generations: Generations,
): Promise<{ path: string; sha256: string }> {
  const a = generations.files("fixture-a");
  const c = generations.files("fixture-c");
  const loaded = new Set(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => new URL(entry.name).pathname),
    ),
  );
  // The probe chunk (src/fixture/pwa-probe-chunk.ts): nothing loads it unless asked.
  const path = Object.keys(a).find(
    (file) =>
      /^\/assets\/pwa-probe-chunk-[^/]+\.js$/.test(file) &&
      c[file] === undefined &&
      !loaded.has(file),
  );
  if (!path)
    throw new Error("no file of A that C lacks and the page did not load");
  return { path, sha256: a[path] as string };
}

const sha256Of = (page: Page, path: string) =>
  page.evaluate(async (url) => {
    const response = await fetch(url);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await response.arrayBuffer(),
    );
    return {
      status: response.status,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, path);

async function accept(page: Page, generation: string): Promise<void> {
  await mark(page);
  await quiet(page);
  await updateRegion(page)
    .getByRole("button", { name: /^Reload( here)?$/ })
    .click();
  await expect.poll(() => marked(page).catch(() => false)).toBe(false);
  await displayed(page);
  await expect.poll(() => build(page)).toBe(generation.slice(-1));
}

test("an old tab keeps its generation through two updates; generations go when no tab runs them; the active one never does", async ({
  context,
  generations,
}) => {
  test.setTimeout(90_000);
  await seedAccount(context, generations);
  const old = await openApp(context, generations, { form: false });
  await workerActive(old);
  await reloadQuietly(old);
  await mark(old);
  expect(await build(old)).toBe("a");

  // B is deployed; the old tab dismisses the banner and stays on A. Tab 2 applies B.
  await generations.serve("fixture-b");
  await checkForUpdate(old);
  await updateRegion(old).getByRole("button", { name: "Not now" }).click();
  const current = await openApp(context, generations, { form: false });
  await expect(
    updateRegion(current).getByRole("button", { name: "Reload" }),
  ).toBeVisible();
  await accept(current, "fixture-b");

  // C is deployed (the server now has only C's files); tab 2 applies it.
  await generations.serve("fixture-c");
  await checkForUpdate(current);
  await expect(
    updateRegion(current).getByRole("button", { name: "Reload" }),
  ).toBeVisible();
  await accept(current, "fixture-c");
  expect(await marked(old)).toBe(true);
  expect(await build(old)).toBe("a");
  expect(await precaches(old)).toHaveLength(3);

  // The old tab loads a lazy chunk of A it never loaded: the worker answers it from A's retained precache (the server, which has only
  // C's files, is not asked), and the module that runs is A's.
  const file = await unloadedFileOf(old, generations);
  await generations.clearLog();
  expect(
    await old.evaluate(() => window.__atlasFixture?.session?.lazyBuildLabel()),
  ).toBe("a");
  expect(await sha256Of(old, file.path)).toEqual({
    status: 200,
    sha256: file.sha256,
  });
  expect(
    (await generations.log()).filter((entry) =>
      entry.path.startsWith("/assets/"),
    ),
  ).toEqual([]);

  // After the grace, a report (a return to tab 2) lets the worker purge B, which no tab runs; A stays for the old tab.
  await current.waitForTimeout(PURGE_GRACE_MS);
  await focus(current);
  await expect.poll(() => precaches(current)).toHaveLength(2);

  // The old tab closes: at the next pass A goes too, and only the active generation is left.
  await old.close();
  await focus(current);
  await expect.poll(() => precaches(current)).toHaveLength(1);
  const [kept] = await precaches(current);
  // A's file is in no cache any more.
  expect(
    await current.evaluate(
      async (path) => (await caches.match(path)) === undefined,
      file.path,
    ),
  ).toBe(true);
  // The one left is the active generation's: it serves C's shell.
  expect(kept).toMatch(/^atlas-precache-[0-9a-f]{16}$/);
  await current.reload();
  await displayed(current);
  expect(await build(current)).toBe("c");
});
