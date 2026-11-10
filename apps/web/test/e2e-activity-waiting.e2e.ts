import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, cpuThrottle, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

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
        body: `${prompt} (1. Red; 2. Blue)`,
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
  // The first option, Red.
  const pick = `[data-message-id="${mineId}"] li:first-child > button[data-choice-row]`;
  let throttle: Awaited<ReturnType<typeof cpuThrottle>> | undefined;
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

    // The keyboard walks the waiting cards with the rest (Frank, 11-10, task #51): Down from the
    // filter tabs enters the list at its first row, the newest card, and Down and Up move on.
    const focusedWaiting = `[...${section}.querySelectorAll(":scope > li")].findIndex((row) => row.contains(document.activeElement))`;
    await evaluate(
      `([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim().startsWith("All")).focus(), true)`,
    );
    await browser("press", "ArrowDown");
    expect(await evaluate<number>(focusedWaiting)).toBe(0);
    await browser("press", "ArrowDown");
    expect(await evaluate<number>(focusedWaiting)).toBe(1);
    await browser("press", "ArrowUp");
    expect(await evaluate<number>(focusedWaiting)).toBe(0);
    // From the page itself, with nothing focused, Down enters it too.
    await evaluate(`(document.activeElement.blur(), true)`);
    await browser("press", "ArrowDown");
    expect(await evaluate<number>(focusedWaiting)).toBe(0);
    await browser("find", "text", "1 more", "click");
    await browser("wait", "--fn", listed(older[0]!));
    expect(await evaluate<number>(shownRows)).toBe(4);

    // The row opens the conversation at the card, which the viewer answers there. Nothing may move
    // the card once its options show (task #72): the notification banner over the composer used to
    // arrive a beat later, shrink the pane and, the pane following its latest message, carry the
    // card up by the banner's height under the press, which then landed on the next option. On a
    // slowed CPU, as on a busy phone, that beat is long enough to press into.
    throttle = await cpuThrottle(browser, "/activity");
    await throttle.set(6);
    await evaluate(
      `(window.__pickTops = [], (function watch() { const b = document.querySelector('${pick}'); if (b) window.__pickTops.push(Math.round(b.getBoundingClientRect().top)); if (window.__pickTops.length < 90) requestAnimationFrame(watch); })(), true)`,
    );
    await browser("find", "text", mine, "click");
    await browser("wait", "--fn", "window.__pickTops.length >= 90");
    const tops = await evaluate<number[]>("window.__pickTops");
    expect(new Set(tops).size).toBe(1);
    await browser("click", pick);
    await throttle.set(1);
    await browser("wait", "--fn", `document.querySelector('${pick}') === null`);
    await browser("wait", "--fn", `!${listed(mine)}`);
    await browser("screenshot", join(artifacts, "answered.png"));
    const answered = await db.actionCard.findUniqueOrThrow({ where: { messageId: mineId } });
    expect(answered.state).toBe("executed");
    expect(answered.result).toMatchObject({ optionId: "a" });
  } finally {
    throttle?.close();
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
