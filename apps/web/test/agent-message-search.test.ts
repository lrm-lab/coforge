import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { searchAgentMessages } from "#src/server/agents/agent-message-search.server";
import type { AgentMessageRepository } from "#src/server/agents/agent-messages.server";
import {
  decodeAgentMessageSearchCursor,
  encodeAgentMessageSearchCursor,
} from "#src/server/db/repositories/agent-message-search-cursor.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("Agent message search", () => {
  test("search maps Date values at the application boundary", async () => {
    const repository: AgentMessageRepository = {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async () => ({
        messages: [
          {
            id: "message-1",
            sequence: 1,
            senderKind: "agent" as const,
            senderHandle: "agent-1",
            senderDescription: "",
            target: "#general",
            body: "hello",
            createdAt: new Date("2026-09-15T00:00:00.000Z"),
            attachments: [],
          },
        ],
        hasMore: false,
        incomplete: false,
      }),
    };
    const result = await searchAgentMessages(
      repository,
      { workspaceId: "workspace-1", agentId: "agent-1" },
      { query: "hello" },
    );
    expect(result.messages[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
  });

  test("searches only canonical messages in the Agent's Workspace and readable conversations", async () => {
    const queries: object[] = [];
    const db = {
      conversation: { findMany: async () => [] },
      $queryRaw: async () => [{ query: "'release' & 'plan'" }],
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              id: "message-1",
              sequence: 41,
              body: "Release plan",
              createdAt: new Date("2026-09-07T10:00:00Z"),
              threadRootId: null,
              sender: {
                agentId: null,
                agent: null,
                user: { username: "ada", description: "" },
              },
              attachments: [],
              conversation: {
                channelName: "general",
                members: [{ user: { username: "ada" } }],
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;
    const result = await new PrismaDirectConversationRepository(db).searchMessages(
      "workspace-1",
      "agent-1",
      {
        query: "release plan",
        sender: "@ada",
        limit: 5,
      },
    );
    expect(queries[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        conversation: { members: { some: { agentId: "agent-1" } } },
        body: { search: "'release' & 'plan'" },
        sender: {
          OR: [{ user: { username: "ada" } }, { agent: { name: "ada" } }],
        },
      },
      orderBy: [
        {
          _relevance: {
            fields: ["body"],
            search: "'release' & 'plan'",
            sort: "desc",
          },
        },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: 6,
    });
    expect<unknown>(result).toEqual({
      messages: [
        {
          id: "message-1",
          sequence: 41,
          senderKind: "human",
          senderHandle: "ada",
          senderDescription: "",
          target: "#general",
          body: "Release plan",
          createdAt: new Date("2026-09-07T10:00:00Z"),
          attachments: [],
        },
      ],
      hasMore: false,
      nextCursor: undefined,
      incomplete: false,
    });
    await new PrismaDirectConversationRepository(db).searchMessages("workspace-1", "agent-1", {
      query: "release",
      sort: "recent",
    });
    expect(queries[1]).toMatchObject({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  describe("search paging", () => {
    const row = (id: string, createdAt: string) => ({
      id,
      sequence: 1,
      body: "Release plan",
      createdAt: new Date(createdAt),
      threadRootId: null,
      sender: { agentId: null, agent: null, user: { username: "ada", description: "" } },
      attachments: [],
      conversation: { channelName: "general", members: [{ user: { username: "ada" } }] },
    });
    const ID_A = "00000000-0000-4000-8000-00000000000a";
    const ID_B = "00000000-0000-4000-8000-00000000000b";
    const ID_C = "00000000-0000-4000-8000-00000000000c";
    const repositoryReturning = (rows: ReturnType<typeof row>[], queries: object[] = []) =>
      new PrismaDirectConversationRepository({
        conversation: { findMany: async () => [] },
        $queryRaw: async () => [{ query: "'release'" }],
        message: {
          findMany: async (input: object) => {
            queries.push(input);
            return rows;
          },
        },
      } as unknown as PrismaClient);

    test("a recent search with a query hands back a cursor when another page follows", async () => {
      const queries: object[] = [];
      const page = await repositoryReturning(
        [
          row(ID_A, "2026-09-07T10:00:03.000Z"),
          row(ID_B, "2026-09-07T10:00:02.000Z"),
          row(ID_C, "2026-09-07T10:00:01.000Z"),
        ],
        queries,
      ).searchMessages("workspace-1", "agent-1", { query: "release", sort: "recent", limit: 2 });
      expect(queries[0]).toMatchObject({ take: 3 });
      expect(page.messages.map((message) => message.id)).toEqual([ID_A, ID_B]);
      expect(page.hasMore).toBe(true);
      expect(page.incomplete).toBe(false);
      expect(decodeAgentMessageSearchCursor(page.nextCursor!)).toEqual({
        createdAt: new Date("2026-09-07T10:00:02.000Z"),
        id: ID_B,
      });
    });

    test("the cursor continues strictly after the last message shown", async () => {
      const queries: object[] = [];
      const cursor = encodeAgentMessageSearchCursor({
        createdAt: new Date("2026-09-07T10:00:02.000Z"),
        id: ID_B,
      });
      const page = await repositoryReturning(
        [row(ID_C, "2026-09-07T10:00:01.000Z")],
        queries,
      ).searchMessages("workspace-1", "agent-1", {
        query: "release",
        sort: "recent",
        limit: 2,
        cursor,
      });
      expect(queries[0]).toMatchObject({
        where: {
          OR: [
            { createdAt: { lt: new Date("2026-09-07T10:00:02.000Z") } },
            { createdAt: new Date("2026-09-07T10:00:02.000Z"), id: { lt: ID_B } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 0,
      });
      expect(page).toMatchObject({ hasMore: false, nextCursor: undefined });
    });

    test("a relevance search reports another page without a cursor", async () => {
      const page = await repositoryReturning([
        row(ID_A, "2026-09-07T10:00:03.000Z"),
        row(ID_B, "2026-09-07T10:00:02.000Z"),
      ]).searchMessages("workspace-1", "agent-1", { query: "release", limit: 1 });
      expect(page).toMatchObject({ hasMore: true, nextCursor: undefined });
      expect(page.messages).toHaveLength(1);
    });

    test("refuses a cursor that is malformed or does not fit the search", async () => {
      const repository = repositoryReturning([]);
      const cursor = encodeAgentMessageSearchCursor({ createdAt: new Date(0), id: ID_A });
      await expect(
        repository.searchMessages("workspace-1", "agent-1", {
          query: "release",
          sort: "recent",
          cursor: "not-a-cursor",
        }),
      ).rejects.toThrow("invalid search cursor");
      await expect(
        repository.searchMessages("workspace-1", "agent-1", { query: "release", cursor }),
      ).rejects.toThrow("a search cursor continues a recent search");
      await expect(
        repository.searchMessages("workspace-1", "agent-1", { sort: "recent", cursor }),
      ).rejects.toThrow("a search cursor continues a recent search");
      await expect(
        repository.searchMessages("workspace-1", "agent-1", {
          query: "release",
          sort: "recent",
          cursor,
          offset: 5,
        }),
      ).rejects.toThrow("a search cursor continues a recent search");
    });
  });
});
