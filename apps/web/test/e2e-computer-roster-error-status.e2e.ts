import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { AGENT_ACTIVITY_DETAIL_KIND } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { browserSession, localBrowserE2e, pageHydrated } from "./helpers/browser-e2e";

/**
 * An Agent's error reads on its Computer's roster (task #450). The status column takes a share of
 * the spare width instead of a fixed 9rem, an error wraps to at most two lines and its whole
 * sentence is the row's tooltip. At phone width, where the status is only a dot, an error's
 * sentence stacks under the runtime line.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser`. The Computer and its
 * Agents are seeded per run and removed after it. Screenshots are written under
 * `.amp/e2e/computer-roster-error-status/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/computer-roster-error-status");
const ERROR =
  "Access denied: the runtime could not read ~/.kiro/credentials.json because its permissions changed after the last login";

test("an Agent's error on the Computer roster wraps to two lines and stays readable on a phone", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `roster-error-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const { workspace } = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
    include: { workspace: true },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `roster-error-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const make = (name: string, runtime: string) =>
    db.agent.create({
      data: {
        workspaceId: workspace.id,
        computerId: computer.id,
        name: `${name}-${suffix}`,
        displayName: name,
        ownerId: DEV_BROWSER_USER.id,
        runtimeConfig: {
          runtime,
          provider: { kind: "default" },
          model: "",
          modelProvider: "",
          reasoning: "",
        },
      },
    });
  try {
    await mkdir(artifacts, { recursive: true });
    const failing = await make("kiro-failing", "kiro");
    await make("pi-helper", "pi");
    await make("codex-helper", "codex");
    const scope = { workspaceId: workspace.id, computerId: computer.id, agentId: failing.id };
    const daemonInstanceId = `e2e-daemon-${suffix}`;
    const launchId = `e2e-launch-${suffix}`;
    const now = Date.now();
    const display = getAgentDisplay();
    await display.observeStatus({
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      ...scope,
      status: "active",
      daemonInstanceId,
      clientSeq: 1,
      observedAtMs: now,
    });
    await display.observeActivity(
      {
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        ...scope,
        detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
        level: "error",
        detail: ERROR,
        observedAtMs: now + 1,
        launchId,
        clientSeq: 1,
      },
      { daemonInstanceId, launchId },
    );

    const section = `document.querySelector('section[aria-labelledby="computer-agents-on-computer"]')`;
    // The failing Agent's row, and in it the error's words on screen: not the status's
    // screen-reader-only copy at phone width, which is 1px wide.
    const row = `[...${section}.querySelectorAll("li")].find((li) => li.textContent.includes("kiro-failing"))`;
    const label = `[...${row}.querySelectorAll("span")].find((el) => el.children.length === 0 && el.textContent.startsWith("Error:") && el.getBoundingClientRect().width > 1)`;
    const open = async () => {
      await browser("open", `${origin}/en/w/${workspace.slug}/computer/${computer.id}`);
      await browser(
        "wait",
        "--fn",
        `${pageHydrated} && ${row} !== undefined && ${label} !== undefined`,
      );
      await evaluate(`${section}.scrollIntoView({ block: "start" }) ?? true`);
    };

    // Desktop: two lines at most, and the whole sentence in the row's tooltip.
    await browser("set", "viewport", "1440", "900");
    await open();
    const desktop = await evaluate<{
      lines: number;
      width: number;
      cut: boolean;
    }>(`(() => {
      const el = ${label};
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return { lines: Math.round(el.getBoundingClientRect().height / lineHeight), width: Math.round(el.getBoundingClientRect().width), cut: el.scrollHeight > el.clientHeight };
    })()`);
    // Two lines, and the rest of the sentence was cut there, not merely short enough to fit.
    expect(desktop.lines).toBe(2);
    expect(desktop.cut).toBe(true);
    // Wider than the old fixed 9rem column could ever give it.
    expect(desktop.width).toBeGreaterThan(144);
    await evaluate(
      `${row}.querySelector("button").setAttribute("data-e2e-failing-row", "") ?? true`,
    );
    // React Aria opens a tooltip on hover once the page has seen a pointer press (its interaction
    // modality starts unset); a person has always clicked something by then, a fresh page has not.
    await browser("click", "#computer-agents-on-computer");
    await browser("hover", "[data-e2e-failing-row]");
    await browser(
      "wait",
      "--fn",
      `document.querySelector('[role="tooltip"]')?.textContent.includes(${JSON.stringify(ERROR)}) === true`,
    );
    await browser("screenshot", join(artifacts, "1440.png"));
    // Untitled UI's dark theme is `.dark-mode` on <html>; the light theme is its absence.
    expect(
      await evaluate<boolean>(
        `(document.documentElement.classList.add("dark-mode"), document.documentElement.classList.contains("dark-mode"))`,
      ),
    ).toBe(true);
    await browser("screenshot", join(artifacts, "1440-dark.png"));
    await evaluate(`document.documentElement.classList.remove("dark-mode") ?? true`);

    // Phone: the status is a dot, and the error's sentence stacks under the runtime line.
    await browser("set", "viewport", "390", "844");
    await open();
    const phone = await evaluate<{
      width: number;
      lines: number;
      inFlow: boolean;
      fits: boolean;
    }>(`(() => {
      const el = ${label};
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return {
        width: Math.round(el.getBoundingClientRect().width),
        lines: Math.round(el.getBoundingClientRect().height / lineHeight),
        inFlow: getComputedStyle(el).position !== "absolute",
        fits: document.documentElement.scrollWidth <= innerWidth,
      };
    })()`);
    expect(phone.inFlow).toBe(true);
    expect(phone.width).toBeGreaterThan(150);
    expect(phone.lines).toBe(2);
    expect(phone.fits).toBe(true);
    await browser("screenshot", join(artifacts, "390.png"));
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { computerId: computer.id } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computer.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 180_000);
