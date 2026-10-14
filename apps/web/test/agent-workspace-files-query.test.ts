import { expect, test } from "bun:test";
import {
  encodeAgentWorkspaceFileReadResult,
  encodeAgentWorkspaceFilesListResult,
  type AgentWorkspaceFileReadRequest,
  type AgentWorkspaceFileReadResult,
  type AgentWorkspaceDeleteResult,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceFilesListRequest,
  type AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";
import {
  AgentWorkspaceFilesQuery,
  type WorkspaceFilesAssignment,
} from "#src/server/agents/agent-workspace-files.server";
import {
  createAgentWorkspaceFileReadResultMethod,
  createAgentWorkspaceFilesListResultMethod,
} from "#src/server/centrifugo/agent-workspace-files-cache.server";

function query(overrides: {
  findOwned: () => Promise<WorkspaceFilesAssignment | undefined>;
  online?: () => Promise<boolean>;
  publishList?: (request: AgentWorkspaceFilesListRequest) => Promise<void>;
  publishRead?: (request: AgentWorkspaceFileReadRequest) => Promise<void>;
  publishDelete?: (request: AgentWorkspaceDeleteRequest) => Promise<void>;
  listRead: () => Promise<AgentWorkspaceFilesListResult | undefined>;
  readRead?: () => Promise<AgentWorkspaceFileReadResult | undefined>;
  deleteRead?: () => Promise<AgentWorkspaceDeleteResult | undefined>;
  cleared?: () => void;
  timing?: { now: () => number; wait: (ms: number) => Promise<void>; timeoutMs: number };
}) {
  return new AgentWorkspaceFilesQuery(
    {
      findOwned: overrides.findOwned,
      online: overrides.online ?? (async () => true),
      publishList: overrides.publishList ?? (async () => {}),
      publishRead: overrides.publishRead ?? (async () => {}),
      listResults: {
        begin: async () => {},
        read: overrides.listRead,
        clear: async () => overrides.cleared?.(),
      },
      readResults: {
        begin: async () => {},
        read: overrides.readRead ?? (async () => undefined),
        clear: async () => overrides.cleared?.(),
      },
      publishDelete: overrides.publishDelete ?? (async () => {}),
      deleteResults: {
        begin: async () => {},
        read: overrides.deleteRead ?? (async () => undefined),
        clear: async () => overrides.cleared?.(),
      },
    },
    overrides.timing,
  );
}

test("Workspace Files list binds the owner's assignment and rechecks it before returning metadata", async () => {
  let assignment: WorkspaceFilesAssignment | undefined = {
    computerId: "computer",
    revision: "one",
  };
  let request: AgentWorkspaceFilesListRequest | undefined;
  let reads = 0;
  let cleared = 0;
  const q = query({
    findOwned: async () => {
      reads++;
      return assignment;
    },
    publishList: async (value) => {
      request = value;
    },
    listRead: async () => {
      assignment = undefined; // Membership/ownership revoked while waiting.
      return {
        ...request!,
        status: "ok",
        rootPath: "/home/agent",
        entries: [],
      } satisfies AgentWorkspaceFilesListResult;
    },
    cleared: () => cleared++,
  });
  expect(await q.list({ userId: "owner", workspaceId: "workspace" }, "agent", "", false)).toEqual({
    status: "unavailable",
  });
  expect(request).toMatchObject({
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
  });
  expect(reads).toBe(2);
  expect(cleared).toBe(1);
});

test.each(["ready", "offline", "timeout", "moved", "reconfigured", "wrong-result"])(
  "Workspace Files list handles %s without leaking stale metadata",
  async (scenario) => {
    let assignment: WorkspaceFilesAssignment = { computerId: "computer", revision: "one" };
    let request: AgentWorkspaceFilesListRequest | undefined;
    let now = 0;
    const q = query({
      findOwned: async () => assignment,
      online: async () => scenario !== "offline",
      publishList: async (value) => {
        request = value;
      },
      listRead: async () => {
        if (scenario === "timeout") return undefined;
        if (scenario === "moved") assignment = { ...assignment, computerId: "other" };
        if (scenario === "reconfigured") assignment = { ...assignment, revision: "two" };
        return {
          ...request!,
          agentId: scenario === "wrong-result" ? "other" : "agent",
          status: "ok",
          rootPath: "/home/agent",
          entries: [],
        };
      },
      timing: {
        now: () => now,
        wait: async () => {
          now += 100;
        },
        timeoutMs: 200,
      },
    });
    const response = await q.list(
      { userId: "owner", workspaceId: "workspace" },
      "agent",
      "",
      false,
    );
    expect(response.status).toBe(
      scenario === "ready" || scenario === "offline" || scenario === "timeout"
        ? scenario
        : "unavailable",
    );
    if (scenario === "offline") expect(request).toBeUndefined();
  },
);

test("Workspace file read binds the owner's assignment and rechecks it before returning content", async () => {
  let assignment: WorkspaceFilesAssignment | undefined = {
    computerId: "computer",
    revision: "one",
  };
  let request: AgentWorkspaceFileReadRequest | undefined;
  const q = query({
    findOwned: async () => assignment,
    publishRead: async (value) => {
      request = value;
    },
    listRead: async () => undefined,
    readRead: async () => {
      assignment = undefined;
      return {
        ...request!,
        status: "ok",
        sizeBytes: 3,
        modifiedAtMs: 1,
        text: "abc",
        contentType: "",
        contentBase64: "",
      } satisfies AgentWorkspaceFileReadResult;
    },
  });
  expect(await q.read({ userId: "owner", workspaceId: "workspace" }, "agent", "a.txt")).toEqual({
    status: "unavailable",
  });
});

test("Workspace deletion binds the owner's assignment and returns the daemon terminal result", async () => {
  let request: AgentWorkspaceDeleteRequest | undefined;
  const q = query({
    findOwned: async () => ({ computerId: "computer", revision: "one" }),
    listRead: async () => undefined,
    publishDelete: async (value) => {
      request = value;
    },
    deleteRead: async () => ({ ...request!, status: "ok" }),
  });
  expect(await q.delete({ userId: "owner", workspaceId: "workspace" }, "agent")).toEqual({
    status: "ready",
    result: { ...request!, status: "ok" },
  });
});

test("Workspace Files list result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentWorkspaceFilesListResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    dirPath: "",
    includeHidden: false,
    status: "ok",
    rootPath: "/home/agent",
    entries: [],
  };
  let accepted = 0;
  const method = createAgentWorkspaceFilesListResultMethod({
    accept: async () => {
      accepted++;
    },
  });
  const bytes = encodeAgentWorkspaceFilesListResult(result);
  for (const principal of [
    { userId: "", workspaceId: "workspace", computerId: "computer" },
    { userId: "user", workspaceId: "other", computerId: "computer" },
    { userId: "user", workspaceId: "workspace", computerId: "other" },
    { userId: "user", workspaceId: "workspace", computerId: "computer", agentId: "agent" },
  ])
    expect(await method(bytes, { principal })).toMatchObject({ code: 403 });
  expect(accepted).toBe(0);
  expect(
    await method(bytes, {
      principal: { userId: "user", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toBeInstanceOf(Uint8Array);
  expect(accepted).toBe(1);
});

test("Workspace file read result RPC trusts daemon claims rather than claimed payload scope", async () => {
  const result: AgentWorkspaceFileReadResult = {
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    path: "a.txt",
    status: "ok",
    sizeBytes: 3,
    modifiedAtMs: 1,
    text: "abc",
    contentType: "",
    contentBase64: "",
  };
  let accepted = 0;
  const method = createAgentWorkspaceFileReadResultMethod({
    accept: async () => {
      accepted++;
    },
  });
  const bytes = encodeAgentWorkspaceFileReadResult(result);
  expect(
    await method(bytes, {
      principal: { userId: "", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toMatchObject({ code: 403 });
  expect(accepted).toBe(0);
  expect(
    await method(bytes, {
      principal: { userId: "user", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toBeInstanceOf(Uint8Array);
  expect(accepted).toBe(1);
});

test("a listing that arrives within tens of milliseconds is read within 20 ms of arriving, not after a flat 100 ms poll", async () => {
  // The Daemon answered 30 ms after the request; the old flat 100 ms poll only saw it at 100 ms,
  // which the Computer page's workspace scan then paid once per directory.
  let now = 0;
  let request: AgentWorkspaceFilesListRequest | undefined;
  const q = query({
    findOwned: async () => ({ computerId: "computer", revision: "one" }),
    publishList: async (published) => {
      request = published;
    },
    listRead: async () =>
      now >= 30 ? { ...request!, status: "ok", rootPath: "/home/agent", entries: [] } : undefined,
    timing: {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      timeoutMs: 5_000,
    },
  });
  const response = await q.list({ userId: "owner", workspaceId: "workspace" }, "agent", "", false);
  expect(response.status).toBe("ready");
  expect(now).toBeGreaterThanOrEqual(30);
  expect(now).toBeLessThan(50);
});

test("a listing that never arrives still waits out the same 5 s timeout, with few extra reads", async () => {
  let now = 0;
  let reads = 0;
  const q = query({
    findOwned: async () => ({ computerId: "computer", revision: "one" }),
    listRead: async () => {
      reads++;
      return undefined;
    },
    timing: {
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      timeoutMs: 5_000,
    },
  });
  const response = await q.list({ userId: "owner", workspaceId: "workspace" }, "agent", "", false);
  expect(response.status).toBe("timeout");
  expect(now).toBeGreaterThanOrEqual(5_000);
  // A flat 100 ms poll read 50 times; the first half second at 20 ms adds 20 more.
  expect(reads).toBeLessThanOrEqual(71);
});
