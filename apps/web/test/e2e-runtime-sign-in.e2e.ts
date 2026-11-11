import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { RedisClient } from "bun";
import { PrismaPg } from "@prisma/adapter-pg";
import { Centrifuge } from "centrifuge/build/protobuf";
import {
  RUNTIME_AUTH_CAPABILITY,
  KIRO_FREE_AUTH_CAPABILITY,
  KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLogoutResult,
} from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import {
  getRuntimeAuthCapabilityLease,
  getKiroFreeCapabilityLease,
  getKiroIdentityCenterCapabilityLease,
} from "#src/server/computers/runtime-auth-capability.server";
import { userRuntimeAuth } from "#src/server/computers/runtime-auth-composition.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { sameOriginProxy } from "./helpers/same-origin-proxy";
import {
  browserSession,
  devBrowserWorkspace,
  hydratedElement,
  localBrowserE2e,
  pageDevtools,
  pageHydrated,
} from "./helpers/browser-e2e";

/** Opt-in runtime sign-in E2E on the private stack the other browser E2Es use (built Web with
 * development skip-auth, PostgreSQL, Redis, Centrifugo, agent-browser). No daemon process runs:
 * the test holds the Computer's `daemon:` control channel with a real daemon-key Centrifugo
 * connection — the live presence the online check requires — and plays the daemon's reports
 * through the server's own report receivers, so no runtime on any machine is signed in or out.
 * Screenshots: .amp/e2e/runtime-sign-in/. */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const redis = new RedisClient(redisUrlFor("runtime sign-in E2E"));
const proxy = sameOriginProxy(origin, centrifugo);
const auth = userRuntimeAuth(db);
const suffix = String(process.pid);
const artifacts = join(import.meta.dir, "../../../.amp/e2e/runtime-sign-in");
const agentName = `signout-agent-${suffix}`;
let workspaceId = "";
let computerId = "";
let pageUrl = "";
let browserPassed = false;
let daemon: Centrifuge | undefined;

const { browser, evaluate, waitFor } = browserSession(browserPath, `runtime-sign-in-${suffix}`);

const open = async (url: string) => {
  await browser("open", url);
  await waitFor(pageHydrated, 30_000);
};
const waitText = (text: string, ms = 15_000) =>
  waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, ms);
const waitSelector = (selector: string, ms = 30_000) =>
  waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, ms);
const clickSelector = async (selector: string, ms = 30_000) => {
  // SSR markup satisfies the selector wait long before the chip's handlers attach; a click
  // that early lands on inert HTML (the Linux runner lost one this way).
  const element = `document.querySelector(${JSON.stringify(selector)})`;
  await waitFor(`${element} !== null && ${hydratedElement(element)}`, ms);
  await browser("click", selector);
};
/** A page expression clicking the dialog's own button whose trimmed text is exactly `text`. */
const clickDialogButton = (text: string) =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent.trim() === ${JSON.stringify(text)},
    );
    button?.click();
    return Boolean(button);
  })()`);
const shot = async (name: string) => {
  await waitFor(
    `document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity)`,
    5_000,
  );
  await Bun.sleep(200);
  await browser("screenshot", join(artifacts, `${name}.png`));
};
/** The page's device metrics through CDP; the returned connection must stay open — closing it
 * drops the emulation. */
const emulate = async (width: number, height: number, mobile: boolean) => {
  const devtools = await pageDevtools(browser, computerId);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  return devtools;
};

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
  const { workspaceId: seededWorkspaceId, workspace } = await devBrowserWorkspace(db);
  workspaceId = seededWorkspaceId;
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
  // The fake daemon's live half: a real daemon-key connection the connect proxy subscribes to
  // the Computer's control channel, so presence — and with the status cache, online — holds.
  const key = prepareDaemonApiKey({
    principal: { userId: DEV_BROWSER_USER.id },
    workspaceId,
    computerId,
  });
  await db.daemonApiKey.create({ data: key.record });
  const controlChannel = `daemon:${workspaceId}:${computerId}`;
  daemon = new Centrifuge(`${centrifugo.replace(/^http/, "ws")}/connection/websocket`, {
    headers: {
      "x-coforge-daemon-api-key": key.apiKey,
      "x-coforge-daemon-instance-id": `sign-in-e2e-${suffix}`,
    },
    websocket: globalThis.WebSocket,
  });
  const subscribed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out subscribing ${controlChannel}`)),
      15_000,
    );
    daemon!.on("subscribed", (context) => {
      if (context.channel === controlChannel) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  daemon.connect();
  await daemon.ready(15_000);
  await subscribed;
  await getComputerStatusCache().put({ workspaceId, computerId }, true);
  await getRuntimeAuthCapabilityLease().record(workspaceId, computerId, [RUNTIME_AUTH_CAPABILITY]);
  pageUrl = `${proxy.origin}/en/w/${workspace.slug}/computer/${computerId}`;
  await mkdir(artifacts, { recursive: true });
});

