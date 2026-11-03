import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * A hovered message's action bar is a bar of its own (task #459), as Slack's and Raft's: solid,
 * edged and lifted, on the row's top edge, ending where the row's content begins. It never covers
 * the sender line — the time, an Agent's description filling it — nor a continuation's first line,
 * which no longer keeps a blank reserve for it, nor the "new messages" divider's label, under which
 * it comes down onto the sender line. A phone opens the action sheet instead.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent and
 * the messages are seeded per run and removed after it. Screenshots (light, dark, a narrow window,
 * a phone) are written under `.amp/e2e/message-hover-toolbar/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/message-hover-toolbar");

test("a hovered message's action bar covers none of the message", async () => {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const { browser, evaluate } = browserSession(browserPath, `hover-toolbar-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-hover-${suffix}`,
      displayName: "Dax",
      description:
        "Front-end engineer: builds, reviews and ships the web interface, from the design system to the last pixel of every page",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "pi",
        provider: { kind: "default" },
        model: "claude-sonnet-5-5",
        modelProvider: "",
        reasoning: "",
      },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-hover-${suffix}`,
      description: "",
      members: {
        create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const viewerMember = channel.members.find((member) => member.userId === DEV_BROWSER_USER.id)!;
  const bodies: [string, string][] = [
    [viewerMember.id, "Can you look at the header on the settings page?"],
    [agentMember.id, "On it. The header wraps on narrow windows; I am moving the actions."],
    [
      agentMember.id,
      "Second message from the same sender, long enough to run the whole width of the column so its first line reaches the right edge where the bar used to sit.",
    ],
    [agentMember.id, "Done."],
  ];
  const messages = [];
  for (const [index, [senderMemberId, body]] of bodies.entries())
    messages.push(
      await db.message.create({
        data: {
          workspaceId,
          conversationId: channel.id,
          sequence: index + 1,
          senderMemberId,
          body,
          createdAt: new Date(Date.now() - (bodies.length - index) * 1000),
        },
      }),
    );
  await db.conversation.update({
    where: { id: channel.id },
    data: { lastSequence: bodies.length },
  });
  const [, heading, continuation] = messages;
  const row = (id: string) => `document.getElementById("message-${id}")`;
  const bar = (id: string) => `${row(id)}.querySelector("[data-message-toolbar]")`;
  /** Whether the bar shows over the row, and whether it overlaps any of `targets` in it. */
  const overlaps = (id: string, targets: string) =>
    evaluate<{ shown: boolean; hits: string[] }>(`(() => {
      const bar = ${bar(id)};
      const box = bar.getBoundingClientRect();
      const hit = (r) => r.width > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      const hits = [...${row(id)}.querySelectorAll(${JSON.stringify(targets)})]
        .filter((el) => !bar.contains(el))
        .flatMap((el) => [...el.getClientRects()].some(hit) ? [el.textContent.slice(0, 40)] : []);
      return { shown: getComputedStyle(bar).opacity === "1", hits };
    })()`);
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const hover = async (id: string) => {
    await browser("hover", `#message-${id}`);
    await browser("wait", "--fn", `getComputedStyle(${bar(id)}).opacity === "1"`);
    await settled();
  };
  const shotBoth = async (name: string, id: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await hover(id);
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await settled();
  };
  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, label] of [
      [1440, 900, "wide"],
      [1024, 768, "narrow"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await browser("open", page);
      await browser("wait", "--fn", `${pageHydrated} && ${row(continuation!.id)} !== null`);

      // The heading row: the bar is over its top edge, clear of the time and the description.
      await hover(heading!.id);
      const onHeading = await overlaps(heading!.id, "time, button, span, .message-markdown p");
      expect(onHeading.shown).toBe(true);
      expect(onHeading.hits).toEqual([]);
      // The first visit opens with the "new messages" divider over the Agent's first message:
      // the bar comes down onto the sender line, clear of the divider's label and the time.
      if (label === "wide") {
        const divider = await evaluate<{
          hit: boolean;
          shown: boolean;
        }>(`(() => {
          const label = ${row(heading!.id)}.closest("li").querySelector('[role="separator"] > span:last-child');
          const a = label.getBoundingClientRect();
          const b = ${bar(heading!.id)}.getBoundingClientRect();
          return { shown: a.width > 0, hit: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top };
        })()`);
        expect(divider).toEqual({ shown: true, hit: false });
      }
      await shotBoth(`${label}-heading`, heading!.id);

      // A continuation: the bar is above its first line, which runs the column's full width.
      await hover(continuation!.id);
      const onContinuation = await overlaps(continuation!.id, ".message-markdown p, time");
      expect(onContinuation.shown).toBe(true);
      expect(onContinuation.hits).toEqual([]);
      expect(
        await evaluate<number>(
          `${row(continuation!.id)}.querySelector(".message-markdown").getBoundingClientRect().right`,
        ),
      ).toBeGreaterThan(
        await evaluate<number>(`${bar(continuation!.id)}.getBoundingClientRect().left`),
      );
      await shotBoth(`${label}-continuation`, continuation!.id);
    }

    // A phone opens the action sheet; no bar shows over the rows.
    await browser("set", "viewport", "390", "844");
    await browser("open", page);
    await browser("wait", "--fn", `${pageHydrated} && ${row(continuation!.id)} !== null`);
    expect(await evaluate<string>(`getComputedStyle(${bar(heading!.id)}).opacity`)).toBe("0");
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
