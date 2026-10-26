import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RedisClient } from "bun";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  RUNTIME_AUTH_CAPABILITY,
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLogoutResult,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  getRuntimeAuthCapabilityLease,
  getKiroIdentityCenterCapabilityLease,
} from "#src/server/computers/runtime-auth-capability.server";
import { userRuntimeAuth } from "#src/server/computers/runtime-auth-composition.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

/** Opt-in runtime sign-in E2E on the private stack the other browser E2Es use (built Web with
 * development skip-auth, PostgreSQL, Redis, Centrifugo, ego-browser). No daemon runs: this test
 * plays the daemon, reading the login the page started from Redis and answering through the
 * server's own report receivers, so no runtime on any machine is signed in or out.
 * Screenshots: .amp/e2e/runtime-sign-in/. */
const databaseUrl = Bun.env.DATABASE_URL;
const web = Bun.env.COFORGE_E2E_WEB_URL;
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
const browser = Bun.which("ego-browser");
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
if (!web || new URL(web).hostname !== "127.0.0.1")
  throw new Error("COFORGE_E2E_WEB_URL must target local Web");
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
if (!browser) throw new Error("ego-browser is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const redis = new RedisClient(redisUrlFor("runtime sign-in E2E"));
const proxy = sameOriginProxy(web, centrifugo);
const auth = userRuntimeAuth(db);
const suffix = String(process.pid);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/runtime-sign-in");
const space = "coforge-chores task167 runtime sign-in";
const agentName = `signout-agent-${suffix}`;
let workspaceId = "";
let computerId = "";
let pageUrl = "";
let browserPassed = false;

async function runBrowser(script: string) {
  const child = Bun.spawn([browser!, "nodejs"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(script);
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}

/** One browser step on the page the earlier steps left open. */
const step = (body: string) =>
  runBrowser(`
    const task = await taskSpace(${JSON.stringify(space)});
    const page = task.page("p1");
    ${body}
  `);
const shot = (name: string) =>
  `await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), undefined, { timeout: 5000 }); await page.waitForTimeout(200); await page.screenshot({ path: ${JSON.stringify(join(artifacts, `${name}.png`))} });`;
/** The dialog's own Sign out, not the popover's that opened it. */
const confirmSignOut = `await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Sign Out").click());`;
const waitText = (text: string) =>
  `await page.waitForFunction((text) => document.body.innerText.includes(text), ${JSON.stringify(text)}, { timeout: 15000 });`;

async function poll<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for the page's request");
}

/** The login the page started, as the daemon would learn it from the intent. */
const currentLogin = (provider: string) =>
  poll(async () => {
    const held = await redis.get(
      `coforge:computer:${encodeURIComponent(computerId)}:runtime-auth-lock:v1:${provider}`,
    );
    return held ? (JSON.parse(held) as { loginId: string }).loginId : undefined;
  });
const scope = () => ({ workspaceId, computerId });
const report = (
  loginId: string,
  sequence: number,
  body: { event: RuntimeAuthLoginReport["event"] } | { result: RuntimeAuthLoginReport["result"] },
) =>
  auth.receiveLoginReport(scope(), {
    protocolMajor: 1,
    workspaceId,
    computerId,
    loginId,
    sequence,
    ...body,
  } as RuntimeAuthLoginReport);

async function answerLogout(result: RuntimeAuthLogoutResult, seen: Set<string>) {
  const base = workspaceRedisKey({ workspaceId, computerId, name: "runtime-auth", version: "v1" });
  const requestId = await poll(async () => {
    const keys = (await redis.send("KEYS", [`${base}:logout:*`])) as string[];
    const fresh = keys
      .map((key) => decodeURIComponent(key.slice(`${base}:logout:`.length)))
      .find((id) => !seen.has(id));
    return fresh;
  });
  seen.add(requestId);
  await auth.receiveLogoutReport(scope(), {
    protocolMajor: 1,
    workspaceId,
    computerId,
    requestId,
    result,
  });
}

beforeAll(async () => {
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  workspaceId = membership.workspaceId;
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `sign-in-${suffix}`,
      name: `sign-in-${suffix}`,
      computerVersion: "1.0.53",
      platform: "linux",
      runtimeAuth: {
        collectedAtMs: Date.now(),
        runtimes: {
          "claude-code": { provider: "claude-code", state: "logged_out" },
          kiro: { provider: "kiro", state: "logged_out" },
          codex: {
            provider: "codex",
            state: "logged_in",
            account: { maskedLabel: "f***@example.com", planLabel: "pro" },
          },
        },
      },
    },
  });
  computerId = computer.id;
  await db.workspaceComputer.create({ data: { workspaceId, computerId } });
  for (const [provider, displayName] of [
    ["claude-code", "Claude Code"],
    ["codex", "Codex CLI"],
    ["kiro", "Kiro CLI"],
  ] as const)
    await db.computerRuntime.create({
      data: { workspaceId, computerId, provider, version: "1.0.0", displayName },
    });
  const base = await db.agent.findFirstOrThrow({
    where: { workspaceId, deletedAt: null, systemKind: null, computerId: { not: null } },
  });
  const { id: _id, createdAt: _created, ...rest } = base;
  await db.agent.create({
    data: {
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null)),
      name: agentName,
      displayName: "Signout Agent",
      computerId,
      runtimeConfig: { ...(base.runtimeConfig as object), runtime: "codex" },
    } as never,
  });
  await getComputerStatusCache().put({ workspaceId, computerId }, true);
  await getRuntimeAuthCapabilityLease().record(workspaceId, computerId, [RUNTIME_AUTH_CAPABILITY]);
  pageUrl = `${proxy.origin}/en/w/${membership.workspace.slug}/computer/${computerId}`;
  await mkdir(artifacts, { recursive: true });
});

