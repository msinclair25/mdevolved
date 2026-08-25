import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DesktopApi, assertStatus } from "./ipc.js";

const api: DesktopApi = {
  selectFolder: async () =>
    assertStatus(await ipcRenderer.invoke(IPC_CHANNELS.selectFolder)),
  getStatus: async () =>
    assertStatus(await ipcRenderer.invoke(IPC_CHANNELS.getStatus)),
  retry: async () => assertStatus(await ipcRenderer.invoke(IPC_CHANNELS.retry)),
  repair: async () =>
    assertStatus(await ipcRenderer.invoke(IPC_CHANNELS.repair)),
  revoke: async () =>
    assertStatus(await ipcRenderer.invoke(IPC_CHANNELS.revoke)),
  setStartAtLogin: async (enabled) => {
    const result = await ipcRenderer.invoke(
      IPC_CHANNELS.setStartAtLogin,
      enabled,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as { enabled?: unknown }).enabled !== "boolean"
    ) {
      throw new Error("invalid start-at-login response");
    }
    return result as { enabled: boolean };
  },
  onStatusChange: (listener) => {
    const wrapped = (...args: readonly unknown[]) =>
      listener(assertStatus(args[0]));
    ipcRenderer.on(IPC_CHANNELS.statusChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.statusChanged, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("mdevolved", api);
