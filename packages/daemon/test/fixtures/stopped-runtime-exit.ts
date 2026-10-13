/**
 * Starts a DaemonRuntime with one Agent, lets that Agent fail a turn with a retryable runtime
 * error (which starts the delivery backoff), then stops the runtime and returns. The process must
 * exit as soon as the stop has, not once the backoff's release timer would have fired.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "#src/code-agent/contract";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";

const root = await mkdtemp(join(tmpdir(), "coforge-stopped-runtime-"));
try {
  const connection = { computerId: "computer-a", workspaceId: "workspace-a", workspaceRoot: root };
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const session = {
    async sendMessage() {},
    async notify() {},
    async interrupt() {},
    async dispose() {},
    subscribe(listener: (event: AgentRuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit() {
      return () => {};
    },
  } satisfies AgentSession;
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const runtime = new DaemonRuntime(
    connection,
    () => ({ provider: "pi", createAgentSession: async () => session }),
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentApiKey() {
          return `sk_agent_${"a".repeat(43)}`;
        },
        async revokeAgentApiKey() {},
        async sendAgentDeliveryAck() {},
        sendAgentActivity() {},
      }),
    },
    undefined,
    {
      runtimes: async () => [],
      cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
      catalogs: async () => [],
    },
    join(root, "state"),
  );
  await runtime.start(connection);
  await runtime.startAgent("agent-a", {
    provider: "pi",
    model: "default",
    modelProvider: "anthropic",
    reasoning: "balanced",
  });
  for (const listener of listeners) listener({ type: "error", message: "connect ECONNRESET" });
  for (const listener of listeners) listener({ type: "completed", status: "failed" });
  await runtime.stop();
} finally {
  await rm(root, { recursive: true, force: true });
}
