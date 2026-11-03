import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/**
 * Task #452: a message sent with "Send as Task" shows its Task in the channel stream, its number,
 * status and owner, and the badge opens the Task, with the Workspace's task-conversations
 * experiment off (the message is the Task) and on (the Task is made from the message, as
 * production's Workspace has it). It shows at once (the Task announced) and after a reload (the
 * message window's read).
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`, the server started with a
 * flag file that offers the `task-conversations` flag (docs/feature-flags.md). Each run seeds its
 * own Workspace, so switching the experiment touches no other test. Screenshots are written under
 * `.amp/e2e/send-as-task-stream/`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const centrifugoOrigin = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugoOrigin || !["localhost", "127.0.0.1"].includes(new URL(centrifugoOrigin).hostname))
  throw new Error("COFORGE_E2E_CENTRIFUGO_URL must target local Centrifugo");
const centrifugoApiKey = Bun.env.COFORGE_CENTRIFUGO_API_KEY;
if (!centrifugoApiKey) throw new Error("COFORGE_CENTRIFUGO_API_KEY is required");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/send-as-task-stream");

test("a message sent as a Task shows its Task in the stream, with task conversations off and on", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `send-as-task-stream-${process.pid}`;
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
    if (code !== 0) throw new Error(`Browser ${args[0]} failed: ${stderr}`);
    return stdout;
  }
  /** Waits for `condition`, failing with its text rather than at the test timeout. */
  const waitFor = async (condition: string, ms = 20_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browser("wait", "--fn", condition),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const eval_ = async (expression: string) => JSON.parse(await browser("eval", expression));
  /** The stream row whose body is `body`. */
  const rowOf = (body: string) =>
    `[...document.querySelectorAll("[data-message-id]")].find((row) => row.textContent.includes(${JSON.stringify(body)}))`;
  const badgeOf = (body: string) => `${rowOf(body)}?.querySelector("[data-message-task]")`;

  await db.user.upsert({
    where: { id: DEV_BROWSER_USER.id },
    update: {},
    create: {
      id: DEV_BROWSER_USER.id,
      username: DEV_BROWSER_USER.username,
      displayName: "Task sender",
      welcomedAt: new Date(),
    },
  });
  const suffix = `${process.pid}-${Date.now()}`;
  const workspace = await db.workspace.create({
    data: {
      name: "Send as Task",
      slug: `send-as-task-${suffix}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `send-as-task-${suffix}`,
      description: "",
      members: { create: { userId: DEV_BROWSER_USER.id } },
    },
  });
  // The page reaches Centrifugo on its own origin, as behind the production proxy: the Task a
  // send makes under task conversations reaches the page only as its announcement.
  const proxy = sameOriginProxy(origin!, centrifugoOrigin!);
  const channelPath = `${proxy.origin}/en/w/${workspace.slug}/channel/${channel.id}`;
  const experiments = new PrismaExperimentsRepository(db);
  /** Waits until Centrifugo has a client on the Workspace's conversation channel: this run's own
   * Workspace, so the only one is this page (https://centrifugal.dev/docs/server/server_api#channels). */
  const workspaceChannelSubscribed = async () => {
    const channel = `chat:workspace:${workspace.id}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${centrifugoOrigin}/api/channels`, {
        method: "POST",
        headers: { "X-API-Key": centrifugoApiKey! },
        body: JSON.stringify({ pattern: channel }),
      });
      const { result } = (await response.json()) as {
        result?: { channels?: Record<string, { num_clients: number }> };
      };
      if ((result?.channels?.[channel]?.num_clients ?? 0) > 0) return;
      await Bun.sleep(200);
    }
    throw new Error(`the page never subscribed to ${channel}`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    for (const on of [false, true]) {
      await experiments.write(workspace.id, "taskConversations", on);
      const mode = on ? "on" : "off";
      const body = `Ship the release notes (${mode}) ${suffix}`;
      await browser("open", channelPath);
      const composer = 'textarea[placeholder^="Message #"]';
      await waitFor(`document.querySelector(${JSON.stringify(composer)}) !== null`, 60_000);
      // The Task's announcement rides the Workspace channel; a page that sends before it has
      // subscribed would only see the Task on its next read.
      await workspaceChannelSubscribed();
      await browser("fill", composer, body);
      await browser("press", "Meta+Shift+Enter");

      const task = await (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const found = await db.task.findFirst({
            where: { conversationId: channel.id, title: { contains: `(${mode})` } },
            select: { number: true, messageId: true, sourceMessageId: true },
          });
          if (found) return found;
          await Bun.sleep(200);
        }
        throw new Error(`no Task was made with the experiment ${mode}`);
      })();
      // Off, the message is the Task; on, the Task is made from it and has no message (a server
      // without the flag offered would take the first path both times).
      if (on) {
        expect(task.messageId).toBeNull();
        expect(task.sourceMessageId).not.toBeNull();
      } else expect(task.messageId).not.toBeNull();

      const label = `#${task.number} · To do · Unassigned`;
      const shows = `${badgeOf(body)}?.textContent.trim() === ${JSON.stringify(label)}`;
      // At once, from the announced Task.
      await waitFor(shows);
      await browser("screenshot", join(artifacts, `stream-${mode}.png`));
      // As on Raft, no "task created" notice is posted beside the message.
      expect(
        await db.message.count({ where: { conversationId: channel.id, senderMemberId: null } }),
      ).toBe(0);
      expect(await eval_(`document.body.textContent.includes("new task created")`)).toBe(false);
      // After a reload, from the message window's read.
      await browser("open", channelPath);
      await waitFor(shows, 60_000);

      // The badge opens the Task's popup.
      await browser("eval", `${badgeOf(body)}.click()`);
      await waitFor(`new URL(location.href).searchParams.get("task") === "${task.number}"`);
      await waitFor(
        `[...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent.includes(${JSON.stringify(`(${mode})`)}))`,
      );
      await browser("screenshot", join(artifacts, `popup-${mode}.png`));
      expect(await eval_(`new URL(location.href).searchParams.get("task")`)).toBe(
        String(task.number),
      );
    }
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
    await browser("close").catch(() => undefined);
    proxy.stop();
    await db.$disconnect();
  }
}, 300_000);
