import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_TREE_EXIT_GRACE_MS, VERSION_PROBE_TIMEOUT_MS } from "@lrm/coforge-anvil";
import { AntigravityAcpProvider } from "@lrm/coforge-anvil/antigravity";
import { antigravityAcpRuntimeHost } from "#src/code-agent/antigravity/acp-host";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test(
  "SSH session variables never reach `agy acp`",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-agy-acp-env-"));
    try {
      // The fixture exits(1) on any leaked SSH marker, so a clean session open proves the
      // launch environment dropped them; an explicit Agent override still applies elsewhere.
      const session = await new AntigravityAcpProvider({
        host: antigravityAcpRuntimeHost,
        command: [process.execPath, anvilRuntimeFixtures.antigravityAcp],
      }).createAgentSession({
        agentWorkspaceDirectory: root,
        instructions: "Standing Antigravity instructions.",
        environment: {
          SSH_CLIENT: "fixture-client",
          SSH_CONNECTION: "fixture-connection",
          SSH_TTY: "fixture-tty",
        },
      });
      try {
        expect(session).toHaveProperty("hasLiveTurn", false);
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000 + VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);
