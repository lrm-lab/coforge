import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { PrismaClient } from "#src/generated/prisma/client";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent stopped because its runtime is signed out (task #682): the reason, red with a warning
 * sign, in the DM header, a channel's member list and the Computer's roster, in English and
 * Chinese; the Agent's profile adds what to do. Seeds a Computer, an Agent and the display the
 * Daemon would report, and removes them after the run. Screenshots, light, dark and phone, are
 * under `.amp/e2e/agent-sign-in-status/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-sign-in-status");

test("a signed-out runtime's Agent says so, and what to do", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `sign-in-status-${process.pid}`);
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const { workspaceId, workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: { select: { slug: true } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `e2e-sign-in-${suffix}`,
      name: `e2e-sign-in-${suffix}.local`,
      displayName: "E2E Studio",
      kind: "local",
      workspaces: { create: { workspaceId } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId,
      computerId: computer.id,
      name: `e2e-sign-in-${suffix}`,
      displayName: "Dorothy",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {
        runtime: "cursor",
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
      channelName: `e2e-sign-in-${suffix}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
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
  const frame = (clientSeq: number) => ({
    protocolMajor: 1,
    requestId: `sign-in-${suffix}-${clientSeq}`,
    ...scope,
    daemonInstanceId: `e2e-${suffix}`,
    clientSeq,
    observedAtMs: Date.now() + clientSeq,
  });
  const display = getAgentDisplay();
  const launchId = `launch-${suffix}`;
  // The Daemon's own sentence for the failure, as the Activity log shows it: the banner shows it
  // word for word, and never the provider's raw error beside it (Frank, 11-09).
  const logged =
    "Cursor is not logged in on this machine. Please log in to Cursor locally, then retry starting this Agent.";
  // Every surface names the stop in that sentence, whatever the page's language (Frank, 11-09).
  const words: Record<string, string> = { en: logged, "zh-CN": logged };
  const said = words.en!;
  await display.observeStatus({ ...frame(1), status: "active" } as never);
  await display.observeActivity(
    {
      ...frame(2),
      detailKind: "runtime_error",
      level: "error",
      detail: logged,
      launchId,
      runtimeError: {
        errorClass: "AuthError",
        errorReason: "auth_failed",
        fingerprint: `fp-${suffix}`,
        providerMessage: '401 "invalid api key"',
      },
    } as never,
    { daemonInstanceId: `e2e-${suffix}`, launchId },
  );
  await display.observeStatus({ ...frame(3), status: "inactive" } as never);

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
  /** The element saying `word`: red, with a warning sign beside it and no status dot. */
  const warning = (word: string) => `(() => {
    const el = [...document.querySelectorAll("p,span")].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(word)}).find((e) => e.getClientRects().length > 0);
    if (!el) return false;
    const row = el.closest(".text-error-primary");
    return !!row && !!(row.querySelector("svg") ?? row.parentElement.querySelector("svg"));
  })()`;
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
  /** The avatars in a channel's header open its member list; they show from `md` up. */
  const membersButton = `document.querySelector('[aria-label="Members"] button, [aria-label="成员"] button')`;
  const memberList = async (locale: string, word: string, name: string, width: string) => {
    await browser("open", page(locale, `/channel/${channel.id}`));
    if (width === "390") {
      // A phone's header has no avatars: the way in is the channel's settings.
      const settings = `document.querySelector('header button[aria-label="Channel details and settings"], header button[aria-label="群聊详情与设置"]')`;
      await until(`${pageHydrated} && ${settings} != null`);
      await press(settings);
      const strip = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /Members|成员/.test((b.getAttribute("aria-label") ?? "") + b.textContent))`;
      await until(`${strip} != null`);
      await press(strip);
    } else {
      await until(`${pageHydrated} && ${membersButton} != null`);
      await press(membersButton);
    }
    await until(warning(word));
    await shots(name);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    for (const [width, height, device] of [
      ["1280", "860", "desktop"],
      ["390", "844", "phone"],
    ] as const) {
      await browser("set", "viewport", width, height);
      for (const locale of ["en", "zh-CN"]) {
        const word = words[locale]!;
        await browser("open", page(locale, `/dm/${direct.id}`));
        await until(`${pageHydrated} && ${warning(word)}`);
        await shots(`dm-${locale}-${device}`);
        await memberList(locale, word, `members-${locale}-${device}`, width);
        await browser("set", "viewport", width, height);
      }
    }
    // A long name keeps its width on a phone: the warning has its own line.
    await db.agent.update({
      where: { id: agent.id },
      data: { displayName: "运行时未登录的长名字测试助手" },
    });
    await browser("open", page("zh-CN", `/dm/${direct.id}`));
    await until(`${pageHydrated} && ${warning(words["zh-CN"]!)}`);
    const nameFits = `(() => { const h = document.querySelector("h1"); return h.scrollWidth <= h.clientWidth; })()`;
    expect(await evaluate<boolean>(nameFits)).toBe(true);
    await shots("dm-zh-CN-phone-long-name");
    await db.agent.update({ where: { id: agent.id }, data: { displayName: "Dorothy" } });

    await browser("set", "viewport", "1280", "860");
    await browser("open", page("en", `/channel/${channel.id}`));
    const agentAvatar = `[...document.querySelectorAll('[aria-label="Members"] *')].find((e) => e.matches('button, a, [role="button"], [aria-label]') && e.textContent.trim() === "Dorothy")`;
    await until(`${pageHydrated} && ${agentAvatar} != null`);
    await evaluate(`(${agentAvatar}.setAttribute("data-hover", ""), true)`);
    // React Aria takes a hover for a pointer's only once the pointer has pressed something.
    await browser("mouse", "move", "800", "400");
    await browser("mouse", "down");
    await browser("mouse", "up");
    await browser("hover", "[data-hover]");
    await until(warning(said));
    await shots("hover-en-desktop");

    await browser("open", page("en", `/dm/${direct.id}`));
    const profile = `[...document.querySelectorAll("button")].find((b) => b.querySelector("h1"))`;
    await until(`${pageHydrated} && ${profile} != null`);
    await press(profile);
    const banner = `document.querySelector(".bg-error-primary")?.textContent ?? ""`;
    await until(`${banner}.includes(${JSON.stringify(logged)})`);
    await shots("profile-en-desktop");
    expect(await evaluate<string>(banner)).not.toContain("invalid api key");
    // Stopped until a person acts, so the banner offers to start it again (task #731); its
    // Computer is offline here, so the button waits and says why instead of failing on press.
    const retry = `[...document.querySelectorAll(".bg-error-primary button")].find((b) => b.textContent.trim() === "Retry")`;
    expect(await evaluate<boolean>(`${retry} != null && ${retry}.disabled`)).toBe(true);
    expect(await evaluate<string>(banner)).toContain("Computer offline");
    await browser("set", "viewport", "390", "844");
    await browser("open", page("en", `/dm/${direct.id}`));
    await until(`${pageHydrated} && ${profile} != null`);
    await press(profile);
    await until(`${banner}.includes(${JSON.stringify(logged)})`);
    await shots("profile-en-phone");
    await browser("set", "viewport", "1280", "860");
    await browser("open", page("zh-CN", `/dm/${direct.id}`));
    await until(`${pageHydrated} && ${profile} != null`);
    await press(profile);
    await until(`${banner}.includes(${JSON.stringify(logged)})`);
    await shots("profile-zh-CN-desktop");
    expect(
      await evaluate<boolean>(
        `[...document.querySelectorAll(".bg-error-primary button")].some((b) => b.textContent.trim() === "重试") && document.querySelector(".bg-error-primary").textContent.includes("电脑离线")`,
      ),
    ).toBe(true);
    await browser("open", page("en", `/computer/${computer.id}`));
    await until(`${pageHydrated} && ${warning(said)}`);
    await shots("computer-en-desktop");
    expect(await evaluate<boolean>(warning(said))).toBe(true);
  } finally {
    await browser("close").catch(() => undefined);
    await db.conversation
      .deleteMany({ where: { id: { in: [channel.id, direct.id] } } })
      .catch(() => undefined);
    await db.agent.delete({ where: { id: agent.id } }).catch(() => undefined);
    await db.computer.delete({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
