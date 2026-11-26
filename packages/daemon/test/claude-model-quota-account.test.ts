import { expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  connection,
  run,
  START,
  until,
  useWakeRecycleEnvironment,
} from "./fixtures/wake-recycle-harness";

useWakeRecycleEnvironment();

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const provider = RUNTIME_PROVIDER.CLAUDE_CODE;

function fableLimit() {
  return {
    type: "error",
    message: "Rate limit reached",
    providerLimit: {
      kind: "window_limit",
      resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      modelWindow: { model: "fable", window: "weekly" },
    },
  } as const;
}

test("a known account's Fable rejection holds only a live peer using that account and model", async () => {
  await run(
    {
      claudeQuotaAccountDigests: {
        "agent-a": ACCOUNT_A,
        "same-fable": ACCOUNT_A,
        "same-sonnet": ACCOUNT_A,
        "other-fable": ACCOUNT_B,
      },
    },
    async (h) => {
      const agents = [
        ["agent-a", "fable"],
        ["same-fable", "fable"],
        ["same-sonnet", "sonnet"],
        ["other-fable", "fable"],
        ["unknown-fable", "fable"],
      ] as const;
      for (const [agentId, model] of agents) {
        await h.runtime.handleAgentStart(
          h.intent({
            agentId,
            model,
            requestId: `start-${agentId}`,
            launchId: `launch-${agentId}`,
          }),
        );
      }
      const before = h.sessions.map((session) => session.inputs.length);
      h.sessions[0]!.emit(fableLimit());
      for (const [index, [agentId]] of agents.entries()) await h.deliver(index + 1, agentId);

      const inputDelta = h.sessions.map((session, index) => session.inputs.length - before[index]!);
      expect(inputDelta).toEqual([0, 0, 1, 1, 1]);
    },
  );
});

test("the same known account and model keeps its wait after a Claude relaunch", async () => {
  await run({ claudeQuotaAccountDigests: { "agent-a": ACCOUNT_A } }, async (h) => {
    await h.runtime.handleAgentStart(
      h.intent({ requestId: "start-first", controlEpoch: 1, launchId: "first", model: "fable" }),
    );
    h.sessions[0]!.emit(fableLimit());
    await h.runtime.handleAgentConfig({
      protocolMajor: 1,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      provider,
      model: "fable",
      modelProvider: "anthropic",
      reasoning: "high",
      revision: 2,
    });
    await until(() => h.sessions[0]!.disposed);
    await h.runtime.handleAgentStart(
      h.intent({ requestId: "start-second", controlEpoch: 2, launchId: "second", model: "fable" }),
    );
    await h.deliver(1);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]!.inputs).toHaveLength(0);
  });
});

test("a restarted Daemon rebinds the quota before accepting model input and releases deferred inputs once", async () => {
  const options = {
    stateDirectory: join(connection.workspaceRoot, "model-quota-restart"),
    claudeQuotaAccountDigests: { "agent-a": ACCOUNT_A },
  };
  const { result: limit } = await run(options, async (h) => {
    await h.runtime.handleAgentStart(h.intent({ model: "fable" }));
    const limit = fableLimit();
    h.sessions[0]!.emit(limit);
    return limit;
  });

  await run({ ...options, claudeQuotaAccountDigests: { "agent-a": ACCOUNT_B } }, async (h) => {
    await h.runtime.handleAgentStart(h.intent({ model: "fable" }));
    const before = h.sessions[0]!.inputs.length;
    await h.deliver(1);
    expect(h.sessions[0]!.inputs).toHaveLength(before + 1);
  });

  await run(options, async (h) => {
    await h.runtime.handleAgentStart(
      h.intent({
        model: "fable",
        resumePrompt: "resume after the quota reset",
        unreadSummary: { "#recovery": 1 },
        unreadConversationIds: { "#recovery": "recovery-conversation" },
      }),
    );
    await h.deliver(1);
    const session = h.sessions[0]!;
    expect(session.inputs).toHaveLength(0);
    expect(h.acks).toEqual(["delivery-1"]);

    const available = {
      type: "model-window-available",
      ...limit.providerLimit,
      occurredAt: START.toISOString(),
    } as const;
    session.emit(available);
    expect(session.inputs).toHaveLength(0);

    setSystemTime(START.getTime() + 10);
    const fresh = { ...available, occurredAt: new Date().toISOString() };
    session.emit(fresh);
    await until(() => session.inputs.includes("resume after the quota reset"));
    session.emit(fresh);
    expect(session.inputs.filter((input) => input === "resume after the quota reset")).toHaveLength(
      1,
    );
    expect(session.inputs.filter((input) => input.includes("#recovery"))).toHaveLength(1);
    expect(h.acks).toEqual(["delivery-1"]);
  });
});
