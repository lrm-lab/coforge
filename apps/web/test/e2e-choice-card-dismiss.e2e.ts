import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A choice card seen by someone it does not ask (task #413): the card in the stream names whom it
 * waits on in its footer and is read-only, the options listed with nothing to tick, type, send or
 * decline, and a click on one picks nothing. Closed some other way, read when it is mounted later
 * (compact), it goes gray and says why: Withdrawn when it is not the asked person who closed it,
 * "<name> didn't answer" when they did. The viewer is the Agent's owner and an ordinary Workspace
 * member here.
 *
 * The redesign has no control to withdraw a card from the stream (the old Dismiss button); only
 * the asked person closes one, by declining, which `e2e-card-ignore-fold.e2e.ts` covers. The
 * closed states are seeded straight into the database.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The Workspace, channel,
 * Agent, asked peer and card are seeded per run and removed after it. Screenshots are written
 * under `.amp/e2e/choice-card-dismiss/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/choice-card-dismiss");

test("someone else's choice card names whom it waits on and offers nothing to answer", async () => {
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
      body: `${prompt} (1. Red; 2. Blue)`,
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
  const card = `document.querySelector('[data-message-id="${message.id}"] [data-question-card]')`;
  const cardText = `(${card}?.textContent ?? "")`;
  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  const optionSel = (id: string) =>
    `[data-message-id="${message.id}"] [data-question-option="${id}"]`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", page);
    await browser(
      "wait",
      "--fn",
      `${card}?.dataset.questionCard === "pending" && ${cardText}.includes("Waiting on Asked Peer") && ${pageHydrated}`,
    );
    // Not the asked person: the question and its options are there to read, and nothing to answer
    // with or decline.
    expect(await evaluate<string>(cardText)).toContain(prompt);
    expect(await evaluate<string>(`${card}.dataset.questionCardView`)).toBe("full");
    expect(
      await evaluate<string[]>(
        `[...${card}.querySelectorAll("[data-question-option]")].map((option) => option.textContent.trim())`,
      ),
    ).toEqual(["Red", "Blue"]);
    expect(
      await evaluate<boolean>(
        `${card}.querySelector("[data-question-send], [data-question-next], [data-question-other-input], [data-question-decline]") === null`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "waiting.png"));

    // A press on an option picks nothing, and nothing is sent.
    await browser("click", optionSel("a"));
    expect(
      await evaluate<boolean>(
        `[...${card}.querySelectorAll("[data-question-option]")].every((option) => option.getAttribute("aria-selected") !== "true")`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "looking.png"));
    expect(
      (await db.actionCard.findUniqueOrThrow({ where: { messageId: message.id } })).state,
    ).toBe("pending");

    // Closed by someone other than the asked person, it is gray and says it was withdrawn.
    await db.actionCard.update({ where: { messageId: message.id }, data: { state: "cancelled" } });
    await browser("open", page);
    await browser(
      "wait",
      "--fn",
      `${card}?.dataset.questionCard === "cancelled" && ${cardText}.includes("Withdrawn") && ${pageHydrated}`,
    );
    expect(await evaluate<string>(`${card}.dataset.questionCardView`)).toBe("compact");
    expect(await evaluate<boolean>(`${cardText}.includes("Waiting on")`)).toBe(false);
    expect(await evaluate<boolean>(`${cardText}.includes(${JSON.stringify(prompt)})`)).toBe(true);
    await browser("screenshot", join(artifacts, "withdrawn.png"));

    // Declined by the asked person, it names them.
    await db.actionCard.update({
      where: { messageId: message.id },
      data: { committedByUserId: peer.id, committedAt: new Date() },
    });
    await browser("open", page);
    await browser(
      "wait",
      "--fn",
      `${card}?.dataset.questionCard === "cancelled" && ${cardText}.includes("Asked Peer didn't answer") && ${pageHydrated}`,
    );
    await browser("screenshot", join(artifacts, "declined.png"));
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
