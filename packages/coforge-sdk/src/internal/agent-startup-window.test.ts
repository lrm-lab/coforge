import { describe, expect, test } from "bun:test";
import {
  AGENT_STARTUP_TIMEOUT_MS,
  RUNTIME_PROVIDER,
  SLOW_STARTUP_TIMEOUT_MS,
  startupDeadlineMs,
  startupTimeoutMs,
} from "./index";

describe("startup window", () => {
  test("slow providers get ten minutes and every other runtime two", () => {
    expect(startupTimeoutMs(RUNTIME_PROVIDER.OPENCODE)).toBe(SLOW_STARTUP_TIMEOUT_MS);
    expect(startupTimeoutMs(RUNTIME_PROVIDER.GROK)).toBe(SLOW_STARTUP_TIMEOUT_MS);
    expect(startupTimeoutMs(RUNTIME_PROVIDER.ANTIGRAVITY)).toBe(SLOW_STARTUP_TIMEOUT_MS);
    expect(startupTimeoutMs(RUNTIME_PROVIDER.PI)).toBe(AGENT_STARTUP_TIMEOUT_MS);
  });

  test("the deadline covers two startup windows plus a minute", () => {
    expect(startupDeadlineMs(RUNTIME_PROVIDER.PI)).toBe(300_000);
    expect(startupDeadlineMs(RUNTIME_PROVIDER.OPENCODE)).toBe(1_260_000);
  });
});
