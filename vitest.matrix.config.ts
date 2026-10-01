import { defineConfig } from "vitest/config";

/**
 * The full scenario matrices (`pnpm test:session-matrix`). These are deterministic and CPU-bound; they are kept out of
 * `pnpm test` (which runs the pairwise selections). The driver script starts one process per shard.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/matrix/**/*.matrix.ts"],
    testTimeout: 0,
    hookTimeout: 0,
    reporters: ["dot"],
  },
});
