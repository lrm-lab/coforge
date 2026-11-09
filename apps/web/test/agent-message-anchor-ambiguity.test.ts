import { expect, test } from "bun:test";

import { AppError } from "#src/lib/app-error";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import { drainScope } from "#src/server/db/repositories/agent-targets.repositories.server";
import { messageAnchorWhere } from "#src/server/db/message-anchor.server";
import { handleAgentMessagesGet } from "#src/routes/api/agent/v1/messages";

const request = (search: string) =>
  new Request(`https://server.example/api/agent/v1/messages${search}`);

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };

test("an ambiguous anchor answers AMBIGUOUS_MESSAGE_PREFIX with its candidates", async () => {
  const result = await handleAgentMessagesGet(request("?target=%23general"), principal, {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    readMessagesPage: async () => {
      throw new AgentMessageValidationError("ambiguous message prefix; use the full UUID", [
        "01a1be5f-023d-7000-8000-000000000001",
        "01a1be5f-023d-7000-8000-000000000002",
      ]);
    },
  });
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body.code).toBe("AMBIGUOUS_MESSAGE_PREFIX");
  expect(body.error).toContain("ambiguous message prefix");
  expect(body.error).toContain("01a1be5f-023d-7000-8000-000000000001");
  expect(body.error).toContain("01a1be5f-023d-7000-8000-000000000002");
});

test("a non-ambiguous validation failure keeps its own message, not the generic one", async () => {
  const result = await handleAgentMessagesGet(request("?target=%23general"), principal, {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    readMessagesPage: async () => {
      throw new AgentMessageValidationError("message anchor not found in this conversation");
    },
  });
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body.code).toBe("INVALID_MESSAGE_QUERY");
  expect(body.error).toBe("message anchor not found in this conversation");
});

const uuid = (n: number) => `01a1be5f-023d-7000-8000-${String(n).padStart(12, "0")}`;

test("drainScope refuses an ambiguous notified-thread anchor instead of picking one", async () => {
  const ports = {
    db: {
      pendingMentionAction: {
        findMany: async () => [
          { conversationId: "conv-1", message: { threadRootId: uuid(1) } },
          { conversationId: "conv-2", message: { threadRootId: uuid(2) } },
        ],
      },
    },
    resolveAgentTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  };
  // uuid(1) and uuid(2) share the 8-hex prefix "01a1be5f".
  await expect(
    drainScope(ports as never, "workspace-1", "agent-1", "#general:01a1be5f"),
  ).rejects.toThrow(AgentMessageValidationError);
  await expect(
    drainScope(ports as never, "workspace-1", "agent-1", "#general:01a1be5f"),
  ).rejects.toThrow("ambiguous message prefix");
});

test("drainScope resolves a single notified-thread match", async () => {
  let seenThreadRootWhere: unknown;
  const ports = {
    db: {
      pendingMentionAction: {
        // The anchor is filtered in the query now; the mock answers what the database would,
        // and pins that the filter is really there.
        findMany: async (args: { where: { message: { threadRootId: unknown } } }) => {
          seenThreadRootWhere = args.where.message.threadRootId;
          return [{ conversationId: "conv-1", message: { threadRootId: uuid(1) } }];
        },
      },
    },
    resolveAgentTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  };
  const scope = await drainScope(ports as never, "workspace-1", "agent-1", `#general:${uuid(1)}`);
  expect(scope).toEqual({ conversationId: "conv-1", threadRootId: uuid(1) });
  expect(seenThreadRootWhere).toEqual(messageAnchorWhere(uuid(1)));
});

test("drainScope resolves same-thread notified rows to one scope, not an ambiguity", async () => {
  const ports = {
    db: {
      pendingMentionAction: {
        findMany: async () => [
          { conversationId: "conv-1", message: { threadRootId: uuid(1) } },
          { conversationId: "conv-1", message: { threadRootId: uuid(1) } },
        ],
      },
    },
    resolveAgentTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  };
  const scope = await drainScope(ports as never, "workspace-1", "agent-1", "#general:01a1be5f");
  expect(scope).toEqual({ conversationId: "conv-1", threadRootId: uuid(1) });
});

test("drainScope resolves a bare channel target with several notified rows", async () => {
  const ports = {
    db: {
      pendingMentionAction: {
        findMany: async () => [
          { conversationId: "conv-1", message: { threadRootId: null } },
          { conversationId: "conv-1", message: { threadRootId: null } },
        ],
      },
    },
    resolveAgentTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  };
  const scope = await drainScope(ports as never, "workspace-1", "agent-1", "#general");
  expect(scope).toEqual({ conversationId: "conv-1", threadRootId: null });
});

