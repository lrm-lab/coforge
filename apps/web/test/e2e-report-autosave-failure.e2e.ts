import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedWeeklyReport } from "./helpers/weekly-report-fixture";

/**
 * A weekly report whose save fails says so, and offers to try again only where trying again can
 * help (task #710): the autosave of a member's report and the Save of a format. A refusal that
 * would come again, the report being gone, says so in words and keeps no retry; a dropped
 * connection keeps "Try again". Seeds a draft report per test and removes it after. Screenshots,
 * light, dark and phone, are under `.artifacts/e2e/report-autosave-failure/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/report-autosave-failure");
const GONE = "This report no longer exists, or is no longer yours.";
const KEEP_TEXT = "Your text is still in the editor. Copy it before you leave.";

async function seed(kind: "member" | "template", week: number) {
  const seeded = await seedWeeklyReport(databaseUrl, {
    week,
    kind,
    title: kind === "member" ? "Autosave report" : "Format report",
    content: { body: "What shipped this week." },
  });
  const { browser, evaluate } = browserSession(
    browserPath,
    `report-save-${kind}-${process.pid}-${week}`,
  );
  return {
    ...seeded,
    browser,
    evaluate,
    page: `${origin}${seeded.path}`,
    async cleanup() {
      await browser("close").catch(() => undefined);
      await seeded.remove();
    },
  };
}

const bar = `[...document.querySelectorAll('[role="alert"]')].find((el) => el.textContent.includes("Not saved"))`;
const barText = `[...${bar}.querySelectorAll("p")].map((p) => p.textContent).join(" | ")`;
const toEnd = `(() => {
  const editor = document.querySelector(".ProseMirror");
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor.lastElementChild);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  return true;
})()`;
const editorReady = `${pageHydrated} && document.querySelector(".ProseMirror") != null`;

test("a report that is gone says so, keeps no retry, and tells the text is still in the editor", async () => {
  const t = await seed("member", 1);
  const shots = async (name: string) => {
    await t.browser("screenshot", join(artifacts, `${name}.png`));
    await t.evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await t.browser("wait", "300");
    await t.browser("screenshot", join(artifacts, `${name}-dark.png`));
    await t.evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, device] of [
      ["1440", "900", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      await t.browser("set", "viewport", width, height);
      await t.browser("open", t.page);
      await t.browser("wait", "--fn", editorReady);
      await t.db.weeklyReport.deleteMany({ where: { id: t.report.id } });
      await t.evaluate(toEnd);
      await t.browser("keyboard", "type", " More.");
      await t.browser("wait", "--fn", `${bar} != null`);
      // In words, never the server's code; nothing to ask again, so the way to keep the text.
      expect(await t.evaluate<string>(barText)).toBe(`Not saved · ${GONE} | ${KEEP_TEXT}`);
      expect(await t.evaluate<boolean>(`${bar}.querySelector("button") == null`)).toBe(true);
      await shots(device);
      // Put the report back for the next width.
      await t.db.weeklyReport.create({ data: { ...t.data, id: t.report.id } });
    }
  } finally {
    await t.cleanup();
  }
}, 180_000);

test("a dropped connection keeps Try again, and the retry saves", async () => {
  const t = await seed("member", 3);
  try {
    await mkdir(artifacts, { recursive: true });
    await t.browser("set", "viewport", "1440", "900");
    await t.browser("open", t.page);
    await t.browser("wait", "--fn", editorReady);
    await t.browser("set", "offline", "on");
    await t.evaluate(toEnd);
    await t.browser("keyboard", "type", " More.");
    await t.browser("wait", "--fn", `${bar} != null`);
    // Nothing known about it to say; it may pass next time.
    expect(await t.evaluate<string>(barText)).toBe("Not saved");
    await t.browser("screenshot", join(artifacts, "offline.png"));
    await t.browser("set", "offline", "off");
    await t.browser("eval", `${bar}.querySelector("button").click()`);
    await t.browser("wait", "--fn", `${bar} == null`);
  } finally {
    await t.browser("set", "offline", "off").catch(() => undefined);
    await t.cleanup();
  }
}, 180_000);

test("a report saved from elsewhere first says so, keeps its retry, and the retry saves", async () => {
  const t = await seed("member", 4);
  try {
    await mkdir(artifacts, { recursive: true });
    await t.browser("set", "viewport", "1440", "900");
    await t.browser("open", t.page);
    await t.browser("wait", "--fn", editorReady);
    // Another tab saved first: the row's version moves on under this editor.
    await t.db.weeklyReport.update({
      where: { id: t.report.id },
      data: { content: { body: "Saved from elsewhere." } },
    });
    await t.evaluate(toEnd);
    await t.browser("keyboard", "type", " More.");
    await t.browser("wait", "--fn", `${bar} != null`);
    expect(await t.evaluate<string>(barText)).toBe(
      "Not saved · This report changed somewhere else and was reloaded. Your edits are kept.",
    );
    await t.browser("screenshot", join(artifacts, "conflict.png"));
    // The page reloaded the report, so asking again carries the fresh version and goes through.
    await t.browser("eval", `${bar}.querySelector("button").click()`);
    await t.browser("wait", "--fn", `${bar} == null`);
  } finally {
    await t.cleanup();
  }
}, 180_000);

test("a format whose save is refused says so the same way", async () => {
  const t = await seed("template", 2);
  const save = `[...document.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Save")`;
  try {
    await mkdir(artifacts, { recursive: true });
    await t.browser("set", "viewport", "1440", "900");
    await t.browser("open", t.page);
    await t.browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector("header input") != null`,
    );
    // Renaming the format is an edit the Save button then sends.
    await t.browser("click", "header input");
    await t.browser("keyboard", "type", " renamed");
    await t.browser("wait", "--fn", `${save} != null`);
    await t.db.weeklyReport.deleteMany({ where: { id: t.report.id } });
    await t.browser("eval", `${save}.click()`);
    await t.browser("wait", "--fn", `${bar} != null`);
    expect(await t.evaluate<string>(barText)).toBe(`Not saved · ${GONE} | ${KEEP_TEXT}`);
    expect(await t.evaluate<boolean>(`${bar}.querySelector("button") == null`)).toBe(true);
    await t.browser("screenshot", join(artifacts, "format.png"));
    // The report is back: Save goes through, and the bar goes.
    await t.db.weeklyReport.create({ data: { ...t.data, id: t.report.id } });
    await t.browser("eval", `${save}.click()`);
    await t.browser("wait", "--fn", `${bar} == null`);
  } finally {
    await t.cleanup();
  }
}, 180_000);
