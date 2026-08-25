export type WindowCloseAction = "hide" | "quit";

export function windowCloseAction(quitting: boolean): WindowCloseAction {
  return quitting ? "quit" : "hide";
}

export function shouldStartAtLogin(enabled: boolean): boolean {
  return enabled;
}
