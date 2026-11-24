import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

function launchResumedCodex() {
  return new CodexProvider({
    host: fixtureCodexHost,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server-scenarios.ts", import.meta.url).pathname,
      "scenario=resume-usage-baseline",
    ],
  }).createAgentSession({
    agentWorkspaceDirectory: tmpdir(),
    instructions: "Fixture",
    sessionId: "thread-1",
  });
}

test("CodexProvider preserves the cumulative baseline emitted during thread/resume", async () => {
  const session = await launchResumedCodex();
  const events: AgentRuntimeEvent[] = [];
  const finished = Promise.withResolvers<void>();
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "completed") finished.resolve();
  });
  try {
    await session.sendMessage("resume-usage-delta");
    await finished.promise;
    expect(events.filter((event) => event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE)).toEqual([
      {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: {
          uncachedInputTokens: 600,
          cacheReadTokens: 2_400,
          cacheWriteTokens: 0,
          outputTokens: 600,
        },
      },
    ]);
  } finally {
    await session.dispose();
  }
});

test("CodexProvider tracks both last readings after a cross-turn counter reset", async () => {
  const session = await launchResumedCodex();
  const events: AgentRuntimeEvent[] = [];
  try {
    for (const input of ["resume-usage-reset", "resume-usage-after-reset"]) {
      const finished = Promise.withResolvers<void>();
      const unsubscribe = session.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") finished.resolve();
      });
      try {
        await session.sendMessage(input);
        await finished.promise;
      } finally {
        unsubscribe();
      }
    }
    expect(
      events.flatMap((event) =>
        event.type === AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE
          ? [[event.usage.uncachedInputTokens, event.usage.outputTokens]]
          : [],
      ),
    ).toEqual([
      [100, 10],
      [100, 10],
      [100, 10],
    ]);
  } finally {
    await session.dispose();
  }
});
