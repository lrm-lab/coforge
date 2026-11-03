import { expect, test } from "bun:test";
import type { AgentSessionOptions } from "@coforge/agent";
import type { AcpConnection } from "#src/acp/connection";
import type { AcpTurnReader } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";

const TURN: AcpTurnReader = { read: () => [], end: () => [] };

test("a failed ACP open attaches stderr that arrives only when the process is disposed", async () => {
  let drained = false;
  const failure = new Error("Maximum call stack size exceeded");
  const process = {
    onFailure: () => () => undefined,
    onClose: () => () => undefined,
    stderrExcerpt: () => (drained ? "Usage limit reached" : ""),
  };
  const connection = {
    process,
    initialize: async () => ({ protocolVersion: 1 }),
    dispose: async () => {
      drained = true;
    },
    connection: { agent: { request: async () => ({}), notify: async () => undefined } },
  } as unknown as AcpConnection;
  const session = new AcpSession(
    {
      label: "Command Code",
      openTransport: () => connection,
      openSession: async () => {
        throw failure;
      },
      turn: () => TURN,
    },
    { agentWorkspaceDirectory: "/tmp", instructions: "" } satisfies AgentSessionOptions,
    1_000,
    (work) => work,
  );
  await expect(session.open()).rejects.toBe(failure);
  expect(failure.message).toBe("Maximum call stack size exceeded\nUsage limit reached");
});
