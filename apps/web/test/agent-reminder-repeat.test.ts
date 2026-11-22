import { afterEach, expect, test } from "bun:test";
import { formatRecurrence } from "#src/features/agents/agent-reminder-repeat";
import { m } from "#src/paraglide/messages";
import { overwriteGetLocale } from "#src/paraglide/runtime";

afterEach(() => overwriteGetLocale(() => "en"));

const read = (rule: string): string => formatRecurrence(rule);

test("a repeat rule reads as a sentence in English and Chinese", () => {
  const cases = ["every:1m", "every:15m", "every:1h", "every:4h", "every:1d", "every:3d"];
  overwriteGetLocale(() => "en");
  expect(cases.map(read)).toEqual([
    "Every minute",
    "Every 15 minutes",
    "Every hour",
    "Every 4 hours",
    "Every day",
    "Every 3 days",
  ]);
  expect(read("daily@09:30")).toBe("Daily at 09:30");
  expect(read("weekly:mon,wed@09:00")).toBe("Weekly on Mon, Wed at 09:00");
  overwriteGetLocale(() => "zh-CN");
  expect(cases.map(read)).toEqual([
    "每分钟",
    "每 15 分钟",
    "每小时",
    "每 4 小时",
    "每天",
    "每 3 天",
  ]);
  expect(read("daily@09:30")).toBe("每天 09:30");
  expect(read("weekly:mon,wed@09:00")).toBe("每周一、周三 09:00");
});

test("standard 5-field cron expressions localize in English and Chinese", () => {
  overwriteGetLocale(() => "en");
  expect(read("* * * * *")).toBe("Every minute");
  expect(read("*/15 * * * *")).toBe("Every 15 minutes");
  expect(read("0 * * * *")).toBe("Every hour");
  expect(read("0 */3 * * *")).toBe("Every 3 hours");
  expect(read("30 * * * *")).toBe("Hourly at :30");
  expect(read("15 */3 * * *")).toBe("Every 3 hours at :15");
  expect(read("5 9 * * *")).toBe("Daily at 09:05");
  expect(read("0 9 */2 * *")).toBe("Every 2 days at 09:00");
  expect(read("0 9 * * 1-5")).toBe("Weekly on Mon, Tue, Wed, Thu, Fri at 09:00");
  expect(read("30 18 * * 0,3")).toBe("Weekly on Sun, Wed at 18:30");
  expect(read("0 9 15 * *")).toBe("Monthly on day 15 at 09:00");
  expect(read("60 9 * * *")).toBe("Repeats: 60 9 * * *");

  overwriteGetLocale(() => "zh-CN");
  expect(read("* * * * *")).toBe("每分钟");
  expect(read("*/15 * * * *")).toBe("每 15 分钟");
  expect(read("0 * * * *")).toBe("每小时");
  expect(read("0 */3 * * *")).toBe("每 3 小时");
  expect(read("30 * * * *")).toBe("每小时 :30");
  expect(read("15 */3 * * *")).toBe("每 3 小时 :15");
  expect(read("5 9 * * *")).toBe("每天 09:05");
  expect(read("0 9 */2 * *")).toBe("每 2 天 09:00");
  expect(read("0 9 * * 1-5")).toBe("每周一、周二、周三、周四、周五 09:00");
  expect(read("30 18 * * 0,3")).toBe("每周日、周三 18:30");
  expect(read("0 9 15 * *")).toBe("每月 15 日 09:00");
  expect(read("60 9 * * *")).toBe("重复：60 9 * * *");
});

test("count = 1 plural forms in agents, computer, and agent-form messages", () => {
  overwriteGetLocale(() => "en");
  expect<string>(m.member_created_agents_count({ count: 1 })).toBe("1 Agent created");
  expect<string>(m.member_created_agents_count({ count: 2 })).toBe("2 Agents created");
  expect<string>(m.agent_wake_block_stopped({ count: 1 })).toContain("1 message is waiting");
  expect<string>(m.agent_wake_block_stopped({ count: 3 })).toContain("3 messages are waiting");
  expect<string>(m.agent_wake_block_start_failed({ count: 1 })).toContain("1 message is waiting");
  expect<string>(m.agent_wake_block_in_flight({ count: 1 })).toContain("1 message is waiting");
  expect<string>(m.computer_agent_workspace_stats({ size: "4 KB", files: 1 })).toBe("4 KB, 1 file");
  expect<string>(m.computer_agent_workspace_stats({ size: "4 KB", files: 1284 })).toBe(
    "4 KB, 1,284 files",
  );
  expect<string>(m.computer_agent_workspaces_deleted_summary({ count: 1 })).toContain(
    "1 archived Agent workspace found",
  );
  expect<string>(m.agent_form_model_refresh_latest({ count: 1 })).toBe("Up to date: 1 model.");
  expect<string>(m.agent_form_model_refresh_latest_pi({ count: 1 })).toContain(
    "Up to date: 1 model.",
  );
});
