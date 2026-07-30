import { Notice } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { VaultSyncSettings } from "../vendor/yaos-src/settings";
import { SetupLinkController } from "../vendor/yaos-src/runtime/setupLinkController";

vi.mock("obsidian", () => ({
  Modal: class {},
  Notice: vi.fn(),
}));

describe("OWD connection application", () => {
  it("does not ask for a second vault-ID confirmation after exchange", async () => {
    const settings = {
      host: "",
      token: "",
      vaultId: "generated-local-id",
    } as VaultSyncSettings;
    const refreshServerCapabilities = vi.fn(async () => undefined);
    const initSync = vi.fn(async () => undefined);
    const restartSync = vi.fn(async () => undefined);
    const updateSettings = vi.fn(
      async (mutator: (value: VaultSyncSettings) => void) => mutator(settings),
    );
    const controller = new SetupLinkController({
      app: {
        vault: {
          getMarkdownFiles: () =>
            Array.from({ length: 20 }, () => ({ path: "note.md" })),
        },
      } as never,
      getSettings: () => settings,
      hasSyncRuntime: () => false,
      initSync,
      isMarkdownPathSyncable: () => true,
      refreshServerCapabilities,
      restartSync,
      updateSettings,
    });

    await controller.applyOwdConnection({
      host: "https://owd.example",
      token: "credential_12345678901234567890",
      vaultId: "946009ef-ad0e-43e4-bd7e-3552d559a9ab",
    });

    expect(settings).toMatchObject({
      host: "https://owd.example",
      token: "credential_12345678901234567890",
      vaultId: "946009ef-ad0e-43e4-bd7e-3552d559a9ab",
    });
    expect(updateSettings).toHaveBeenCalledOnce();
    expect(refreshServerCapabilities).toHaveBeenCalledOnce();
    expect(initSync).toHaveBeenCalledOnce();
    expect(restartSync).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      "Server linked. Starting sync...",
      6000,
    );
  });

  it("restarts an existing sync runtime after re-pairing", async () => {
    const settings = {
      host: "https://old.example",
      token: "old_credential",
      vaultId: "revoked-vault-id",
    } as VaultSyncSettings;
    const refreshServerCapabilities = vi.fn(async () => undefined);
    const initSync = vi.fn(async () => undefined);
    const restartSync = vi.fn(async () => undefined);
    const updateSettings = vi.fn(
      async (mutator: (value: VaultSyncSettings) => void) => mutator(settings),
    );
    const controller = new SetupLinkController({
      app: {
        vault: { getMarkdownFiles: () => [] },
      } as never,
      getSettings: () => settings,
      hasSyncRuntime: () => true,
      initSync,
      isMarkdownPathSyncable: () => true,
      refreshServerCapabilities,
      restartSync,
      updateSettings,
    });

    await controller.applyOwdConnection({
      host: "https://owd.example/",
      token: "replacement_credential",
      vaultId: "replacement-vault-id",
    });

    expect(settings).toMatchObject({
      host: "https://owd.example",
      token: "replacement_credential",
      vaultId: "replacement-vault-id",
    });
    expect(refreshServerCapabilities).toHaveBeenCalledOnce();
    expect(restartSync).toHaveBeenCalledOnce();
    expect(initSync).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith(
      "Server linked. Reconnecting sync...",
      6000,
    );
  });
});
