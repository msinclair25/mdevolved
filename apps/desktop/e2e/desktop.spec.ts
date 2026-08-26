import { _electron as electron, expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packageDirectory = join(
  desktopDirectory,
  "release",
  `MDevolved Sync-${process.platform}-${process.arch}`,
);
const executablePath =
  process.platform === "darwin"
    ? join(
        packageDirectory,
        "MDevolved Sync.app",
        "Contents",
        "MacOS",
        "mdevolved-sync",
      )
    : join(
        packageDirectory,
        process.platform === "win32" ? "mdevolved-sync.exe" : "mdevolved-sync",
      );

for (const width of [760, 360]) {
  test(`opens the packaged desktop shell accessibly at ${width}px`, async () => {
    const application = await electron.launch({
      executablePath,
      cwd: desktopDirectory,
      env: { ...process.env, NODE_ENV: "production" },
    });

    try {
      const window = await application.firstWindow();
      await window.setViewportSize({ height: 720, width });

      await expect(window).toHaveTitle("MDevolved Sync");
      await expect(
        window.getByRole("heading", {
          name: "Keep your project memory close.",
        }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: "Choose Markdown folder" }),
      ).toBeEnabled();
      await expect(
        window.getByText("No folder selected", { exact: true }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: "Retry" }),
      ).toBeDisabled();
      await expect(
        window.getByRole("button", { name: "Repair" }),
      ).toBeDisabled();
      await expect(
        window.getByRole("button", { name: "Disconnect" }),
      ).toBeDisabled();
      await expect(
        window.getByRole("checkbox", { name: "Start MDevolved when I log in" }),
      ).toBeVisible();
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const api = (window as Window & { mdevolved?: unknown }).mdevolved;
            if (typeof api !== "object" || api === null) return undefined;
            return (api as { getStatus: () => Promise<{ phase: string }> })
              .getStatus()
              .then((status) => status.phase);
          }),
        )
        .toBe("unconfigured");

      const overflow = await window.evaluate(() => ({
        body: document.body.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    } finally {
      await application.close();
    }
  });
}
