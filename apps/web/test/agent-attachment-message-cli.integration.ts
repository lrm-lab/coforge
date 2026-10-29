import { agentMessageReactionRepository } from "#src/server/agents/agent-message-reactions.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { handleAgentMessageReaction } from "#src/routes/api/agent/v1/messages_.$messageId.reactions";
import { handleAgentAttachmentCommentsGet } from "#src/routes/api/agent/v1/attachments/$attachmentId.comments";
import { readAgentAttachmentComments } from "#src/server/attachments/agent-attachment-comments.server";
import { adaptAgentReactionResponse } from "@lrm/coforge-daemon/src/connection/agent-message-adapters";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentProxy } from "@lrm/coforge-daemon/src/agent-proxy";
import { createAgentMessageHttpClient } from "@lrm/coforge-daemon/src/connection/agent-http-clients";
import { adaptAgentHistoryResponse } from "@lrm/coforge-daemon/src/connection/agent-history-response";
import { adaptAgentSendResponse } from "@lrm/coforge-daemon/src/connection/agent-message-adapters";
import { AgentMessageOperations } from "@lrm/coforge-daemon/src/daemon-runtime/agent-message-operations";
import { AgentMessageAttentionIndex } from "@lrm/coforge-daemon/src/daemon-runtime/agent-message-attention-index";
import { AgentInboxStateMachine } from "@lrm/coforge-daemon/src/daemon-runtime/agent-inbox-state-machine";
import { AgentStateDb } from "@lrm/coforge-daemon/src/persistence/agent-state-db";
import { AgentMessageDraftStore } from "@lrm/coforge-daemon/src/persistence/agent-message-draft-store";
import { canonicalThreadTarget } from "@lrm/coforge-daemon/src/daemon-runtime/thread-target";
import { handleAgentMessagesGet, handleAgentMessagesPost } from "#src/routes/api/agent/v1/messages";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { agentAttachmentMessagesFixture } from "./helpers/agent-attachment-messages-fixture";

