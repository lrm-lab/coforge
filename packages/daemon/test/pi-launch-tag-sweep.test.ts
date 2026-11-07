import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { completionStream, piProvider, piRuntime, writeOpenAiHost } from "./fixtures/pi-host";
import { agentLaunchTag } from "#src/platform/agent-launch-tag";
import { sweepAgentLaunchTags } from "#src/platform/agent-launch-tag-sweep";

const TEST_AGENT_INSTRUCTIONS = "Test Agent instructions.";

// Same budget rationale as pi-agent-adapter.test.ts: an embedded Pi session is in-process work
// with no product bound, sitting on bun:test's 5s default on a busy host.
setDefaultTimeout(30_000);

test("embedded Pi bash descendants carry the launch tag and the sweep collects a setsid escapee", async () => {
  // Task #673 / QA's #577 repro shape: the shell tool spawns a setsid'd, reparented escapee;
  // only the inherited COFORGE_AGENT_LAUNCH_TAG identifies it after the tree is gone. Bun is
  // the escapee binary because Apple platform binaries do not expose env to `ps eww` on macOS.
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-launch-tag-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "host-pi-agent");
  await mkdir(workspace);
  const agentId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const command =
    `perl -MPOSIX -e 'setsid(); exec $ENV{COFORGE_BUN}, "-e", "setTimeout(()=>{},120000)"' & ` +
    `echo "ESCAPEE_PID=$!"`;
  let requestCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requestCount += 1;
      if (requestCount === 1)
        return completionStream(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "bash-escapee",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          },
          "tool_calls",
        );
      return completionStream({ role: "assistant", content: "done" }, "stop");
    },
  });
  await writeOpenAiHost(agentDir, `${server.url}v1`);
  const events: AgentRuntimeEvent[] = [];
  const session = await piProvider().createAgentSession({
    agentWorkspaceDirectory: workspace,
    instructions: TEST_AGENT_INSTRUCTIONS,
    ...piRuntime(agentDir),
    environment: {
      PI_CODING_AGENT_DIR: agentDir,
      COFORGE_BUN: process.execPath,
      COFORGE_AGENT_LAUNCH_TAG: agentLaunchTag(agentId, token),
    },
  });
  session.subscribe((event) => events.push(event));
  let escapeePid = 0;
  try {
    await session.sendMessage("spawn the escapee");
    const output = events
      .filter((event) => event.type === "tool-output")
      .map((event) => event.text)
      .join("\n");
    escapeePid = Number(/ESCAPEE_PID=(\d+)/.exec(output)?.[1]) || 0;
    expect(escapeePid).toBeGreaterThan(0);
    // The escapee outlives its session: dispose first, then sweep exactly this launch's tag.
    await session.dispose();
    const report = await sweepAgentLaunchTags({ agentId, trigger: "test" });
    expect(report.matched).toBeGreaterThanOrEqual(1);
    expect(report.killed).toBe(report.matched);
    expect(report.unkilled).toEqual([]);
    await Bun.sleep(300);
    expect(() => process.kill(escapeePid, 0)).toThrow();
  } finally {
    try {
      if (escapeePid > 0) process.kill(escapeePid, "SIGKILL");
    } catch {}
    await session.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
