import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { backendPaths } from "./src/lib/backend-routes.ts";

const target = process.env.ATLAS_BACKEND_URL ?? "http://127.0.0.1:8080";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      injectManifest: { globPatterns: ["**/*.{js,css,html,woff2,svg}"] },
    }),
  ],
  server: {
    proxy: Object.fromEntries(
      backendPaths.map((path) => [
        path.source,
        { target, changeOrigin: false },
      ]),
    ),
  },
  build: { target: "es2022" },
});
