import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A choice card seen by someone it does not ask (task #413): it names whom it waits on, offers no
 * option to press, and lets the asking Agent's owner withdraw it, after which it reads Cancelled.
 * The owner is an ordinary Workspace member here, so the admin rule cannot stand in for theirs.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The Workspace, channel,
 * Agent, asked peer and card are seeded per run and removed after it. Screenshots are written
 * under `.amp/e2e/choice-card-dismiss/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/choice-card-dismiss");

test("the Agent's owner sees whom a choice card waits on and can withdraw it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `choice-dismiss-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const peer = await db.user.create({
    data: { username: `e2e-dismiss-peer-${suffix}`, displayName: "Asked Peer" },
  });
  // A Workspace of its own where the viewer is an ordinary member: withdrawing is for the Agent's
  // owner or a Workspace admin, so the dev user's usual owner role would pass this either way.
  const workspace = await db.workspace.create({
    data: {
      slug: `e2e-dismiss-${suffix}`,
      name: "E2E Dismiss",
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, role: "member" },
          { userId: peer.id, role: "member" },
        ],
      },
    },
  });
  const workspaceId = workspace.id;
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-dismiss-agent-${suffix}`,
      displayName: "Asking Agent",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-dismiss-${suffix}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const prompt = `E2E dismiss ${suffix}`;
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: `${prompt} (A. Red; B. Blue)`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
  await db.actionCard.create({
    data: {
      messageId: message.id,
      conversationId: channel.id,
      workspaceId,
      kind: "choice",
      payload: {
        type: "choice",
        prompt,
        options: [
          { id: "a", label: "Red" },
          { id: "b", label: "Blue" },
        ],
        to: peer.id,
      },
      preparedByAgentId: agent.id,
    },
  });
  const card = `document.querySelector('[data-message-id="${message.id}"] [role="group"]')`;
  const cardText = `(${card}?.textContent ?? "")`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser(
      "wait",
      "--fn",
      `${cardText}.includes("Waiting for Asked Peer") && ${pageHydrated}`,
    );
    // Not the asked person: the options are listed, not pressable, so Dismiss is the one button.
    expect(
      await evaluate<string[]>(`[...${card}.querySelectorAll("button")].map((b) => b.textContent)`),
    ).toEqual(["Dismiss"]);
    await browser("screenshot", join(artifacts, "waiting.png"));

    // Scoped to the card: the notifications banner has a "Dismiss" too.
    await browser("click", `[data-message-id="${message.id}"] [role="group"] button`);
    await browser("wait", "--fn", `${cardText}.includes("Cancelled")`);
    expect(await evaluate<boolean>(`${cardText}.includes("Waiting for")`)).toBe(false);
    await browser("screenshot", join(artifacts, "dismissed.png"));
    const dismissed = await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(dismissed.state).toBe("cancelled");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
