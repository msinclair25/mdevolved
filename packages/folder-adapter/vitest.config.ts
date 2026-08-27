import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@mdevolved/yaos-core": resolve(
        import.meta.dirname,
        "../yaos-core/src/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
