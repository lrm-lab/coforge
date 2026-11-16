import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedWeeklyReport } from "./helpers/weekly-report-fixture";

/**
 * An image zoomed from a report being edited answers + and - while the caret is still in the
 * editor behind it, and the keys type nothing into the report. The zoomed frame is under
 * `.amp/e2e/report-image-zoom-keys/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/report-image-zoom-keys");

test("a zoomed image in an edited report zooms by + and - and leaves the text alone", async () => {
  const { path, remove } = await seedWeeklyReport(databaseUrl, {
    week: 9,
    title: "Zoom keys report",
    content: { tabs: { Summary: { markdown: "Before.\n\n![Icon](/apple-touch-icon.png)" } } },
  });
  const { browser, evaluate, waitFor } = browserSession(browserPath, `report-zoom-${process.pid}`);
  const zoomed = `document.querySelector('[role="dialog"] img')`;
  const zoomWidth = `(${zoomed}?.style.width ?? "")`;
  const editorText = `document.querySelector(".ProseMirror").textContent`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${path}`);
    await waitFor(`${pageHydrated} && document.querySelector(".ProseMirror img") !== null`);
    const before = await evaluate<string>(editorText);

    await browser("click", ".ProseMirror p");
    await browser("click", ".ProseMirror img");
    await waitFor(`${zoomed} !== null`);
    expect(await evaluate<boolean>(`document.activeElement.closest(".ProseMirror") !== null`)).toBe(
      true,
    );

    await browser("press", "+");
    await waitFor(`${zoomWidth} !== ""`);
    await browser("screenshot", join(artifacts, "zoomed.png"));
    await browser("press", "-");
    await waitFor(`${zoomWidth} === ""`);
    await browser("press", "Escape");
    await waitFor(`${zoomed} === null`);
    expect(await evaluate<string>(editorText)).toBe(before);
  } finally {
    await browser("close").catch(() => undefined);
    await remove();
  }
}, 180_000);
