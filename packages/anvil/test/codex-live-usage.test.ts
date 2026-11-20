import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

test("two live Codex sessions on one Computer read their own Codex homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-codex-live-usage-"));
  const provider = new CodexProvider({
    host: {
      ...fixtureCodexHost,
      maskAccountLabel: (email) => email.replace(/^./u, "*"),
      buildUsageEnvironment() {
        throw new Error("live usage must use the existing app-server");
      },
    },
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname,
      "live-home-usage",
    ],
  });
  const sessions = [];
  try {
    for (const account of ["alpha", "beta"]) {
      const codexHome = join(root, account);
      await mkdir(codexHome);
      sessions.push(
        await provider.createAgentSession({
          agentWorkspaceDirectory: root,
          instructions: "Fixture Agent",
          environment: { HOME: root, CODEX_HOME: codexHome },
        }),
      );
    }
    const [alpha, beta] = await Promise.all(sessions.map((session) => session.readUsage?.(500)));
    expect(alpha?.accountLabel).toBe("*lpha@example.com");
    expect(beta?.accountLabel).toBe("*eta@example.com");
  } finally {
    await Promise.allSettled(sessions.map((session) => session.dispose()));
    await rm(root, { recursive: true, force: true });
  }
});
