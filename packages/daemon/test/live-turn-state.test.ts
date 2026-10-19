import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "#src/code-agent/codex/provider";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { CursorProvider } from "#src/code-agent/cursor/provider";
import { OpenCodeProvider } from "#src/code-agent/opencode/provider";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { AntigravityProvider } from "#src/code-agent/antigravity/provider";
import { CoforgeProvider, PiProvider } from "#src/code-agent/pi/provider";
import { VERSION_PROBE_TIMEOUT_MS } from "#src/code-agent/version-gate";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";

const command = (name: string) => [
  process.execPath,
  new URL(`./fixtures/${name}`, import.meta.url).pathname,
];
const providers = [
  new CodexProvider({ command: command("codex-app-server.ts") }),
  new ClaudeCodeProvider({ command: command("claude-stream-json.ts") }),
  new KiroProvider({ command: command("kiro-acp.ts") }),
  new CursorProvider({ command: command("cursor-agent-fixture.ts") }),
  new OpenCodeProvider({ command: command("opencode-fixture.ts") }),
  new GrokProvider({ command: command("grok-acp-fixture.ts") }),
  new AntigravityProvider({ command: command("antigravity-fixture.ts") }),
];

for (const provider of providers) {
  test(
    `${provider.provider} reports actual live turn state through admission, interruption and disposal`,
    async () => {
      const root = await mkdtemp(join(realpathSync(tmpdir()), "coforge-live-turn-"));
      try {
        const session = await provider.createAgentSession({
          agentWorkspaceDirectory: root,
          instructions:
            provider.provider === "kiro"
              ? "Keep the asymmetric marker 719 in the system prompt."
              : "Test Agent instructions.",
          ...(["cursor", "opencode", "antigravity"].includes(provider.provider)
            ? { sessionId: "saved-session" }
            : {}),
          environment: {
            COFORGE_CURSOR_MODE: "hang",
            COFORGE_OPENCODE_MODE: "hang",
            COFORGE_GROK_MODE: "hang",
            COFORGE_GROK_ACP_LOG: join(root, "grok-rpc.jsonl"),
            COFORGE_AGY_MODE: "hang",
          },
        });
        try {
          expect(session).toHaveProperty("hasLiveTurn", false);
          const completed = Promise.withResolvers<void>();
          const unsubscribe = session.subscribe((event) => {
            if (event.type === "completed") completed.resolve();
          });
          try {
            await session.notify!("wait");
            expect(session).toHaveProperty("hasLiveTurn", true);
            await session.interrupt();
            await completed.promise;
            expect(session).toHaveProperty("hasLiveTurn", false);
          } finally {
            unsubscribe();
          }
        } finally {
          await session.dispose();
        }
        expect(session).toHaveProperty("hasLiveTurn", false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000 + VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS,
  );
}

for (const provider of [new PiProvider(), new CoforgeProvider()]) {
  test(`${provider.provider} distinguishes SDK preflight and live work from a settled prompt`, async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "coforge-sdk-live-turn-"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch() {
        started.resolve();
        await release.promise;
        return new Response(
          `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const agentDir = join(root, "host-config");
      await mkdir(agentDir);
      await Bun.write(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: `${server.url}v1`,
              models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
            },
          },
        }),
      );
      await mkdir(join(root, ".builtin-runtime"));
      await Bun.write(
        join(root, ".builtin-runtime/models.json"),
        JSON.stringify({ providers: { openrouter: { baseUrl: `${server.url}v1` } } }),
      );
      const builtIn = provider.provider === "coforge";
      const session = await provider.createAgentSession({
        agentWorkspaceDirectory: root,
        instructions: "Test Agent instructions.",
        environment: { PI_CODING_AGENT_DIR: agentDir },
        runtime: {
          provider: provider.provider,
          modelProvider: builtIn ? "openrouter" : "openai",
          model: builtIn ? "deepseek/deepseek-v4-flash-0731" : "custom",
          reasoning: "",
          providerConfig: {
            kind: "coforge",
            providerId: builtIn ? "openrouter" : "openai",
            apiKey: "fixture-test-key",
          },
        },
      });
      try {
        expect(session).toHaveProperty("hasLiveTurn", false);
        const prompt = session.sendMessage("work");
        await started.promise;
        expect(session).toHaveProperty("hasLiveTurn", true);
        release.resolve();
        await prompt;
        expect(session).toHaveProperty("hasLiveTurn", false);
      } finally {
        release.resolve();
        await session.dispose();
      }
      expect(session).toHaveProperty("hasLiveTurn", false);
    } finally {
      release.resolve();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
