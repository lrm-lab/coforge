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

/** A child that answers its first request with `notifications` updates and then `result`, all in
 * one chunk that only becomes readable after its exit has been observed. */
export function exitingTree(notifications: number, result: object): OwnedProcessTree {
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
