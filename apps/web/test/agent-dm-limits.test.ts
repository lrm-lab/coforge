import { describe, expect, test } from "bun:test";
import {
  AGENT_DM_LIMITS,
  agentDmChainLength,
} from "#src/server/conversations/agent-dm-limits.server";

const now = new Date("2026-10-24T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("agentDmChainLength", () => {
  test("counts messages back until a gap of the quiet window", () => {
    expect(agentDmChainLength([minutesAgo(1), minutesAgo(3), minutesAgo(8)], now)).toBe(3);
    // 10 minutes of silence ends the chain: the message before it is a different conversation.
    expect(agentDmChainLength([minutesAgo(1), minutesAgo(12), minutesAgo(13)], now)).toBe(1);
  });

  test("is zero when the newest message is already older than the quiet window", () => {
    expect(agentDmChainLength([minutesAgo(10)], now)).toBe(0);
    expect(agentDmChainLength([], now)).toBe(0);
  });

  test("the three limits are in one place", () => {
    expect(AGENT_DM_LIMITS).toEqual({
      chainMessages: 20,
      quietMs: 10 * 60_000,
      senderPerHour: 60,
    });
  });
});
