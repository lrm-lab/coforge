import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  encodeAgentReplyIntent,
  REPLY_INTENT_PHASE,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { PrismaClient } from "#src/generated/prisma/client";
import { sameOriginProxy } from "./same-origin-proxy";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { ManageAgents } from "#src/server/agents/manage-agents.server";
import { PUBLICATION_REROUTED_CODE } from "#src/server/agents/agent-activity-relay.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "#src/server/db/repositories/setup.repositories.server";
import { ComputerRegistrar } from "#src/server/computers/registration.server";
import { PublicChannels } from "#src/server/conversations/public-channels.server";
import { RedisMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import {
  prepareAppNotificationQueues,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  agentMessagesPostDependencies,
  handleAgentMessagesPost,
} from "#src/routes/api/agent/v1/messages";

function requireEnvironment(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const visible = (text: string) =>
  `[...document.querySelectorAll('[role="status"]')].some((node) => node.textContent === ${JSON.stringify(text)} && node.checkVisibility())`;
export const announced = (text: string) =>
  `[...document.querySelectorAll('[role="status"]')].some((node) => node.textContent === ${JSON.stringify(text)})`;

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export function setupAgentReplying({ artifactsName }: { artifactsName: string }) {
  const upstreamOrigin = requireEnvironment("COFORGE_E2E_WEB_URL");
  if (!["localhost", "127.0.0.1"].includes(new URL(upstreamOrigin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  const centrifugoOrigin = requireEnvironment("COFORGE_E2E_CENTRIFUGO_URL");
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required");
  const databaseUrl = requireEnvironment("DATABASE_URL");
  if (new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  const redisUrl = requireEnvironment("REDIS_URL");
  requireEnvironment("COFORGE_CENTRIFUGO_API_URL");
  requireEnvironment("COFORGE_CENTRIFUGO_API_KEY");
  const proxySecret = requireEnvironment("COFORGE_CENTRIFUGO_PROXY_SECRET");
  const artifacts = join(import.meta.dir, "../../../../.artifacts/e2e", artifactsName);

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const redis = new Bun.RedisClient(redisUrl);
  const centrifugo = createCentrifugoServerApi();
  const proxy = sameOriginProxy(upstreamOrigin, centrifugoOrigin);
  const session = `${artifactsName}-${process.pid}`;

  async function browser(...args: string[]) {
    const child = Bun.spawn([browserPath!, "--session", session, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${args[0]} failed: ${stderr}`);
    return stdout;
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const printed = (
      await browser("eval", `(async () => JSON.stringify(await (${expression})))()`)
    ).trim();
    if (printed === "undefined" || printed === "null") return undefined as T;
    return JSON.parse(JSON.parse(printed)) as T;
  }

  async function until(condition: string, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await evaluate<boolean>(condition))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${condition}`);
      await Bun.sleep(100);
    }
  }

  async function staysFalse(condition: string, ms: number) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      expect(await evaluate<boolean>(condition)).toBe(false);
      await Bun.sleep(250);
    }
  }

  let channels: PublicChannels;
  const createdConversations: string[] = [];
  const suffix = String(process.pid);
  const agentName = `replier${suffix}`;
  const fx = {
    suffix,
    agentName,
    typingSentence: `${agentName} is typing…`,
    replyingSentence: `${agentName} is replying`,
    joinedName: `e2e-replying-${suffix}`,
    unjoinedName: `e2e-readonly-${suffix}`,
    workspacePath: "",
    workspaceId: "",
    computerId: "",
    agentId: "",
    otherAgents: [] as { id: string; name: string }[],
    get agentIds() {
      return [fx.agentId, ...fx.otherAgents.map((agent) => agent.id)];
    },
    writerUserId: "",
    joinedId: "",
    unjoinedId: "",
    rootId: "",
    proxy,
    db,
    browser,
    evaluate,
    until,
    staysFalse,
    screenshot: (name: string) => browser("screenshot", join(artifacts, name)),
    open: (conversationId: string, search = "") =>
      browser("open", `${proxy.origin}${fx.workspacePath}/channel/${conversationId}${search}`),
    untilText: (text: string) =>
      until(`document.body.innerText.includes(${JSON.stringify(text)})`, 60_000),
    send: (channelId: string, userId: string, body: string, threadRootId?: string) =>
      channels.send({
        workspaceId: fx.workspaceId,
        userId,
        channelId,
        idempotencyKey: crypto.randomUUID(),
        body,
        threadRootId,
      }),
    async createChannel(name: string) {
      const channel = await channels.create(fx.workspaceId, DEV_BROWSER_USER.id, name);
      createdConversations.push(channel.id);
      await addAgents(channel.id);
      return channel.id;
    },
    sendFrame,
    announce,
    agentSends,
  };

  async function sendFrame(intent: AgentReplyIntent["intent"], agentId = fx.agentId) {
    const channel = `agent:activity:${fx.workspaceId}`;
    const frame = encodeAgentReplyIntent({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: fx.workspaceId,
      agentId,
      observedAtMs: Date.now(),
      intent,
    });
    const response = await fetch(`${upstreamOrigin}/api/internal/centrifugo-agent-activity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-coforge-centrifugo-proxy-secret": proxySecret,
      },
      body: JSON.stringify({
        user: DEV_BROWSER_USER.id,
        channel,
        b64data: base64(frame),
        meta: { workspace_id: fx.workspaceId, computer_id: fx.computerId },
      }),
    });
    const answer = (await response.json()) as { error?: { code?: number } };
    if (!response.ok || answer.error?.code !== PUBLICATION_REROUTED_CODE)
      throw new Error(
        `the Web did not re-route the reply intent: ${response.status} ${JSON.stringify(answer)}`,
      );
  }

  async function addAgents(conversationId: string) {
    await db.conversationMember.createMany({
      data: fx.agentIds.map((agentId) => ({
        workspaceId: fx.workspaceId,
        conversationId,
        agentId,
      })),
    });
  }

  async function announce(target: string, agentId = fx.agentId) {
    const callId = crypto.randomUUID();
    const start = () => sendFrame({ phase: REPLY_INTENT_PHASE.START, callId, target }, agentId);
    await start();
    const timer = setInterval(() => void start().catch(() => undefined), 5_000);
    return {
      stop: () => clearInterval(timer),
      end: async () => {
        clearInterval(timer);
        await sendFrame({ phase: REPLY_INTENT_PHASE.END, callId, target }, agentId);
      },
    };
  }

  async function agentSends(target: string, content: string) {
    const response = await handleAgentMessagesPost(
      new Request("http://local/api/agent/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, content, idempotencyKey: crypto.randomUUID() }),
      }),
      { workspaceId: fx.workspaceId, agentId: fx.agentId },
      agentMessagesPostDependencies(db),
    );
    const answer = await response.json();
    if (!response.ok || answer.state !== "sent")
      throw new Error(`the Agent's send failed: ${response.status} ${JSON.stringify(answer)}`);
  }

  beforeAll(async () => {
    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: DEV_BROWSER_USER.id, role: "owner" },
      orderBy: { createdAt: "asc" },
      include: { workspace: { select: { slug: true } } },
    });
    fx.workspacePath = `/en/w/${membership.workspace.slug}`;
    fx.workspaceId = membership.workspaceId;
    const workspaceId = fx.workspaceId;
    const writer = await db.user.create({
      data: { displayName: `e2erp${suffix}`, username: `e2erp${suffix}` },
    });
    fx.writerUserId = writer.id;
    await db.workspaceMembership.create({ data: { workspaceId, userId: writer.id } });
    const registration = await new ComputerRegistrar({
      workspaceAccess: new PrismaWorkspaceAccess(db),
      registrations: new PrismaComputerRegistrationRepository(db),
    }).register(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        workspaceSlug: membership.workspace.slug,
        name: `e2erp-${suffix}`,
        displayName: "Replying E2E Computer",
        machineId: `e2erp-${suffix}`,
        platform: "linux",
        osVersion: "e2e",
        computerVersion: "0.1.0",
        registrationIdempotencyKey: crypto.randomUUID(),
      },
      { userId: DEV_BROWSER_USER.id },
    );
    fx.computerId = registration.computerId;
    const agents = new ManageAgents(
      new PrismaAgentRepository(db),
      { start: async () => undefined, stop: async () => undefined },
      { canRun: async () => true },
      { run: async (_agentId, callback) => callback() },
    );
    const createAgent = async (name: string) =>
      (
        await agents.create(
          { userId: DEV_BROWSER_USER.id, workspaceId, role: "admin" },
          {
            name,
            description: "Replying E2E Agent",
            provider: "pi",
            computerId: fx.computerId,
            model: "e2e",
            modelProvider: "e2e",
            reasoning: "balanced",
          },
        )
      ).agent.id;
    fx.agentId = await createAgent(agentName);
    for (const letter of ["b", "c", "d"]) {
      const name = `${agentName}${letter}`;
      fx.otherAgents.push({ id: await createAgent(name), name });
    }

    channels = new PublicChannels(db, new RedisMessageRequestIdempotency(redis), centrifugo);
    fx.joinedId = await fx.createChannel(fx.joinedName);
    const unjoined = await channels.create(workspaceId, writer.id, fx.unjoinedName);
    fx.unjoinedId = unjoined.id;
    createdConversations.push(unjoined.id);
    await addAgents(unjoined.id);
    await prepareAppNotificationQueues(databaseUrl);
    fx.rootId = (await fx.send(fx.joinedId, DEV_BROWSER_USER.id, `Thread root ${suffix}`)).id;
    await fx.send(fx.joinedId, DEV_BROWSER_USER.id, `First reply ${suffix}`, fx.rootId);
    await fx.send(fx.unjoinedId, writer.id, `Read-only channel message ${suffix}`);

    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
  }, 120_000);

  afterAll(async () => {
    await browser("close").catch(() => undefined);
    proxy.stop();
    try {
      await db.message.deleteMany({ where: { conversationId: { in: createdConversations } } });
      await db.conversationMember.deleteMany({
        where: { conversationId: { in: createdConversations } },
      });
      await db.conversation.deleteMany({ where: { id: { in: createdConversations } } });
      await db.agent.deleteMany({
        where: {
          OR: [{ id: { in: fx.agentIds } }, { ownerId: fx.writerUserId }],
        },
      });
      await db.computer.deleteMany({ where: { id: fx.computerId } });
      await db.workspaceMembership.deleteMany({ where: { userId: fx.writerUserId } });
      await db.user.deleteMany({ where: { id: fx.writerUserId } });
      await redis.send("EVAL", [
        'local keys = redis.call("KEYS", ARGV[1]); if #keys > 0 then return redis.call("DEL", unpack(keys)) end return 0',
        "0",
        `*${fx.workspaceId}*`,
      ]);
    } finally {
      redis.close();
      await Promise.all([db.$disconnect(), stopAppNotificationQueue()]);
    }
  });

  return fx;
}
