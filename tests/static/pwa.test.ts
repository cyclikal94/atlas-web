// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { webManifest } from "../../build/web-manifest";

/**
 * WEB-14a, static checks.
 *  - A-7 (the lifecycle-protocol constraint): the worker imports nothing of the session, the data layer or the API client, calls no
 *    `fetch`, uses no `Notification` (WEB-14b's), never claims clients (WEB-07 F11 / WEB-08a F-12) and skips waiting only when the
 *    accepting tab says so.
 *  - A-1: the manifest's fields and icons; the PNGs have the sizes the manifest states; the shell links the Apple touch icon.
 *  - The reference nginx configuration serves the manifest with its media type and revalidates it.
 */
const ROOT = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const workerFiles = [
  "src/sw.ts",
  ...readdirSync(join(ROOT, "src/sw")).map((name) => `src/sw/${name}`),
];
/** Source without comments, so a rule is about code, not about the words that explain it. */
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the worker's boundary (A-7)", () => {
  test.each(workerFiles)(
    "%s imports only the worker's own modules, the route list, the protocol and Workbox routing",
    (file) => {
      const imports = [...code(file).matchAll(/from\s+"([^"]+)"/g)].map(
        (match) => match[1],
      );
      for (const target of imports)
        expect(target).toMatch(
          /^(?:\.\/core|\.\/state|\.\/lifecycle|\.\/sw\/(?:core|state|lifecycle)|\.\.?\/lib\/backend-routes|\.\.?\/lib\/pwa\/protocol|workbox-routing)$/,
        );
    },
  );

  test.each(workerFiles)(
    "%s sends nothing itself and shows nothing",
    (file) => {
      const text = code(file);
      expect(text).not.toMatch(/\bfetch\s*\(/);
      expect(text).not.toMatch(
        /XMLHttpRequest|sendBeacon|WebSocket|EventSource/,
      );
      expect(text).not.toMatch(/\bNotification\b|showNotification/);
      expect(text).not.toMatch(/clientsClaim|clients\.claim/);
    },
  );

  test("skipWaiting is called exactly once, inside the handler of the accepting tab's message", () => {
    const text = code("src/sw.ts");
    expect(text.match(/skipWaiting\(/g)).toHaveLength(1);
    expect(text).toMatch(
      /message\.type === "atlas:skip-waiting"\)\s*\{\s*event\.waitUntil\(self\.skipWaiting\(\)\)/,
    );
  });

  test("the navigation route denies every backend path (Q10)", () => {
    const text = code("src/sw.ts");
    expect(text).toMatch(/new NavigationRoute\(/);
    expect(text).toMatch(/denylist:\s*backendPaths/);
    expect(read("package.json")).not.toMatch(/workbox-precaching/);
  });
});

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (file: string) => {
  const bytes = readFileSync(join(ROOT, file));
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe("the installable app (A-1)", () => {
  test("the manifest names the app, starts and is scoped at the root, and is standalone", () => {
    expect(webManifest).toMatchObject({
      id: "/",
      name: "Atlas",
      short_name: "Atlas",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(webManifest.theme_color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  test("192 and 512 icons, a maskable 512, and the SVG; every PNG has the size it claims", () => {
    const sizes = webManifest.icons.map((icon) => icon.sizes);
    expect(sizes).toEqual(
      expect.arrayContaining(["192x192", "512x512", "any"]),
    );
    expect(
      webManifest.icons.some(
        (icon) => "purpose" in icon && icon.purpose === "maskable",
      ),
    ).toBe(true);
    for (const icon of webManifest.icons) {
      const file = join("public", icon.src);
      expect(statSync(join(ROOT, file)).isFile()).toBe(true);
      if (icon.type !== "image/png") continue;
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(file)).toEqual({ width, height });
    }
  });

  test.each(["index.html", "fixture.html"])(
    "%s links the 180 px Apple touch icon",
    (file) => {
      expect(read(file)).toContain(
        '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />',
      );
      expect(pngSize("public/icons/apple-touch-icon.png")).toEqual({
        width: 180,
        height: 180,
      });
    },
  );

  test("nginx serves the manifest with its media type and revalidates it", () => {
    const conf = read("deploy/nginx/web.conf");
    const block =
      /location = \/manifest\.webmanifest \{([\s\S]*?)try_files/.exec(conf);
    expect(block).not.toBeNull();
    expect(block?.[1]).toContain('add_header Cache-Control "no-cache" always;');
    expect(block?.[1]).toContain("default_type application/manifest+json;");
    expect(block?.[1]).toContain("atlas-security-headers.conf");
    // The production policy already allows the manifest and the worker from the origin only.
    expect(read("deploy/nginx/security-headers.conf")).toMatch(
      /manifest-src 'self'; worker-src 'self'/,
    );
  });
});
