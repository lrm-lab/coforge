import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Guards message row hover background layer radius and colors (#189).
 *
 * 消息区 message row
 * hover的背景层，色值为“E0E5F1”，透明度为50%，有圆角，圆角为8
 *
 * In accordance with AGENTS.md design tokens and rem units:
 * - 8px radius is represented by Tailwind's `rounded-lg` (--radius-lg: 0.5rem = 8px).
 * - #E0E5F1 at 50% opacity is represented by `hover:bg-border-secondary/50`
 *   and `focus-within:bg-border-secondary/50` (--color-border-secondary: #e0e5f1 in light mode).
 */
const REPO_ROOT = join(import.meta.dir, "..");
const MESSAGE_ROW = join(REPO_ROOT, "src/features/conversations/message-row.tsx");

test("message row hover background layer has 8px border radius (rounded-lg) and border-secondary/50", async () => {
  const source = await readFile(MESSAGE_ROW, "utf8");
  const rowMatch = source.match(
    /data-message=\{own \? "own" : "other"\}[\s\S]*?className=\{cn\(([\s\S]*?)\)\}/,
  );
  expect(rowMatch).toBeDefined();
  const classes = rowMatch![1];
  expect(classes).toContain("rounded-lg");
  expect(classes).toContain("hover:bg-border-secondary/50");
  expect(classes).toContain("focus-within:bg-border-secondary/50");
});
