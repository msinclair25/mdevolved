import { builtinModules } from "node:module";
import process from "node:process";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
const shared = {
  banner: {
    js: "/* OWD Sync — Apache-2.0 adapter with pinned 0BSD YAOS client; see UPSTREAM.md. */",
  },
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  logLevel: "info",
  minify: production,
  sourcemap: production ? false : "inline",
  target: "es2018",
  treeShaking: true,
};

const main = await esbuild.context({
  ...shared,
  define: { __YAOS_QA_HARNESS_ENABLED__: "false" },
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
});

if (production) {
  await main.rebuild();
  await main.dispose();
} else {
  await main.watch();
}
