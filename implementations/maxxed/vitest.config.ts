import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // pglite boot + the multi-step pipeline can take a few seconds per suite.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each suite owns its own pglite instance; run files sequentially to keep
    // memory bounded and output deterministic.
    fileParallelism: false,
  },
});
