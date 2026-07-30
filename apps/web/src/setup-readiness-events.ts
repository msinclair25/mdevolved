export const SETUP_READINESS_REFRESH_EVENT = "owd:refresh-setup-readiness";

export function requestSetupReadinessRefresh(): void {
  window.dispatchEvent(new Event(SETUP_READINESS_REFRESH_EVENT));
}
