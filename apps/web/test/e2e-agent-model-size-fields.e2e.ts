import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * The runtime dialog's context window and maximum output fields show only where they do anything
 * (task #coforge-designer-team:#124): an Agent on Pi with the Computer's own providers has them,
 * one on Claude Code does not. Seeds a Computer and two Agents and removes them after the run.
 * Screenshots, desktop and phone, light and dark, are under `.amp/e2e/agent-model-size-fields/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-model-size-fields");

test("only an Agent whose runtime reads them shows the model size fields", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `model-sizes-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const computerName = `E2E Studio ${suffix}`;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-sizes-${suffix}`,
      name: `e2e-sizes-${suffix}.local`,
      displayName: computerName,
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  await db.computerRuntime.createMany({
    data: [
      {
        workspaceId,
        computerId: computer.id,
        provider: "claude-code",
        version: "1.0.0",
        displayName: "Claude Code",
      },
      {
        workspaceId,
        computerId: computer.id,
        provider: "pi",
        version: "1.0.0",
        displayName: "Pi",
      },
    ],
  });
  const seed = async (runtime: string, displayName: string) => {
    const agent = await db.agent.create({
      data: {
        workspaceId,
        computerId: computer.id,
        name: `e2e-sizes-${runtime}-${suffix}`,
        displayName,
        ownerId: DEV_BROWSER_USER.id,
        runtimeConfig: {
          runtime,
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
          // Saved before the fields were limited: read back without an error either way.
          contextWindow: 200_000,
        },
      },
    });
    const direct = await db.conversation.create({
      data: {
        workspaceId,
        directKey: agentDirectKey(DEV_BROWSER_USER.id, agent.id),
        members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
      },
    });
    return { agent, direct };
  };
  const pi = await seed("pi", "Pia");
  const claude = await seed("claude-code", "Clara");

  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const sizeField = `[...document.querySelectorAll('[role="dialog"] label')].some((label) => label.textContent.trim().startsWith("Context window"))`;
  const openDialog = async (directId: string) => {
    await browser("open", `${origin}/en/w/${workspace.slug}/dm/${directId}`);
    const profile = `[...document.querySelectorAll("button")].find((b) => b.querySelector("h1"))`;
    const pencil = `document.querySelector('button[aria-label="Edit runtime configuration"]')`;
    await browser("wait", "--fn", `${pageHydrated} && (${pencil} != null || ${profile} != null)`);
    // A phone opens the profile from the header; a desktop shows it beside the chat already.
    if (!(await evaluate<boolean>(`${pencil} != null`))) await press(profile);
    await browser("wait", "--fn", `${pencil} != null`);
    await press(pencil);
    await browser("wait", "--fn", `document.querySelector('[role="dialog"] form') != null`);
    await browser("wait", "1500");
  };
  const shots = async (name: string) => {
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
  };
  const openCreateDialog = async () => {
    await browser("open", `${origin}/en/w/${workspace.slug}/members?setup=create-agent`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.querySelector('[role="dialog"]') != null`,
    );
    const localRadio = `[...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent.trim() === "Local Computer")`;
    if (await evaluate<boolean>(`${localRadio} != null`)) await press(localRadio);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] input[name="name"]') != null`,
    );
    await browser("find", "role", "button", "click", "--name", "Computer");
    await browser("find", "role", "option", "click", "--name", computerName);
    await browser("wait", "500");
  };
  const selectCreateRuntime = async (runtimeLabel: "Claude Code" | "Pi") => {
    await browser("find", "role", "button", "click", "--name", "Runtime");
    await browser("find", "role", "option", "click", "--name", runtimeLabel, "--exact");
    await browser("wait", "400");
    await evaluate(`(() => {
      const target =
        document.querySelector('[role="dialog"] input[name="contextWindow"]') ??
        document.querySelector('[role="dialog"] form > div > *:last-child');
      target?.scrollIntoView({ block: "end", behavior: "instant" });
      return Boolean(target);
    })()`);
    await browser("wait", "150");
  };
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, device] of [
      [1440, 900, "desktop"],
      [390, 844, "phone"],
    ] as const) {
      await browser("set", "viewport", String(width), String(height));
      await openDialog(pi.direct.id);
      expect(await evaluate<boolean>(sizeField)).toBe(true);
      await shots(`${device}-pi`);
      await openDialog(claude.direct.id);
      expect(await evaluate<boolean>(sizeField)).toBe(false);
      await shots(`${device}-claude`);

      await openCreateDialog();
      await selectCreateRuntime("Claude Code");
      expect(await evaluate<boolean>(sizeField)).toBe(false);
      await shots(`create-${device}-claude`);
      await selectCreateRuntime("Pi");
      expect(
        await evaluate<boolean>(
          `[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.includes("Configured on this Computer"))`,
        ),
      ).toBe(true);
      expect(await evaluate<boolean>(sizeField)).toBe(true);
      await shots(`create-${device}-pi`);
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [pi.direct.id, claude.direct.id] } } })
      .catch(() => undefined);
    await db.agent
      .deleteMany({ where: { id: { in: [pi.agent.id, claude.agent.id] } } })
      .catch(() => undefined);
    await db.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
