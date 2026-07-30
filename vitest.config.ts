import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          APP_ENVIRONMENT: "test",
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: [
      "apps/web/test/**/*.test.ts",
      "apps/worker/test/**/*.test.ts",
      "packages/client-packs/test/**/*.test.ts",
      "packages/contracts/test/**/*.test.ts",
    ],
  },
});
