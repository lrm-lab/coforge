import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { publishConversationReadChanged } from "#src/server/conversations/conversation-read-realtime.server";
import { browserSession, localBrowserE2e } from "./helpers/browser-e2e";

/**
 * An Agent reading the viewer's DM message shows "Read" under it without a reload (task #230).
 * The suite sends a message from the page, then advances the Agent's read position and publishes
 * `conversation.read.v1` exactly as the server does when the Agent reads. Realtime needs the
 * same-origin proxy (`scripts/e2e/same-origin-proxy.ts`): run with
 * `COFORGE_E2E_WEB_URL=http://127.0.0.1:8790`. Screenshots live in .amp/e2e/direct-agent-read-live/.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const artifacts = join(import.meta.dir, "../../../.amp/e2e/direct-agent-read-live");
const { browser, evaluate } = browserSession(browserPath, `agent-read-${process.pid}`);
let slug = "";
let workspaceId = "";
let computerId = "";
let agentId = "";
let conversationId = "";
let agentMemberId = "";
const probe = "read probe";
const tick = (state: "sent" | "read") =>
  `Boolean(document.querySelector('main [data-message="own"] [data-read-state="${state}"]'))`;

// The suite's own Computer, Agent and DM, so it never writes to a real Agent's conversation.
beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  slug = membership.workspace.slug;
  workspaceId = membership.workspaceId;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `agent-read-${process.pid}`,
      name: `agent-read-${process.pid}`,
      platform: "darwin",
    },
  });
  computerId = computer.id;
  await db.workspaceComputer.create({ data: { workspaceId, computerId } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      ownerId: DEV_BROWSER_USER.id,
      computerId,
      name: `agent-read-${process.pid}`,
      displayName: "Read Probe",
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  agentId = agent.id;
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      directKey: `agent:${agentId}|user:${DEV_BROWSER_USER.id}`,
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { agentId }],
      },
    },
  });
  conversationId = conversation.id;
  agentMemberId = (
    await db.conversationMember.findUniqueOrThrow({
      where: { conversationId_agentId: { conversationId, agentId } },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  try {
    await browser("close");
  } finally {
    if (conversationId) await db.conversation.delete({ where: { id: conversationId } });
    if (agentId) await db.agent.delete({ where: { id: agentId } });
    if (computerId) {
      await db.workspaceComputer.deleteMany({ where: { computerId } });
      await db.computer.delete({ where: { id: computerId } });
    }
    await db.$disconnect();
  }
});

test("an Agent's read turns the viewer's message into two ticks without a reload", async () => {
  await browser("set", "viewport", "1280", "900");
  await browser("open", `${origin}/en/w/${slug}/dm/${conversationId}`);
  await browser("wait", "main textarea");
  await browser("fill", "main textarea", probe);
  await browser("press", "Enter");
  let message: { sequence: number } | null = null;
  for (let i = 0; i < 50 && !message; i++) {
    message = await db.message.findFirst({
      where: { conversationId, body: probe },
      select: { sequence: true },
    });
    if (!message) await Bun.sleep(200);
  }
  expect(message).not.toBeNull();
  // Let the page take in its own message before the Agent reads it.
  await Bun.sleep(1500);
  await browser("screenshot", join(artifacts, "before-read.png"));
  expect(await evaluate<boolean>(tick("sent"))).toBe(true);
  expect(await evaluate<boolean>(tick("read"))).toBe(false);
  await db.conversationMember.updateMany({
    where: { conversationId, agentId },
    data: { agentReadThroughSequence: message!.sequence },
  });
  await publishConversationReadChanged(createCentrifugoServerApi(), {
    workspaceId,
    conversationId,
    memberId: agentMemberId,
    readThroughSequence: message!.sequence,
  });
  let read = false;
  for (let i = 0; i < 25 && !read; i++) {
    read = await evaluate<boolean>(tick("read"));
    if (!read) await Bun.sleep(200);
  }
  await browser("screenshot", join(artifacts, "after-read.png"));
  expect(read).toBe(true);
}, 120_000);
