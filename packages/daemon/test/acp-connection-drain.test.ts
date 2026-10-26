import { expect, test } from "bun:test";
import type { OwnedProcessTree } from "@lrm/coforge-anvil";
import { GrokConnection } from "#src/code-agent/grok/connection";
import { KiroConnection } from "#src/code-agent/kiro/connection";
import { ProcessTreeOwner } from "#src/platform/process-tree";

const modeOptions = [
  {
    id: "mode",
    name: "Mode",
    type: "select" as const,
    currentValue: "agent",
    options: [{ value: "agent", name: "Agent" }],
  },
];

const sessionUpdate = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s",
    update: { sessionUpdate: "config_option_update", configOptions: modeOptions },
  },
};

/** A child that answers its first request with `notifications` updates and then `result`, all in
 * one chunk that only becomes readable after its exit has been observed. */
function exitingTree(notifications: number, result: object): OwnedProcessTree {
  const exited = Promise.withResolvers<number>();
  const sent = Promise.withResolvers<{ id: string }>();
  return {
    child: {
      pid: 1,
      exited: exited.promise,
      exitCode: 0,
      stdin: {
        write: (text: string) => {
          sent.resolve(JSON.parse(text));
          exited.resolve(0);
          return true;
        },
        end: () => undefined,
        flush: async () => undefined,
      },
      stdout: {
        async *[Symbol.asyncIterator]() {
          const request = await sent.promise;
          await new Promise((resolve) => setImmediate(resolve));
          const update = JSON.stringify(sessionUpdate);
          const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
          yield new TextEncoder().encode(
            [...Array(notifications).fill(update), response].join("\n") + "\n",
          );
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
}

test.each([0, 10, 100])(
  "Kiro: a response written after %d notifications and just before the process exits is delivered",
  async (notifications) => {
    const spawn = ProcessTreeOwner.prototype.spawn;
    ProcessTreeOwner.prototype.spawn = () =>
      exitingTree(notifications, { configOptions: modeOptions });
    try {
      const connection = new KiroConnection(["unused"], ".", {});
      try {
        const response = await connection.connection.agent.request("session/set_config_option", {
          sessionId: "s",
          configId: "mode",
          value: "agent",
        });
        expect(response.configOptions).toHaveLength(1);
        // Only once everything was handled does the connection report the process as gone.
        await expect(connection.waitForConfig("s", [], "model", 1_000)).rejects.toThrow(
          "process closed before configuration",
        );
      } finally {
        await connection.dispose();
      }
    } finally {
      ProcessTreeOwner.prototype.spawn = spawn;
    }
  },
);

test.each([0, 100])(
  "Grok: a response written after %d notifications and just before the process exits is delivered",
  async (notifications) => {
    const spawn = ProcessTreeOwner.prototype.spawn;
    ProcessTreeOwner.prototype.spawn = () => exitingTree(notifications, {});
    const updates: string[] = [];
    try {
      const connection = new GrokConnection(
        ["unused"],
        ".",
        {},
        (method) => updates.push(method),
        () => ({ outcome: { outcome: "cancelled" } }),
      );
      try {
        await connection.connection.agent.request("authenticate", { methodId: "m" });
        expect(updates).toEqual(Array(notifications).fill("session/update"));
        await connection.connection.closed;
      } finally {
        await connection.dispose();
      }
    } finally {
      ProcessTreeOwner.prototype.spawn = spawn;
    }
  },
);
