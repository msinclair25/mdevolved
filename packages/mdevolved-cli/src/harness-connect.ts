import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

export const HARNESS_CLIENT_IDS = [
  "codex",
  "claude",
  "grok",
  "hermes",
] as const;

export type HarnessClientId = (typeof HARNESS_CLIENT_IDS)[number];

export type HarnessCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<number>;

export type HarnessCommandExists = (command: string) => Promise<boolean>;

const EXECUTABLES: Record<HarnessClientId, string> = {
  codex: "codex",
  claude: "claude",
  grok: "grok",
  hermes: "hermes",
};

const ENVIRONMENT_HINTS: Record<HarnessClientId, readonly string[]> = {
  codex: ["CODEX_HOME", "CODEX_THREAD_ID"],
  claude: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
  grok: ["GROK_HOME"],
  hermes: ["HERMES_HOME"],
};

export function validateMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("mcp_url_invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    throw new Error("mcp_url_insecure");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("mcp_url_must_not_contain_credentials_or_state");
  if (!url.pathname.endsWith("/mcp")) throw new Error("mcp_url_path_invalid");
  return url.toString();
}

export function harnessSetupCommands(
  client: HarnessClientId,
  mcpUrl: string,
): ReadonlyArray<{ command: string; args: readonly string[] }> {
  switch (client) {
    case "codex":
      return [
        {
          command: "codex",
          args: ["mcp", "add", "mdevolved", "--url", mcpUrl],
        },
        {
          command: "codex",
          args: [
            "mcp",
            "login",
            "mdevolved",
            "--scopes",
            "vault.read,project.initialize.request,project.connect.request",
          ],
        },
      ];
    case "claude":
      return [
        {
          command: "claude",
          args: ["mcp", "add", "--transport", "http", "mdevolved", mcpUrl],
        },
      ];
    case "grok":
      return [
        {
          command: "grok",
          args: ["mcp", "add", "--transport", "http", "mdevolved", mcpUrl],
        },
      ];
    case "hermes":
      return [
        {
          command: "hermes",
          args: ["mcp", "add", "mdevolved", "--url", mcpUrl, "--auth", "oauth"],
        },
      ];
  }
}

export async function detectHarnessClient(
  env: NodeJS.ProcessEnv,
  commandExists: HarnessCommandExists,
): Promise<HarnessClientId> {
  const hinted = HARNESS_CLIENT_IDS.filter((client) =>
    ENVIRONMENT_HINTS[client].some((key) => Boolean(env[key])),
  );
  if (hinted.length === 1) return hinted[0];
  if (hinted.length > 1)
    throw new Error(`multiple_clients_detected:${hinted.join(",")}`);

  const installed = (
    await Promise.all(
      HARNESS_CLIENT_IDS.map(async (client) => ({
        client,
        exists: await commandExists(EXECUTABLES[client]),
      })),
    )
  ).filter(({ exists }) => exists);
  if (installed.length === 0) throw new Error("supported_client_not_detected");
  if (installed.length > 1)
    throw new Error(
      `multiple_clients_detected:${installed.map(({ client }) => client).join(",")}`,
    );
  return installed[0].client;
}

export async function connectHarness(
  requestedClient: HarnessClientId | "auto",
  rawMcpUrl: string,
  options: {
    commandExists?: HarnessCommandExists;
    env?: NodeJS.ProcessEnv;
    runner?: HarnessCommandRunner;
  } = {},
): Promise<HarnessClientId> {
  const mcpUrl = validateMcpUrl(rawMcpUrl);
  const commandExists =
    options.commandExists ??
    ((command) => executableOnPath(command, options.env ?? process.env));
  const client =
    requestedClient === "auto"
      ? await detectHarnessClient(options.env ?? process.env, commandExists)
      : requestedClient;
  if (!(await commandExists(EXECUTABLES[client])))
    throw new Error(`client_command_unavailable:${client}`);

  const runner = options.runner ?? runHarnessCommand;
  for (const { command, args } of harnessSetupCommands(client, mcpUrl)) {
    if ((await runner(command, args)) !== 0)
      throw new Error(`client_setup_failed:${client}`);
  }
  return client;
}

async function executableOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Keep checking the remaining PATH entries.
      }
    }
  }
  return false;
}

function runHarnessCommand(
  command: string,
  args: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: "inherit" });
    child.once("error", () =>
      reject(new Error(`client_command_unavailable:${command}`)),
    );
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
