import { packager } from "@electron/packager";

const paths = await packager({
  arch: process.arch,
  asar: true,
  dir: ".",
  electronVersion: "44.0.0",
  executableName: "mdevolved-sync",
  ignore: [
    /^\/release(?:\/|$)/u,
    /^\/node_modules(?:\/|$)/u,
    /^\/src(?:\/|$)/u,
    /^\/test(?:\/|$)/u,
    /(?:^|\/)tsconfig\.json$/u,
    /(?:^|\/)vitest\.config\.ts$/u,
  ],
  name: "MDevolved Sync",
  out: "release",
  overwrite: true,
  platform: process.platform,
  prune: false,
});

if (paths.length !== 1) throw new Error("desktop_package_output_invalid");
process.stdout.write(`${paths[0]}\n`);
