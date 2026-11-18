import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Centrifuge } from "centrifuge";
import { PrismaClient } from "#src/generated/prisma/client";
import { artifactPresenceChannel } from "#src/features/artifacts/artifact-presence-channel";
import { issueBrowserRealtimeToken } from "#src/server/auth/browser-realtime-token.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { agentWrites } from "./helpers/artifact-agent-writes";
import { artifactChrome } from "./helpers/artifact-chrome";
import {
  browserSession,
  devBrowserWorkspace,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

/**
 * The artifact viewer and gallery as Raft lays them out: the viewer owns the window (no sidebar)
 * and its header reads, left to right, back link, title, version, who can see, home conversation,
 * who is viewing, then find, copy link and more; the presence popover lists who is viewing now
 * (you first) and who looked before, and someone opening or closing the artifact shows or leaves
 * at once, without a reload; the Workspace scope names the Workspace; the gallery's
 * conversation filter opens with a "who can see" group that filters by visibility; the send dialog
 * counts what is selected and previews the artifact; a viewer reached from the gallery goes back to it.
 * Markdown artifacts only, so it needs no
 * sandbox origin. Opt-in like every `.e2e.ts`:
 *   COFORGE_E2E_WEB_URL=... DATABASE_URL=... bun test ./test/e2e-artifact-viewer-parity.e2e.ts
 * against a Web started with `COFORGE_FEATURE_FLAGS_FILE=/tmp/coforge-flags-docs.json`.
 * Screenshots go under `.artifacts/e2e/artifact-viewer-parity/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const centrifugo = Bun.env.COFORGE_E2E_CENTRIFUGO_URL;
if (!centrifugo) throw new Error("COFORGE_E2E_CENTRIFUGO_URL is required");
const shots = join(import.meta.dir, "../../../.artifacts/e2e/artifact-viewer-parity");

test("the viewer's own window and header, its presence list, the gallery's visibility group, the send dialog", async () => {
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({
      COFORGE_FEATURE_FLAGS_FILE: "/tmp/coforge-flags-docs.json",
    }),
  );
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const session = browserSession(browserPath, `artifact-viewer-parity-${process.pid}`);
  const { browser, evaluate } = session;
  const chrome = artifactChrome(session);
  const experiments = new PrismaExperimentsRepository(db);
  const services = productionArtifacts(db);
  const { workspaceId, workspace } = await devBrowserWorkspace(db);
  const workspaceName = (
    await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } })
  ).name;
  const before = (await experiments.read(workspaceId)).artifacts;
  const tail = `${process.pid}-${Date.now()}`.slice(-6);
  const agent = await db.agent.create({
    data: {
      workspaceId,
      name: `e2e-parity-${tail}`,
      displayName: "Scribe",
      ownerId: DEV_BROWSER_USER.id,
      runtimeConfig: {},
    },
  });
  const lin = await db.user.create({ data: { username: `lin-v-${tail}`, displayName: "Lin Xia" } });
  await db.workspaceMembership.create({ data: { workspaceId, userId: lin.id } });
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `e2e-parity-${tail}`,
      description: "",
      members: { create: [{ userId: DEV_BROWSER_USER.id }, { agentId: agent.id }] },
    },
  });
  const bot = agentWrites(services, workspaceId, agent.id);
  const settled = () =>
    browser("wait", "--fn", `document.getAnimations().every((a) => a.playState !== "running")`);
  const shoot = async (shot: string) => {
    await settled();
    await browser("screenshot", join(shots, `${shot}.png`));
  };
  const text = (needle: string) => `document.body.textContent.includes(${JSON.stringify(needle)})`;
  const ready = `${pageHydrated} && document.querySelector("main .ProseMirror") != null`;
  const pageOf = (id: string) => `${origin}/en/w/${workspace.slug}/artifacts/${id}`;
  const left = (selector: string) =>
    `document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().left ?? -1`;
  let linPage: Centrifuge | undefined;
  try {
    await experiments.write(workspaceId, "artifacts", true);
    await mkdir(shots, { recursive: true });
    await browser("set", "viewport", "1280", "860");
    const doc = await bot.create({
      conversationId: channel.id,
      title: `Launch plan ${tail}`,
      files: { "plan.md": `# Goal\n\nShip it (run ${tail}).\n` },
    });
    await db.artifactViewerPosition.create({
      data: {
        artifactId: doc.id,
        userId: lin.id,
        openedAt: new Date(Date.now() - 4 * 86_400_000),
        seenVersion: 1,
      },
    });
    const wide = await bot.create({
      conversationId: channel.id,
      title: `Team notes ${tail}`,
      files: { "notes.md": `# Notes\n\nFor everyone (run ${tail}).\n` },
    });
    await services.visibility.moveToWorkspace({
      workspaceId,
      artifactId: wide.id,
      agentId: agent.id,
    });

    await browser("open", pageOf(wide.id));
    await browser("wait", "--fn", ready, "--timeout", "90000");
    expect(await evaluate<boolean>(`document.querySelector('a[href$="/artifacts"]') == null`)).toBe(
      true,
    );
    const header = "main header";
    await chrome.untilPillScope(`Everyone in ${workspaceName}`);
    for (const selector of [
      'a[aria-label^="Home conversation:"]',
      'button[aria-label="Who is viewing"]',
    ])
      await chrome.until(`document.querySelector('${header} ${selector}') != null`);
    const x = {
      back: await evaluate<number>(left(`${header} a`)),
      title: await evaluate<number>(left(`${header} h1`)),
      version: await evaluate<number>(left(`${header} button[aria-label$=", switch version"]`)),
      who: await evaluate<number>(left(`${header} [aria-label^="Who can see:"]`)),
      home: await evaluate<number>(left(`${header} a[aria-label^="Home conversation:"]`)),
      viewing: await evaluate<number>(left(`${header} button[aria-label="Who is viewing"]`)),
      more: await evaluate<number>(left(`${header} button[aria-label="More actions"]`)),
    };
    expect(Object.values(x).every((value) => value >= 0)).toBe(true);
    expect(Object.values(x)).toEqual(Object.values(x).sort((a, b) => a - b));
    await shoot("1-viewer-header");

    const viewingChip = `document.querySelector('${header} button[aria-label="Who is viewing"]')`;
    const linViewing = `${viewingChip}?.querySelector('[data-viewer="${lin.id}"]') != null`;
    await chrome.until(
      `${viewingChip}?.querySelector('[data-viewer="${DEV_BROWSER_USER.id}"]') != null`,
    );
    expect(await evaluate<boolean>(linViewing)).toBe(false);
    await services.viewerPositions.open({ workspaceId, artifactId: wide.id, userId: lin.id });
    linPage = new Centrifuge(`${centrifugo.replace(/^http/, "ws")}/connection/websocket`, {
      token: await issueBrowserRealtimeToken({ userId: lin.id, workspaceId }),
      websocket: globalThis.WebSocket,
    });
    linPage.newSubscription(artifactPresenceChannel(workspaceId, wide.id)).subscribe();
    linPage.connect();
    await chrome.until(linViewing);
    await chrome.press(viewingChip);
    await chrome.until(text("Lin Xia"));
    expect(
      await evaluate<string[]>(
        `[...document.querySelectorAll('[role="dialog"] li')].map((li) => li.textContent.trim())`,
      ),
    ).toContain("Lin XiaViewing now");
    await shoot("1b-someone-opens");
    await browser("press", "Escape");
    linPage.disconnect();
    await chrome.until(`!(${linViewing})`);
    await browser("open", pageOf(doc.id));
    await browser("wait", "--fn", ready, "--timeout", "30000");

    await chrome.until(
      `document.querySelector('${header} button[aria-label="Who is viewing"]') != null`,
    );
    await chrome.press(`document.querySelector('${header} button[aria-label="Who is viewing"]')`);
    await chrome.until(`${text("Lin Xia")}`);
    const rows = await evaluate<string[]>(
      `[...document.querySelectorAll('[role="dialog"] li')].map((li) => li.textContent.trim())`,
    );
    expect(rows[0]).toContain("You");
    expect(rows[0]).toContain("Viewing now");
    expect(rows).toContain("Lin Xia4d ago");
    await shoot("2-presence");
    await browser("press", "Escape");

    await browser("open", `${origin}/en/w/${workspace.slug}/artifacts`);
    await browser("wait", "--fn", `${pageHydrated} && ${text(`Launch plan ${tail}`)}`);
    await chrome.press(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Conversation")`,
    );
    await chrome.until(`${text("Who can see")} && ${text("Channels and DMs")}`);
    await shoot("3-conversation-filter");
    await chrome.press(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Everyone in ${workspaceName}")`,
    );
    await chrome.until(`${text(`Team notes ${tail}`)} && !${text(`Launch plan ${tail}`)}`);
    await browser("press", "Escape");
    await chrome.until(`document.querySelector('[role="dialog"]') == null`);
    await chrome.press(`document.querySelector('main article button[aria-label^="Who can see:"]')`);
    await chrome.until(
      `[...document.querySelectorAll('[role="menuitemradio"]')].some((i) => i.textContent.includes("Everyone in ${workspaceName}"))`,
    );
    await chrome.closeMenus();
    await chrome.press(
      `[...document.querySelectorAll("main a")].find((a) => a.textContent.trim() === "Team notes ${tail}")`,
    );
    await browser("wait", "--fn", ready, "--timeout", "30000");
    expect(await evaluate<string>(`document.querySelector('${header} a').textContent.trim()`)).toBe(
      "Artifacts",
    );
    await chrome.press(`document.querySelector('${header} a')`);
    await chrome.until(
      `location.pathname.endsWith("/artifacts") && ${text(`Launch plan ${tail}`)}`,
    );

    await browser("open", pageOf(doc.id));
    await browser("wait", "--fn", ready, "--timeout", "30000");
    await chrome.openMore();
    await chrome.pressMenuItem("Send to");
    await chrome.until(`${text("0 selected")}`);
    const firstTarget = `document.querySelector('[role="dialog"] li label')`;
    await chrome.until(`${firstTarget} != null`);
    await chrome.press(firstTarget);
    await chrome.until(`${text("1 selected")}`);
    const dialog = await chrome.dialogText();
    expect(dialog).toContain(`Launch plan ${tail}`);
    expect(dialog).toContain("v1");
    await shoot("4-send-dialog");
  } finally {
    linPage?.disconnect();
    await browser("close").catch(() => undefined);
    await db.artifact
      .deleteMany({ where: { homeKey: `conversation:${channel.id}` } })
      .catch(() => undefined);
    await db.conversation.deleteMany({ where: { id: channel.id } }).catch(() => undefined);
    await db.agent.deleteMany({ where: { id: agent.id } }).catch(() => undefined);
    await db.workspaceMembership.deleteMany({ where: { userId: lin.id } }).catch(() => undefined);
    await db.user.delete({ where: { id: lin.id } }).catch(() => undefined);
    await experiments.write(workspaceId, "artifacts", before).catch(() => undefined);
    await db.$disconnect();
  }
}, 240_000);
