import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });
await build({
  bundle: true,
  entryPoints: ["src/cli-entry.ts", "src/index.ts"],
  format: "esm",
  outdir: "dist",
  platform: "node",
  sourcemap: true,
  splitting: true,
  target: "node22",
});
