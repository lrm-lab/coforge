import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent whose credential the Daemon holds it on (task #90): the process stays up, so the
 * display is live, yet only a person can clear the cause. The DM header, the Computer's roster and
 * the profile banner name it as the stop, and the banner offers Retry, which is the panel's plain
 * Start (never a Stop first: a Stop would drop what the hold kept). Seeds an online Computer, an
 * Agent and the display the Daemon would report; screenshots, light, dark and phone, are under
 * `.amp/e2e/agent-held-credential/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-held-credential");

test("a live Agent held on its credential asks a person, and Retry is a Start", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `held-credential-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-held-${suffix}`,
      name: `e2e-held-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-held-${suffix}`,
      displayName: "Dorothy",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "claude-code",
        provider: { kind: "default" },
        model: "",
        modelProvider: "",
        reasoning: "",
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
  const scope = { workspaceId, computerId: computer.id, agentId: agent.id };
  await getComputerStatusCache().put(scope, true);
  const frame = (clientSeq: number) => ({
    protocolMajor: 1,
    requestId: `held-${suffix}-${clientSeq}`,
    ...scope,
    daemonInstanceId: `e2e-${suffix}`,
    clientSeq,
    observedAtMs: Date.now() + clientSeq,
  });
  const display = getAgentDisplay();
  const launchId = `launch-${suffix}`;
  const logged =
    "Claude Code is not logged in on this machine. Please log in to Claude Code locally, then retry starting this Agent.";
  // The process stays up: an active status, then the held failure, and no "inactive" after it.
  await display.observeStatus({ ...frame(1), status: "active" } as never);
  await display.observeActivity(
    {
      ...frame(2),
      detailKind: "runtime_error",
      level: "error",
      detail: logged,
      launchId,
      runtimeError: {
        errorClass: "AuthenticationError",
        errorReason: "auth_failed",
        fingerprint: `fp-${suffix}`,
        requiredAction: "user_reauth",
      },
    } as never,
    { daemonInstanceId: `e2e-${suffix}`, launchId },
  );

  const until = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate<boolean>(expression)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const press = async (selector: string) => {
    await evaluate(`(${selector}.setAttribute("data-press", ""), true)`);
    await browser("click", "[data-press]");
    await evaluate(`(document.querySelector("[data-press]")?.removeAttribute("data-press"), true)`);
  };
  const shots = async (name: string) => {
    await browser(
      "wait",
      "--fn",
      `document.getAnimations().every((a) => a.playState !== "running")`,
    );
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`(document.documentElement.classList.add("dark-mode"), true)`);
    await browser("wait", "300");
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`(document.documentElement.classList.remove("dark-mode"), true)`);
    await browser("wait", "300");
  };
  const page = (locale: string, path: string) => `${origin}/${locale}/w/${workspace.slug}${path}`;
  const profile = `[...document.querySelectorAll("button")].find((b) => b.querySelector("h1"))`;
  const banner = `document.querySelector(".bg-error-primary")?.textContent ?? ""`;
  const retry = (word: string) =>
    `[...document.querySelectorAll(".bg-error-primary button")].find((b) => b.textContent.trim() === ${JSON.stringify(word)})`;
  const openProfile = async (locale: string) => {
    await browser("open", page(locale, `/dm/${direct.id}`));
    await until(`${pageHydrated} && ${profile} != null`);
    await press(profile);
    await until(`${banner}.includes(${JSON.stringify(logged)})`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await openProfile("en");
    await shots("profile-en-desktop");
    expect(
      await evaluate<boolean>(`${retry("Retry")} != null && !${retry("Retry")}.disabled`),
    ).toBe(true);
    // The Computer is online: no offline note beside Retry.
    expect(await evaluate<string>(banner)).not.toContain("Computer offline");

    // Retry sends one Start and nothing else: record every request naming a control action.
    await evaluate(`(() => {
      window.__controls = [];
      const send = window.fetch;
      window.fetch = (input, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes('"action"')) window.__controls.push(body);
        return send(input, init);
      };
      return true;
    })()`);
    await press(retry("Retry"));
    await until(`window.__controls.length > 0`);
    await browser("wait", "1000");
    const sent = await evaluate<string[]>(`window.__controls`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"s":"start"');
    expect(sent[0]).not.toContain('"s":"stop"');

    await openProfile("zh-CN");
    await shots("profile-zh-CN-desktop");
    expect(await evaluate<boolean>(`${retry("重试")} != null`)).toBe(true);

    await browser("set", "viewport", "390", "844");
    await openProfile("en");
    await shots("profile-en-phone");

    await browser("set", "viewport", "1280", "860");
    await browser("open", page("en", `/computer/${computer.id}`));
    const roster = `[...document.querySelectorAll(".text-error-primary")].some((e) => e.textContent.includes(${JSON.stringify(logged)}))`;
    await until(`${pageHydrated} && ${roster}`);
    await shots("computer-en-desktop");
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: direct.id } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
