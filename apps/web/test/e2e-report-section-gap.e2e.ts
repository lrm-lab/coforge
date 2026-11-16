import { expect, test } from "bun:test";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";
import { seedWeeklyReport } from "./helpers/weekly-report-fixture";

/**
 * The room under an empty weekly report section (task #106) is drawn, not written: clicking
 * into it and leaving without typing saves nothing, and typing there saves what was typed.
 * Seeds a draft report and removes it after.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const TEMPLATE = "## Work Summary\n\n## Next Steps";

test("clicking into an empty section and leaving saves nothing; typing there saves", async () => {
  const { db, report, path, remove } = await seedWeeklyReport(databaseUrl, {
    week: 7,
    title: "Section gap report",
    content: { markdown: TEMPLATE },
  });
  const { browser, evaluate } = browserSession(browserPath, `report-gap-${process.pid}`);
  // Leaving the editor saves the report as it stands (into its page form, `tabs`): the text is
  // what must not change.
  const saved = async () => {
    const { content } = await db.weeklyReport.findUniqueOrThrow({ where: { id: report.id } });
    const { markdown, tabs } = content as {
      markdown?: string;
      tabs?: Record<string, { markdown: string }>;
    };
    return tabs ? Object.values(tabs).map((page) => page.markdown) : [markdown];
  };
  const gaps = `document.querySelectorAll(".ProseMirror .section-gap").length`;
  // What follows the first heading: the drawn room ("DIV") or a paragraph to write in ("P").
  const underFirst = `document.querySelector(".ProseMirror h2").nextElementSibling?.tagName`;
  // The room is a widget that takes the click on mousedown, as a pointer would.
  const pressGap = (index: number) =>
    evaluate(`(() => {
      const room = document.querySelectorAll(".ProseMirror .section-gap")[${index}];
      room.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    })()`);
  try {
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${path}`);
    await browser("wait", "--fn", `${pageHydrated} && ${gaps} === 2`);

    await pressGap(0);
    await browser("wait", "--fn", `${underFirst} === "P"`);
    expect(await evaluate<boolean>(`document.activeElement?.closest(".ProseMirror") != null`)).toBe(
      true,
    );
    // Leave without typing: the room comes back and nothing is saved.
    await evaluate(`document.activeElement.blur() ?? true`);
    await browser("wait", "--fn", `${underFirst} === "DIV"`);
    // Past the editor's 150 ms debounce and the autosave after it.
    await browser("wait", "1500");
    expect(await saved()).toEqual([TEMPLATE]);
    expect(await evaluate<string>(`document.body.innerText`)).not.toContain("Not saved");

    // Typing there is writing, and it is saved under its heading.
    await pressGap(0);
    await browser("wait", "--fn", `${underFirst} === "P"`);
    await browser("keyboard", "type", "Shipped the gap");
    await browser("wait", "--fn", `!document.body.innerText.includes("Saving")`);
    await browser("wait", "1500");
    expect(await saved()).toEqual(["## Work Summary\n\nShipped the gap\n\n## Next Steps"]);
  } finally {
    await browser("close").catch(() => undefined);
    await remove();
  }
}, 120_000);
