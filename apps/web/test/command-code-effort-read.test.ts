import { expect, test } from "bun:test";
import { encodeDaemonRuntimeCommandCodeEffortReadResponse } from "@lrm/coforge-sdk/internal";
import { createDaemonRuntimeCommandCodeEffortReadResultMethod } from "#src/server/centrifugo/command-code-effort-result.server";
import { CommandCodeEffortRead } from "#src/server/computers/command-code-effort-read.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };

function waiter(options: {
  read: () => Promise<
    | {
        protocolMajor: number;
        requestId: string;
        workspaceId: string;
        computerId: string;
        accepted: boolean;
        status: string;
        efforts: string[];
      }
    | undefined
  >;
  now: () => number;
  wait: () => Promise<void>;
  publish?: () => Promise<void>;
  begin?: () => Promise<void>;
}) {
  const marks: string[] = [];
  const reader = new CommandCodeEffortRead(
    {
      publish: async () => {
        marks.push("publish");
        await options.publish?.();
      },
      results: {
        begin: async (pending) => {
          expect(pending.revision).toBe("");
          marks.push("begin");
          await options.begin?.();
        },
        read: async (requestId) => {
          const result = await options.read();
          return result ? { ...result, requestId } : undefined;
        },
        clear: async () => {
          marks.push("clear");
        },
      },
    },
    { now: options.now, wait: options.wait, timeoutMs: 1_000 },
  );
  return { reader, marks };
}

test("a ready Command Code effort read drops default and keeps the other values", async () => {
  let now = 0;
  const { reader, marks } = waiter({
    now: () => now,
    wait: async () => {
      now += 100;
    },
    read: async () => ({
      protocolMajor: 1,
      requestId: "filled-by-waiter",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      accepted: true,
      status: "ready",
      efforts: ["default", "", "off", "high", "max"],
    }),
  });
  expect(await reader.execute(viewer, "computer-1", "native-model")).toEqual({
    status: "ready",
    efforts: ["off", "high", "max"],
  });
  expect(marks).toEqual(["begin", "publish", "clear"]);
});

test("a failed Command Code effort read stays failed instead of becoming an empty list", async () => {
  let now = 0;
  const { reader } = waiter({
    now: () => now,
    wait: async () => {
      now += 100;
    },
    read: async () => ({
      protocolMajor: 1,
      requestId: "filled-by-waiter",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      accepted: false,
      status: "failed",
      efforts: ["high"],
    }),
  });
  expect(await reader.execute(viewer, "computer-1", "native-model")).toEqual({ status: "failed" });
});

test("an invisible Command Code runtime does not publish an effort read", async () => {
  const marks: string[] = [];
  const unauthorized = new CommandCodeEffortRead(
    {
      publish: async () => {
        marks.push("publish");
      },
      authorize: async () => false,
      results: {
        begin: async () => {
          marks.push("begin");
        },
        read: async () => undefined,
        clear: async () => {
          marks.push("clear");
        },
      },
    },
    { now: () => 0, wait: async () => {}, timeoutMs: 1_000 },
  );
  expect(await unauthorized.execute(viewer, "computer-1", "native-model")).toEqual({
    status: "failed",
  });
  expect(marks).toEqual([]);
});

test("a Command Code effort read that does not answer in time is failed and still cleared", async () => {
  let now = 0;
  const { reader, marks } = waiter({
    now: () => now,
    wait: async () => {
      now += 1_000;
    },
    read: async () => undefined,
    publish: async () => {
      throw new Error("publish failed once");
    },
  });
  expect(await reader.execute(viewer, "computer-1", "native-model")).toEqual({ status: "failed" });
  expect(marks).toEqual(["begin", "publish", "clear"]);
  const timedOut = waiter({
    now: () => now,
    wait: async () => {
      now += 1_000;
    },
    read: async () => undefined,
  });
  expect(await timedOut.reader.execute(viewer, "computer-1", "native-model")).toEqual({
    status: "failed",
  });
  expect(timedOut.marks).toEqual(["begin", "publish", "clear"]);
});

test("the effort result RPC stores this Computer's reply and refuses another Computer", async () => {
  const accepted: unknown[] = [];
  const method = createDaemonRuntimeCommandCodeEffortReadResultMethod({
    accept: async (response) => {
      accepted.push(response.status);
    },
  });
  const payload = encodeDaemonRuntimeCommandCodeEffortReadResponse({
    protocolMajor: 1,
    requestId: "effort-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    accepted: true,
    status: "ready",
    efforts: ["off", "high", "max"],
  });
  const metadata = {
    principal: { userId: "computer-user", workspaceId: "workspace-1", computerId: "computer-1" },
  };
  expect(await method(payload, metadata)).toEqual(new Uint8Array());
  expect(accepted).toEqual(["ready"]);
  expect(
    await method(payload, {
      principal: { userId: "computer-user", workspaceId: "workspace-1", computerId: "other" },
    }),
  ).toEqual({ code: 403, message: "daemon runtime identity is not authorized" });
  expect(accepted).toEqual(["ready"]);
});
