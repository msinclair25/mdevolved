import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import {
  OWD_SYNC_INSTALLER_BASE_PATH,
  OWD_SYNC_INSTALLER_FORMAT,
  OWD_SYNC_PLUGIN_ID,
} from "./src/obsidian-plugin-installer";
import { OWD_SYNC_REQUIRED_VERSION } from "./src/obsidian-plugin-links";

const pluginAssetNames = ["main.js", "manifest.json", "styles.css"] as const;
const releaseDirectory = fileURLToPath(
  new URL("../../packages/obsidian-plugin/release/", import.meta.url),
);

type InstallerFile = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
};

async function loadInstallerFiles(): Promise<InstallerFile[]> {
  const assets = await Promise.all(
    pluginAssetNames.map(async (name) => {
      const bytes = await readFile(`${releaseDirectory}/${name}`);
      return {
        bytes,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  const pluginManifest = JSON.parse(
    assets
      .find((asset) => asset.name === "manifest.json")
      ?.bytes.toString("utf8") ?? "null",
  ) as unknown;
  if (
    typeof pluginManifest !== "object" ||
    pluginManifest === null ||
    !("id" in pluginManifest) ||
    pluginManifest.id !== OWD_SYNC_PLUGIN_ID ||
    !("version" in pluginManifest) ||
    pluginManifest.version !== OWD_SYNC_REQUIRED_VERSION
  ) {
    throw new Error(
      "The packaged OWD Sync manifest does not match the web installer.",
    );
  }

  const manifestBytes = Buffer.from(
    `${JSON.stringify(
      {
        assets: assets.map((asset) => ({
          bytes: asset.bytes.byteLength,
          name: asset.name,
          sha256: asset.sha256,
        })),
        format: OWD_SYNC_INSTALLER_FORMAT,
        pluginId: OWD_SYNC_PLUGIN_ID,
        version: OWD_SYNC_REQUIRED_VERSION,
      },
      null,
      2,
    )}\n`,
  );

  return [
    ...assets.map((asset) => ({
      bytes: asset.bytes,
      contentType:
        asset.name === "manifest.json"
          ? "application/json; charset=utf-8"
          : asset.name === "styles.css"
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
      fileName: `${OWD_SYNC_INSTALLER_BASE_PATH.slice(1)}/${asset.name}`,
    })),
    {
      bytes: manifestBytes,
      contentType: "application/json; charset=utf-8",
      fileName: `${OWD_SYNC_INSTALLER_BASE_PATH.slice(1)}/installer-manifest.json`,
    },
  ];
}

function owdSyncInstallerAssets(): Plugin {
  const files = loadInstallerFiles();
  return {
    name: "owd-sync-installer-assets",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(
          request.url ?? "/",
          "http://owd.local",
        ).pathname.slice(1);
        void files
          .then((installerFiles) => {
            const file = installerFiles.find(
              (candidate) => candidate.fileName === path,
            );
            if (file === undefined) {
              next();
              return;
            }
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", file.contentType);
            response.end(file.bytes);
          })
          .catch(next);
      });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(
          request.url ?? "/",
          "http://owd.local",
        ).pathname.slice(1);
        void files
          .then((installerFiles) => {
            const file = installerFiles.find(
              (candidate) => candidate.fileName === path,
            );
            if (file === undefined) {
              next();
              return;
            }
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", file.contentType);
            response.end(file.bytes);
          })
          .catch(next);
      });
    },
    async generateBundle() {
      for (const file of await files) {
        this.emitFile({
          fileName: file.fileName,
          source: file.bytes,
          type: "asset",
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), owdSyncInstallerAssets()],
  build: {
    sourcemap: false,
  },
});
