import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Activity's "Waiting on you" section (task #413): a choice card that asks the viewer heads the
 * All view, one that asks someone else does not appear, and answering it from the conversation the
 * row opens takes it off the list.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent and
 * peer and both cards are seeded per run and removed after it. Screenshots are written under
 * `.amp/e2e/activity-waiting/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/activity-waiting");

test("a choice card asking the viewer waits in Activity until they answer it", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `activity-waiting-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const peer = await db.user.create({
    data: { username: `e2e-waiting-peer-${suffix}`, displayName: "Waiting Peer" },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id } });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-waiting-agent-${suffix}`,
      displayName: "Waiting Agent",
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
      channelName: `e2e-waiting-${suffix}`,
      description: "",
      members: {
        create: [
          { userId: DEV_BROWSER_USER.id, channelRole: "admin" },
          { userId: peer.id },
          { agentId: agent.id },
        ],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const card = async (sequence: number, prompt: string, to: string) => {
    const options = [
      { id: "a", label: "Red" },
      { id: "b", label: "Blue" },
    ];
    const message = await db.message.create({
      data: {
        workspaceId,
        conversationId: channel.id,
        sequence,
        senderMemberId: agentMember.id,
        body: `${prompt} (A. Red; B. Blue)`,
      },
    });
    await db.actionCard.create({
      data: {
        messageId: message.id,
        conversationId: channel.id,
        workspaceId,
        kind: "choice",
        payload: { type: "choice", prompt, options, to },
        preparedByAgentId: agent.id,
      },
    });
    return message.id;
  };
  const mine = `E2E waiting mine ${suffix}`;
  const theirs = `E2E waiting theirs ${suffix}`;
  // Three older cards for the viewer too: four in all, past the three the section shows.
  const older = [1, 2, 3].map((index) => `E2E waiting older ${index} ${suffix}`);
  for (const [index, prompt] of older.entries()) await card(index + 1, prompt, DEV_BROWSER_USER.id);
  await card(4, theirs, peer.id);
  const mineId = await card(5, mine, DEV_BROWSER_USER.id);
  const section = `document.querySelector('ol[aria-label="Waiting on you"]')`;
  const listed = (prompt: string) =>
    `(${section}?.textContent ?? "").includes(${JSON.stringify(prompt)})`;
  const pick = `[data-message-id="${mineId}"] button[aria-label="A. Red"]`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/activity`);
    await browser("wait", "--fn", `${listed(mine)} && ${pageHydrated}`);
    // Only the card that asks the viewer: the other asks the peer.
    expect(await evaluate<boolean>(listed(theirs))).toBe(false);
    // Three show, newest first, the heading counts all four, and the oldest is behind "1 more".
    const shownRows = `${section}.querySelectorAll(":scope > li").length`;
    expect(await evaluate<number>(shownRows)).toBe(3);
    expect(await evaluate<boolean>(listed(older[0]!))).toBe(false);
    expect(await evaluate<string>(`${section}.previousElementSibling.textContent`)).toContain(
      "· 4",
    );
    await browser("screenshot", join(artifacts, "waiting.png"));
    await browser("find", "text", "1 more", "click");
    await browser("wait", "--fn", listed(older[0]!));
    expect(await evaluate<number>(shownRows)).toBe(4);

    // The row opens the conversation at the card, which the viewer answers there.
    await browser("find", "text", mine, "click");
    await browser("wait", "--fn", `document.querySelector('${pick}') !== null`);
    // The pane may still be scrolling to the card when the option first appears, and a click on
    // a moving target lands beside it: click again until the card closes on the pick.
    const closed = `document.querySelector('${pick}') === null`;
    for (let attempt = 0; !(await evaluate<boolean>(closed)); attempt++) {
      if (attempt === 5) throw new Error("the pick never landed");
      await browser("click", pick).catch(() => undefined);
      for (let poll = 0; poll < 15 && !(await evaluate<boolean>(closed)); poll++)
        await Bun.sleep(200);
    }
    await browser("wait", "--fn", `!${listed(mine)}`);
    await browser("screenshot", join(artifacts, "answered.png"));
    const answered = await db.actionCard.findUniqueOrThrow({ where: { messageId: mineId } });
    expect(answered.state).toBe("executed");
    expect(answered.result).toMatchObject({ optionId: "a" });
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId, userId: peer.id } })
      .catch(() => undefined);
    await db.user.deleteMany({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
