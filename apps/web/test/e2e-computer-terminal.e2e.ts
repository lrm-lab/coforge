import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Centrifuge } from "centrifuge/build/protobuf";
import {
  COMPUTER_TERMINAL_CAPABILITY,
  COMPUTER_TERMINAL_FRAME_METHOD,
  decodeTerminalControl,
  encodeTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { PrismaClient } from "#src/generated/prisma/client";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { getComputerTerminalCapabilityLease } from "#src/server/computers/computer-terminal-capability.server";
import { revokeComputerTerminalBestEffort } from "#src/server/computers/computer-terminal-production.server";
import { getComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";
import { scanPublicationKinds } from "../../../packages/daemon/src/connection/publication-routing";
import { ComputerTerminalRelay } from "../../../packages/daemon/src/daemon-runtime/computer-terminal-relay";
import { ComputerTerminalSession } from "../../../packages/daemon/src/daemon-runtime/computer-terminal-session";
import {
  animationsSettled,
  browserSession,
  devBrowserWorkspace,
  hydratedElement,
  localBrowserE2e,
  pageDevtools,
  pageHydrated,
} from "./helpers/browser-e2e";
import { sameOriginProxy } from "./helpers/same-origin-proxy";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const proxy = sameOriginProxy(origin, centrifugo);
const suffix = String(process.pid);
const artifacts = join(import.meta.dir, "../../../.artifacts/e2e/computer-terminal");
const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

let workspaceId = "";
let workspaceSlug = "";
let ownerComputerId = "";
let nonOwnerComputerId = "";
let nonOwnerUserId = "";
let ownerUrl = "";
let nonOwnerUrl = "";
const workerInstanceId = `term-e2e-${suffix}`;
let startedAt = Date.now();
let daemon: Centrifuge | undefined;
let relay: ComputerTerminalRelay | undefined;
let browserPassed = false;

let spawnCount = 0;
let closeCount = 0;
const receivedWrites: string[] = [];

const { browser, evaluate, waitFor } = browserSession(browserPath, `computer-terminal-${suffix}`);

const open = async (url: string) => {
  await browser("open", url);
  await waitFor(pageHydrated, 30_000);
};
const waitText = (text: string, ms = 15_000) =>
  waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, ms);
const clickButton = async (text: string, selector = "button", ms = 15_000) => {
  const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled).at(-1)`;
  await waitFor(`${target} !== undefined && ${hydratedElement(target)}`, ms);
  const clicked = await evaluate<boolean>(`(() => {
    const b = ${target};
    b?.click();
    return Boolean(b);
  })()`);
  if (!clicked) throw new Error(`Button "${text}" not found`);
};
const shot = async (name: string) => {
  await waitFor(animationsSettled({ allowInfinite: true }), 5_000);
  await Bun.sleep(200);
  await browser("screenshot", join(artifacts, `${name}.png`));
};
const closeWorkspace = async () => {
  await browser("click", "[data-terminal-workspace] [data-dialog-close]");
  await waitFor(`document.querySelector('[data-terminal-workspace]') === null`);
};
const emulate = async (width: number, height: number, mobile: boolean) => {
  const devtools = await pageDevtools(browser, workspaceSlug);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  return devtools;
};

async function setupCapabilities(capabilities: string[]) {
  const scope = { workspaceId, computerId: ownerComputerId };
  startedAt = Date.now();
  await getComputerStatusCache().put(scope, true);
  await getComputerRestartStore().ready(
    scope,
    { workerInstanceId, daemonVersion: "1.0.99", startedAt },
    [],
  );
  await getComputerTerminalCapabilityLease().record(workspaceId, ownerComputerId, capabilities, {
    workerInstanceId,
    startedAt,
  });
}

async function waitTerminalText(text: string, ms = 15_000) {
  await waitFor(
    `(document.querySelector(".xterm-rows")?.textContent ?? "").includes(${JSON.stringify(text)})`,
    ms,
  );
}

beforeAll(async () => {
  const seeded = await devBrowserWorkspace(db);
  workspaceId = seeded.workspaceId;
  workspaceSlug = seeded.workspace.slug;

  const otherUser = await db.user.create({
    data: {
      username: `peer_term_${suffix}`,
      email: `e2e-term-other-${suffix}@example.com`,
      displayName: "Peer Owner",
    },
  });
  nonOwnerUserId = otherUser.id;
  await db.workspaceMembership.create({
    data: { workspaceId, userId: nonOwnerUserId, role: "member" },
  });

  const peerComputer = await db.computer.create({
    data: {
      ownerId: nonOwnerUserId,
      machineId: `peer-term-${suffix}`,
      name: `peer-term-${suffix}`,
      displayName: "Peer Workstation",
      computerVersion: "1.0.99",
      platform: "linux",
    },
  });
  nonOwnerComputerId = peerComputer.id;
  await db.workspaceComputer.create({
    data: { workspaceId, computerId: nonOwnerComputerId, terminalEnabled: true },
  });

  const ownerComputer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `owner-term-${suffix}`,
      name: `owner-term-${suffix}`,
      displayName: "Mac Studio Term",
      computerVersion: "1.0.99",
      platform: "darwin",
    },
  });
  ownerComputerId = ownerComputer.id;
  await db.workspaceComputer.create({
    data: { workspaceId, computerId: ownerComputerId, terminalEnabled: false },
  });

  const key = prepareDaemonApiKey({
    principal: { userId: DEV_BROWSER_USER.id },
    workspaceId,
    computerId: ownerComputerId,
  });
  await db.daemonApiKey.create({ data: key.record });

  const controlChannel = `daemon:${workspaceId}:${ownerComputerId}`;
  daemon = new Centrifuge(`${centrifugo.replace(/^http/, "ws")}/connection/websocket`, {
    headers: {
      "x-coforge-daemon-api-key": key.apiKey,
      "x-coforge-daemon-instance-id": workerInstanceId,
    },
    websocket: globalThis.WebSocket,
  });

  relay = new ComputerTerminalRelay({
    workspaceId,
    computerId: ownerComputerId,
    daemonInstanceId: workerInstanceId,
    send: async (frame) => {
      await daemon!.rpc(COMPUTER_TERMINAL_FRAME_METHOD, encodeTerminalFrame(frame));
    },
    create: (binding) =>
      new ComputerTerminalSession({
        ...binding,
        spawn: async (dims, onOutput) => {
          spawnCount += 1;
          let exitResolve!: (exit: { code: number; signal: string | null }) => void;
          const shellExited = new Promise<{ code: number; signal: string | null }>((resolve) => {
            exitResolve = resolve;
          });
          setTimeout(() => {
            onOutput(utf8.encode(`welcome@coforge ${dims.cols}x${dims.rows} % `));
          }, 15);
          let lineBuffer = "";
          return {
            shellKind: "zsh",
            shellExited,
            write: async (bytes) => {
              const text = utf8Decode.decode(bytes);
              receivedWrites.push(text);
              for (const ch of text) {
                if (ch === "\r" || ch === "\n") {
                  if (lineBuffer.length > 0 || text.includes("\r") || text.includes("\n")) {
                    const cmd = lineBuffer;
                    lineBuffer = "";
                    onOutput(utf8.encode(`\r\nECHO:${cmd}\r\nwelcome@coforge % `));
                  }
                } else if (ch >= " ") {
                  lineBuffer += ch;
                  onOutput(utf8.encode(ch));
                }
              }
            },
            resize: () => {},
            close: async () => {
              closeCount += 1;
              exitResolve({ code: 0, signal: null });
            },
          };
        },
      }),
  });

  daemon.on("publication", (context) => {
    if (context.channel !== controlChannel || !(context.data instanceof Uint8Array)) return;
    if (!scanPublicationKinds(context.data).includes("computer_terminal")) return;
    void relay!.control(decodeTerminalControl(context.data));
  });

  const subscribed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon control subscribe timeout")), 15_000);
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
  await setupCapabilities([COMPUTER_TERMINAL_CAPABILITY]);

  ownerUrl = `${proxy.origin}/en/w/${workspaceSlug}/computer/${ownerComputerId}`;
  nonOwnerUrl = `${proxy.origin}/en/w/${workspaceSlug}/computer/${nonOwnerComputerId}`;
  await mkdir(artifacts, { recursive: true });
});

afterAll(async () => {
  await relay?.stop().catch(() => {});
  daemon?.disconnect();
  proxy.stop();
  await getComputerTerminalStore()
    .clearSession({ workspaceId, computerId: ownerComputerId })
    .catch(() => {});
  if (ownerComputerId) {
    await db.computer.delete({ where: { id: ownerComputerId } }).catch(() => {});
  }
  if (nonOwnerComputerId) {
    await db.computer.delete({ where: { id: nonOwnerComputerId } }).catch(() => {});
  }
  if (nonOwnerUserId) {
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId, userId: nonOwnerUserId } })
      .catch(() => {});
    await db.user.delete({ where: { id: nonOwnerUserId } }).catch(() => {});
  }
  await db.$disconnect();
  if (browserPassed && Bun.env.COFORGE_E2E_KEEP_BROWSER !== "1") {
    await browser("close").catch(() => {});
  }
});

test("enforces non-owner isolation, owner Enable gate, lazy xterm chunk, interactive I/O, conflict takeover, mobile read-only view, and revocation", async () => {
  await open(nonOwnerUrl);
  const devtools = await emulate(1440, 900, false);
  try {
    await waitText("Peer Workstation");
    const nonOwnerHasSection = await evaluate<boolean>(
      `document.querySelector('[data-terminal-section]') !== null`,
    );
    expect(nonOwnerHasSection).toBe(false);
    await shot("01-non-owner-desktop-light");

    await open(ownerUrl);
    await waitText("Enable direct shell access");
    await shot("02-owner-disabled-desktop-light");

    await clickButton("Enable");
    await waitText("Enable terminal for Mac Studio Term?");
    await shot("03-enable-confirm-dialog-desktop-light");
    await clickButton("Enable terminal", '[role="dialog"] button');
    await waitText("Open terminal");

    await setupCapabilities([]);
    await open(ownerUrl);
    await waitText("Upgrade required");
    await shot("04-needs-upgrade-desktop-light");

    await setupCapabilities([COMPUTER_TERMINAL_CAPABILITY]);
    await open(ownerUrl);
    await waitText("Open terminal");

    const loadedBeforeOpen = await evaluate<string[]>(
      `performance.getEntriesByType("resource").map((r) => r.name).filter((n) => n.includes("xterm") || n.includes("computer-terminal-workspace"))`,
    );
    expect(loadedBeforeOpen).toEqual([]);
    const preloadBeforeOpen = await evaluate<string[]>(
      `[...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.href).filter((h) => h.includes("computer-terminal-workspace") || h.includes("vendor~computer-terminal-workspace"))`,
    );
    expect(preloadBeforeOpen).toEqual([]);

    await browser(
      "eval",
      `(() => { performance.setResourceTimingBufferSize(2000); performance.clearResourceTimings(); })()`,
    );
    await clickButton("Open terminal");
    await waitFor(`document.querySelector('[data-terminal-workspace="interactive"]') !== null`);
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await waitTerminalText("welcome@coforge");

    const loadedAfterOpen = await evaluate<string[]>(
      `[...performance.getEntriesByType("resource").map((r) => r.name), ...[...document.querySelectorAll('link[rel="stylesheet"], script[src]')].map((el) => el.href || el.src || "")].filter((n) => n.includes("computer-terminal-workspace") || n.includes("vendor~computer-terminal-workspace"))`,
    );
    expect(loadedAfterOpen.some((name) => name.includes("computer-terminal-workspace"))).toBe(true);
    expect(
      loadedAfterOpen.some((name) => name.includes("vendor~computer-terminal-workspace")),
    ).toBe(true);

    await evaluate<boolean>(`(() => {
      const ta = document.querySelector('[data-terminal-canvas="interactive"] textarea');
      ta?.focus();
      return Boolean(ta);
    })()`);
    await browser("type", '[data-terminal-canvas="interactive"] textarea', "pwd");
    await browser("press", "Enter");
    await waitTerminalText("ECHO:pwd", 15_000);
    expect(receivedWrites.join("")).toContain("pwd");

    await browser("press", "Escape");
    await Bun.sleep(150);
    expect(
      await evaluate<boolean>(
        `document.querySelector('[data-terminal-workspace="interactive"]') !== null`,
      ),
    ).toBe(true);
    await shot("05-xterm-interactive-desktop-light");

    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await shot("06-xterm-interactive-desktop-dark");
    await browser("eval", `document.documentElement.classList.remove("dark-mode")`);

    const saved = await getComputerTerminalStore().getSession({
      workspaceId,
      computerId: ownerComputerId,
    });
    expect(saved).toBeDefined();

    await closeWorkspace();
    await waitText("A terminal session is currently running");

    await getComputerTerminalStore().saveSession({
      ...saved!,
      activeAttach: {
        attachId: "ta_conflict_other",
        attachGeneration: saved!.attachGeneration,
        loginGeneration: 1,
        mode: "interactive",
        nextInputSeq: 1,
        cols: saved!.cols,
        rows: saved!.rows,
        opened: true,
        createdAtMs: Date.now(),
      },
      updatedAtMs: Date.now(),
    });
    await clickButton("Open terminal");
    await waitText("This terminal is open in another view.");
    await shot("07-conflict-takeover-desktop-light");
    await clickButton("Take over", '[data-terminal-workspace="interactive"] button');
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await waitTerminalText("ECHO:pwd", 15_000);
    expect(spawnCount).toBe(1);

    await closeWorkspace();

    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await open(ownerUrl);
    await waitText("View terminal");
    await shot("09-phone-390-owner-section-light");

    await clickButton("View terminal");
    await waitFor(`document.querySelector('[data-terminal-workspace="readonly"]') !== null`);
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await waitText("Read-only live view. Continue on desktop for interactive input.");
    await waitTerminalText("ECHO:pwd", 15_000);

    const textareaProps = await evaluate<{ readOnly: boolean; inputMode: string }>(`(() => {
      const ta = document.querySelector('[data-terminal-canvas="readonly"] textarea');
      return { readOnly: Boolean(ta?.readOnly), inputMode: ta?.inputMode ?? "" };
    })()`);
    expect(textareaProps).toEqual({ readOnly: true, inputMode: "none" });
    await shot("10-phone-390-readonly-live-light");
    await closeWorkspace();

    await db.computer.update({
      where: { id: ownerComputerId },
      data: { displayName: "研发工作站-LongUnbrokenMachineIdentifier-2026" },
    });
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 568,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await open(ownerUrl.replace("/en/", "/zh-CN/"));
    await clickButton("查看终端");
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await waitText("当前为只读实时视图，请在桌面端继续交互输入。");
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    const overflow320 = await evaluate<boolean>(
      `document.documentElement.scrollWidth > window.innerWidth`,
    );
    expect(overflow320).toBe(false);
    await shot("11-phone-320-readonly-live-dark");
    await browser("eval", `document.documentElement.classList.remove("dark-mode")`);
    await closeWorkspace();

    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await open(ownerUrl);
    await clickButton("View terminal");
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await clickButton("Close shell", '[data-terminal-workspace="readonly"] button');
    await waitText("This terminates the active shell process");
    await shot("12-phone-390-close-confirm-light");
    await clickButton("Close shell", '[role="dialog"] button');
    await waitFor(
      `document.querySelector('[data-terminal-status="disconnected"]') !== null`,
      15_000,
    );
    expect(closeCount).toBe(1);
    await shot("13-phone-390-closed-disconnected-light");
    await closeWorkspace();

    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await open(ownerUrl);
    await clickButton("Open terminal");
    await waitFor(`document.querySelector('[data-terminal-status="connected"]') !== null`, 15_000);
    await waitTerminalText("welcome@coforge", 15_000);

    await db.workspaceComputer.update({
      where: { workspaceId_computerId: { workspaceId, computerId: ownerComputerId } },
      data: { terminalEnabled: false },
    });
    await browser("eval", `document.documentElement.classList.add("dark-mode")`);
    await revokeComputerTerminalBestEffort({
      workspaceId,
      computerId: ownerComputerId,
      closeShell: true,
      notifyReason: "permission_denied",
    });
    await waitFor(
      `document.querySelector('[data-terminal-status="unauthorized"]') !== null`,
      15_000,
    );
    await shot("08-revoked-unauthorized-desktop-dark");
    await browser("eval", `document.documentElement.classList.remove("dark-mode")`);

    browserPassed = true;
  } finally {
    await devtools.close();
  }
}, 180_000);
