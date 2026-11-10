import { expect, test } from "bun:test";
import type { AgentContextViewRequest, AgentContextViewResult } from "@lrm/coforge-sdk/internal";
import { ComputerAgentContextViews } from "#src/server/computers/computer-agent-context-views.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const input = {
  computerId: "computer-1",
  agentId: "agent-1",
  messageId: "message-1",
  sessionId: "session-1",
  maxBytes: 1024,
};

type Options = {
  enabled?: boolean;
  owned?: boolean;
  online?: boolean;
  supported?: boolean | { supported: boolean; reason?: "no_session" };
  publishFails?: boolean;
  beginFails?: boolean;
  readFails?: boolean;
};

/** A use case over a results store the test fills the way the Computer's result RPC would. */
function useCase(options: Options = {}) {
  const marks: string[] = [];
  const published: AgentContextViewRequest[] = [];
  // What the Computer has answered so far, by request id.
  const answers = new Map<string, AgentContextViewResult>();
  const flags = { enabled: options.enabled ?? true, owned: options.owned ?? true };
  const views = new ComputerAgentContextViews({
    enabled: async () => {
      marks.push("enabled");
      return flags.enabled;
    },
    owned: async () => {
      marks.push("owned");
      return flags.owned;
    },
    online: async () => options.online ?? true,
    supported: async () => options.supported ?? true,
    publish: async (request) => {
      marks.push("publish");
      if (options.publishFails) throw new Error("centrifugo is down");
      published.push(request);
    },
    results: {
      begin: async () => {
        marks.push("begin");
        if (options.beginFails) throw new Error("redis is down");
      },
      read: async (requestId) => {
        marks.push("read");
        if (options.readFails) throw new Error("redis is down");
        return answers.get(requestId);
      },
    },
  });
  /** The Computer answers the request that was published last. */
  const answer = (value: Partial<AgentContextViewResult> = {}) => {
    const request = published.at(-1)!;
    answers.set(request.requestId, {
      protocolMajor: 1,
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      computerId: request.computerId,
      agentId: request.agentId,
      messageId: request.messageId,
      sessionId: request.sessionId,
      maxBytes: request.maxBytes,
      status: "ok",
      createdAtMs: 1,
      content: new TextEncoder().encode("context"),
      encoding: "identity",
      ...value,
    });
  };
  /** Starts a view and returns where its result is read. */
  const start = async () => {
    const started = await views.start(viewer, input);
    if (started.status !== "started") throw new Error("not started");
    return {
      computerId: input.computerId,
      agentId: input.agentId,
      requestId: started.requestId,
    };
  };
  return { views, marks, published, flags, answer, start };
}

test("starting publishes one request and returns its id without waiting", async () => {
  const { views, marks, published } = useCase();
  const started = await views.start(viewer, input);
  expect(started).toEqual({ status: "started", requestId: published[0]!.requestId });
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({ protocolMajor: 1, workspaceId: "workspace-1", ...input });
  // The request stays pending for the Computer's result: starting never reads or waits.
  expect(marks).not.toContain("read");
  expect(marks.slice(-2)).toEqual(["begin", "publish"]);
});

test("a read before the Computer answers is pending and authorizes nobody", async () => {
  const { views, marks, start } = useCase();
  const scope = await start();
  marks.length = 0;
  expect(await views.read(viewer, scope)).toEqual({ status: "pending" });
  expect(marks).toEqual(["read"]);
});

test("a ready result is returned whole and can be read again", async () => {
  const { views, answer, start } = useCase();
  const scope = await start();
  answer();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await views.read(viewer, scope);
    expect(read.status).toBe("ready");
    if (read.status === "ready")
      expect(new TextDecoder().decode(read.result.content)).toBe("context");
  }
});

test("a gzip result is normalized before it reaches the viewer", async () => {
  const { views, answer, start } = useCase();
  const scope = await start();
  answer({ content: new Uint8Array(Bun.gzipSync(Buffer.from("context"))), encoding: "gzip" });
  const read = await views.read(viewer, scope);
  expect(read.status).toBe("ready");
  if (read.status === "ready") {
    expect(read.result.encoding).toBe("identity");
    expect(new TextDecoder().decode(read.result.content)).toBe("context");
  }
});

test("a corrupt gzip result is a failed read", async () => {
  const { views, answer, start } = useCase();
  const scope = await start();
  answer({ content: new TextEncoder().encode("not gzip"), encoding: "gzip" });
  expect(await views.read(viewer, scope)).toEqual({ status: "unavailable", reason: "read_failed" });
});

test("a daemon failure keeps its reason", async () => {
  const { views, answer, start } = useCase();
  const scope = await start();
  answer({ status: "failed", reason: "media_removed", content: new Uint8Array() });
  expect(await views.read(viewer, scope)).toEqual({
    status: "failed",
    result: expect.objectContaining({ status: "failed", reason: "media_removed" }),
  });
});

test("a request id reaches nothing outside the caller's Workspace, Computer and Agent", async () => {
  const { views, answer, start } = useCase();
  const scope = await start();
  answer();
  expect(await views.read(viewer, { ...scope, computerId: "computer-2" })).toEqual({
    status: "pending",
  });
  expect(await views.read(viewer, { ...scope, agentId: "agent-2" })).toEqual({
    status: "pending",
  });
  expect(await views.read({ userId: "user-2", workspaceId: "workspace-2" }, scope)).toEqual({
    status: "pending",
  });
});

test("a result is returned only to who still owns the Computer", async () => {
  const { views, flags, answer, start } = useCase();
  const scope = await start();
  answer();
  flags.owned = false;
  expect(await views.read(viewer, scope)).toEqual({
    status: "unavailable",
    reason: "agent_moved",
  });
});

test("a result is withheld once the feature is off", async () => {
  const { views, flags, answer, start } = useCase();
  const scope = await start();
  answer();
  flags.enabled = false;
  expect(await views.read(viewer, scope)).toEqual({ status: "unsupported" });
});

test("a read that cannot reach the store throws so the poll asks again", async () => {
  const { views } = useCase({ readFails: true });
  await expect(
    views.read(viewer, {
      computerId: input.computerId,
      agentId: input.agentId,
      requestId: "ctxv_0123456789abcdef0123456789abcdef",
    }),
  ).rejects.toThrow("redis is down");
});

test("a disabled feature does not publish", async () => {
  const { views, published } = useCase({ enabled: false });
  expect(await views.start(viewer, input)).toEqual({ status: "unsupported" });
  expect(published).toHaveLength(0);
});

test("a Computer the viewer does not own is refused before anything is sent", async () => {
  const { views, published } = useCase({ owned: false });
  expect(await views.start(viewer, input)).toEqual({
    status: "unavailable",
    reason: "no_computer",
  });
  expect(published).toHaveLength(0);
});

test("an offline Computer is refused with the offline reason", async () => {
  const { views, published } = useCase({ online: false });
  expect(await views.start(viewer, input)).toEqual({ status: "offline", reason: "offline" });
  expect(published).toHaveLength(0);
});

test("an unsupported Agent keeps the availability reason", async () => {
  const { views, published } = useCase({ supported: { supported: false, reason: "no_session" } });
  expect(await views.start(viewer, input)).toEqual({ status: "unsupported", reason: "no_session" });
  expect(published).toHaveLength(0);
});

test("a store or publish that fails is an offline start", async () => {
  expect(await useCase({ beginFails: true }).views.start(viewer, input)).toEqual({
    status: "unavailable",
    reason: "offline",
  });
  expect(await useCase({ publishFails: true }).views.start(viewer, input)).toEqual({
    status: "unavailable",
    reason: "offline",
  });
});
