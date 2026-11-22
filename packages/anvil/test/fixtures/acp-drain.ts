import type { OwnedProcessTree } from "@lrm/coforge-anvil";

export const modeOptions = [
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

export function exitingTree(
  notifications: number,
  result: object,
  updateAfterResult = false,
): OwnedProcessTree {
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
          const updates = Array(notifications).fill(update);
          const lines = updateAfterResult ? [response, ...updates] : [...updates, response];
          yield new TextEncoder().encode(lines.join("\n") + "\n");
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => undefined,
    },
    terminate: async () => undefined,
    waitForExit: async () => true,
  } satisfies OwnedProcessTree;
}
