import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { TaskBoard } from "#src/server/tasks/task-board.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * Esc steps back one popup at a time inside one channel (task #478): from a parent's popup, a
 * sub-task opened from its Sub-tasks tab, and from a sub-task's popup, the parent opened from its
 * properties. Each time Esc returns to the popup it was opened from, and only that one closes on
 * the next Esc. On the channel's page and on the Tasks page, on a desktop and a phone.
 *
 * Opt-in like the other browser E2Es: real local Web started with the `task-conversations` flag
 * file (`/tmp/coforge-flags-tc.json`, read here too), and `agent-browser`. The channel and its
 * Tasks are seeded per run and removed after it. Screenshots are written under
 * `.amp/e2e/task-popup-esc/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/task-popup-esc");

test("Esc steps back to the popup a sub-task or a parent was opened from", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-tc.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `task-esc-${process.pid}`);
  const board = new TaskBoard(db);
  const experiments = new PrismaExperimentsRepository(db);
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id },
    include: { workspace: { select: { slug: true } } },
  });
  const as = { workspaceId, userId: DEV_BROWSER_USER.id };
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  // A second member, for the composer's `@` completion to offer.
  const peer = await db.user.create({
    data: { username: `esc-peer-${tail}`, displayName: `Esc Peer ${tail}` },
  });
  await db.workspaceMembership.create({ data: { workspaceId, userId: peer.id, role: "member" } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-esc-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { userId: peer.id }] },
    },
  });
  // Another channel for the composer's `#` completion to offer.
  const other = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-esc-ref-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }] },
    },
  });
  const before = (await experiments.read(workspaceId)).taskConversations;
  try {
    await experiments.write(workspaceId, "taskConversations", true);
    const run = (command: Record<string, unknown>) =>
      board.execute(as, {
        idempotencyKey: crypto.randomUUID(),
        conversationId: channel.id,
        ...command,
      } as Parameters<TaskBoard["execute"]>[1]);
    const parentTitle = `Parent work ${tail}`;
    const childTitle = `Child step ${tail}`;
    const parent = (await run({ operation: "create", title: parentTitle })).tasks[0]!.number;
    const child = (
      await run({ operation: "create", title: childTitle, parent: { number: parent } })
    ).tasks[0]!.number;

    const dialog = `document.querySelector('[role="dialog"]')`;
    const showing = (title: string) =>
      `${dialog}?.querySelector("h2")?.textContent.includes(${JSON.stringify(title)}) === true`;
    const settled = () =>
      browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
    const press = async (selector: string) => {
      expect(
        await evaluate<boolean>(
          `(() => { const el = ${selector}; if (!el) return false; el.setAttribute("data-e2e-press", ""); return true; })()`,
        ),
      ).toBe(true);
      await browser("click", "[data-e2e-press]");
      await evaluate(
        `document.querySelectorAll("[data-e2e-press]").forEach((el) => el.removeAttribute("data-e2e-press")) ?? true`,
      );
    };
    const pressText = (text: string, roles: string) =>
      press(
        `[...${dialog}.querySelectorAll(${JSON.stringify(roles)})].find((el) => el.textContent.includes(${JSON.stringify(text)}))`,
      );
    /** Esc with focus wherever it is left: on the page once the row that opened a step is gone,
     * or back in the popup's composer. (Focus on the dialog itself is `e2e-task-popup-steps`.) */
    const esc = async () => {
      await settled();
      await evaluate(`(document.activeElement?.blur?.(), true)`);
      await browser("press", "Escape");
    };
    const shoot = async (name: string) => {
      await settled();
      await browser("screenshot", join(artifacts, `${name}.png`));
      await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
      await browser("screenshot", join(artifacts, `${name}-dark.png`));
      await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
    };
    await mkdir(artifacts, { recursive: true });

    const pages = {
      channel: (number: number) =>
        `${origin}/zh-CN/w/${workspace.slug}/channel/${channel.id}?task=${number}`,
      tasks: (number: number) =>
        `${origin}/zh-CN/w/${workspace.slug}/tasks?task=${encodeURIComponent(`${channel.id}:${number}`)}`,
    };
    for (const [width, height, label] of [
      [1280, 860, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      for (const [where, page] of Object.entries(pages)) {
        // From the parent's Sub-tasks tab into the sub-task, then Esc back to the parent.
        await browser("open", page(parent));
        await browser("wait", "--fn", `${pageHydrated} && ${showing(parentTitle)}`);
        await pressText("子任务", '[role="tab"]');
        await browser(
          "wait",
          "--fn",
          `${dialog}.textContent.includes(${JSON.stringify(childTitle)})`,
        );
        await pressText(childTitle, 'button, [role="button"], [role="row"]');
        await browser("wait", "--fn", showing(childTitle));
        await shoot(`${label}-${where}-1-subtask`);
        await esc();
        await browser("wait", "--fn", showing(parentTitle));
        await shoot(`${label}-${where}-2-back-to-parent`);
        await esc();
        await browser("wait", "--fn", `${dialog} === null`);

        // From the sub-task's properties up to its parent, then Esc back to the sub-task.
        await browser("open", page(child));
        await browser("wait", "--fn", `${pageHydrated} && ${showing(childTitle)}`);
        await press(
          `[...${dialog}.querySelectorAll("dd button, dd [role=button], dd a")].find((el) => el.textContent.includes(${JSON.stringify(parentTitle)}))`,
        );
        await browser("wait", "--fn", showing(parentTitle));
        await esc();
        await browser("wait", "--fn", showing(childTitle));
        await esc();
        await browser("wait", "--fn", `${dialog} === null`);
      }
    }

    // What sits inside or over the popup has Esc first, on the first popup and on a step alike:
    // an input method still composing in the discussion's composer keeps it (only the IME
    // cancels), the composer's `#` completion closes alone, and a menu or a confirmation over the
    // popup closes alone. Only the next Esc is the popup's.
    await browser("set", "viewport", "1280", "860");
    const composer = `${dialog}.querySelector("textarea[data-composer]")`;
    const layers = `document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]').length`;
    const stays = async (title: string, count: number) => {
      await settled();
      await Bun.sleep(400);
      await settled();
      expect(await evaluate<boolean>(showing(title))).toBe(true);
      expect(await evaluate<number>(layers)).toBe(count);
    };
    for (const [state, title] of [
      ["first", parentTitle],
      ["step", childTitle],
    ] as const) {
      await browser("open", pages.channel(parent));
      await browser("wait", "--fn", `${pageHydrated} && ${showing(parentTitle)}`);
      if (state === "step") {
        await pressText("子任务", '[role="tab"]');
        await browser(
          "wait",
          "--fn",
          `${dialog}.textContent.includes(${JSON.stringify(childTitle)})`,
        );
        await pressText(childTitle, 'button, [role="button"], [role="row"]');
        await browser("wait", "--fn", showing(childTitle));
      }
      await browser("wait", "--fn", `${composer} !== null`);

      // An IME composing: Chrome sends Escape as keyCode 229 with `isComposing`.
      expect(
        await evaluate<boolean>(
          `(() => { const t = ${composer}; t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); return true; })()`,
        ),
      ).toBe(true);
      await stays(title, 1);

      // The `#` and `@` completions: one Esc closes the list and only the list; it stays closed
      // (the key's own keyup must not reopen it), the popup stays and so does focus.
      for (const [trigger, typed] of [
        ["channel", `#e2e-esc-ref-${tail}`],
        ["mention", "@Esc"],
      ] as const) {
        await browser("fill", '[role="dialog"] textarea[data-composer]', typed);
        await browser("wait", "--fn", `${composer}.hasAttribute("aria-controls")`);
        await shoot(`guard-${state}-1-${trigger}`);
        await browser("press", "Escape");
        await browser("wait", "--fn", `!${composer}.hasAttribute("aria-controls")`);
        await stays(title, 1);
        expect(await evaluate<boolean>(`${composer}.hasAttribute("aria-controls")`)).toBe(false);
        expect(await evaluate<boolean>(`document.activeElement === ${composer}`)).toBe(true);
        await browser("fill", '[role="dialog"] textarea[data-composer]', "");
      }

      // The ··· menu over the popup: Esc closes the menu alone.
      await press(`${dialog}.querySelector('button[aria-label*="的更多操作"]')`);
      await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
      await browser("press", "Escape");
      await browser("wait", "--fn", `document.querySelector('[role="menu"]') === null`);
      await stays(title, 1);

      // A confirmation over the popup (delete): Esc closes the confirmation alone.
      await press(`${dialog}.querySelector('button[aria-label*="的更多操作"]')`);
      await browser("wait", "--fn", `document.querySelector('[role="menu"]') !== null`);
      await press(
        `[...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.includes("删除任务"))`,
      );
      await browser("wait", "--fn", `${layers} === 2`);
      await shoot(`guard-${state}-2-confirm`);
      await browser("press", "Escape");
      await browser("wait", "--fn", `${layers} === 1`);
      await stays(title, 1);

      // Nothing over it: Esc is the popup's again. (Focus came back to the ··· button, whose
      // tooltip would take the next Esc first, as React Aria's tooltips do; read the title.)
      await press(`${dialog}.querySelector("h2")`);
      await esc();
      if (state === "step") {
        await browser("wait", "--fn", showing(parentTitle));
        await esc();
      }
      await browser("wait", "--fn", `${dialog} === null`);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await experiments.write(workspaceId, "taskConversations", before).catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, other.id] } } })
      .catch(() => undefined);
    await db.user.delete({ where: { id: peer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
