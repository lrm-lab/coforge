import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { WorkspaceAssistants } from "#src/server/agents/workspace-assistants.server";
import { createAgentApiKey } from "#src/server/agents/agent-api-key.server";
import { PrismaAgentApiKeyRepository } from "#src/server/db/repositories/agent-api-key.repositories.server";
import { createDaemonApiKeyFactory } from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";

// Opt-in against a rebuilt local Web and disposable local PostgreSQL/Redis. Keys stay in memory.
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
if (
  !origin ||
  !databaseUrl ||
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname) ||
  new URL(databaseUrl).hostname !== "127.0.0.1"
)
  throw new Error("Local COFORGE_E2E_WEB_URL and DATABASE_URL are required");
const artifacts = new URL("../../../.amp/e2e/workspace-assistant/", import.meta.url).pathname;

test("the running Web serves independent platform assistants and delegated native commands", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const suffix = crypto.randomUUID();
  const users = await Promise.all(
    ["alice", "bob"].map((name) =>
      db.user.create({
        data: { username: `proof-${name}-${suffix.slice(0, 8)}`, displayName: name },
      }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `proof-${suffix}`,
      name: "Assistant HTTP proof",
      members: {
        create: users.map((user, index) => ({
          userId: user.id,
          role: index === 0 ? "owner" : "member",
        })),
      },
    },
  });
  const computers: string[] = [];
  const observations: string[] = [];
  try {
    const actors: Array<{
      user: (typeof users)[number];
      agentId: string;
      conversationId: string;
      headers: Record<string, string>;
    }> = [];
    for (const user of users) {
      const computer = await db.computer.create({
        data: {
          ownerId: user.id,
          machineId: `proof-${user.id}`,
          workspaces: { create: { workspaceId: workspace.id } },
        },
      });
      computers.push(computer.id);
      const assistant = await new WorkspaceAssistants(db).bindComputer(
        workspace.id,
        user.id,
        computer.id,
      );
      const agentKey = await createAgentApiKey({
        agentId: assistant.agentId,
        workspaceId: workspace.id,
        ownerId: user.id,
        computerId: computer.id,
        repository: new PrismaAgentApiKeyRepository(db),
      });
      const daemonKey = await createDaemonApiKeyFactory(
        new PrismaDaemonApiKeyRepository(db),
      ).create({
        principal: { userId: user.id },
        workspaceId: workspace.id,
        computerId: computer.id,
      });
      const headers = {
        authorization: `Bearer ${daemonKey}`,
        "x-coforge-agent-api-key": `Bearer ${agentKey}`,
      };
      actors.push({ user, ...assistant, headers });
    }
    const [a, b] = actors;
    expect(a!.agentId).not.toBe(b!.agentId);
    expect(a!.conversationId).not.toBe(b!.conversationId);
    async function api(actor: (typeof actors)[number], path: string, init: RequestInit = {}) {
      const response = await fetch(`${origin}/api/agent/v1/${path}`, {
        ...init,
        headers: { ...actor.headers, ...init.headers },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (!response.ok)
        throw new Error(
          `Native ${path.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      return response.json();
    }
    const post = (actor: (typeof actors)[number], path: string, body: object) =>
      api(actor, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }),
      });
    const channel = await post(a!, "channels", {
      name: `proof-${suffix.slice(0, 8)}`,
      description: "Delegated HTTP proof",
    });
    const target = channel.target;
    const forbidden = await fetch(
      `${origin}/api/agent/v1/channels/${encodeURIComponent(target)}/archive`,
      {
        method: "POST",
        headers: { ...b!.headers, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      },
    );
    expect(forbidden.status).toBe(403);

    const uploaded = new FormData();
    uploaded.set("target", target);
    uploaded.set("file", new File(["assistant-http-file"], "proof.txt", { type: "text/plain" }));
    const attachment = await api(a!, "attachments/", { method: "POST", body: uploaded });
    const sent = await post(a!, "messages", {
      target,
      content: "native-http-marker",
      attachmentIds: [attachment.id],
    });
    await post(a!, `messages/${sent.messageId}/reactions`, { emoji: "👍" });
    const reacted = await db.message.findUniqueOrThrow({
      where: { id: sent.messageId },
      select: {
        reactionVersion: true,
        reactions: { select: { emoji: true, member: { select: { userId: true } } } },
      },
    });
    expect(reacted.reactionVersion).toBe(1);
    expect(reacted.reactions).toEqual([{ emoji: "👍", member: { userId: a!.user.id } }]);
    await api(a!, `messages/${sent.messageId}/reactions`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), emoji: "👍" }),
    });
    const unreacted = await db.message.findUniqueOrThrow({
      where: { id: sent.messageId },
      select: { reactionVersion: true, reactions: { select: { emoji: true } } },
    });
    expect(unreacted.reactionVersion).toBe(2);
    expect(unreacted.reactions).toEqual([]);
    const read = await api(a!, `messages?target=${encodeURIComponent(target)}`);
    expect(read.messages.some((message: { id: string }) => message.id === sent.messageId)).toBe(
      true,
    );
    const file = await fetch(`${origin}/api/agent/v1/attachments/${attachment.id}`, {
      headers: a!.headers,
    });
    expect(await file.text()).toBe("assistant-http-file");
    observations.push(
      "Native HTTP channel creation, message send/read and attachment upload/send/download succeeded with live authentication and PostgreSQL/Redis.",
    );
    for (const actor of actors) {
      const member = await db.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: { conversationId: actor.conversationId, userId: actor.user.id },
        },
      });
      await db.message.create({
        data: {
          workspaceId: workspace.id,
          conversationId: actor.conversationId,
          senderMemberId: member.id,
          sequence: 1,
          body: `private-${actor.user.id}`,
        },
      });
    }
    const ownA = await api(a!, `messages?target=@${a!.user.username}`);
    const ownB = await api(b!, `messages?target=@${b!.user.username}`);
    expect(
      ownA.messages.some((message: { body: string }) =>
        message.body.includes(`private-${a!.user.id}`),
      ),
    ).toBe(true);
    expect(JSON.stringify(ownA)).not.toContain(`private-${b!.user.id}`);
    expect(JSON.stringify(ownB)).not.toContain(`private-${a!.user.id}`);
    const first = await api(a!, `events?target=${encodeURIComponent(target)}&limit=1`);
    expect(first.events.map((message: { id: string }) => message.id)).toEqual([sent.messageId]);
    expect((await api(a!, `events?target=${encodeURIComponent(target)}`)).events).toEqual([]);
    expect(
      (await api(b!, `events?target=${encodeURIComponent(target)}`)).events.map(
        (message: { id: string }) => message.id,
      ),
    ).toEqual([sent.messageId]);
    observations.push(
      "Separate authenticated assistants saw only their own seeded private DM marker; delegated channel drains advanced independently without replay.",
    );
    const outsider = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: a!.user.id,
        name: `outsider-${suffix.slice(0, 8)}`,
        displayName: "Outsider",
        runtimeConfig: { runtime: "pi", provider: { kind: "default" }, model: "", reasoning: "" },
      },
    });
    const mention = await post(a!, "messages", { target, content: `hello @${outsider.name}` });
    expect(mention.pendingMentionActions).toHaveLength(1);
    expect(mention.pendingMentionActions[0].reason).toBe("not_member");
    const pending = await api(a!, "mention-actions/pending");
    expect(
      pending.pendingMentionActions.some(
        (action: { resolutionId: string }) =>
          action.resolutionId === mention.pendingMentionActions[0].resolutionId,
      ),
    ).toBe(true);
    await post(a!, "mention-actions/execute", {
      action: "add",
      resolutionIds: [mention.pendingMentionActions[0].resolutionId],
    });
    expect(
      await db.conversationMember.findUnique({
        where: {
          conversationId_agentId: {
            conversationId: (
              await db.conversation.findFirstOrThrow({
                where: { workspaceId: workspace.id, channelName: target.slice(1) },
              })
            ).id,
            agentId: outsider.id,
          },
        },
      }),
    ).not.toBeNull();
    observations.push(
      "Send receipt preserved the pending mention; native mention pending/add acted through the member's existing channel authority.",
    );
    await db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: b!.user.id } },
    });
    expect(
      (await fetch(`${origin}/api/agent/v1/manual?topic=index`, { headers: b!.headers })).status,
    ).toBe(401);
    observations.push(
      "Leaving the Workspace invalidated the already-issued assistant/daemon credential pair.",
    );
    await mkdir(artifacts, { recursive: true });
    await Bun.write(
      `${artifacts}http-report.json`,
      JSON.stringify(
        {
          feature: "workspace-assistant",
          environment: `local ${origin}`,
          steps: [
            "Provision two disposable members and real native API credentials",
            "Exercise channel, message, attachment, event and mention commands against rebuilt Web",
            "Check private DM reads and membership revocation",
          ],
          observations,
          outcome: "pass",
          notes:
            "HTTP proof only. Realtime publications used a local API sink; no browser or real model turn was exercised.",
        },
        null,
        2,
      ),
    );
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { id: { in: computers } } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await db.$disconnect();
  }
});
