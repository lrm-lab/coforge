import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards message row hover padding, action toolbar appearance, and day divider styling
 * per task #99 design requirements.
 *
 * 1. 鼠标 hover 对话内容，内容区距离 hover 背景层上下左右间距都为 12px (p-3)。
 * 2. hover 对话内容时，右侧出现的操作 icon 去除背景浮层，定位在 top-3 right-3 (各 12px)。
 * 3. 对话中的时间分割线距离上下内容区距离各为 16px (py-4)，分割线色值为 "#E0E5F1"，时间标签带边框。
 * 4. hover 的背景层色值为 "#E0E5F1"，透明度为 50% (hover:bg-[#E0E5F1]/50)。
 */
const REPO_ROOT = join(import.meta.dir, "..");
const MESSAGE_ROW = join(REPO_ROOT, "src/features/conversations/message-row.tsx");

test("message row hover styling: 12px padding on all sides and #E0E5F1 at 50% opacity", async () => {
  const source = await readFile(MESSAGE_ROW, "utf8");

  // Content area has 12px padding (p-3) to hover background layer on all 4 sides
  expect(source).toContain('data-message={own ? "own" : "other"}');
  const rowContainerMatch = source.match(
    /data-message=\{own \? "own" : "other"\}[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/,
  );
  expect(rowContainerMatch).toBeDefined();
  const rowClasses = rowContainerMatch![1];
  expect(rowClasses).toContain("p-3");
  expect(rowClasses).toContain("hover:bg-[#E0E5F1]/50");
  expect(rowClasses).toContain("focus-within:bg-[#E0E5F1]/50");
  expect(rowClasses).not.toContain("hover:bg-secondary");
});

test("action toolbar: floating pill background and shadow are removed, placed at top-3 right-3", async () => {
  const source = await readFile(MESSAGE_ROW, "utf8");

  // Toolbar is positioned 12px from top and right (top-3 right-3)
  expect(source).toContain("top-3 right-3");

  // Floating background pill styles (bg-primary, border, shadow-lg) are removed from the toolbar container
  const toolbarMatch = source.match(/<div\s+className=\{cn\(\s*"([^"]*top-3 right-3[^"]*)"/);
  expect(toolbarMatch).toBeDefined();
  const toolbarClasses = toolbarMatch![1];
  expect(toolbarClasses).not.toContain("bg-primary");
  expect(toolbarClasses).not.toContain("border");
  expect(toolbarClasses).not.toContain("shadow-lg");
});

test("day divider: 16px vertical spacing, #E0E5F1 lines, and bordered date label", async () => {
  const source = await readFile(MESSAGE_ROW, "utf8");

  // Divider spacing is 16px (py-4) and aligned horizontally with px-3
  expect(source).toMatch(/const DIVIDER_ROW_CLASS =\s*"[^"]*px-3[^"]*py-4[^"]*"/);

  // DayDivider uses #E0E5F1 for the divider lines
  expect(source).toContain("bg-[#E0E5F1]");

  // DayDivider time label has a border with #E0E5F1 and rounded pill shape
  expect(source).toMatch(/rounded-full\s+border\s+border-\[#E0E5F1\]/);
});
