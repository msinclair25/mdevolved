import { expect, test } from "@playwright/test";

const marketingUrl = `http://127.0.0.1:${process.env.MD10_MARKETING_PORT ?? "4174"}`;

test("keeps the lovable demo and six-action path usable", async ({ page }) => {
  await page.goto(marketingUrl);

  const quickstart = page.locator("[data-md10-quickstart]");
  await expect(quickstart.locator(":scope > li")).toHaveCount(6);
  await expect(quickstart).not.toContainText(/MCP|receipt|migration|Obsidian/u);

  const demo = page.locator("[data-demo]");
  const frames = demo.locator("[data-demo-frame]");
  await expect(frames).toHaveCount(5);
  await expect(demo.locator("[data-demo-frame]:visible")).toHaveCount(1);

  const resume = demo.getByRole("button", { name: "Resume" });
  await resume.focus();
  await page.keyboard.press("Enter");
  await expect(resume).toHaveAttribute("aria-current");
  await expect(frames.nth(4)).toBeVisible();
  await expect(
    demo.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();

  await demo.getByRole("button", { name: "Replay" }).click();
  await expect(frames.first()).toBeVisible();
  await expect(
    demo.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://mdevolved.com/og-mdevolved.png",
  );
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("shows every caption without autoplay for reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(marketingUrl);

  const demo = page.locator("[data-demo]");
  await expect(demo).toHaveAttribute("data-reduced-motion");
  await expect(demo.locator("[data-demo-frame]")).toHaveCount(5);
  for (const frame of await demo.locator("[data-demo-frame]").all()) {
    await expect(frame).toBeVisible();
  }
  await expect(demo.locator(".demo-controls")).toBeHidden();
});

test("keeps the complete demo available without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(marketingUrl);

  const demo = page.locator("[data-demo]");
  for (const frame of await demo.locator("[data-demo-frame]").all()) {
    await expect(frame).toBeVisible();
  }
  await expect(demo.locator(".demo-controls")).toBeHidden();
  await context.close();
});
