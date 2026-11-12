import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { devBrowserWorkspace } from "./helpers/browser-e2e";
import { chromePath, launchHeadlessChrome, until } from "./helpers/headless-chrome";

/**
 * Task #98 (Frank, 11-12): in a message box, Enter sent the first message but the second needed
 * Cmd+Enter. Every message box sends with Enter, again and again: a channel, a direct message, a
 * thread and a Task's discussion each take four messages in a row by Enter, typed as plain keys and
 * through an input method (the way Chinese is typed), and a forward's note goes with Enter twice.
 *
 * Opt-in like the other browser E2Es: the real local Web and a headless Chrome over DevTools, with
 * real key events. The Agent, channel and DM are seeded per run and removed after it.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
const databaseUrl = Bun.env.DATABASE_URL;
const chrome = chromePath();

test("every message box sends with Enter twice in a row, typed plainly or through an IME", async () => {
  if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
  if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
    throw new Error("DATABASE_URL must target local PostgreSQL");
  if (!chrome) throw new Error("Chrome is required (COFORGE_E2E_CHROME)");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const tail = `${process.pid}-${Date.now()}`.slice(-5);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-enter-${tail}`,
      displayName: `Enter Agent ${tail}`,
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
      channelName: `e2e-enter-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
    include: { members: true },
  });
  const agentMember = channel.members.find((member) => member.agentId === agent.id)!;
  const root = await db.message.create({
    data: {
      workspaceId,
      conversationId: channel.id,
      sequence: 1,
      senderMemberId: agentMember.id,
      body: `Thread root ${tail}`,
    },
  });
  await db.conversation.update({ where: { id: channel.id }, data: { lastSequence: 1 } });
  const { conversationId: dmId } = await new DirectConversations(db).open(
    workspaceId,
    DEV_BROWSER_USER.id,
    { agentId: agent.id },
  );

  const experiments = new PrismaExperimentsRepository(db);
  const taskConversationsBefore = (await experiments.read(workspaceId)).taskConversations;
  await experiments.write(workspaceId, "taskConversations", true);
  const created = await new TaskBoard(db).execute({ workspaceId, userId: DEV_BROWSER_USER.id }, {
    idempotencyKey: crypto.randomUUID(),
    conversationId: channel.id,
    operation: "create",
    titles: [`Enter twice ${tail}`],
  } as Parameters<TaskBoard["execute"]>[1]);
  const taskNumber = created.tasks[0]!.number;

  const browser = await launchHeadlessChrome(chrome);
  let page!: Awaited<ReturnType<typeof browser.open>>;
  const base = `${origin}/en/w/${workspace.slug}`;
  /** Presses Enter. `ime229` sends it as Chrome on macOS does with a Chinese input method once
   * the field was cleared under it (a sent message): keyCode 229, with no composition going on. */
  const press = async (ime229 = false) => {
    for (const type of ["keyDown", "keyUp"] as const)
      await page.command("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: type === "keyDown" && ime229 ? 229 : 13,
        nativeVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
  };
  /** Types `text` as an input method does: a composition of pinyin, then the committed text. */
  const typeThroughIme = async (pinyin: string, text: string) => {
    for (let index = 1; index <= pinyin.length; index++)
      await page.command("Input.imeSetComposition", {
        text: pinyin.slice(0, index),
        selectionStart: index,
        selectionEnd: index,
      });
    await page.command("Input.insertText", { text });
  };
  /** The conversation's composer, or with a thread open the thread pane's (the later one). */
  const composer = (which: "first" | "last") =>
    `[...document.querySelectorAll("textarea[data-composer]")].at(${which === "first" ? 0 : -1})`;
  const sent = (text: string) =>
    until(
      () =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll("[data-message-id]")].some((row) => row.textContent.includes(${JSON.stringify(text)}))`,
        ),
      10_000,
    ).then(
      () => true,
      () => false,
    );
  /** Sends four messages by Enter: typed plainly, through an IME (Enter a moment after the
   * candidate is picked, as a person presses it), and each again with the Enter reported as 229;
   * which arrived. */
  const sendTwice = async (scope: "first" | "last", label: string) => {
    const results: Record<string, boolean> = {};
    await until(() => page.evaluate<boolean>(`${composer(scope)}?.disabled === false`), 60_000);
    await page.evaluate(`${composer(scope)}.focus()`);
    for (const round of [1, 2, 3, 4]) {
      const text = `${label} ${round} ${tail}`;
      const ime = round % 2 === 0;
      const ime229 = round > 2;
      if (!ime) await page.command("Input.insertText", { text });
      else {
        await page.command("Input.insertText", { text: `${text} ` });
        await typeThroughIme("nihao", "你好");
        await Bun.sleep(150);
      }
      await press(ime229);
      results[`${label} #${round}${ime ? " IME" : ""}${ime229 ? " Enter=229" : ""}`] =
        await sent(text);
    }
    return results;
  };

  try {
    page = await browser.open(`${base}/channel/${channel.id}`);
    await page.command("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const results: Record<string, boolean> = {
      ...(await sendTwice("first", "channel")),
      ...(await (async () => {
        await page.command("Page.navigate", { url: `${base}/dm/${dmId}` });
        return sendTwice("first", "dm");
      })()),
      ...(await (async () => {
        await page.command("Page.navigate", {
          url: `${base}/channel/${channel.id}?threadRootId=${root.id}`,
        });
        return sendTwice("last", "thread");
      })()),
    };
    Object.assign(
      results,
      await (async () => {
        await page.command("Page.navigate", {
          url: `${base}/tasks?task=${channel.id}:${taskNumber}`,
        });
        return sendTwice("last", "task");
      })(),
    );

    // A forward's note goes with Enter, the second time too (with the Enter marked 229).
    for (const round of [1, 2]) {
      await page.command("Page.navigate", { url: `${base}/channel/${channel.id}` });
      await until(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('li[data-message-id="${root.id}"] [aria-label="More"]') != null && (!window.$_TSR || window.$_TSR.hydrated === true)`,
          ),
        60_000,
      );
      await page.evaluate(
        `document.querySelector('li[data-message-id="${root.id}"] [aria-label="More"]').click()`,
      );
      await until(() =>
        page.evaluate<boolean>(
          `[...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.trim() === "Forward")`,
        ),
      );
      await page.evaluate(
        `[...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "Forward").click()`,
      );
      const target = `[role="dialog"] input[type="checkbox"][aria-label*="e2e-enter-${tail}"]`;
      await until(() =>
        page.evaluate<boolean>(`document.querySelector('[role="dialog"] textarea') != null`),
      );
      await page.evaluate(
        `document.querySelector('input[placeholder="Search channels, people or Agents"]').focus()`,
      );
      await page.command("Input.insertText", { text: `e2e-enter-${tail}` });
      await until(() =>
        page.evaluate<boolean>(`document.querySelector(${JSON.stringify(target)}) != null`),
      );
      await page.evaluate(`document.querySelector(${JSON.stringify(target)}).click()`);
      await page.evaluate(`document.querySelector('[role="dialog"] textarea').focus()`);
      const note = `forward note ${round} ${tail}`;
      await page.command("Input.insertText", { text: note });
      await press(round === 2);
      results[`forward note #${round}${round === 2 ? " Enter=229" : ""}`] = await until(
        () =>
          page.evaluate<boolean>(
            `document.querySelector('[role="dialog"]') == null && document.body.textContent.includes("Forwarded to")`,
          ),
        10_000,
      ).then(
        () => true,
        () => false,
      );
    }

    // Enter while a word is still being composed only confirms it: nothing is sent until the next
    // Enter, a moment after the word is in.
    await page.command("Page.navigate", { url: `${base}/channel/${channel.id}` });
    await until(() => page.evaluate<boolean>(`${composer("first")}?.disabled === false`), 60_000);
    await page.evaluate(`${composer("first")}.focus()`);
    const composed = `composing ${tail}`;
    await page.command("Input.insertText", { text: `${composed} ` });
    await page.command("Input.imeSetComposition", {
      text: "nihao",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await press(true);
    await Bun.sleep(1500);
    results["Enter while composing sends nothing"] = !(await page.evaluate<boolean>(
      `[...document.querySelectorAll("[data-message-id]")].some((row) => row.textContent.includes(${JSON.stringify(composed)}))`,
    ));
    await page.command("Input.insertText", { text: "你好" });
    await Bun.sleep(150);
    await press();
    results["the next Enter sends it"] = await sent(composed);
    console.log(JSON.stringify(results, null, 2));
    expect(Object.entries(results).filter(([, ok]) => !ok)).toEqual([]);
  } finally {
    await browser.close();
    await experiments
      .write(workspaceId, "taskConversations", taskConversationsBefore === true)
      .catch(() => {});
    await db.conversation.deleteMany({ where: { id: { in: [channel.id, dmId] } } }).catch(() => {});
    await db.agentMessageDelivery.deleteMany({ where: { agentId: agent.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => {});
    await db.$disconnect();
  }
}, 240_000);
