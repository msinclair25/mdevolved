import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

export async function captureMd10Proof(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  if (
    process.env.MD10_CAPTURE !== "1" ||
    testInfo.project.name !== "chrome-desktop"
  ) {
    return;
  }
  const directory = resolve("apps/marketing/public/demo");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: resolve(directory, `${name}.png`),
  });
}
