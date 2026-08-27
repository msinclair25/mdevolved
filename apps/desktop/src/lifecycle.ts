export type WindowCloseAction = "hide" | "quit";

export function windowCloseAction(quitting: boolean): WindowCloseAction {
  return quitting ? "quit" : "hide";
}

export function shouldStartAtLogin(enabled: boolean): boolean {
  return enabled;
}

export function isSupportedDesktopPairingLink(value: string): boolean {
  return ["mdevolved://connect?", "owd-pair://connect?"].some((prefix) =>
    value.startsWith(prefix),
  );
}
