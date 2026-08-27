import { type App, Modal } from "obsidian";
import type { OwdPairingConsent } from "./pairing-contract";

export function promptForOwdPairingLink(
  app: App,
  vaultName: string,
  submit: (link: string) => void,
): void {
  new OwdPairingLinkModal(app, vaultName, submit).open();
}

class OwdPairingLinkModal extends Modal {
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly submit: (link: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Pair this selected vault" });
    contentEl.createEl("p", {
      text: `Only the currently open vault “${this.vaultName}” can be paired from this window.`,
    });
    contentEl.createEl("p", {
      cls: "mod-muted",
      text: "Copy a short-lived pairing link from your MDevolved dashboard and paste it below. The link cannot open or select another vault.",
    });

    const input = contentEl.createEl("textarea", {
      cls: "owd-pairing-link-input",
      attr: {
        "aria-label": "MDevolved pairing link",
        autocomplete: "off",
        placeholder: "mdevolved://connect?deployment=…&grant=…",
        rows: "4",
        spellcheck: "false",
      },
    });
    const error = contentEl.createEl("p", {
      cls: "owd-pairing-input-error",
      attr: { role: "alert" },
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());
    buttons
      .createEl("button", { cls: "mod-cta", text: "Review pairing" })
      .addEventListener("click", () => {
        const link = input.value.trim();
        if (link.length === 0) {
          error.setText("Paste the short-lived pairing link first.");
          input.focus();
          return;
        }

        this.close();
        this.submit(link);
      });

    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function confirmOwdPairing(
  app: App,
  consent: OwdPairingConsent,
): Promise<boolean> {
  return new Promise((resolve) => {
    new OwdPairingModal(app, consent, resolve).open();
  });
}

class OwdPairingModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly consent: OwdPairingConsent,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Pair this vault with MDevolved?" });
    contentEl.createEl("p", {
      text: `MDevolved Sync will connect “${this.consent.vaultName}” to ${this.consent.deploymentHost}.`,
    });

    const disclosure = contentEl.createEl("ul", {
      cls: "owd-pairing-disclosure",
    });
    disclosure.createEl("li", {
      text: "Reads and synchronizes eligible Markdown notes in this vault.",
    });
    disclosure.createEl("li", {
      text: "Can synchronize eligible attachments only when your server enables attachment sync.",
    });
    disclosure.createEl("li", {
      text: "Excludes the .obsidian configuration folder and does not read other plugins’ settings, tokens, or credentials.",
    });
    contentEl.createEl("p", {
      cls: "mod-muted",
      text: "The short-lived link is exchanged once. The resulting vault credential is stored only in this plugin’s private settings and sent to your deployment over HTTPS (or localhost HTTP during development). Legacy owd-pair links are accepted for compatibility, but never copy an existing installation’s authority.",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.finish(false));
    buttons
      .createEl("button", { cls: "mod-cta", text: "Pair and start sync" })
      .addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(confirmed);
    this.close();
  }
}
