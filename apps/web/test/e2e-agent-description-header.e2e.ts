import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent's message header names what the Agent is for (task #414), as Raft's does: the first
 * line of its description after its name and model, before the time. In a narrow pane the
 * description gives way first; the name and the time stay whole.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agent and
 * the Agent's message are seeded per run and removed after it. Screenshots (light, dark, a phone)
 * are written under `.amp/e2e/agent-description-header/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-description-header");

test("an Agent's message header shows the first line of its description", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `agent-description-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const firstLine = "Front-end engineer: builds and reviews the web interface";
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-dax-${suffix}`,
      displayName: "Dax",
      description: `\n${firstLine}\nSecond line the header leaves out.`,
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
      channelName: `e2e-description-${suffix}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: "I build and review the web interface.",
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
  const row = `document.querySelector('[data-message-id="${message.id}"]')`;
  const label = `[...${row}.querySelectorAll("button")].find((el) => el.textContent === ${JSON.stringify(firstLine)})`;
  const page = `${origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  /** The label's own width and the width its text would need. */
  const widths = () =>
    evaluate<[number, number]>(
      `(() => { const el = ${label}; return [el.clientWidth, el.scrollWidth]; })()`,
    );
  const shown = async () => {
    await browser("open", page);
    await browser("wait", "--fn", `${row} !== null && ${label} !== undefined && ${pageHydrated}`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    await shown();
    // Name, model, then the first non-blank line, whole; the rest of the description is not in
    // the header.
    const order = await evaluate<number[]>(
      `["Dax", "claude-sonnet-5-5", ${JSON.stringify(firstLine)}].map((text) => ${row}.textContent.indexOf(text))`,
    );
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(await evaluate<boolean>(`${row}.textContent.includes("Second line")`)).toBe(false);
    const [wide, needed] = await widths();
    expect(wide).toBeGreaterThanOrEqual(needed);
    await browser("screenshot", join(artifacts, "light.png"));

    await browser("eval", `localStorage.setItem("coforge-theme", "dark")`);
    await shown();
    await browser("screenshot", join(artifacts, "dark.png"));
    await browser("eval", `localStorage.removeItem("coforge-theme")`);

    // A phone: the description is cut, the name and the time are not.
    await browser("set", "viewport", "390", "844");
    await shown();
    const [narrow, full] = await widths();
    expect(narrow).toBeLessThan(full);
    const nameCut = await evaluate<boolean>(
      `[...${row}.querySelectorAll("*")].some((el) => el.children.length === 0 && el.textContent === "Dax" && el.scrollWidth > el.clientWidth)`,
    );
    expect(nameCut).toBe(false);
    expect(
      await evaluate<number>(`${row}.querySelector("time").getBoundingClientRect().right`),
    ).toBeLessThanOrEqual(390);
    await browser("screenshot", join(artifacts, "phone.png"));
  } finally {
    await browser("eval", `localStorage.removeItem("coforge-theme")`).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: agent.id } })
      .catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
