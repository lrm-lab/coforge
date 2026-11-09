import { expect, test } from "bun:test";
import {
  encodeDaemonRuntimeCommandCodeEffortReadResponse,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
} from "@lrm/coforge-sdk/internal";
import { createDaemonRuntimeCommandCodeEffortReadResultMethod } from "#src/server/centrifugo/command-code-effort-result.server";
import { CommandCodeEffortRead } from "#src/server/computers/command-code-effort-read.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const input = { computerId: "computer-1", modelId: "native-model" };

type Answer = Partial<DaemonRuntimeCommandCodeEffortReadResponse>;

/** A use case over a results store the test fills the way the Computer's result RPC would. */
function useCase(
  options: { allowed?: boolean; publishFails?: boolean; beginFails?: boolean } = {},
) {
  const marks: string[] = [];
  const published: DaemonRuntimeCommandCodeEffortReadRequest[] = [];
  // What the Computer has answered so far, by request id.
  const answers = new Map<string, DaemonRuntimeCommandCodeEffortReadResponse>();
  const reader = new CommandCodeEffortRead({
    authorize: async () => {
      marks.push("authorize");
      return options.allowed ?? true;
    },
    results: {
      begin: async (pending) => {
        expect(pending.revision).toBe("");
        marks.push("begin");
        if (options.beginFails) throw new Error("redis is down");
      },
      read: async (requestId) => {
        marks.push("read");
        return answers.get(requestId);
      },
    },
    publish: async (request) => {
      marks.push("publish");
      if (options.publishFails) throw new Error("centrifugo is down");
      published.push(request);
    },
  });
  /** The Computer answers the request that was published last. */
  const answer = (value: Answer = {}) => {
    const request = published.at(-1)!;
    answers.set(request.requestId, {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      accepted: true,
      status: "ready",
      efforts: ["off", "high"],
      ...value,
    });
  };
  /** Starts a read and returns where its answer is read. */
  const start = async () => {
    const started = await reader.start(viewer, input);
    if (started.status !== "started") throw new Error("not started");
    return { computerId: input.computerId, requestId: started.requestId };
  };
  return { reader, marks, published, answer, start };
}

test("starting publishes one read for the model and returns its request id without waiting", async () => {
  const { reader, marks, published } = useCase();
  const started = await reader.start(viewer, input);
  expect(started).toEqual({ status: "started", requestId: published[0]!.requestId });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    modelId: "native-model",
  });
  // The request stays pending for the Computer's answer: starting never reads, clears or waits.
  expect(marks).toEqual(["authorize", "begin", "publish"]);
});

test("a read before the Computer answers is pending and authorizes nobody", async () => {
  const { reader, marks, start } = useCase();
  const scope = await start();
  marks.length = 0;
  expect(await reader.read(viewer, scope)).toEqual({ status: "pending" });
  expect(marks).toEqual(["read"]);
});

test("a ready answer drops default and keeps the other values, and can be read again", async () => {
  const { reader, answer, start } = useCase();
  const scope = await start();
  answer({ efforts: ["default", "", "off", "high", "max"] });
  const ready = { status: "ready" as const, efforts: ["off", "high", "max"] };
  expect(await reader.read(viewer, scope)).toEqual(ready);
  // A poll whose reply was lost on the way back asks again.
  expect(await reader.read(viewer, scope)).toEqual(ready);
});

test("a failed answer stays failed instead of becoming an empty list", async () => {
  const { reader, answer, start } = useCase();
  const scope = await start();
  answer({ accepted: false, status: "failed", efforts: ["high"] });
  expect(await reader.read(viewer, scope)).toEqual({ status: "failed" });
});

test("an invisible Command Code runtime does not publish an effort read", async () => {
  const { reader, marks } = useCase({ allowed: false });
  expect(await reader.start(viewer, input)).toEqual({ status: "failed" });
  expect(marks).toEqual(["authorize"]);
});

test("a store that cannot record the request, or a publish that fails, is a failed start", async () => {
  const noStore = useCase({ beginFails: true });
  expect(await noStore.reader.start(viewer, input)).toEqual({ status: "failed" });
  expect(noStore.marks).toEqual(["authorize", "begin"]);
  const noPublish = useCase({ publishFails: true });
  expect(await noPublish.reader.start(viewer, input)).toEqual({ status: "failed" });
  expect(noPublish.marks).toEqual(["authorize", "begin", "publish"]);
});

test("a request id reaches nothing outside the caller's Workspace and Computer", async () => {
  const { reader, answer, start } = useCase();
  const { requestId } = await start();
  answer();
  expect(await reader.read(viewer, { computerId: "computer-2", requestId })).toEqual({
    status: "pending",
  });
  expect(
    await reader.read(
      { userId: "user-2", workspaceId: "workspace-2" },
      { computerId: "computer-1", requestId },
    ),
  ).toEqual({ status: "pending" });
});

test("an answer is returned only to who may still select the runtime", async () => {
  const options = { allowed: true };
  const { reader, marks, answer, start } = useCase(options);
  const scope = await start();
  answer();
  marks.length = 0;
  options.allowed = false;
  expect(await reader.read(viewer, scope)).toEqual({ status: "failed" });
  expect(marks).toEqual(["read", "authorize"]);
});

test("the effort result RPC stores this Computer's reply and refuses another Computer", async () => {
  const accepted: unknown[] = [];
  const method = createDaemonRuntimeCommandCodeEffortReadResultMethod({
    accept: async (response) => {
      accepted.push(response.status);
      return true;
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