afterAll(async () => {
  daemon?.disconnect();
  proxy.stop();
  if (computerId) {
    await db.agent.deleteMany({ where: { name: agentName } });
    await db.computer.delete({ where: { id: computerId } });
  }
  await db.$disconnect();
  redis.close();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1")
    await browser("close").catch(() => {});
});

test("signing a runtime in shows the device code, takes a pasted code again, and ends signed in", async () => {
  await open(pageUrl);
  const devtools = await emulate(1440, 900, false);
  try {
    await clickSelector('li button[aria-label^="Claude Code"]');
    await waitText("Not signed in");
    await browser("find", "role", "button", "click", "--name", "Sign In");
    await waitText("Sign in to Claude Code");
    await shot("starting");
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
    await waitText("WXYZ-2468");
    await waitText("The code expires in 10 min.");
    await shot("device-code");
    await browser("fill", '[role="dialog"] input', "first-code");
    await clickDialogButton("Submit");
    await waitText("Checking the code");
    await report(loginId, 3, { event: { kind: "code_prompt", retry: true } });
    await waitText("That code was not accepted");
    await shot("code-rejected");
    await report(loginId, 4, {
      result: { kind: "logged_in", account: { maskedLabel: "c***@example.com", planLabel: "max" } },
    });
    await waitText("Claude Code is signed in on");
    await shot("signed-in");
    await clickDialogButton("Done");
    await waitFor(`!document.querySelector('[role="dialog"]')`);
  } finally {
    await devtools.close();
  }
}, 90_000);

test("signing a runtime out names the Agents using it and shows a refusal before it succeeds", async () => {
  const seen = new Set<string>();
  const devtools = await emulate(1440, 900, false);
  try {
    await browser("press", "Escape");
    await clickSelector('li button[aria-label^="Codex CLI"]');
    await browser("find", "role", "button", "click", "--name", "Sign out");
    await waitText("Sign out of Codex CLI?");
    await waitText("Signout Agent keep running");
    await shot("sign-out-confirm");
    await clickDialogButton("Sign out");
    await answerLogout({ kind: "failed", reason: "still_logged_in" }, seen);
    await waitText("Still signed in");
    await shot("sign-out-refused");
    await clickDialogButton("Sign out");
    await answerLogout({ kind: "logged_out" }, seen);
    await waitFor(`!document.querySelector('[role="dialog"]')`, 15_000);
  } finally {
    await devtools.close();
  }
  browserPassed = true;
  expect(seen.size).toBe(2);
}, 90_000);

