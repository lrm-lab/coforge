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
 * An Agent its Computer refused to start says why, in its own words, on the profile's error banner
 * (task #418): each of the three runtime refusals the daemon tells apart (`launch-failure.test.ts`
 * pins their sentences) reaches the banner as that sentence, not as a generic one.
 *
 * Opt-in like the other browser E2Es: real local Web + `agent-browser` + the stack's Redis, where
 * the test writes each Agent's display as the daemon's status and failure activity would. The
 * Workspace, its Computer and Agents are seeded per run and removed after it. One screenshot per
 * refusal is written under `.amp/e2e/agent-runtime-refusal-banner/`.
 */
const { origin, browserPath, databaseUrl } = localBrowserE2e();
const artifacts = join(import.meta.dir, "../../../.amp/e2e/agent-runtime-refusal-banner");

/** The daemon's sentence for each refusal, for a Kiro Agent (`launch-failure.test.ts`). */
const REFUSALS = [
  {
    code: "RUNTIME_PRIVATE",
    reason: "runtime_private",
    sentence:
      "The configured runtime is marked private on this Computer, and is not shared with this Agent's owner.",
  },
  {
    code: "RUNTIME_NOT_INSTALLED",
    reason: "runtime_not_installed",
    sentence: "Kiro is not installed on this Computer. Install Kiro, then start the Agent again.",
  },
  {
    code: "RUNTIME_UNUSABLE",
    reason: "runtime_unusable",
    sentence:
      "Kiro is not usable on this Computer. Check its status in Computer settings, then start the Agent again.",
  },
] as const;

test("each runtime refusal shows its own sentence on the Agent's error banner", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const { browser, evaluate } = browserSession(browserPath, `refusal-banner-${process.pid}`);
  const suffix = `${process.pid}-${Date.now()}`;
  const workspace = await db.workspace.create({
    data: {
      name: "Runtime refusals",
      slug: `runtime-refusals-${suffix}`,
      members: { create: [{ userId: DEV_BROWSER_USER.id, role: "owner" }] },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `runtime-refusals-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const display = getAgentDisplay();
  /** The banner's sentence: the status line that carries the error, without its buttons. */
  const banner = `[...document.querySelectorAll('[role="status"] .line-clamp-2')].map((el) => el.textContent ?? "").find((text) => text.startsWith("Error:"))`;
  try {
    await mkdir(artifacts, { recursive: true });
    await browser("set", "viewport", "1440", "900");
    for (const [index, refusal] of REFUSALS.entries()) {
      const agent = await db.agent.create({
        data: {
          workspaceId: workspace.id,
          computerId: computer.id,
          name: `e2e-refused-${index}-${suffix}`,
          displayName: `Refused ${refusal.code}`,
          ownerId: DEV_BROWSER_USER.id,
          runtimeConfig: {
            runtime: "kiro",
            provider: { kind: "default" },
            model: "",
            modelProvider: "",
            reasoning: "",
          },
        },
      });
      const scope = { workspaceId: workspace.id, computerId: computer.id, agentId: agent.id };
      const daemonInstanceId = `e2e-daemon-${suffix}`;
      const launchId = `e2e-launch-${index}`;
      const now = Date.now();
      await display.observeStatus({
        protocolMajor: 1,
        requestId: crypto.randomUUID(),
        ...scope,
        status: "active",
        daemonInstanceId,
        clientSeq: 1,
        observedAtMs: now,
      });
      // What the daemon publishes when the Web refuses the Agent's configuration
      // (`launchFailureActivity` → `runtimeErrorActivityDraft`).
      await display.observeActivity(
        {
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          ...scope,
          detailKind: AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_ERROR,
          level: "error",
          detail: refusal.sentence,
          observedAtMs: now + 1,
          launchId,
          clientSeq: 1,
          runtimeError: {
            errorClass: "authorization",
            errorReason: refusal.reason,
            fingerprint: refusal.reason,
          },
        },
        { daemonInstanceId, launchId },
      );

      await browser(
        "open",
        `${origin}/en/w/${workspace.slug}/members?profile=agent:${agent.id}&agentTab=profile`,
      );
      await browser("wait", "--fn", `${banner} !== undefined && ${pageHydrated}`);
      expect(await evaluate<string>(banner)).toBe(`Error: ${refusal.sentence}`);
      await browser("screenshot", join(artifacts, `${refusal.reason}.png`));
    }
  } finally {
    await browser("close").catch(() => undefined);
    await db.agent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => undefined);
    await db.computer.deleteMany({ where: { id: computer.id } }).catch(() => undefined);
    await db.workspaceMembership
      .deleteMany({ where: { workspaceId: workspace.id } })
      .catch(() => undefined);
    await db.workspace.deleteMany({ where: { id: workspace.id } }).catch(() => undefined);
    await db.$disconnect();
  }
}, 120_000);
