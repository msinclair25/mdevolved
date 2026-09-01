import { basename } from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalizeFolderRoot,
  createFolderSource,
  folderSourceIdentity,
} from "@mdevolved/folder-adapter";
import type { SourceDescriptor } from "@mdevolved/yaos-core";
import {
  ProtectedCredentialCustody,
  createSystemProtectedCredentialBackend,
  type ProtectedCredentialBackend,
} from "./custody.js";
import {
  createFetchPairingTransport,
  pairFolder,
  parsePairingLink,
  type PairingConnection,
  type PairingTransport,
} from "./pairing.js";
import {
  createSyncRuntime,
  type SyncRuntime,
  type VaultSyncLike,
} from "./runtime.js";
import {
  confirmSourcePublication,
  createPortableVaultSync,
} from "./vaultFactory.js";
import {
  connectHarness,
  HARNESS_CLIENT_IDS,
  type HarnessClientId,
  type HarnessCommandExists,
  type HarnessCommandRunner,
} from "./harness-connect.js";

export const CLIENT_VERSION = "mdevolved-cli-alpha.1";

export type CliArguments =
  | {
      command: "sync";
      sourceRoot: string;
      pairingFromStdin: boolean;
      json: boolean;
    }
  | {
      command: "connect";
      client: HarnessClientId | "auto";
      mcpUrl: string;
      json: boolean;
    };

export type CliNextAction =
  | "client_configured"
  | "client_setup_failed"
  | "provide_pairing"
  | "pairing_failed"
  | "sync_complete"
  | "sync_failed";

export type CliResult =
  | {
      ok: boolean;
      action: Exclude<
        CliNextAction,
        "client_configured" | "client_setup_failed"
      >;
      sourceId: string;
      message?: string;
      stats?: {
        conflicts: number;
        diskWrites: number;
        remoteWrites: number;
        skippedOversize: number;
      };
    }
  | {
      ok: boolean;
      action: "client_configured" | "client_setup_failed";
      client?: HarnessClientId;
      message?: string;
    };

export interface CliDependencies {
  stdin?: AsyncIterable<string>;
  stdout?: (line: string) => void;
  backend?: ProtectedCredentialBackend;
  pairingTransport?: PairingTransport;
  vaultFactory?: (
    connection: PairingConnection,
    descriptor: SourceDescriptor,
  ) => Promise<VaultSyncLike>;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
  commandExists?: HarnessCommandExists;
  commandRunner?: HarnessCommandRunner;
}

const SECRET_FLAGS = new Set([
  "--grant",
  "--token",
  "--credential",
  "--pairing-url",
  "--pairing-link",
]);

export function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv[0] === "connect") {
    const mcpUrl = argv[1];
    if (!mcpUrl || mcpUrl.startsWith("-"))
      throw new Error(
        "usage: mdevolved connect <mcp-url> [--client auto|codex|claude|grok|hermes] [--json]",
      );
    let client: HarnessClientId | "auto" = "auto";
    let json = false;
    for (let index = 2; index < argv.length; index += 1) {
      const argument = argv[index];
      if (
        SECRET_FLAGS.has(argument) ||
        [...SECRET_FLAGS].some((flag) => argument.startsWith(`${flag}=`))
      ) {
        throw new Error("credentials_must_not_be_passed_as_arguments");
      }
      if (argument === "--json") json = true;
      else if (argument === "--client") {
        const value = argv[index + 1];
        if (!value) throw new Error("client_required");
        client = parseHarnessClient(value);
        index += 1;
      } else if (argument.startsWith("--client=")) {
        client = parseHarnessClient(argument.slice("--client=".length));
      } else throw new Error("unknown_argument");
    }
    return { command: "connect", client, mcpUrl, json };
  }
  if (argv.length < 2 || argv[0] !== "sync")
    throw new Error("usage: mdevolved <connect|sync>");
  const sourceRoot = argv[1];
  if (!sourceRoot || sourceRoot.startsWith("-"))
    throw new Error("source_folder_required");
  let pairingFromStdin = false;
  let json = false;
  for (const argument of argv.slice(2)) {
    if (
      SECRET_FLAGS.has(argument) ||
      [...SECRET_FLAGS].some((flag) => argument.startsWith(`${flag}=`))
    ) {
      throw new Error("credentials_must_not_be_passed_as_arguments");
    }
    if (argument === "--pairing-stdin") pairingFromStdin = true;
    else if (argument === "--json") json = true;
    else throw new Error("unknown_argument");
  }
  return { command: "sync", sourceRoot, pairingFromStdin, json };
}

function parseHarnessClient(value: string): HarnessClientId | "auto" {
  if (value === "auto") return value;
  if ((HARNESS_CLIENT_IDS as readonly string[]).includes(value))
    return value as HarnessClientId;
  throw new Error("client_unsupported");
}

async function readBoundedStdin(input: AsyncIterable<string>): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    value += chunk;
    if (value.length > 2_048) throw new Error("pairing_input_too_large");
  }
  return value.trim();
}

function emit(result: CliResult, dependencies: CliDependencies): void {
  dependencies.stdout?.(JSON.stringify(result));
}