test("drainScope accepts an uppercase anchor", async () => {
  const ports = {
    db: {
      pendingMentionAction: {
        findMany: async () => [{ conversationId: "conv-1", message: { threadRootId: uuid(1) } }],
      },
    },
    resolveAgentTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  };
  const scope = await drainScope(
    ports as never,
    "workspace-1",
    "agent-1",
    `#general:${uuid(1).slice(0, 13).toUpperCase()}`,
  );
  expect(scope).toEqual({ conversationId: "conv-1", threadRootId: uuid(1) });
});

test("drainScope refuses an ambiguous attachment comment anchor", async () => {
  const attachmentId = uuid(9);
  const ports = {
    db: {
      attachment: {
        findFirst: async () => ({
          conversationId: "conv-1",
          message: { id: uuid(3), threadRootId: null },
          commentThread: null,
        }),
      },
      attachmentComment: {
        findMany: async () => [
          { message: { id: uuid(4), threadRootId: uuid(3) } },
          { message: { id: uuid(5), threadRootId: uuid(6) } },
        ],
      },
    },
    resolveAgentTarget: async () => ({ conversationId: "conv-1", threadRootId: null }),
  };
  await expect(
    drainScope(ports as never, "workspace-1", "agent-1", `attachment:${attachmentId}:01a1be5f`),
  ).rejects.toThrow("ambiguous message prefix");
});

test("drainScope resolves attachment comments sharing one thread root", async () => {
  const attachmentId = uuid(9);
  const ports = {
    db: {
      attachment: {
        findFirst: async () => ({
          conversationId: "conv-1",
          message: { id: uuid(3), threadRootId: null },
          commentThread: null,
        }),
      },
      attachmentComment: {
        findMany: async () => [
          { message: { id: uuid(4), threadRootId: uuid(3) } },
          { message: { id: uuid(5), threadRootId: uuid(3) } },
        ],
      },
    },
    resolveAgentTarget: async () => ({ conversationId: "conv-1", threadRootId: null }),
  };
  const scope = await drainScope(
    ports as never,
    "workspace-1",
    "agent-1",
    `attachment:${attachmentId}:01a1be5f`,
  );
  expect(scope).toEqual({ conversationId: "conv-1", threadRootId: uuid(3) });
});

// Before comment migration the discussion is its own conversation and a root comment carries
// `threadRootId: null` — its own id is then the thread root (the `?? id` rule).
const discussionPorts = (comments: { id: string; threadRootId: string | null }[]) => ({
  db: {
    attachment: {
      findFirst: async () => ({
        conversationId: "conv-1",
        message: { id: uuid(3), threadRootId: null },
        commentThread: { conversationId: "conv-discussion" },
      }),
    },
    attachmentComment: {
      findMany: async () => comments.map((message) => ({ message })),
    },
  },
  resolveAgentTarget: async () => ({ conversationId: "conv-1", threadRootId: null }),
});

test("drainScope refuses two attachment root comments sharing a prefix", async () => {
  const ports = discussionPorts([
    { id: uuid(4), threadRootId: null },
    { id: uuid(5), threadRootId: null },
  ]);
  await expect(
    drainScope(ports as never, "workspace-1", "agent-1", `attachment:${uuid(9)}:01a1be5f`),
  ).rejects.toThrow("ambiguous message prefix");
});

test("drainScope resolves a single attachment root comment to its own thread", async () => {
  const ports = discussionPorts([{ id: uuid(4), threadRootId: null }]);
  const scope = await drainScope(
    ports as never,
    "workspace-1",
    "agent-1",
    `attachment:${uuid(9)}:01a1be5f`,
  );
  expect(scope).toEqual({ conversationId: "conv-discussion", threadRootId: uuid(4) });
});

test("drainScope resolves an attachment root comment and its reply to one scope", async () => {
  const ports = discussionPorts([
    { id: uuid(4), threadRootId: null },
    { id: uuid(5), threadRootId: uuid(4) },
  ]);
  const scope = await drainScope(
    ports as never,
    "workspace-1",
    "agent-1",
    `attachment:${uuid(9)}:01a1be5f`,
  );
  expect(scope).toEqual({ conversationId: "conv-discussion", threadRootId: uuid(4) });
});
