import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RecoveryKeyCard,
  type PendingRecoveryKey,
} from "../src/RecoveryKeyCard";

function render(options: {
  configured: boolean;
  pending?: PendingRecoveryKey | null;
  sessionVerifiedFilename?: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(RecoveryKeyCard, {
      configured: options.configured,
      disabled: false,
      fingerprint: "a".repeat(64),
      onActivate: () => undefined,
      onCancel: () => undefined,
      onChooseFile: () => undefined,
      onCreate: () => undefined,
      onDownload: () => undefined,
      pending: options.pending ?? null,
      sessionVerifiedFilename: options.sessionVerifiedFilename ?? null,
    }),
  );
}

describe("recovery key setup card", () => {
  it("explains the backup and key relationship before setup", () => {
    const html = render({ configured: false });

    expect(html).toContain("Create the key to your backups");
    expect(html).toContain("Encrypted backup");
    expect(html).toContain("Recovery key");
    expect(html).toContain("Restorable Source");
    expect(html).toContain("cannot recreate");
  });

  it("uses a normal browser download and requires reopening it before activation", () => {
    const readyToDownload = render({
      configured: true,
      pending: {
        byteLength: 217,
        downloadHref: "blob:owd-recovery-key",
        downloadRequested: false,
        filename: "owd-recovery-key-2026-07-23T01-02-03Z.txt",
        verifiedFilename: null,
      },
    });
    const downloaded = render({
      configured: true,
      pending: {
        byteLength: 217,
        downloadHref: "blob:owd-recovery-key",
        downloadRequested: true,
        filename: "owd-recovery-key-2026-07-23T01-02-03Z.txt",
        verifiedFilename: null,
      },
    });

    expect(readyToDownload).toContain("Download recovery key");
    expect(readyToDownload).toContain('href="blob:owd-recovery-key"');
    expect(readyToDownload).toContain(
      'download="owd-recovery-key-2026-07-23T01-02-03Z.txt"',
    );
    expect(readyToDownload).toContain(
      "does not call the native save-location API",
    );
    expect(downloaded).toContain("Confirm the downloaded key");
    expect(downloaded).toContain("217 bytes");
    expect(downloaded).toContain("Choose recovery key file");
    expect(downloaded).toContain("Existing backups do not change");
    expect(downloaded).toContain("Finish setup");
    expect(downloaded).toContain("disabled");
  });

  it("enables setup only after the downloaded file is verified", () => {
    const html = render({
      configured: true,
      pending: {
        byteLength: 217,
        downloadHref: "blob:owd-recovery-key",
        downloadRequested: true,
        filename: "owd-recovery-key-2026-07-23T01-02-03Z.txt",
        verifiedFilename: "owd-recovery-key-2026-07-23T01-02-03Z.txt",
      },
    });

    expect(html).toContain(
      "Verified: owd-recovery-key-2026-07-23T01-02-03Z.txt",
    );
    expect(html).toContain(
      '<button class="primary-action" type="button">Finish setup</button>',
    );
  });

  it("uses the standard file input for downloaded-key selection", () => {
    const html = render({ configured: true });

    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".txt,text/plain"');
    expect(html).toContain("Standard saved recovery key file picker");
  });

  it("shows missing-key guidance before another backup", () => {
    const html = render({ configured: true });

    expect(html).toContain("Confirm you still have your recovery key");
    expect(html).toContain("I can’t find my recovery key");
    expect(html).toContain("will not unlock older ones");
  });

  it("makes successful session verification unmistakable", () => {
    const html = render({
      configured: true,
      sessionVerifiedFilename: "owd-recovery-key-test.txt",
    });

    expect(html).toContain("Recovery key ready");
    expect(html).toContain("Ready for backup");
    expect(html).toContain("Change the recovery key");
    expect(html).not.toContain("Choose recovery key file");
  });
});
