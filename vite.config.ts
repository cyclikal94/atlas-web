import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { recordBundledPackages } from "./build/bundled-packages.ts";
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

export default defineConfig(({ mode }) => {
  const fixture = mode === "fixture";
  const proxy = Object.fromEntries(
    backendPaths.map((path) => [path.source, { target, changeOrigin: false }]),
  );
  return {
    plugins: [
      react(),
      tailwindcss(),
      preloadPrimaryFont(),
      ...(fixture
        ? [fixtureEntryAsIndex()]
        : [
            recordBundledPackages("app"),
            VitePWA({
              strategies: "injectManifest",
              srcDir: "src",
              filename: "sw.ts",
              injectRegister: false,
              manifest: false,
              injectManifest: {
                globPatterns: ["**/*.{js,css,html,woff2,svg}"],
                // The worker is a separate build: record what it bundles (Workbox) for the third-party notices.
                buildPlugins: {
                  vite: [recordBundledPackages("service-worker")],
                },
              },
            }),
          ]),
    ],
    // Same-origin by design: no CORS headers, in development or preview, so a cross-origin page can never read a response.
    server: { proxy, cors: false },
    preview: { proxy, cors: false },
    build: {
      target: "es2022",
      outDir: fixture ? "dist-fixture" : "dist",
      ...(fixture ? { rollupOptions: { input: "fixture.html" } } : {}),
    },
  };
});
