import type { DesktopApi, SyncStatus } from "./ipc.js";

declare global {
  interface Window {
    mdevolved: DesktopApi;
  }
}

const statusLabel = document.querySelector<HTMLElement>("[data-status]");
const folderLabel = document.querySelector<HTMLElement>("[data-folder]");
const messageLabel = document.querySelector<HTMLElement>("[data-message]");
const chooseButton = document.querySelector<HTMLButtonElement>(
  "[data-action=choose]",
);
const retryButton = document.querySelector<HTMLButtonElement>(
  "[data-action=retry]",
);
const repairButton = document.querySelector<HTMLButtonElement>(
  "[data-action=repair]",
);
const revokeButton = document.querySelector<HTMLButtonElement>(
  "[data-action=revoke]",
);
const loginToggle = document.querySelector<HTMLInputElement>(
  "[data-action=login]",
);

function render(status: SyncStatus): void {
  if (statusLabel) statusLabel.textContent = status.phase;
  if (folderLabel)
    folderLabel.textContent = status.folderPath ?? "No folder selected";
  if (messageLabel) messageLabel.textContent = status.message ?? "";
  if (retryButton) retryButton.disabled = !status.canRetry;
  if (repairButton) repairButton.disabled = !status.canRepair;
  if (revokeButton) revokeButton.disabled = status.revoked;
}

chooseButton?.addEventListener("click", async () =>
  render(await window.mdevolved.selectFolder()),
);
retryButton?.addEventListener("click", async () =>
  render(await window.mdevolved.retry()),
);
repairButton?.addEventListener("click", async () =>
  render(await window.mdevolved.repair()),
);
revokeButton?.addEventListener("click", async () =>
  render(await window.mdevolved.revoke()),
);
loginToggle?.addEventListener("change", async () => {
  await window.mdevolved.setStartAtLogin(loginToggle.checked);
});
window.mdevolved.onStatusChange(render);
void window.mdevolved.getStatus().then(render);
