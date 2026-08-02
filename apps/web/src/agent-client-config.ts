import {
  createAlbatrossAuthorizationCommand as createProfileAlbatrossAuthorizationCommand,
  createAlbatrossMcpMergeConfig as createProfileAlbatrossMcpMergeConfig,
  createAlbatrossSetupKit as createProfileAlbatrossSetupKit,
  createEveConnectionSource as createProfileEveConnectionSource,
  createObsidianMindMcpMergeConfig as createProfileMcpMergeConfig,
  createObsidianMindProjectMcpCommand as createProfileProjectMcpCommand,
} from "@owd/client-packs";

export const AGENT_SERVER_NAME = "md-evolved";

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createCursorInstallUrl(mcpUrl: string): string {
  const installUrl = new URL("https://cursor.com/en/install-mcp");
  installUrl.searchParams.set("name", AGENT_SERVER_NAME);
  installUrl.searchParams.set(
    "config",
    base64EncodeUtf8(JSON.stringify({ url: mcpUrl })),
  );
  return installUrl.toString();
}

export function createAntigravityConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [AGENT_SERVER_NAME]: {
          serverUrl: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

export function createCodexSetupCommands(mcpUrl: string): string {
  const quotedUrl = `'${mcpUrl.replaceAll("'", `'\\''`)}'`;
  return [
    `codex mcp add ${AGENT_SERVER_NAME} --url ${quotedUrl}`,
    `codex mcp login ${AGENT_SERVER_NAME} --scopes vault.read,project.initialize.request,project.connect.request`,
  ].join("\n");
}

export function createObsidianMindMcpMergeConfig(mcpUrl: string): string {
  return createProfileMcpMergeConfig(mcpUrl);
}

export function createObsidianMindProjectMcpCommand(mcpUrl: string): string {
  return createProfileProjectMcpCommand(mcpUrl);
}

export function createEveConnectionSource(
  mcpUrl: string,
  connectorUid?: string,
): string {
  return createProfileEveConnectionSource(mcpUrl, connectorUid);
}

export function createAlbatrossAuthorizationCommand(
  mcpUrl: string,
  participantId?: string,
): string {
  return createProfileAlbatrossAuthorizationCommand(mcpUrl, participantId);
}

export function createAlbatrossMcpMergeConfig(
  mcpUrl: string,
  participantId?: string,
): string {
  return createProfileAlbatrossMcpMergeConfig(mcpUrl, participantId);
}

export function createAlbatrossSetupKit(
  mcpUrl: string,
  participantId?: string,
): string {
  return createProfileAlbatrossSetupKit(mcpUrl, participantId);
}
