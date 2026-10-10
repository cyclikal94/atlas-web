import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { recordBundledPackages } from "./build/bundled-packages.ts";
import { webManifest } from "./build/web-manifest.ts";
import { backendPaths } from "./src/lib/backend-routes.ts";

// The backend's documented default bind is 127.0.0.1:3000 (the image binds 0.0.0.0:3000).
const target = process.env.ATLAS_BACKEND_URL ?? "http://127.0.0.1:3000";

/**
 * Fixture mode builds fixture.html into dist-fixture/ as index.html, so a preview server's history fallback serves
 * deep links. The production build has one input (index.html) and never sees fixture.html.
 */
function fixtureEntryAsIndex(): Plugin {
  return {
    name: "atlas-fixture-entry-as-index",
    // In fixture dev mode (pnpm dev:fixture) every page navigation gets the fixture entry, so client routes work.
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? "/";
        const pathname = url.split("?")[0] ?? "/";
        if (
          request.headers.accept?.includes("text/html") &&
          !pathname.startsWith("/@") &&
          !pathname.startsWith("/src/") &&
          !/\.[A-Za-z0-9]+$/.test(pathname)
        ) {
          request.url = `/fixture.html${url.includes("?") ? url.slice(url.indexOf("?")) : ""}`;
        }
        next();
      });
    },
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      const from = join(dir, "fixture.html");
      if (existsSync(from)) renameSync(from, join(dir, "index.html"));
    },
  };
}

/**
 * Preloads the primary sans font (Latin subset) so its request starts with the stylesheet's instead of after it. The measured
 * effect is in .agtx/evidence/WEB-07/A2 (fallback-font window before and after). Only this one font: the mono font and the
 * Latin-extended subsets stay lazy, because most screens do not need them.
 */
function preloadPrimaryFont(): Plugin {
  return {
    name: "atlas-preload-primary-font",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const font = Object.keys(context.bundle ?? {}).find((file) =>
          /geist-latin-wght-normal-[^/]+\.woff2$/.test(file),
        );
        if (!font) return undefined;
        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              crossorigin: "",
              href: `/${font}`,
            },
            injectTo: "head",
          },
        ];
      },
    },
  };
}

/**
 * The service worker and the manifest (WEB-14a). Production builds ship them; so does `pwa-fixture`, the FIXTURE entry built with the
 * worker for the PWA browser checks (scripts/build-pwa-generations.mjs builds it into the ignored `dist-pwa/`; it is never packaged).
 * The worker is a classic script (`iife`): registered without `type: "module"`, it runs in every supported engine.
 */
function pwa(record: boolean): Plugin[] {
  return VitePWA({
    strategies: "injectManifest",
    srcDir: "src",
    filename: "sw.ts",
    injectRegister: false,
    manifest: webManifest,
    // The glob already lists the icons and the manifest; the plugin would list them a second time.
    includeManifestIcons: false,
    injectManifest: {
      globPatterns: ["**/*.{js,css,html,woff2,svg,png,webmanifest}"],
      rollupFormat: "iife",
      // The worker is a separate build: record what it bundles (Workbox) for the third-party notices.
      ...(record
        ? { buildPlugins: { vite: [recordBundledPackages("service-worker")] } }
        : {}),
    },
  });
}

export default defineConfig(({ mode }) => {
  const pwaFixture = mode === "pwa-fixture";
  const fixture = mode === "fixture" || pwaFixture;
  const proxy = Object.fromEntries(
    backendPaths.map((path) => [path.source, { target, changeOrigin: false }]),
  );
  return {
    plugins: [
      react(),
      tailwindcss(),
      preloadPrimaryFont(),
      ...(fixture ? [fixtureEntryAsIndex()] : [recordBundledPackages("app")]),
      ...(pwaFixture || !fixture ? pwa(!fixture) : []),
    ],
    // Same-origin by design: no CORS headers, in development or preview, so a cross-origin page can never read a response.
    server: { proxy, cors: false },
    preview: { proxy, cors: false },
    build: {
      target: "es2022",
      // The PWA test build injects no `<link rel="modulepreload">` into its HTML, like the production build (whose entry is one chunk and
      // has none). With the worker answering the precached modules, Chromium 153 discards such HTML preloads with a console warning ("a
      // cross-world service worker resource mismatch"), intermittently; preloads made at run time for lazy chunks are kept (WEB-14a,
      // docs/pwa.md).
      ...(pwaFixture
        ? {
            modulePreload: {
              resolveDependencies: (
                _file: string,
                deps: string[],
                context: { hostType: "html" | "js" },
              ) => (context.hostType === "html" ? [] : deps),
            },
          }
        : {}),
      outDir: pwaFixture
        ? "dist-pwa/fixture"
        : fixture
          ? "dist-fixture"
          : "dist",
      rollupOptions: {
        ...(fixture ? { input: "fixture.html" } : {}),
        // `src/data` modules have no import-time effect the application depends on (the plan registry is filled by the plans that
        // are USED, and is read only by tests). Saying so lets the bundler drop whatever the boot path does not use from the data
        // layer's single public index, so the initial chunk carries only the deletion-port shims (plan 5.3.1, 6.1).
        treeshake: {
          moduleSideEffects: (id: string) => !/[\\/]src[\\/]data[\\/]/.test(id),
        },
      },
    },
  };
});
