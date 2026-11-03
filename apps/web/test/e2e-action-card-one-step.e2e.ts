import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { ActionCards } from "#src/server/conversations/action-cards.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An action card commits its draft in one press and closes to one line in the message (task #449,
 * step 2): Create makes the channel as the card shows it, Add adds the proposed Agent, Dismiss
 * closes a card unmade. The made channel is a link whose tooltip is when it was made, and opens
 * it. A channel name taken since the card was drafted says so and offers no Retry, since sending it
 * again fails the same way.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The channel, its Agents
 * and the cards are seeded per run and removed after it, with the channel the card made.
 * Screenshots, light, dark and phone, are written under `.amp/e2e/action-card-one-step/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/action-card-one-step");

test("an action card commits in one press and closes to one line", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `card-one-step-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const tail = suffix.slice(-5);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const runtimeConfig = {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const makeAgent = (name: string, displayName: string) =>
    db.agent.create({
      data: { workspaceId, name, displayName, ownerId: DEV_BROWSER_USER.id, runtimeConfig },
    });
  const agent = await makeAgent(`card-scout-${tail}`, "Scout");
  const helper = await makeAgent(`card-helper-${tail}`, "Release Helper");
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-one-step-${suffix}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const cards = new ActionCards(db, new PrismaDirectConversationRepository(db));
  const principal = { workspaceId, agentId: agent.id };
  const target = `#${channel.channelName}`;
  const launch = `launch-${tail}`;
  const taken = `taken-${tail}`;
  const created: string[] = [channel.id];
  const message = (id: string) => `document.querySelector('[data-message-id="${id}"]')`;
  /** The card's own box while it waits: its buttons, not the message's. */
  const card = (id: string) => `${message(id)}.querySelector('[role="group"][aria-label]')`;
  /** Presses the button named `name` in the card of message `id`, as a person's click does. */
  const press = async (id: string, name: string) => {
    expect(
      await evaluate<boolean>(`(() => {
        const button = [...${card(id)}.querySelectorAll("button")].find((el) => el.textContent.trim() === ${JSON.stringify(name)});
        button?.setAttribute("data-e2e-press", "");
        button?.scrollIntoView({ block: "center" });
        return Boolean(button);
      })()`),
    ).toBe(true);
    await browser("click", "[data-e2e-press]");
    await evaluate(
      `document.querySelector("[data-e2e-press]")?.removeAttribute("data-e2e-press") ?? true`,
    );
  };
  const buttons = (id: string) =>
    evaluate<string[]>(
      `[...(${card(id)}?.querySelectorAll("button") ?? [])].map((el) => el.textContent.trim())`,
    );
  /** The message's text on screen, without the line a screen reader reads in place of the card. */
  const text = (id: string) =>
    evaluate<string>(`(() => {
      const copy = ${message(id)}.cloneNode(true);
      copy.querySelectorAll(".sr-only").forEach((el) => el.remove());
      return copy.textContent;
    })()`);
  // Colors ease into a new theme: a screenshot waits until no transition is still running.
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shot = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    await settled();
  };
  try {
    await mkdir(artifacts, { recursive: true });
    const createCard = await cards.prepare(principal, {
      target,
      action: {
        type: "channel:create",
        name: launch,
        description: "Where the 2.0 launch is planned, from the first draft to the release notes.",
        initialAgents: [agent.name, helper.name],
      },
    });
    const addCard = await cards.prepare(principal, {
      target,
      action: { type: "channel:add_member", channel: channel.channelName!, agents: [helper.name] },
    });
    const agentCard = await cards.prepare(principal, {
      target,
      action: {
        type: "agent:create",
        name: `card-writer-${tail}`,
        description: "Drafts the release notes from merged pull requests.",
      },
    });
    const takenCard = await cards.prepare(principal, {
      target,
      action: { type: "channel:create", name: taken, draftHint: "For the retro" },
    });
    // Someone made a channel of that name after the card was drafted.
    const takenBy = await db.conversation.create({
      data: { workspaceId, channelName: taken, description: "", members: { create: [] } },
    });
    created.push(takenBy.id);

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${card(takenCard.messageId)} != null`);
    // One primary button for what the card would make; Edit… only where a dialog can change it.
    expect(await buttons(createCard.messageId)).toEqual(["Create", "Edit…", "Dismiss"]);
    expect(await buttons(addCard.messageId)).toEqual(["Add", "Edit…", "Dismiss"]);
    expect(await buttons(agentCard.messageId)).toEqual(["Create…", "Dismiss"]);
    // The channel card's Create waits for the Projects, which say whether its Project still exists.
    await browser(
      "wait",
      "--fn",
      `[...${card(createCard.messageId)}.querySelectorAll("button")].every((el) => !el.disabled)`,
    );
    await shot("pending");

    // The name taken since: said so, and the primary button renames it in the dialog, since
    // sending it again would fail the same way.
    await press(takenCard.messageId, "Create");
    await browser(
      "wait",
      "--fn",
      `${message(takenCard.messageId)}.querySelector('[role="alert"]') != null`,
    );
    expect(await text(takenCard.messageId)).toContain(`There's already a channel named #${taken}.`);
    expect(await buttons(takenCard.messageId)).toEqual(["Rename…", "Dismiss"]);
    await evaluate(`${card(takenCard.messageId)}.scrollIntoView({ block: "center" }) ?? true`);
    await shot("failed");
    await press(takenCard.messageId, "Rename…");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] input')?.value === ${JSON.stringify(taken)}`,
    );
    await browser("press", "Escape");
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') == null`);

    // Create, Add and Dismiss each close their card to one line.
    await press(createCard.messageId, "Create");
    await press(addCard.messageId, "Add");
    await press(agentCard.messageId, "Dismiss");
    const link = `[...${message(createCard.messageId)}.querySelectorAll("a")].find((el) => el.textContent === ${JSON.stringify(`#${launch}`)})`;
    await browser(
      "wait",
      "--fn",
      `${link} !== undefined && ${card(addCard.messageId)} == null && ${card(agentCard.messageId)} == null`,
    );
    const made = await db.conversation.findFirstOrThrow({
      where: { workspaceId, channelName: launch },
      select: { id: true, members: { select: { agentId: true } } },
    });
    created.push(made.id);
    // The Agents the card named, beside any the Workspace adds to every new channel.
    expect(made.members.map((member) => member.agentId)).toEqual(
      expect.arrayContaining([agent.id, helper.id]),
    );
    expect(
      await db.conversationMember.count({
        where: { conversationId: channel.id, agentId: helper.id },
      }),
    ).toBe(1);
    expect(await text(createCard.messageId)).toContain(`Created channel #${launch}`);
    expect(await text(addCard.messageId)).toContain(`Added members Release Helper → ${target}`);
    expect(await text(agentCard.messageId)).toContain("Cancelled");
    // The viewer's own commit is not followed by their name.
    expect(await text(createCard.messageId)).not.toContain(DEV_BROWSER_USER.name);

    // The made channel's tooltip is when it was made. React Aria opens a hover tooltip once the
    // page has seen a pointer press, which a person has always made by now.
    await browser("click", "textarea[data-composer]");
    await evaluate(`${link}.setAttribute("data-e2e-made", "") ?? true`);
    await browser("hover", "[data-e2e-made]");
    await browser(
      "wait",
      "--fn",
      `/\\d/.test(document.querySelector('[role="tooltip"]')?.textContent ?? "")`,
    );
    await shot("handled");

    // Phone: the same lines, nothing past the screen's edge.
    await browser("set", "viewport", "390", "844");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${message(takenCard.messageId)} != null`);
    await evaluate(`${message(createCard.messageId)}.scrollIntoView({ block: "center" }) ?? true`);
    expect(await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`)).toBe(
      true,
    );
    await browser("screenshot", join(artifacts, "phone-handled.png"));
    await evaluate(`${message(takenCard.messageId)}.scrollIntoView({ block: "center" }) ?? true`);
    await browser("screenshot", join(artifacts, "phone-pending.png"));

    // The link opens the channel it made.
    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}/en/w/${workspace.slug}/channel/${channel.id}`);
    await browser("wait", "--fn", `${pageHydrated} && ${link} !== undefined`);
    await evaluate(`${link}.setAttribute("data-e2e-made", "") ?? true`);
    await browser("click", "[data-e2e-made]");
    await browser("wait", "--fn", `location.pathname.endsWith(${JSON.stringify(made.id)})`);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
    await db.agentMessageDelivery
      .deleteMany({ where: { agentId: { in: [agent.id, helper.id] } } })
      .catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [agent.id, helper.id] } } })
      .catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
