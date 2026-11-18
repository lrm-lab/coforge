import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedWeeklyReport } from "./helpers/weekly-report-fixture";

/**
 * A weekly report's present mode answers the keyboard wherever focus is: the arrows turn its
 * pages, and Escape leaves it, with focus left on the page behind it and with focus on one of its
 * own buttons (inside its dialog). Seeds a two-page report and removes it after. The last frame
 * is under `.artifacts/e2e/report-present-keys/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/report-present-keys");

test("present mode turns its pages by the arrows and leaves on Escape", async () => {
  const { path, remove } = await seedWeeklyReport(databaseUrl, {
    week: 7,
    title: "Present keys report",
    content: {
      tabs: {
        "Page one": { markdown: "The first page." },
        "Page two": { markdown: "The second page." },
      },
    },
  });
  const { browser, evaluate, waitFor } = browserSession(
    browserPath,
    `report-present-${process.pid}`,
  );
  const presenting = `document.querySelector('[role="dialog"] [aria-label="Exit presentation"]') !== null`;
  const shows = (text: string) =>
    `(document.querySelector('[role="dialog"]')?.textContent ?? "").includes(${JSON.stringify(text)})`;
  const open = async () => {
    await evaluate(`(document.querySelector('[aria-label="Present"]').click(), true)`);
    await waitFor(`${presenting} && ${shows("The first page.")}`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${path}`);
    await waitFor(`${pageHydrated} && document.querySelector('[aria-label="Present"]') !== null`);

    // Focus stays on the page behind the overlay: the arrows turn, Escape leaves.
    await open();
    await browser("press", "ArrowRight");
    await waitFor(shows("The second page."));
    await browser("press", "ArrowLeft");
    await waitFor(shows("The first page."));
    await browser("press", "Escape");
    await waitFor(`!(${presenting})`);

    // Focus on one of its own buttons, inside its dialog: Escape still leaves.
    await open();
    await evaluate(`(document.querySelector('[aria-label="Next page"]').focus(), true)`);
    await browser("press", "ArrowRight");
    await waitFor(shows("The second page."));
    await browser("screenshot", join(artifacts, "second-page.png"));
    await evaluate(`(document.querySelector('[aria-label="Exit presentation"]').focus(), true)`);
    await browser("press", "Escape");
    await waitFor(`!(${presenting})`);
    expect(await evaluate<boolean>(presenting)).toBe(false);
  } finally {
    await browser("close").catch(() => undefined);
    await remove();
  }
}, 180_000);
