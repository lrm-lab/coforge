import { expect, test } from "bun:test";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { ownerAgentLanguage, ownerAgentName } from "#src/server/agents/owner-agent-name.server";
import {
  WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME,
  ensureWeeklyReportAssistant,
  weeklyReportAssistantDisplayName,
} from "#src/server/records/weekly-report-assistant.server";

/** A lone surrogate does not survive a round trip through UTF-8. */
const wholeCharacters = (text: string) =>
  new TextDecoder().decode(new TextEncoder().encode(text)) === text;

test("an owner's Agent name keeps the whole person label when it fits", () => {
  expect(ownerAgentName("李健", "的助手")).toBe("李健的助手");
  expect(ownerAgentName("Frank", "'s Assistant")).toBe("Frank's Assistant");
});

test("a long person label is cut by character to leave room for the suffix, never mid-pair", () => {
  for (const suffix of ["的周报助手", "'s Weekly Report Assistant"]) {
    // 😀 and 𠮷 are one character in two UTF-16 units each.
    for (const person of ["😀".repeat(100), "𠮷".repeat(100), `a${"😀".repeat(100)}`]) {
      const name = ownerAgentName(person, suffix);
      expect(wholeCharacters(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(AGENT_DISPLAY_NAME_MAX_LENGTH);
      expect(name.endsWith(suffix)).toBe(true);
      expect(name.length).toBeGreaterThan(AGENT_DISPLAY_NAME_MAX_LENGTH - 2);
    }
  }
  const bmp = ownerAgentName("名".repeat(80), "的助手");
  expect([...bmp].length).toBe(AGENT_DISPLAY_NAME_MAX_LENGTH);
});

test("a cut never leaves a space before the suffix", () => {
  const person = `${"a".repeat(AGENT_DISPLAY_NAME_MAX_LENGTH - "的周报助手".length - 1)} b`;
  expect(ownerAgentName(person, "的周报助手")).toBe(`${person.slice(0, -2)}的周报助手`);
});

test("the owner's saved language wins, then the request's, then Chinese", () => {
  expect(ownerAgentLanguage("en", "zh-CN")).toBe("en");
  expect(ownerAgentLanguage("zh-CN", "en")).toBe("zh-CN");
  expect(ownerAgentLanguage(null, "en")).toBe("en");
  expect(ownerAgentLanguage(undefined, undefined)).toBe("zh-CN");
  expect(ownerAgentLanguage("fr", undefined)).toBe("zh-CN");
});

test("the weekly-report assistant is named in the owner's language", () => {
  expect(weeklyReportAssistantDisplayName("李健")).toBe("李健的周报助手");
  expect(weeklyReportAssistantDisplayName("  Ada  ", "zh-CN")).toBe("Ada的周报助手");
  expect(weeklyReportAssistantDisplayName("Ada", "en")).toBe("Ada's Weekly Report Assistant");
  expect(weeklyReportAssistantDisplayName("  ", "en")).toBe(WEEKLY_REPORT_ASSISTANT_DISPLAY_NAME);
});

test("a long weekly-report assistant name is cut by character in both languages", () => {
  for (const language of ["zh-CN", "en"] as const) {
    const name = weeklyReportAssistantDisplayName("😀".repeat(100), language);
    expect(wholeCharacters(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(AGENT_DISPLAY_NAME_MAX_LENGTH);
  }
});

test("a new weekly-report assistant is created named in its owner's saved language", async () => {
  const created: string[] = [];
  const owner = { username: "ada", displayName: "Ada", preferences: { language: "en" } };
  const tx = {
    user: { findUnique: async () => owner },
    weeklyReportAssistant: { findUnique: async () => null, create: async () => ({ id: "link" }) },
    agent: {
      findUnique: async () => null,
      create: async ({ data }: { data: { displayName: string } }) => {
        created.push(data.displayName);
        return { id: "agent" };
      },
    },
  };
  const db = { $transaction: async (run: (tx: unknown) => unknown) => run(tx) };
  await ensureWeeklyReportAssistant(db as never, { workspaceId: "w", userId: "u" });
  owner.preferences.language = "zh-CN";
  await ensureWeeklyReportAssistant(db as never, { workspaceId: "w", userId: "u" });
  expect(created).toEqual(["Ada's Weekly Report Assistant", "Ada的周报助手"]);
});
