import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { mutantRedirect } from "./scripts/mutation/redirect-plugin.mjs";

/**
 * The mutation harness's vitest configuration (WEB-09a plan 8.12, 8.11). A mutant is a PATCHED COPY of one or more source files kept
 * outside the tree (`ATLAS_MUTANT_DIR`, laid out like the repository); the plugin makes every import of such a file resolve to the
 * copy, and nothing else changes. The real source is never edited, so a crash cannot leave a broken guard behind, and a run with no
 * `ATLAS_MUTANT_DIR` is the unmutated CONTROL: the same tests over the same tree.
 */
export default defineConfig({
  plugins: [
    mutantRedirect(resolve(import.meta.dirname), process.env.ATLAS_MUTANT_DIR),
    react(),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
