import { defineConfig } from "vitest/config";

// Root tests only. Each implementation under implementations/* is its own
// project with its own test runner, so we exclude them here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "implementations/**"],
  },
});
