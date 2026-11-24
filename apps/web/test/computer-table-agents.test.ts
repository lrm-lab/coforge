import { expect, test } from "bun:test";
import { computerTableVisibleAgentCount } from "#src/features/computers/computer-table-agents";

test("normal computer table shows up to 3 agent avatars and folds extras into +N", () => {
  expect(computerTableVisibleAgentCount(0, false)).toBe(0);
  expect(computerTableVisibleAgentCount(1, false)).toBe(1);
  expect(computerTableVisibleAgentCount(2, false)).toBe(2);
  expect(computerTableVisibleAgentCount(3, false)).toBe(3);
  expect(computerTableVisibleAgentCount(4, false)).toBe(3);
  expect(computerTableVisibleAgentCount(13, false)).toBe(3);
  expect(computerTableVisibleAgentCount(103, false)).toBe(3);
});

test("compact computer table keeps 3 avatars without overflow and folds into +N on overflow", () => {
  expect(computerTableVisibleAgentCount(0, true)).toBe(0);
  expect(computerTableVisibleAgentCount(1, true)).toBe(1);
  expect(computerTableVisibleAgentCount(2, true)).toBe(2);
  expect(computerTableVisibleAgentCount(3, true)).toBe(3);
  expect(computerTableVisibleAgentCount(4, true)).toBe(2);
  expect(computerTableVisibleAgentCount(13, true)).toBe(2);
  expect(computerTableVisibleAgentCount(102, true)).toBe(2);
  expect(computerTableVisibleAgentCount(1002, true)).toBe(1);
});
