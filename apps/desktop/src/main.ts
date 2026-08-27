import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray,
} from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  IPC_CHANNELS,
  assertBooleanArg,
  assertTrustedSender,
  selectedFolder,
  type SyncController,
  type SyncStatus,
} from "./ipc.js";
import { ProtectedCredentialCustody } from "./custody.js";
import { FolderSyncController } from "./controller.js";
import { windowCloseAction } from "./lifecycle.js";

const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
const rendererFile = join(moduleDirectory, "index.html");

function registerEvent(
  target: object,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  const on = Reflect.get(target, "on");
  if (typeof on !== "function") throw new Error("event_target_invalid");
  Reflect.apply(on, target, [event, listener]);
}

export interface DesktopMainOptions {
  controller?: SyncController;
  expectedRendererUrl?: string;
  platform?: string;
}

export interface DesktopMainHandle {
  controller: SyncController;
  getCredentialCustody(): ProtectedCredentialCustody | undefined;
}

export function createDesktopMain(
  options: DesktopMainOptions = {},
): DesktopMainHandle {
  let custody: ProtectedCredentialCustody | undefined;
  const controller =
    options.controller ?? new FolderSyncController(() => custody);
  const expectedRendererUrl =
    options.expectedRendererUrl ?? pathToFileURL(rendererFile).href;
  const platform = options.platform ?? process.platform;
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let custodyUnavailable = false;
  let quitting = false;
  let startAtLogin = false;

  const senderCheck = (event: {
    sender: { getURL(): string };
    senderFrame?: { url: string } | null;
  }): void => {
    assertTrustedSender(event.sender.getURL(), expectedRendererUrl);
    if (event.senderFrame !== undefined && event.senderFrame !== null) {
      assertTrustedSender(event.senderFrame.url, expectedRendererUrl);
    }
  };

  const publish = (status: SyncStatus): SyncStatus => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.statusChanged, status);
    }
    if (tray) tray.setToolTip(`MDevolved Sync: ${status.phase}`);
    return status;
  };

  const acceptPairingLink = async (value: string): Promise<void> => {
    if (!value.startsWith("mdevolved://connect?")) return;
    try {
      if (!controller.pair) throw new Error("pairing_unavailable");
      publish(await controller.pair(value));
    } catch {
      publish({
        ...controller.getStatus(),
        phase: "error",
        message:
          "Pairing failed. Create a fresh private request and try again.",
        canRetry: false,
      });
    }
  };

  registerEvent(app, "open-url", (...args: unknown[]) => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const url = args[1] as string | undefined;
    event?.preventDefault?.();
    if (url) void acceptPairingLink(url);
  });
  registerEvent(app, "second-instance", (...args: unknown[]) => {
    const argv = args[1] as string[] | undefined;
    const url = argv?.find((value) => value.startsWith("mdevolved://connect?"));
    if (url) void acceptPairingLink(url);
  });

  ipcMain.handle(IPC_CHANNELS.getStatus, (event) => {
    senderCheck(event);
    return controller.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.selectFolder, async (event) => {
    senderCheck(event);
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Choose a Markdown folder",
    });
    const folder = selectedFolder(result);
    if (!folder) return controller.getStatus();
    if (!custody) {
      return publish({
        ...controller.getStatus(),
        phase: "error",
        message:
          "Protected credential storage is unavailable. Reconnect is disabled on this device.",
        canRetry: false,
        canRepair: false,
      });
    }
    return publish(await controller.selectFolder(folder));
  });
  ipcMain.handle(IPC_CHANNELS.retry, async (event) => {
    senderCheck(event);
    return publish(await controller.retry());
  });
  ipcMain.handle(IPC_CHANNELS.repair, async (event) => {
    senderCheck(event);
    return publish(await controller.repair());
  });
  ipcMain.handle(IPC_CHANNELS.revoke, async (event) => {
    senderCheck(event);
    const status = await controller.revoke();
    await custody?.revoke();
    return publish(status);
  });
  ipcMain.handle(IPC_CHANNELS.setStartAtLogin, (event, value) => {
    senderCheck(event);
    startAtLogin = assertBooleanArg(value);
    app.setLoginItemSettings({ openAtLogin: startAtLogin });
    return { enabled: startAtLogin };
  });

  const openWindow = async (): Promise<void> => {
    if (window && !window.isDestroyed()) {
      window.show();
      return;
    }
    window = new BrowserWindow({
      width: 760,
      height: 720,
      webPreferences: {
        preload: join(moduleDirectory, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    registerEvent(window.webContents, "will-navigate", (...args: unknown[]) => {
      const event = args[0] as
        { preventDefault?: () => void; url?: string } | undefined;
      event?.preventDefault?.();
      if (event?.url === expectedRendererUrl) return;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url !== expectedRendererUrl) return { action: "deny" };
      return { action: "deny" };
    });
    await window.loadFile(rendererFile);
    registerEvent(window, "close", (...args: unknown[]) => {
      const event = args[0] as { preventDefault?: () => void } | undefined;
      if (windowCloseAction(quitting) === "hide") {
        event?.preventDefault?.();
        window?.hide();
      }
    });
  };

  app.on("before-quit", () => {
    quitting = true;
    tray?.destroy();
  });

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { controller, getCredentialCustody: () => custody };
  }

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("mdevolved");
    try {
      custody = ProtectedCredentialCustody.create(
        safeStorage,
        join(app.getPath("userData"), "credential.bin"),
        platform,
      );
    } catch {
      custodyUnavailable = true;
    }
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip("MDevolved Sync");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open", click: () => void openWindow() },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => void openWindow());
    controller.onStatusChange?.(publish);
    await openWindow();
    if (custodyUnavailable) {
      publish({
        ...controller.getStatus(),
        phase: "error",
        message:
          "Protected credential storage is unavailable. Reconnect is disabled on this device.",
        canRetry: false,
        canRepair: false,
      });
    } else if (controller.restore) {
      publish(await controller.restore());
    }
    const startupUrl = process.argv.find((value) =>
      value.startsWith("mdevolved://connect?"),
    );
    if (startupUrl) await acceptPairingLink(startupUrl);
  });

  return { controller, getCredentialCustody: () => custody };
}

if (process.env.NODE_ENV !== "test") createDesktopMain();
