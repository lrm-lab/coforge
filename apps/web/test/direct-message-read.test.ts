import { describe, expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { ReadDirectMessages } from "#src/server/conversations/direct-message.server";
import type { DirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { unusedDatabase } from "./helpers/unused-database";

describe("ReadDirectMessages", () => {
  test("coordinates target lookup and conversation selection before reading persisted messages", async () => {
    const calls: string[] = [];
    const messages = [
      {
        id: "message-a",
        sequence: 1,
        senderKind: "human" as const,
        senderHandle: "ada",
        senderDescription: "",
        body: "Hello",
        createdAt: new Date("2026-08-28T00:00:00Z"),
        target: "@user",
        attachments: [],
      },
    ];
    const repository = {
      async userIdForUsername(target: string) {
        calls.push(`lookup:${target}`);
        return "user-a";
      },
      async openAgentDirect(workspaceId: string, agentId: string, parentTarget: string) {
        const userId = await this.userIdForUsername?.(parentTarget);
        if (!userId) throw new AppError("TARGET_NOT_ACCESSIBLE");
        const conversation = await this.getOrCreateUserAgent(workspaceId, userId, agentId);
        return { conversation, peer: { kind: "user" as const, userId } };
      },
      async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
        calls.push(`conversation:${workspaceId}:${userId}:${agentId}`);
        return { id: "conversation-a" };
      },
      async sendMessage() {
        throw new Error("not used");
      },
      async readMessages(_workspaceId: string, _agentId: string, target: string) {
        calls.push(`read:${target}`);
        return messages;
      },
      database: unusedDatabase,
    } satisfies DirectConversationRepository;

    await expect(
      new ReadDirectMessages(repository).execute({
        workspaceId: "workspace-a",
        agentId: "agent-a",
        target: "@user",
      }),
    ).resolves.toEqual(messages);
    expect(calls).toEqual([
      "lookup:@user",
      "conversation:workspace-a:user-a:agent-a",
      "read:@user",
    ]);
  });
});
