import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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

  if (process.platform !== "win32") {
    const fakeBin = join(temporary, "fake-bin");
    const capturePath = join(temporary, "connect-commands.jsonl");
    await mkdir(fakeBin);
    const fakeCodex = join(fakeBin, "codex");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node\nconst { appendFileSync } = require("node:fs");\nappendFileSync(process.env.MDEVOLVED_CONNECT_CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      "utf8",
    );
    await chmod(fakeCodex, 0o755);
    const connected = spawnSync(
      process.execPath,
      [
        join(
          installDirectory,
          "node_modules",
          "mdevolved",
          "dist",
          "cli-entry.js",
        ),
        "connect",
        "https://private-deployment.example/mcp",
        "--client",
        "codex",
        "--json",
      ],
      {
        cwd: installDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          MDEVOLVED_CONNECT_CAPTURE: capturePath,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    const connectOutput = `${connected.stdout}\n${connected.stderr}`;
    const commands = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      connected.status !== 0 ||
      !connectOutput.includes('"action":"client_configured"') ||
      commands.length !== 2 ||
      commands[0]?.join(" ") !==
        "mcp add mdevolved --url https://private-deployment.example/mcp" ||
      !commands[1]?.join(" ").startsWith("mcp login mdevolved --scopes ") ||
      JSON.stringify(commands).includes("Bearer") ||
      JSON.stringify(commands).includes("token")
    ) {
      throw new Error(
        `clean_install_connect_smoke_failed:${connectOutput.trim()}`,
      );
    }
  }
  process.stdout.write(
    "MDevolved clean-install pairing and connect smoke passed.\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
