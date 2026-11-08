import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { type OwnedProcessTree } from "@lrm/coforge-anvil";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { captureDaemonLogs } from "./fixtures/log-capture";

// A code agent's process records must say which Agent and which launch they belong to, or a
// stall repair cannot be reconstructed from the log afterwards (task #698).

const AGENT_ID = "6c1a9d54-18e2-4b0f-9a77-4d0b0f2ef4a1";
const LAUNCH_ID = "e2f0c4d6-7a31-4c58-9b6e-5a1d2c3b4e5f";

/** One process that answers a single request and then exits. */
function answeringTree(): OwnedProcessTree {
  return {
    child: {
      pid: 4242,
      exited: Promise.resolve(0),
      exitCode: 0,
      stdin: { write: () => true, end: () => undefined, flush: async () => undefined },
      stdout: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('{"id":"coforge-1","result":"pong"}\n');
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
}

/** Every code_agent record one process writes, given its environment. */
async function codeAgentRecords(environment: Record<string, string>) {
  const { records } = await captureDaemonLogs(async () => {
    const process = new JsonlProcess(["unused"], tmpdir(), environment, {
      spawn: () => answeringTree(),
    });
    const exited = Promise.withResolvers<void>();
    process.onClose(() => exited.resolve());
    try {
      expect(await process.request({ method: "ping" })).toMatchObject({ result: "pong" });
      await exited.promise;
    } finally {
      await process.dispose();
    }
  });
  return records.filter((record) => String(record.properties.event).startsWith("code_agent."));
}

test("a launch's code agent process records carry its agent and launch", async () => {
  const records = await codeAgentRecords({
    COFORGE_CURRENT_AGENT_ID: AGENT_ID,
    COFORGE_AGENT_LAUNCH_ID: LAUNCH_ID,
  });
  // The whole life of the process, not only its start.
  const events = records.map((record) => record.properties.event);
  expect(events).toContain("code_agent.process.started");
  expect(events).toContain("code_agent.request.sent");
  expect(events).toContain("code_agent.response.received");
  expect(events).toContain("code_agent.process.exited");
  for (const record of records) {
    expect(record.properties).toMatchObject({ agent_id: AGENT_ID, launch_id: LAUNCH_ID });
  }
});

test("a process launched without an Agent identity records none", async () => {
  const records = await codeAgentRecords({});
  expect(records.map((record) => record.properties.event)).toContain("code_agent.process.started");
  for (const record of records) {
    expect(record.properties).not.toHaveProperty("agent_id");
    expect(record.properties).not.toHaveProperty("launch_id");
  }
});
