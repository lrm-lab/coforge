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
 * grant, approve on /oauth/verify, verify /context + /events + reminder refusal, and revoke
 * the key from the Agent's profile panel.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/external-agent");

test("external Agent: create, device login, approve, message check and revoke", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `ext-agent-${process.pid}`);
  const tail = `${process.pid}-${Date.now()}`.slice(-10);
  const agentName = `ext-${tail}`;
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  let createdAgentId: string | undefined;

  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shots = async (name: string) => {
    await settled();
    await browser("screenshot", join(artifacts, `${name}.png`));
    await evaluate(`document.documentElement.classList.add("dark-mode") ?? true`);
    await settled();
    await browser("screenshot", join(artifacts, `${name}-dark.png`));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);
  };

  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    await browser("open", `${origin}/en/w/${workspace.slug}/members`);
    await browser("wait", "--fn", pageHydrated);

    // 1. Open NewAgentDialog and select External.
    await browser("click", `button:has-text("New Agent")`);
    await browser("wait", "--fn", `document.querySelector('[role="dialog"]') !== null`);
    await browser("click", `[role="radio"]:has-text("External")`);
    await browser("fill", `input[name="name"]`, agentName);
    await browser("fill", `input[name="displayName"]`, `External ${tail}`);
    await browser("click", `[role="dialog"] button[type="submit"]`);
    await browser(
      "wait",
      "--fn",
      `document.body.innerText.includes("coforge agent login --server")`,
    );
    await shots("connect-card");

    const agentRow = await db.agent.findFirst({
      where: { workspaceId, name: agentName, deletedAt: null },
      select: { id: true },
    });
    expect(agentRow).not.toBeNull();
    createdAgentId = agentRow!.id;

    // 2. Start device grant from external CLI client.
    const deviceResponse = await fetch(`${origin}/oauth/device`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "coforge-cli",
        grant: {
          kind: "external_agent",
          workspace: workspace.slug,
          agent: agentName,
          machine_name: "e2e-build-box",
          hostname: "e2e-build-box.local",
          os: "linux 6.8",
          client_name: "coforge-cli e2e",
        },
      }),
    });
    expect(deviceResponse.status).toBe(200);
    const grant = (await deviceResponse.json()) as {
      device_code: string;
      user_code: string;
    };

    // 3. Approve in /oauth/verify.
    await browser("open", `${origin}/en/oauth/verify`);
    await browser("wait", "--fn", pageHydrated);
    await browser(
      "fill",
      `input[autocomplete="one-time-code"], input[inputmode="text"]`,
      grant.user_code.replace(/-/g, ""),
    );
    await browser("wait", "--fn", `document.body.innerText.includes("e2e-build-box")`);
    await shots("device-verify");
    await browser("click", `button:has-text("Approve")`);
    await browser("wait", "--fn", `document.body.innerText.includes("e2e-build-box") === false`);

    // 4. Exchange device_code for sk_ext_ key and verify /context, /events, and reminder refusal.
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
        operation: "schedule",
        fireAt: new Date(Date.now() + 60_000).toISOString(),
        text: "test",
      }),
    });
    expect(remRes.status).toBe(403);

    // 5. Open Agent profile panel and revoke the key.
    await browser(
      "open",
      `${origin}/en/w/${workspace.slug}/members?profile=agent:${createdAgentId}`,
    );
    await browser(
      "wait",
      "--fn",
      `${pageHydrated} && document.body.innerText.includes("e2e-build-box")`,
    );
    await shots("profile-panel");
    await browser("click", `button:has-text("Revoke")`);
    await browser("wait", "--fn", `document.body.innerText.includes("No machines connected yet.")`);

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
});
