import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  menuItemNamed,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/external-agent");

test("external Agent: page credential, browser-approved login, presence, revoke and replace", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `ext-agent-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-8);
  const agentName = `ext-long-agent-name-${tail}`;
  const machineName = `build-server-very-long-machine-name-for-break-ui-check-${tail}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  let createdAgentId: string | undefined;

  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
  };
  const shots = async (name: string) => {
    await shoot(name);
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await shoot(`${name}-dark`);
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/members`);
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && [...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === "New Agent")`,
    );

    await browser("find", "role", "button", "click", "--name", "New Agent", "--exact");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] input[value="external"]') !== null`,
    );
    await browser("click", `label:has(input[value="external"])`);
    await browser("fill", `input[name="name"]`, agentName);
    await browser("click", `[role="dialog"] button[type="submit"]`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[data-testid="external-agent-credential"]') !== null`,
    );
    const prompt = await evaluate<string>(
      `document.querySelector('[data-testid="external-agent-prompt"]').textContent`,
    );
    expect(prompt).toContain(`${origin}/cli/install.sh`);
    expect(prompt).toContain(`coforge agent login --server ${origin} --agent ${agentName}`);
    expect(prompt).toContain("message send --target '@");
    expect(prompt).toContain("inbox check");
    const pageKey = await evaluate<string>(
      `document.querySelector('[data-testid="external-agent-credential"]').textContent.trim()`,
    );
    expect(pageKey.startsWith("sk_ext_")).toBe(true);
    expect(
      await evaluate<string>(
        `document.querySelector('[data-testid="external-agent-state"]').dataset.state`,
      ),
    ).toBe("waiting");
    await shots("1-connect-waiting");
    await browser("set", "viewport", "390", "844");
    await shoot("1-connect-waiting-phone");
    await browser("set", "viewport", "1280", "860");

    const agentRow = await db.agent.findFirst({
      where: { workspaceId, name: agentName, deletedAt: null },
      select: { id: true, displayName: true },
    });
    expect(agentRow).not.toBeNull();
    expect(agentRow!.displayName).toBe(agentName);
    createdAgentId = agentRow!.id;

    const ctxRes = await fetch(`${origin}/api/agent/v1/context`, {
      headers: { authorization: `Bearer ${pageKey}` },
    });
    expect(ctxRes.status).toBe(200);
    const ctx = (await ctxRes.json()) as { prompt: { text: string } | null };
    expect(ctx.prompt?.text).toContain("COFORGE_PROFILE");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[data-testid="external-agent-state"]')?.dataset.state === "online"`,
    );
    await shots("2-connect-online");

    const eventsRes = await fetch(`${origin}/api/agent/v1/events`, {
      headers: { authorization: `Bearer ${pageKey}` },
    });
    expect(eventsRes.status).toBe(200);

    const remRes = await fetch(`${origin}/api/agent/v1/reminders`, {
      method: "POST",
      headers: { authorization: `Bearer ${pageKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        workspaceId,
        computerId: "external",
        agentId: createdAgentId,
        operation: "schedule",
        title: "test",
        target: "#general",
        messageId: crypto.randomUUID(),
        fireAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(remRes.status).toBe(409);
    expect(((await remRes.json()) as { code?: string }).code).toBe(
      "reminders_unsupported_for_external_agents",
    );

    const deviceResponse = await fetch(`${origin}/oauth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "coforge-cli",
        machine_name: machineName,
        hostname: `${machineName}.internal.example`,
        os: "linux 6.8.0-generic",
        client_name: "coforge-cli 0.1.0",
      }),
    });
    expect(deviceResponse.status).toBe(200);
    const grant = (await deviceResponse.json()) as {
      device_code: string;
      user_code: string;
    };

    await browser("open", `${origin}/en/oauth/verify`);
    await browser("wait", "--fn", pageHydrated);
    await browser(
      "fill",
      `input[autocomplete="one-time-code"], input[inputmode="text"]`,
      grant.user_code.replace(/-/g, ""),
    );
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes(${JSON.stringify(machineName)})`,
    );
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes(${JSON.stringify(`@${agentName}`)})`,
    );
    await browser("click", `label:has(input[value="${createdAgentId}"])`);
    await browser(
      "wait",
      "--fn",
      `document.querySelector('input[value="${createdAgentId}"]')?.checked === true`,
    );
    await shots("3-device-verify");
    await browser("set", "viewport", "390", "844");
    await shoot("3-device-verify-phone");
    await browser("set", "viewport", "1280", "860");
    await browser("find", "role", "button", "click", "--name", "Approve");
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes(${JSON.stringify(machineName)}) === false`,
    );

    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: grant.device_code,
        client_id: "coforge-cli",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const deviceKey = ((await tokenResponse.json()) as { api_key: string }).api_key;
    expect(deviceKey.startsWith("sk_ext_")).toBe(true);
    expect(
      (
        await fetch(`${origin}/api/agent/v1/context`, {
          headers: { authorization: `Bearer ${deviceKey}` },
        })
      ).status,
    ).toBe(200);

    const chooseInRowMenu = async (rowText: string, item: string) => {
      expect(
        await evaluate<boolean>(
          `(() => { const row = [...document.querySelectorAll('[data-testid="external-agent-credential-row"]')].find((el) => el.textContent?.includes(${JSON.stringify(rowText)})); row?.querySelector('button[aria-label="Credential actions"]')?.setAttribute("data-e2e-menu", ""); return Boolean(row); })()`,
        ),
      ).toBe(true);
      await browser("click", "[data-e2e-menu]");
      await browser("wait", "--fn", `Boolean(${menuItemNamed(item)})`);
      await browser("find", "role", "menuitem", "click", "--name", item);
    };
    const confirmInDialog = async (label: string) => {
      await browser(
        "wait",
        "--fn",
        `document.querySelector('[role="alertdialog"], [role="dialog"]') !== null`,
      );
      expect(
        await evaluate<boolean>(
          `(() => { const button = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find((el) => el.textContent?.trim() === ${JSON.stringify(label)}); button?.setAttribute("data-e2e-confirm", ""); return Boolean(button); })()`,
        ),
      ).toBe(true);
      await browser("click", "[data-e2e-confirm]");
    };
    const rowCount = () =>
      evaluate<number>(
        `document.querySelectorAll('[data-testid="external-agent-credential-row"]').length`,
      );

    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/members?profile=agent:${createdAgentId}`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.innerText.includes(${JSON.stringify(machineName)})`,
    );
    expect(await rowCount()).toBe(2);
    await shots("4-profile-online");
    await browser("set", "viewport", "390", "844");
    await shoot("4-profile-online-phone");
    await browser("set", "viewport", "1280", "860");

    await chooseInRowMenu(machineName, "Revoke");
    await confirmInDialog("Revoke");
    await browser(
      "wait",
      "--fn",
      `document.querySelectorAll('[data-testid="external-agent-credential-row"]').length === 1`,
    );
    expect(
      (
        await fetch(`${origin}/api/agent/v1/context`, {
          headers: { authorization: `Bearer ${deviceKey}` },
        })
      ).status,
    ).toBe(401);

    await chooseInRowMenu("Created on this page", "Create new credential");
    await confirmInDialog("Create new credential");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[data-testid="external-agent-credential"]') !== null`,
    );
    const replacedKey = await evaluate<string>(
      `document.querySelector('[data-testid="external-agent-credential"]').textContent.trim()`,
    );
    expect(replacedKey).not.toBe(pageKey);
    expect(
      (
        await fetch(`${origin}/api/agent/v1/context`, {
          headers: { authorization: `Bearer ${pageKey}` },
        })
      ).status,
    ).toBe(401);
    await shots("5-profile-replaced");
  } finally {
    await browser("close").catch(() => undefined);
    const agentIds = createdAgentId
      ? [createdAgentId]
      : (
          await db.agent.findMany({ where: { workspaceId, name: agentName }, select: { id: true } })
        ).map((agent) => agent.id);
    for (const agentId of agentIds) {
      await db.deviceAuthorization
        .deleteMany({ where: { grant: { path: ["agentId"], equals: agentId } } })
        .catch(() => undefined);
    }
    await db.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 60_000);
