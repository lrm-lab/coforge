import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * Full external Agent flow: create via NewAgentDialog ("External"), start coforge-cli device
 * grant (with extra-long Agent & machine names for break-ui), approve on /oauth/verify, verify
 * /context + /events + reminder refusal, and revoke the key from the Agent's profile panel.
 * Captures light, dark, and phone screenshots under `.amp/e2e/external-agent/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/external-agent");

test("external Agent: create, device login, approve, message check and revoke", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `ext-agent-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-8);
  // Intentionally long names to verify wrapping/truncation (break-ui).
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

    // 1. Open NewAgentDialog, select External, create, and shoot connect card (light, dark, phone).
    await browser("find", "role", "button", "click", "--name", "New Agent", "--exact");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="dialog"] input[value="external"]') !== null`,
    );
    await browser("click", `label:has(input[value="external"])`);
    await browser("fill", `input[name="name"]`, agentName);
    await browser("fill", `input[name="displayName"]`, `External ${tail}`);
    await browser("click", `[role="dialog"] button[type="submit"]`);
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes("coforge agent login --server")`,
    );
    await shots("1-connect-card");
    await browser("set", "viewport", "390", "844");
    await shoot("1-connect-card-phone");
    await browser("set", "viewport", "1280", "860");

    const agentRow = await db.agent.findFirst({
      where: { workspaceId, name: agentName, deletedAt: null },
      select: { id: true },
    });
    expect(agentRow).not.toBeNull();
    createdAgentId = agentRow!.id;

    // 2. Start device grant from external CLI client (form-urlencoded per RFC 8628).
    const deviceResponse = await fetch(`${origin}/oauth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "coforge-cli",
        workspace: workspace.slug,
        agent: agentName,
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

    // 3. Approve in /oauth/verify (shoot light, dark, phone).
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
    await shots("2-device-verify");
    await browser("set", "viewport", "390", "844");
    await shoot("2-device-verify-phone");
    await browser("set", "viewport", "1280", "860");
    await browser("find", "role", "button", "click", "--name", "Approve");
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes(${JSON.stringify(machineName)}) === false`,
    );

    // 4. Exchange device_code for sk_ext_ key and verify /context, /events, and reminder refusal.
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
    const issued = (await tokenResponse.json()) as { api_key: string };
    expect(issued.api_key.startsWith("sk_ext_")).toBe(true);

    const ctxRes = await fetch(`${origin}/api/agent/v1/context`, {
      headers: { authorization: `Bearer ${issued.api_key}` },
    });
    expect(ctxRes.status).toBe(200);
    const ctx = (await ctxRes.json()) as { prompt: { text: string } | null };
    expect(ctx.prompt?.text).toContain("COFORGE_PROFILE");

    const eventsRes = await fetch(`${origin}/api/agent/v1/events`, {
      headers: { authorization: `Bearer ${issued.api_key}` },
    });
    expect(eventsRes.status).toBe(200);

    const remRes = await fetch(`${origin}/api/agent/v1/reminders`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.api_key}`,
        "content-type": "application/json",
      },
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
    expect(remRes.status).toBe(403);

    // 5. Open Agent profile panel, shoot connected state, revoke, and shoot revoked state.
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/members?profile=agent:${createdAgentId}`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.innerText.includes(${JSON.stringify(machineName)})`,
    );
    await shots("3-profile-connected");
    await browser("find", "role", "button", "click", "--name", "Revoke");
    await browser("wait", "--fn", `document.body.innerText.includes("No machines connected yet.")`);
    await shoot("4-profile-revoked");

    const revokedCtx = await fetch(`${origin}/api/agent/v1/context`, {
      headers: { authorization: `Bearer ${issued.api_key}` },
    });
    expect(revokedCtx.status).toBe(401);
  } finally {
    await browser("close").catch(() => undefined);
    if (createdAgentId)
      await db.agent.deleteMany({ where: { id: createdAgentId } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 300_000);
