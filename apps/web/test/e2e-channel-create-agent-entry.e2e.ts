import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const browserPath = Bun.which("agent-browser");
if (!browserPath) throw new Error("agent-browser is required");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/channel-create-agent-entry");

test("the add view creates an Agent named by the search, and it joins the channel", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = `channel-create-agent-${process.pid}`;
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
  async function evaluate<T>(expression: string): Promise<T> {
    return JSON.parse(JSON.parse(await browser("eval", `JSON.stringify(${expression})`))) as T;
  }
  const waitFor = (condition: string, ms = 20_000) =>
    Promise.race([
      browser("wait", "--fn", condition),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${condition}`)), ms),
      ),
    ]);
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((element) => element.textContent.trim().startsWith(${JSON.stringify(text)})).at(-1)`;
  async function clickText(selector: string, text: string) {
    await waitFor(`${byText(selector, text)} !== undefined`);
    await browser("eval", `${byText(selector, text)}.click()`);
  }
  const panel = `document.querySelector('[role="dialog"][aria-label="Channel details and settings"]')`;
  const panelHas = (text: string) => `${panel}?.textContent.includes(${JSON.stringify(text)})`;
  const agentForm = `[...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.querySelector('input[name="name"]'))`;

  async function openPanel() {
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    for (let attempt = 0; ; attempt += 1) {
      await browser("click", '[aria-label="Channel details and settings"]');
      const opened = await waitFor(`${panel} !== null`, 5_000).then(
        () => true,
        () => false,
      );
      if (opened) break;
      if (attempt === 5) throw new Error("the channel settings panel never opened");
    }
  }
  async function chooseClaudeCode() {
    await waitFor(
      `${agentForm}.querySelector('button[aria-label="Refresh model catalog"]:not([disabled])') != null`,
    );
    const picked = JSON.parse(
      await browser(
        "eval",
        `(async () => {
        const dialog = ${agentForm};
        if (!dialog) return "no-dialog";
        const trigger = [...dialog.querySelectorAll('button[aria-haspopup="listbox"]')].find((button) => (button.getAttribute("aria-labelledby") ?? "").split(" ").some((id) => document.getElementById(id)?.textContent.includes("Runtime")));
        if (!trigger) return "no-trigger";
        trigger.click();
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent.includes("Claude Code"));
          if (option) {
            option.click();
            return "clicked";
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return "no-option";
      })()`,
      ),
    ) as string;
    if (picked !== "clicked") throw new Error(`runtime picker: ${picked}`);
    await waitFor(
      `[...${agentForm}.querySelectorAll("button")].some((button) => button.textContent.trim() === "Claude Code")`,
    );
  }

  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const workspacePath = `/en/w/${membership.workspace.slug}`;
  const workspaceId = membership.workspaceId;
  const channel = await db.conversation.create({
    data: { workspaceId, channelName: `e2e-create-agent-${process.pid}`, description: "" },
  });
  const agentName = `e2e-joined-${process.pid}`;
  try {
    await db.conversationMember.create({
      data: {
        conversationId: channel.id,
        workspaceId,
        userId: DEV_BROWSER_USER.id,
        channelRole: "admin",
      },
    });
    await mkdir(artifacts, { recursive: true });

    await browser("set", "viewport", "1440", "900");
    await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
    await waitFor(
      `document.querySelector('[aria-label="Channel details and settings"]') !== null`,
      60_000,
    );
    await openPanel();

    await waitFor(`${panel}?.querySelector('[aria-label="Add members"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Add members"]').click()`);
    await waitFor(panelHas("Add selected (0)"));
    await waitFor(panelHas("Create Agent"));
    expect(
      await evaluate<boolean>(
        panelHas(`(joins #${channel.channelName} automatically after creation)`),
      ),
    ).toBe(true);

    await browser("fill", 'input[placeholder="Name"]', agentName);
    await waitFor(panelHas(`No members match “${agentName}”`));
    await waitFor(panelHas(`Create Agent “${agentName}”`));
    await browser("screenshot", join(artifacts, "entry.png"));

    await clickText(`[role="dialog"] button`, `Create Agent “${agentName}”`);
    await waitFor(`${agentForm} !== undefined`);
    await waitFor(
      `${agentForm}.textContent.includes(${JSON.stringify(`Joins #${channel.channelName} automatically after it is created.`)})`,
    );
    const form = await evaluate<{ name: string; visibilityDisabled: boolean }>(`(() => {
      const dialog = ${agentForm};
      const makePrivate = [...dialog.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest("label")?.textContent.includes("Make private"));
      return {
        name: dialog.querySelector('input[name="name"]').value,
        visibilityDisabled: makePrivate?.disabled === true,
      };
    })()`);
    expect(form).toEqual({ name: agentName, visibilityDisabled: true });
    await browser("screenshot", join(artifacts, "form.png"));

    await chooseClaudeCode();

    await clickText(`[role="dialog"] button`, "Create Agent");
    await waitFor(`${agentForm} === undefined`);
    await waitFor(`!${panelHas(`No members match “${agentName}”`)}`);
    const created = await db.agent.findFirstOrThrow({ where: { workspaceId, name: agentName } });
    expect(created.visibility).toBe("public");
    expect(
      await db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId: created.id, leftAt: null },
      }),
    ).not.toBeNull();
    expect(
      await evaluate<string>(`${panel}.querySelector('input[placeholder="Name"]').value`),
    ).toBe("");
    await browser("screenshot", join(artifacts, "joined.png"));

    await browser("fill", 'input[placeholder="Name"]', agentName);
    await waitFor(panelHas(`No members match “${agentName}”`));
    await waitFor(`!${panelHas(`Create Agent “`)}`);
    await clickText(`[role="dialog"] button`, "Create Agent");
    await waitFor(`${agentForm} !== undefined`);
    await browser("fill", '[role="dialog"]:has(input[name="name"]) input[name="name"]', agentName);
    await chooseClaudeCode();
    await clickText(`[role="dialog"] button`, "Create Agent");
    await waitFor(`${agentForm}?.querySelector('[role="alert"]')?.textContent.trim().length > 0`);
    expect(await evaluate<boolean>(`${panel} !== null`)).toBe(true);
    await browser("screenshot", join(artifacts, "refused.png"));
    await clickText(`[role="dialog"] button`, "Cancel");
    await waitFor(`${byText(`[role="dialog"] button`, "Discard changes")} !== undefined`);
    await clickText(`[role="dialog"] button`, "Discard changes");
    await waitFor(`${agentForm} === undefined`);
    expect(await db.agent.count({ where: { workspaceId, name: agentName } })).toBe(1);

    await db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
      data: { role: "member" },
    });
    await browser("open", `${origin}${workspacePath}/channel/${channel.id}`);
    await openPanel();
    await waitFor(`${panel}?.querySelector('[aria-label="Add members"]') != null`);
    await browser("eval", `${panel}.querySelector('[aria-label="Add members"]').click()`);
    await waitFor(panelHas("only a Workspace owner or admin can create Agents"));
    expect(
      await evaluate<boolean>(
        `[...${panel}.querySelectorAll("button")].some((button) => button.textContent.startsWith("Create Agent"))`,
      ),
    ).toBe(false);
    await browser("screenshot", join(artifacts, "denied.png"));
  } finally {
    await db.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: DEV_BROWSER_USER.id } },
      data: { role: "owner" },
    });
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { workspaceId, name: agentName } });
    await browser("close").catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