afterAll(async () => {
  proxy.stop();
  if (computerId) {
    await db.agent.deleteMany({ where: { name: agentName } });
    await db.computer.delete({ where: { id: computerId } });
  }
  await db.$disconnect();
  redis.close();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await runBrowser(
      `const task = await taskSpace(${JSON.stringify(space)}); await task.finish({ keep: [] });`,
    );
});

test("signing a runtime in shows the device code, takes a pasted code again, and ends signed in", async () => {
  await step(`
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(${JSON.stringify(pageUrl)});
    await page.waitForSelector('li button[aria-label^="Claude Code"]', { timeout: 30000 });
    await page.click('li button[aria-label^="Claude Code"]');
    ${waitText("Not signed in")}
    await page.click("loc=role:button[name='Sign In']");
    ${waitText("Sign in to Claude Code")}
  `);
  const loginId = await currentLogin("claude-code");
  await report(loginId, 1, {
    event: {
      kind: "device_code",
      userCode: "WXYZ-2468",
      verificationUrl: "https://auth.example/device",
      expiresInSeconds: 600,
    },
  });
  await report(loginId, 2, { event: { kind: "code_prompt", message: "Paste the code" } });
  await step(`
    ${waitText("WXYZ-2468")}
    ${waitText("The code expires in 10 min.")}
    ${shot("device-code")}
    await page.fill('[role="dialog"] input', "first-code");
    await page.click("loc=role:button[name='Submit']");
    ${waitText("Checking the code")}
  `);
  await report(loginId, 3, { event: { kind: "code_prompt", retry: true } });
  await step(`
    ${waitText("That code was not accepted")}
    ${shot("code-rejected")}
  `);
  await report(loginId, 4, {
    result: { kind: "logged_in", account: { maskedLabel: "c***@example.com", planLabel: "max" } },
  });
  await step(`
    ${waitText("Claude Code is signed in on")}
    ${shot("signed-in")}
    await page.click("loc=role:button[name='Done']");
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  `);
}, 90_000);

test("signing a runtime out names the Agents using it and shows a refusal before it succeeds", async () => {
  const seen = new Set<string>();
  await step(`
    await page.keyboard.press("Escape");
    await page.click('li button[aria-label^="Codex CLI"]');
    await page.click("loc=role:button[name='Sign Out']");
    ${waitText("Sign out of Codex CLI?")}
    ${waitText("Signout Agent keep running")}
    ${shot("sign-out-confirm")}
    ${confirmSignOut}
  `);
  await answerLogout({ kind: "failed", reason: "still_logged_in" }, seen);
  await step(`
    ${waitText("Still signed in")}
    ${shot("sign-out-refused")}
    ${confirmSignOut}
  `);
  await answerLogout({ kind: "logged_out" }, seen);
  await step(`
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), undefined, { timeout: 15000 });
  `);
  browserPassed = true;
  expect(seen.size).toBe(2);
}, 90_000);

test("Kiro enterprise form starts the shared device-code flow and explains an explicit organization refusal", async () => {
  browserPassed = false;
  await getComputerStatusCache().put(scope(), true);
  await getKiroIdentityCenterCapabilityLease().record(workspaceId, computerId, [
    KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  ]);
  await step(`
  await page.goto(${JSON.stringify(pageUrl)});
  await page.waitForSelector('li button[aria-label^="Kiro"]',{timeout:30000});
  await page.click('li button[aria-label^="Kiro"]');
  await page.click("loc=role:button[name='Sign In']");
  ${waitText("Sign in to Kiro with IAM Identity Center")}
  ${shot("kiro-enterprise-form-en")}
  await page.fill("loc=role:textbox[name*='Start URL']","https://example.awsapps.com/start");
  await page.fill("loc=role:textbox[name*='AWS Region']","us-east-1");
  await page.click("loc=role:button[name='Sign In']");
 `);
  const id = await currentLogin("kiro");
  await report(id, 1, {
    event: {
      kind: "device_code",
      verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
      userCode: "ABCD-EFGH",
    },
  });
  await step(`
  ${waitText("ABCD-EFGH")}
  ${shot("kiro-device-code")}
 `);
  await report(id, 2, {
    result: { kind: "failed", reason: "rejected", detail: "kiro_device_flow_disabled" },
  });
  await step(`
  ${waitText("Your organization has disabled device-code sign-in.")}
  ${shot("kiro-device-disabled")}
  await page.click('loc=css:button[aria-label="Close"]');
  await page.cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.goto(${JSON.stringify(pageUrl.replace("/en/", "/zh-CN/"))});
  await page.waitForSelector('li button[aria-label^="Kiro"]',{timeout:30000});
  await page.click('li button[aria-label^="Kiro"]');
  await page.click("loc=role:button[name='登录']");
  await page.evaluate(()=>document.documentElement.classList.add("dark-mode"));
  ${waitText("通过 IAM Identity Center 登录 Kiro")}
  ${shot("kiro-enterprise-form-zh-dark-mobile")}
  await page.click('loc=css:button[aria-label="关闭"]');
 `);
  await db.computer.update({ where: { id: computerId }, data: { platform: "win32" } });
  await step(`
  await page.goto(${JSON.stringify(pageUrl.replace("/en/", "/zh-CN/"))});
  await page.waitForSelector('li button[aria-label^="Kiro"]',{timeout:30000});
  await page.click('li button[aria-label^="Kiro"]');
  await page.waitForSelector('[role="dialog"]',{timeout:15000});
  const signInVisible = await page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"] button')).some(button => button.textContent?.trim() === "登录"));
  if (signInVisible) throw new Error("Windows must not show the enterprise login entry");
  ${shot("kiro-windows-no-enterprise")}
 `);
  browserPassed = true;
}, 90_000);
