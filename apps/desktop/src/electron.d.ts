declare module "electron" {
  export interface BrowserWindow {
    loadFile(path: string): Promise<void>;
    show(): void;
    hide(): void;
    isDestroyed(): boolean;
    on(event: string, listener: (...args: never[]) => void): this;
    webContents: {
      on(event: string, listener: (...args: never[]) => void): this;
      send(channel: string, ...args: readonly unknown[]): void;
      setWindowOpenHandler(
        handler: (details: { url: string }) => { action: "deny" },
      ): void;
    };
  }

  export interface IpcMain {
    handle(
      channel: string,
      listener: (
        event: IpcMainInvokeEvent,
        ...args: readonly unknown[]
      ) => unknown,
    ): void;
    on(
      channel: string,
      listener: (event: IpcMainEvent, ...args: readonly unknown[]) => void,
    ): void;
  }

  export interface IpcMainEvent {
    sender: {
      getURL(): string;
    };
  }

  export interface IpcMainInvokeEvent extends IpcMainEvent {
    senderFrame?: {
      url: string;
    };
  }

  export interface Tray {
    setToolTip(tooltip: string): void;
    setContextMenu(menu: unknown): void;
    on(event: string, listener: () => void): this;
    destroy(): void;
  }

  export interface Menu {
    buildFromTemplate(template: readonly unknown[]): unknown;
  }

  export interface Dialog {
    showOpenDialog(options: {
      properties: readonly string[];
      title: string;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
    showMessageBox(options: {
      type: string;
      title: string;
      message: string;
    }): Promise<void>;
  }

  export interface SafeStorage {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?(): string;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  }

  export interface App {
    isReady(): boolean;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: never[]) => void): this;
    quit(): void;
    getPath(name: string): string;
    setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  }

  export interface ContextBridge {
    exposeInMainWorld(key: string, api: unknown): void;
  }

  export interface IpcRenderer {
    invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: readonly unknown[]) => void): this;
    removeListener(
      channel: string,
      listener: (...args: readonly unknown[]) => void,
    ): this;
  }

  export interface NativeImage {
    readonly __nativeImageBrand: unique symbol;
  }

  export const app: App;
  export const BrowserWindow: new (
    options: Record<string, unknown>,
  ) => BrowserWindow;
  export const dialog: Dialog;
  export const ipcMain: IpcMain;
  export const Menu: Menu;
  export const safeStorage: SafeStorage;
  export const Tray: new (image: NativeImage) => Tray;
  export const nativeImage: { createEmpty(): NativeImage };
  export const contextBridge: ContextBridge;
  export const ipcRenderer: IpcRenderer;
}
