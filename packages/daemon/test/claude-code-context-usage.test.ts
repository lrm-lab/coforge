import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_RUNTIME_EVENT_TYPE, type AgentRuntimeEvent } from "#src/code-agent/contract";
import {
  claudeFixtureProvider,
  TEST_AGENT_INSTRUCTIONS,
  waitForEvent,
} from "./fixtures/claude-feed";

// The launched child inherits the Daemon's environment: a shell that exports its own auto-compact
// window would otherwise change every context-window reading below.
const inheritedAutoCompactWindow = Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
beforeEach(() => {
  delete Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
});
afterEach(() => {
  if (inheritedAutoCompactWindow === undefined) delete Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  else Bun.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = inheritedAutoCompactWindow;
});

test("Claude Code reports a context-window reading, selecting the largest model entry when none is configured", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-context-usage-"));

  try {
    const session = await claudeFixtureProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("context-usage");
    await waitForEvent(events, "completed");
    expect(events.find((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE)).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
      usedTokens: 27_908,
      windowTokens: 200_000,
      occurredAt: expect.any(String),
    });

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Claude Code selects the configured model's context window over the largest entry", async () => {
  const agentWorkspaceDirectory = await mkdtemp(
    join(tmpdir(), "coforge-claude-context-usage-model-"),
  );

  try {
    const session = await claudeFixtureProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
      runtime: {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoning: "",
      },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("context-usage");
    await waitForEvent(events, "completed");
    expect(events.find((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE)).toEqual({
      type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
      usedTokens: 27_908,
      windowTokens: 512_000,
      occurredAt: expect.any(String),
    });

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test.each([
  ["1M", 1_000_000],
  ["300k", 300_000],
  ["abc", 1_000_000],
])(
  "Claude Code caps the reported window at the Agent's auto-compact window %p",
  async (value, windowTokens) => {
    const agentWorkspaceDirectory = await mkdtemp(
      join(tmpdir(), "coforge-claude-context-usage-compact-"),
    );

    try {
      const session = await claudeFixtureProvider().createAgentSession({
        agentWorkspaceDirectory,
        instructions: TEST_AGENT_INSTRUCTIONS,
        runtime: {
          provider: "claude-code",
          model: "claude-sonnet-5",
          reasoning: "",
          envVars: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: value },
        },
      });
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));

      await session.sendMessage("context-usage");
      await waitForEvent(events, "completed");
      expect(
        events.find((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE),
      ).toMatchObject({ windowTokens });

      await session.dispose();
    } finally {
      await rm(agentWorkspaceDirectory, { recursive: true, force: true });
    }
  },
);

test("Claude Code emits no context-usage event when no modelUsage entry carries a contextWindow", async () => {
  const agentWorkspaceDirectory = await mkdtemp(
    join(tmpdir(), "coforge-claude-context-usage-absent-"),
  );

  try {
    const session = await claudeFixtureProvider().createAgentSession({
      agentWorkspaceDirectory,
      instructions: TEST_AGENT_INSTRUCTIONS,
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.sendMessage("context-usage-no-window");
    await waitForEvent(events, "completed");
    expect(events.some((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE)).toBe(
      false,
    );

    await session.dispose();
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});