test("Kiro enterprise form starts the shared device-code flow and explains an explicit organization refusal", async () => {
  browserPassed = false;
  await getComputerStatusCache().put(scope(), true);
  await getKiroIdentityCenterCapabilityLease().record(workspaceId, computerId, [
    KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  ]);
  const devtools = await emulate(1440, 900, false);
  try {
    await open(pageUrl);
    await clickSelector('li button[aria-label^="Kiro"]');
    await browser("find", "role", "button", "click", "--name", "Sign In");
    await waitText("Sign in to Kiro with IAM Identity Center");
    await shot("kiro-enterprise-form-en");
    await browser(
      "find",
      "role",
      "textbox",
      "fill",
      "--name",
      "Start URL",
      "https://example.awsapps.com/start",
    );
    await browser("find", "role", "textbox", "fill", "--name", "AWS region", "us-east-1");
    await browser("find", "role", "button", "click", "--name", "Sign In");
    const id = await currentLogin("kiro");
    await report(id, 1, {
      event: {
        kind: "device_code",
        verificationUrl: "https://device.sso.us-east-1.amazonaws.com/",
        userCode: "ABCD-EFGH",
      },
    });
    await waitText("ABCD-EFGH");
    await shot("kiro-device-code");
    await report(id, 2, {
      result: { kind: "failed", reason: "rejected", detail: "kiro_device_flow_disabled" },
    });
    await waitText("Your organization has disabled device-code sign-in.");
    await shot("kiro-device-disabled");
    await browser("click", 'button[aria-label="Close"]');
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await open(pageUrl.replace("/en/", "/zh-CN/"));
    await clickSelector('li button[aria-label^="Kiro"]');
    await browser("find", "role", "button", "click", "--name", "登录");
    await waitText("通过 IAM Identity Center 登录 Kiro");
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await shot("kiro-enterprise-form-zh-dark-mobile");
    await browser("click", 'button[aria-label="关闭"]');
    await db.computer.update({ where: { id: computerId }, data: { platform: "win32" } });
    await open(pageUrl.replace("/en/", "/zh-CN/"));
    await clickSelector('li button[aria-label^="Kiro"]');
    await waitSelector('[role="dialog"]', 15_000);
    const signInVisible = await evaluate(
      `Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent?.trim() === "登录")`,
    );
    if (signInVisible) throw new Error("Windows must not show the enterprise login entry");
    await shot("kiro-windows-no-enterprise");
  } finally {
    await devtools.close();
  }
  browserPassed = true;
}, 90_000);

test("a Computer that can sign Kiro in free asks which account first; free starts with no form (task #87)", async () => {
  browserPassed = false;
  // The earlier tests hold the control channel; this one plays an offline Computer, so the free
  // start answers "offline" the way a Kiro start without the identity center or the free license
  // would have been refused as a bad request before that.
  daemon?.disconnect();
  daemon = undefined;
  await db.computer.update({ where: { id: computerId }, data: { platform: "linux" } });
  await getComputerStatusCache().put(scope(), true);
  await getKiroIdentityCenterCapabilityLease().record(workspaceId, computerId, [
    KIRO_IDENTITY_CENTER_AUTH_CAPABILITY,
  ]);
  await getKiroFreeCapabilityLease().record(workspaceId, computerId, [KIRO_FREE_AUTH_CAPABILITY]);
  const devtools = await emulate(1440, 900, false);
  try {
    const startUrlShown = `document.querySelector('[role="dialog"]')?.innerText.includes("Start URL")`;
    /** The radio's own input is hidden under its label, which takes the click. */
    const choose = async (value: string) => {
      const clicked = await evaluate(`(() => {
        const input = document.querySelector('input[type=radio][value=${JSON.stringify(value)}]');
        input?.closest("label")?.click();
        return Boolean(input);
      })()`);
      if (!clicked) throw new Error(`no ${value} radio to choose`);
    };
    await open(pageUrl);
    await clickSelector('li button[aria-label^="Kiro"]');
    await browser("find", "role", "button", "click", "--name", "Sign In");
    await waitSelector("input[type=radio][value=free]", 15_000);
    const freeChosen = await evaluate(
      `document.querySelector('input[type=radio][value="free"]')?.checked`,
    );
    if (!freeChosen) throw new Error("Free must be chosen first");
    if (await evaluate(startUrlShown)) throw new Error("Free asks for no Start URL");
    await shot("kiro-choice-free-en");
    await choose("pro");
    await waitText("Start URL");
    await shot("kiro-choice-enterprise-en");
    await choose("free");
    await waitFor(`!(${startUrlShown})`, 5_000);
    await browser("click", '[role="dialog"] button[type="submit"]');
    await waitText("This Computer is offline.");
    await browser("click", 'button[aria-label="Close"]');
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await open(pageUrl.replace("/en/", "/zh-CN/"));
    await clickSelector('li button[aria-label^="Kiro"]');
    await browser("find", "role", "button", "click", "--name", "登录");
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await waitSelector("input[type=radio][value=pro]", 15_000);
    await choose("pro");
    await waitText("AWS 区域");
    await shot("kiro-choice-zh-dark-mobile");
    await browser("click", 'button[aria-label="关闭"]');
    await devtools.send("Emulation.clearDeviceMetricsOverride", {});
  } finally {
    await devtools.close();
  }
  browserPassed = true;
}, 90_000);