test("real CLI → proxy → daemon operations → HTTP → PostgreSQL reads a file comment and refuses to reply", async () => {
  const f = await agentAttachmentMessagesFixture();
  const root = await mkdtemp(join(tmpdir(), "coforge-attachment-cli-"));
  let proxy: ReturnType<typeof startAgentProxy> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const comment = await f.comments.post(f.actor, {
      attachmentId: f.attachment.id,
      body: "Please review this file",
    });
    const repository = {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
    };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/reactions"))
          return handleAgentMessageReaction(
            request,
            path.split("/").at(-2)!,
            request.method === "POST",
            f.principal,
            agentMessageReactionRepository(f.db, new PrismaDirectConversationRepository(f.db)),
          );
        if (path.endsWith("/comments"))
          return handleAgentAttachmentCommentsGet(request, f.attachment.id, (options) =>
            readAgentAttachmentComments(f.db, f.principal, options),
          );
        return request.method === "GET"
          ? handleAgentMessagesGet(request, f.principal, repository, f.messages)
          : handleAgentMessagesPost(request, f.principal, {
              repository: {},
              sender: f.messages,
              attachmentMessages: f.messages,
              requestRecords: getMessageRequestIdempotency(),
            });
      },
    });
    const client = createAgentMessageHttpClient();
    const apiKey = `sk_agent_${"a".repeat(43)}`;
    const keys = {
      url: `${server.url}api/agent/v1/messages`,
      agentApiKey: apiKey,
      daemonApiKey: "fixture",
    };
    const attention = new AgentMessageAttentionIndex(
      f.workspace.id,
      { session: () => undefined },
      async () => {},
    );
    const inbox = new AgentInboxStateMachine(
      new AgentMessageDraftStore(AgentStateDb.open(root, f.principal.agentId)),
    );
    const operations = new AgentMessageOperations({
      connection: { workspaceId: f.workspace.id, computerId: "fixture" },
      attention,
      inbox: () => inbox,
      reportFreshnessHold: () => {},
      transport: {
        agentMessage: async (request) => {
          if (request.operation === "react" || request.operation === "unreact")
            return adaptAgentReactionResponse(
              await client.requestReaction!({
                ...keys,
                url: `${server!.url}api/agent/v1/messages/${request.messageId}/reactions`,
                method: request.operation === "react" ? "POST" : "DELETE",
                request,
              }),
            );
          return request.operation === "read"
            ? adaptAgentHistoryResponse(await client.requestRead!({ ...keys, request }))
            : adaptAgentSendResponse(await client.requestSend!({ ...keys, request }));
        },
      },
    });
    proxy = startAgentProxy({
      runtime: {
        attachmentComments: async (_context, request) =>
          client.requestAttachmentComments!({
            ...keys,
            url: `${server!.url}api/agent/v1/attachments/${f.attachment.id}/comments`,
            request,
          }),
        agentMessage: async (_context, request, key) => {
          const target = request.target
            ? await canonicalThreadTarget(request.target, async (parent, anchor) =>
                adaptAgentHistoryResponse(
                  await client.requestRead!({
                    ...keys,
                    request: {
                      ...f.principal,
                      idempotencyKey: crypto.randomUUID(),
                      operation: "read",
                      target: parent,
                      around: anchor,
                      limit: 1,
                    },
                  }),
                ),
              )
            : undefined;
          return operations.handle(f.principal.agentId, request, target, key);
        },
      },
    });
    const token = proxy.issue(f.principal.agentId, apiKey);
    const cliPath = new URL("../../../packages/coforge/src/cli.ts", import.meta.url).pathname;
    const runCli = async (args: string[], body?: string) => {
      const child = Bun.spawn([process.execPath, cliPath, ...args], {
        env: {
          ...Object.fromEntries(
            Object.entries(Bun.env).filter(([, value]) => typeof value === "string"),
          ),
          COFORGE_AGENT_CONTEXT: token,
          COFORGE_AGENT_PROXY_URL: proxy!.url,
          COFORGE_CLI_DRAFT_STATE_DIR: root,
          COFORGE_CLI_CONSUMED_SEQ_STATE_DIR: root,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(body ?? "");
      child.stdin.end();
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exit, stdout, stderr };
    };
    const cli = async (args: string[], body?: string) => {
      const { exit, stdout, stderr } = await runCli(args, body);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return stdout;
    };
    const capabilities = await cli(["attachment", "comments", f.attachment.id]);
    // A comment takes no reactions and no replies: the Web panel shows top-level comments only.
    expect(capabilities).not.toContain("message react");
    expect(capabilities).toContain(`message read --target '${f.target}'`);
    expect(capabilities).toContain(`message send --target '${f.target}'`);
    const reaction = await runCli([
      "message",
      "react",
      "--message-id",
      comment.id,
      "--emoji",
      "✅",
    ]);
    expect(reaction.exit).not.toBe(0);
    expect(`${reaction.stdout}${reaction.stderr}`).toContain(
      "attachment comments take no reactions",
    );
    expect(
      (await f.comments.list(f.actor, { attachmentId: f.attachment.id })).comments[0]!.resolved,
    ).toBe(false);
    const before = await cli(["message", "read", "--target", f.target, "--unread"]);
    expect(before).toContain("Please review this file");
    // The generic message line still names the thread a message sits in; replies to it are
    // refused above.
    expect(before).toContain(`replyTarget=${f.target}:${comment.id.slice(0, 13)}`);
    expect(before).toContain("Coverage: top-level messages");
    const target = `${f.target}:${comment.id.slice(0, 13)}`;
    // Reading one comment's thread is still allowed (it is empty: the Web has no replies); only
    // replying to it is refused.
    const threadedRead = await cli(["message", "read", "--target", target]);
    expect(threadedRead).toContain(`No messages in ${target}`);
    const send = await runCli(
      ["message", "send", "--target", target],
      "Reviewed through the real CLI",
    );
    expect(send.exit).not.toBe(0);
    expect(`${send.stdout}${send.stderr}`).toContain("attachment comments have no replies");
    const after = await cli(["message", "read", "--target", `${f.target}:${comment.id}`]);
    expect(after).toContain("No messages in");
    const human = await f.comments.list(f.actor, {
      attachmentId: f.attachment.id,
      rootId: comment.id,
    });
    expect(human.comments).toEqual([]);
    console.log(
      JSON.stringify({
        artifact: "attachment-message-cli",
        attachmentId: f.attachment.id,
        rootId: comment.id,
        replyId: null,
        capabilities,
        reaction: { exit: reaction.exit, output: `${reaction.stdout}${reaction.stderr}` },
        before,
        send: { exit: send.exit, output: `${send.stdout}${send.stderr}` },
        after,
        humanReadback: human.comments.map((m) => ({ id: m.id, body: m.body })),
      }),
    );
  } finally {
    proxy?.close();
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
}, 30_000);
