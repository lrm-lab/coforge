import { expect, test } from "bun:test";
import {
  MEMORY_AGENT_TOOL_PROFILES,
  isMemoryAgentToolProfile,
  toolsForMemoryFence,
  workspaceProfileToToolFence,
} from "./memory-tool-fences";
import { OPENVIKING_TOOL_NAMES, OPENVIKING_TOOL_PROFILE } from "./openviking-memory";

test("keeps the Agent tool fence distinct from Workspace Memory Profile persistence", () => {
  expect(MEMORY_AGENT_TOOL_PROFILES).toEqual(["openviking-memory"]);
  expect(OPENVIKING_TOOL_PROFILE).not.toBe("openviking");
  expect(workspaceProfileToToolFence("openviking")).toBe(OPENVIKING_TOOL_PROFILE);
  expect(workspaceProfileToToolFence("off")).toBeUndefined();
  expect(isMemoryAgentToolProfile(OPENVIKING_TOOL_PROFILE)).toBe(true);
  expect(isMemoryAgentToolProfile("openviking")).toBe(false);
  expect(isMemoryAgentToolProfile("all-tools")).toBe(false);
});

test("exposes Fork and AIG retrieval, Offer, and diagnosis on the memory fence", () => {
  expect(toolsForMemoryFence(OPENVIKING_TOOL_PROFILE)).toEqual([
    OPENVIKING_TOOL_NAMES.forkFind,
    OPENVIKING_TOOL_NAMES.expand,
    OPENVIKING_TOOL_NAMES.offer,
    OPENVIKING_TOOL_NAMES.diagnose,
  ]);
  expect(
    toolsForMemoryFence(OPENVIKING_TOOL_PROFILE).some((name) => name.startsWith("causal_")),
  ).toBe(false);
});

test("Memory Agent discovery exposes Fork and AIG traversal", () => {
  expect(toolsForMemoryFence("openviking-memory")).toContain("ov_fork_find");
  expect(toolsForMemoryFence("openviking-memory")).toContain("ov_expand");
  expect(toolsForMemoryFence("openviking-memory")).not.toContain("ov_find");
  expect(toolsForMemoryFence("openviking-memory")).not.toContain("ov_search_context");
  expect(toolsForMemoryFence("openviking-memory")).not.toContain("ov_read");
  expect(toolsForMemoryFence("openviking-memory")).toContain("memory_diagnose");
});
