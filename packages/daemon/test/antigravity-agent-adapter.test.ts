import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_TREE_EXIT_GRACE_MS, VERSION_PROBE_TIMEOUT_MS } from "@lrm/coforge-anvil";
import { AntigravityAcpProvider } from "@lrm/coforge-anvil/antigravity";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { antigravityAcpRuntimeHost } from "#src/code-agent/antigravity/acp-host";
import { toolStartActivity } from "#src/code-agent/tool-activity";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

const AGY_SESSION_TIMEOUT_MS = 30_000 + VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

async function agyTurnEvents(
  prompt: string | undefined,
  environment: Record<string, string> = {},
): Promise<AgentRuntimeEvent[]> {
  const root = await mkdtemp(join(tmpdir(), "coforge-agy-acp-"));
  try {
    const session = await new AntigravityAcpProvider({
      host: antigravityAcpRuntimeHost,
      command: [process.execPath, anvilRuntimeFixtures.antigravityAcp],
    }).createAgentSession({
      agentWorkspaceDirectory: root,
      instructions: "Standing Antigravity instructions.",
      environment,
    });
    try {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      if (prompt === undefined) return events;
      await session.sendMessage(prompt);
      for (let i = 0; i < 100 && !events.some((e) => e.type === "completed"); i++)
        await Bun.sleep(20);
      return events;
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const toolStart = (events: AgentRuntimeEvent[]) => {
  const start = events.find((e) => e.type === "tool-start");
  if (start?.type !== "tool-start") throw new Error("agy reported no tool start");
  return toolStartActivity(start);
};

test(
  "SSH session variables never reach `agy acp`",
  async () => {
    await expect(
      agyTurnEvents(undefined, {
        SSH_CLIENT: "fixture-client",
        SSH_CONNECTION: "fixture-connection",
        SSH_TTY: "fixture-tty",
      }),
    ).resolves.toEqual([]);
  },
  AGY_SESSION_TIMEOUT_MS,
);

test(
  "agy's run_command of a CoForge send reports the message and the reply it is sending",
  async () => {
    const events = await agyTurnEvents("run:coforge message send --target '#general' --content hi");
    expect(toolStart(events).entries).toEqual([
      expect.objectContaining({ toolName: "send_message", toolInput: "#general" }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "reply-intent", id: "t1", target: "#general" }),
    );
  },
  AGY_SESSION_TIMEOUT_MS,
);

test(
  "agy's run_command reports a running command",
  async () => {
    expect(toolStart(await agyTurnEvents("run:ls -la"))).toMatchObject({
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND,
      entries: [expect.objectContaining({ toolName: "bash", toolInput: "ls -la" })],
    });
  },
  AGY_SESSION_TIMEOUT_MS,
);
