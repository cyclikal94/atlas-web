import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import { mutantRedirect } from "./scripts/mutation/redirect-plugin.mjs";
import base from "./vite.config.ts";

/**
 * The FIXTURE build for the real-engine mutants (WEB-09a plan 8.12): the same configuration as `vite build --mode fixture`, into
 * `dist-mutant/`, with a patched copy of a source file (`ATLAS_MUTANT_DIR`) in place of the original. Never packaged; `dist-mutant`
 * is a build output like `dist-fixture` and is removed by the runner.
 */
export default defineConfig(async (env) => {
  const config = (await (typeof base === "function"
    ? base(env)
    : base)) as UserConfig;
  return {
    ...config,
    plugins: [
      mutantRedirect(
        resolve(import.meta.dirname),
        process.env.ATLAS_MUTANT_DIR,
      ),
      ...(config.plugins ?? []),
    ],
    build: {
      ...config.build,
      outDir: process.env.ATLAS_MUTANT_OUT_DIR ?? "dist-mutant",
      emptyOutDir: true,
    },
  };
});
