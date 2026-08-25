import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = await mkdtemp(join(tmpdir(), "mdevolved-clean-install-"));
const packageDirectory = join(temporary, "package");
const installDirectory = join(temporary, "install");
function run(command, args, cwd) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? (process.env.ComSpec ?? "cmd.exe") : command,
    windows ? ["/d", "/s", "/c", command, ...args] : args,
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
    },
  );
  if (result.error) throw result.error;
  return result;
}

try {
  await mkdir(packageDirectory);
  await mkdir(installDirectory);
  const packed = run(
    "pnpm",
    ["--filter", "mdevolved", "pack", "--pack-destination", packageDirectory],
    process.cwd(),
  );
  if (packed.status !== 0) {
    throw new Error(`pack_failed:${packed.stderr.trim()}`);
  }
  const tarball = (await readdir(packageDirectory)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (!tarball) throw new Error("pack_tarball_missing");
  const installed = run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packageDirectory, tarball),
    ],
    installDirectory,
  );
  if (installed.status !== 0) {
    throw new Error(`clean_install_failed:${installed.stderr.trim()}`);
  }
  await mkdir(join(installDirectory, "notes"));
  const smoke = spawnSync(
    process.execPath,
    [
      join(
        installDirectory,
        "node_modules",
        "mdevolved",
        "dist",
        "cli-entry.js",
      ),
      "sync",
      "notes",
      "--json",
    ],
    { cwd: installDirectory, encoding: "utf8" },
  );
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  if (
    smoke.status !== 2 ||
    !output.includes('"action":"provide_pairing"') ||
    output.includes("credential") ||
    output.includes("token")
  ) {
    throw new Error(`clean_install_smoke_failed:${output.trim()}`);
  }
  process.stdout.write("MDevolved clean-install pairing smoke passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
