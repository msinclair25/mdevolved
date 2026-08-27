import { Notice, arrayBufferToBase64, requestUrl } from "obsidian";
import VaultCrdtSyncPlugin from "../vendor/yaos-src/main";
import {
  OwdPairingError,
  pairOwdVault,
  parseObsidianPairingProtocol,
  parseOwdPairingLink,
  sourceRootFingerprintSha256,
  type OwdConnection,
} from "./pairing-contract";
import { confirmOwdPairing, promptForOwdPairingLink } from "./pairing-modal";
import { parseObsidianMindRuntimeProfile } from "./vault-runtime-profile";
import { createObsidianSourceAdapter } from "./obsidian-adapter";
import type {
  SourceAdapterBoundary,
  SourceAdapterOptions,
} from "../vendor/yaos-src/runtime/sourceAdapterPort";

export default class OwdSyncPlugin extends VaultCrdtSyncPlugin {
  private upstreamLoad: Promise<void> = Promise.resolve();
  private confirmationTail: Promise<void> = Promise.resolve();

  protected override createSourceAdapter(
    options: SourceAdapterOptions,
  ): SourceAdapterBoundary {
    return createObsidianSourceAdapter({ app: this.app, ...options });
  }

  protected override async validateSourceContinuity(): Promise<boolean> {
    const expected = this.settings.sourceRootFingerprintSha256.trim();
    if (expected === "") return true;
    const actual = await sourceRootFingerprintSha256(
      this.app.vault.adapter.getResourcePath("").trim(),
    );
    if (actual === expected) return true;
    new Notice(
      "MDevolved Sync for Obsidian is paused because this device's approved vault root changed. Pair this vault again to resume safely.",
      10000,
    );
    return false;
  }

  override async onload(): Promise<void> {
    this.addCommand({
      id: "pair-this-vault",
      name: "Pair this vault with MDevolved",
      callback: () => this.startOwdPairing(),
    });

    this.registerObsidianProtocolHandler("mdevolved-pair", (params) => {
      void this.handleOwdPairing(() => parseObsidianPairingProtocol(params));
    });
    this.registerObsidianProtocolHandler("owd-pair", (params) => {
      void this.handleOwdPairing(() => parseObsidianPairingProtocol(params));
    });

    this.upstreamLoad = super.onload();
    await this.upstreamLoad;
    if (
      this.settings.host.trim() !== "" &&
      this.settings.token.trim() !== "" &&
      this.settings.vaultId.trim() !== ""
    ) {
      void this.confirmCurrentSync(false);
    }
  }

  override startOwdPairing(): void {
    const vaultName = this.app.vault.getName();
    promptForOwdPairingLink(this.app, vaultName, (link) => {
      void this.handleOwdPairing(() => parseOwdPairingLink(link));
    });
  }

  private async handleOwdPairing(
    readPairing: () => ReturnType<typeof parseOwdPairingLink>,
  ): Promise<void> {
    try {
      await this.upstreamLoad;
      const outcome = await pairOwdVault(
        readPairing(),
        this.app.vault.getName(),
        this.app.vault.adapter.getResourcePath(""),
        this.manifest.version,
        {
          applyConnection: (connection) => this.applyConnection(connection),
          confirm: (consent) => confirmOwdPairing(this.app, consent),
          request: async (request) => {
            const response = await requestUrl({ ...request, throw: false });
            return { json: response.json, status: response.status };
          },
        },
      );

      if (outcome === "cancelled") {
        new Notice(
          "MDevolved pairing cancelled. No connection settings were changed.",
          6000,
        );
      }
    } catch (error: unknown) {
      new Notice(
        error instanceof OwdPairingError
          ? error.message
          : "MDevolved pairing could not be completed. Generate a new link and try again.",
        8000,
      );
    }
  }

  private async applyConnection(connection: OwdConnection): Promise<void> {
    await this.applyOwdConnection({
      host: connection.host,
      token: connection.token,
      vaultId: connection.vaultId,
      ...(connection.deviceId === undefined
        ? {}
        : { sourceDeviceId: connection.deviceId }),
      ...(connection.rootFingerprintSha256 === undefined
        ? {}
        : {
            sourceRootFingerprintSha256: connection.rootFingerprintSha256,
          }),
    });
    await this.confirmCurrentSync(true);
  }

  private confirmCurrentSync(showSuccess: boolean): Promise<void> {
    const scheduled = this.confirmationTail.then(async () => {
      const stateVector = await this.getOwdSyncConfirmationState();
      const runtimeProfile = await this.readRuntimeProfile();
      const stateVectorBase64Url = arrayBufferToBase64(stateVector)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      const response = await requestUrl({
        body: JSON.stringify({
          pluginVersion: this.manifest.version,
          ...(runtimeProfile === null ? {} : { runtimeProfile }),
          schemaVersion: 3,
          stateVector: stateVectorBase64Url,
        }),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.settings.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        throw: false,
        url: `${this.settings.host.replace(/\/$/u, "")}/api/vaults/${encodeURIComponent(this.settings.vaultId)}/sync-confirmation`,
      });
      if (response.status !== 200 && response.status !== 202) {
        const problem =
          typeof response.json === "object" &&
          response.json !== null &&
          typeof Reflect.get(response.json, "error") === "object" &&
          Reflect.get(response.json, "error") !== null
            ? Reflect.get(Reflect.get(response.json, "error"), "message")
            : null;
        throw new OwdPairingError(
          typeof problem === "string"
            ? problem
            : `MDevolved could not confirm the first sync (server status ${response.status}).`,
        );
      }
      if (showSuccess) {
        new Notice(
          "MDevolved Sync for Obsidian connected this vault and started its searchable library.",
          8000,
        );
      }
    });
    this.confirmationTail = scheduled.catch((error: unknown) => {
      if (!showSuccess) {
        new Notice(
          error instanceof Error
            ? `MDevolved Sync for Obsidian: ${error.message}`
            : "MDevolved Sync for Obsidian could not confirm this vault.",
          8000,
        );
      }
    });
    return scheduled;
  }

  private async readRuntimeProfile() {
    try {
      const manifestPath = "vault-manifest.json";
      if (!(await this.app.vault.adapter.exists(manifestPath))) return null;
      return parseObsidianMindRuntimeProfile(
        await this.app.vault.adapter.read(manifestPath),
      );
    } catch {
      return null;
    }
  }
}
