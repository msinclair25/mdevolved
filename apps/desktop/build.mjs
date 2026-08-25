import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  bundle: true,
  entryPoints: ["src/main.ts", "src/preload.ts"],
  external: ["electron"],
  format: "esm",
  outdir: "dist",
  platform: "node",
  sourcemap: true,
  target: "node22",
});
await build({
  bundle: true,
  entryPoints: ["src/renderer.ts"],
  format: "esm",
  outdir: "dist",
  platform: "browser",
  sourcemap: true,
  target: "chrome150",
});
await Promise.all([
  cp("src/index.html", "dist/index.html"),
  cp("src/style.css", "dist/style.css"),
]);
