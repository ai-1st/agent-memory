import { defineConfig } from "vitest/config";

// Scope test discovery to THIS deliverable's own suite. The repo root also holds
// sibling comparison builds (implementations/*) and the bench harness (bench/*);
// without this, vitest would glob their *.test.ts too.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "data", "implementations/**", "bench/**"],
  },
});