export async function runCli(
  args: CliArguments,
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  if (args.command === "connect") {
    try {
      const client = await connectHarness(args.client, args.mcpUrl, {
        ...(dependencies.commandExists === undefined
          ? {}
          : { commandExists: dependencies.commandExists }),
        ...(dependencies.commandRunner === undefined
          ? {}
          : { runner: dependencies.commandRunner }),
        ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
      });
      const result = {
        ok: true,
        action: "client_configured" as const,
        client,
        message:
          "Open or restart the client, approve the exact Source when asked, then say “Connect this project to MDevolved.”",
      };
      emit(result, dependencies);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        action: "client_setup_failed" as const,
        message: error instanceof Error ? error.message : "client_setup_failed",
      };
      emit(result, dependencies);
      return result;
    }
  }
  const canonicalRoot = await canonicalizeFolderRoot(args.sourceRoot);
  const sourceId = await folderSourceIdentity(canonicalRoot);
  const custody = new ProtectedCredentialCustody(
    sourceId,
    dependencies.backend ??
      createSystemProtectedCredentialBackend(dependencies.stateDirectory),
  );
  let credential = await custody.get();
  let connection: PairingConnection | null = null;
  if (credential === null && args.pairingFromStdin) {
    if (!dependencies.stdin) {
      const result = {
        ok: false,
        action: "pairing_failed" as const,
        sourceId,
        message: "pairing_input_unavailable",
      };
      emit(result, dependencies);
      return result;
    }
    try {
      const pairing = parsePairingLink(
        await readBoundedStdin(dependencies.stdin),
      );
      const descriptor = await descriptorFor(
        canonicalRoot,
        custody,
        dependencies.stateDirectory,
      );
      connection = await pairFolder(
        pairing,
        descriptor,
        basename(canonicalRoot),
        CLIENT_VERSION,
        dependencies.pairingTransport ?? createFetchPairingTransport(),
        {
          displayName: `MDevolved folder on ${process.platform}`,
          rootFingerprintSha256: createHash("sha256")
            .update(sourceId, "utf8")
            .digest("hex"),
        },
      );
      await custody.install(
        {
          sourceId,
          fingerprint: connection.fingerprint,
          status: "active",
          issuedAt: connection.issuedAt,
          ...(connection.expiresAt === undefined
            ? {}
            : { expiresAt: connection.expiresAt }),
        },
        connection.token,
        {
          host: connection.host,
          vaultId: connection.vaultId,
          ...(connection.deviceId === undefined
            ? {}
            : { deviceId: connection.deviceId }),
          ...(connection.rootFingerprintSha256 === undefined
            ? {}
            : {
                rootFingerprintSha256: connection.rootFingerprintSha256,
              }),
        },
      );
      credential = await custody.get();
    } catch (error) {
      const result = {
        ok: false,
        action: "pairing_failed" as const,
        sourceId,
        message: error instanceof Error ? error.message : "pairing_failed",
      };
      emit(result, dependencies);
      return result;
    }
  }
  if (credential === null || credential.status !== "active") {
    const result = {
      ok: false,
      action: "provide_pairing" as const,
      sourceId,
      message: "provide_pairing_link_on_protected_stdin",
    };
    emit(result, dependencies);
    return result;
  }
  if (!connection) {
    connection = await custody.getConnection();
    if (!connection) {
      const result = {
        ok: false,
        action: "pairing_failed" as const,
        sourceId,
        message: "credential_unavailable",
      };
      emit(result, dependencies);
      return result;
    }
  }
  const expectedRootFingerprintSha256 = createHash("sha256")
    .update(sourceId, "utf8")
    .digest("hex");
  if (
    connection.rootFingerprintSha256 !== undefined &&
    connection.rootFingerprintSha256 !== expectedRootFingerprintSha256
  ) {
    const result = {
      ok: false,
      action: "pairing_failed" as const,
      sourceId,
      message: "source_root_mismatch",
    };
    emit(result, dependencies);
    return result;
  }
  const descriptor = await descriptorFor(
    canonicalRoot,
    custody,
    dependencies.stateDirectory,
  );
  const vaultFactory =
    dependencies.vaultFactory ??
    (async (candidate: PairingConnection): Promise<VaultSyncLike> =>
      await createPortableVaultSync(candidate));
  let runtime: SyncRuntime | undefined;
  try {
    runtime = await createSyncRuntime({
      sourceRoot: canonicalRoot,
      custody,
      vault: await vaultFactory(connection, descriptor),
      ...(dependencies.stateDirectory === undefined
        ? {}
        : { stateDirectory: dependencies.stateDirectory }),
      clientVersion: CLIENT_VERSION,
      deviceName: connection.deviceId ?? "MDevolved folder",
      watch: false,
    });
    await runtime.start();
    const synced = await runtime.syncOnce();
    await confirmSourcePublication(connection, runtime.getStateVector());
    const result = {
      ok: true,
      action: "sync_complete" as const,
      sourceId,
      stats: {
        conflicts: synced.conflicts.length,
        diskWrites: synced.diskWrites,
        remoteWrites: synced.remoteWrites,
        skippedOversize: synced.skippedOversize.length,
      },
    };
    emit(result, dependencies);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      action: "sync_failed" as const,
      sourceId,
      message: error instanceof Error ? error.message : "sync_failed",
    };
    emit(result, dependencies);
    return result;
  } finally {
    await runtime?.stop();
  }
}

async function descriptorFor(
  root: string,
  custody: ProtectedCredentialCustody,
  stateDirectory?: string,
): Promise<SourceDescriptor> {
  const source = await createFolderSource({
    root,
    credentials: custody,
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
    clientVersion: CLIENT_VERSION,
  });
  const descriptor = source.descriptor;
  await source.close();
  return descriptor;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseCliArguments(argv);
    const result = await runCli(args, {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stdin: process.stdin,
    });
    return result.ok ? 0 : 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "mdevolved_failed"}\n`,
    );
    return 2;
  }
}
