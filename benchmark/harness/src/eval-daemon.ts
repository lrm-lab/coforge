import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ComputerRegistrar } from "../../../apps/web/src/server/computers/registration.server";
import {
  PrismaComputerRegistrationRepository,
  PrismaWorkspaceAccess,
} from "../../../apps/web/src/server/db/repositories/setup.repositories.server";
import { readAgentRuntimeCredentialEncryptionKey } from "../../../apps/web/src/server/agents/agent-runtime-credentials.server";
import {
  DaemonRuntime,
  startAgentProxy,
  createCodeAgentProvider,
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
  FileDaemonCredentialStore,
  type CodeAgentProviderFactory,
} from "@lrm/coforge-daemon";
import {
  decodeAgentStartIntent,
  encodeAgentStartIntent,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import { type MemoryAgentToolProfile } from "@lrm/coforge-sdk/agent";
import { EVAL_DISABLE_HOST_PI_INJECTION } from "../../../packages/agent/src/runner.ts";
import { AgentControl } from "../../../apps/web/src/server/agents/agent-control.server";
import { getAgentControlSignal } from "../../../apps/web/src/server/agents/agent-control-signal.server";
import { getAgentRuntimeLock } from "../../../apps/web/src/server/agents/agent-runtime-lock.server";
import { PrismaAgentControlStore } from "../../../apps/web/src/server/db/repositories/agent-control.repositories.server";
import { MentionDeliveryReports } from "../../../apps/web/src/server/conversations/mention-deliveries.server";
import { PrismaMentionDeliveryRepository } from "../../../apps/web/src/server/db/repositories/mention-delivery.repositories.server";
import { createAgentSessions } from "../../../apps/web/src/server/db/repositories/agent-session.repositories.server";
import { PrismaDirectConversationRepository } from "../../../apps/web/src/server/db/repositories/direct-conversation.repositories.server";
import { createCentrifugoServerApi } from "../../../apps/web/src/server/centrifugo/server-api.server";
import type { PrismaClient } from "../../../apps/web/src/generated/prisma/client";
import { evalHostIdentity } from "./eval-host-identity";

export { evalHostIdentity };

/** The workspace fields the eval daemon reads; every benchmark's EvalWorkspace has them. */
export type EvalHostWorkspace = {
  db: PrismaClient;
  workspaceId: string;
  slug: string;
  evalUserId: string;
  machineId: string;
  computerId: string;
};

/** An Agent the eval computer hosts, with the Pi provider and model its runtime config names. */
export type EvalHostedAgent = { agentId: string; provider: string; model: string };

export type EvalDaemon = {
  computerId: string;
  /** Daemon workspaces root; agent N's execution dir is
   * `<workspaceRoot>/<workspaceId>/agents/<agentId>`. */
  workspaceRoot: string;
  stop: () => Promise<void>;
};

function memoryApiKey(provider: string): string {
  const inline = Bun.env.DEV_MEMORY_API_KEY?.trim();
  if (inline) return inline;
  const modelsPath = `${process.env.HOME}/.pi/agent/models.json`;
  const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
    providers?: Record<string, { apiKey?: string }>;
  };
  const key = models.providers?.[provider]?.apiKey?.trim();
  if (!key) throw new Error(`Pi provider ${provider} has no apiKey in ~/.pi/agent/models.json`);
  return key;
}

async function encryptApiKey(agentId: string, providerId: string, apiKeyInput: string) {
  const associatedData = new TextEncoder().encode(`${agentId}\0${providerId}`);
  const encryptionKey = await readAgentRuntimeCredentialEncryptionKey(process.env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData },
      await crypto.subtle.importKey("raw", encryptionKey, "AES-GCM", false, ["encrypt"]),
      new TextEncoder().encode(apiKeyInput),
    ),
  );
  return {
    keyId: "v1",
    ciphertext: Buffer.from(encrypted).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    hint: `••••${apiKeyInput.slice(-4)}`,
  };
}

/** Hosts the given workspace Agents on one eval computer. A fence, when an Agent needs one, is
 * attached to its AgentStart intent by `startAgent`, never stored in its runtime config. */
export async function startEvalDaemon(input: {
  label: string;
  workspace: EvalHostWorkspace;
  webUrl: string | null;
  agents: EvalHostedAgent[];
}): Promise<EvalDaemon> {
  process.env[EVAL_DISABLE_HOST_PI_INJECTION] = "1";
  Bun.env[EVAL_DISABLE_HOST_PI_INJECTION] = "1";
  const webUrl = input.webUrl ?? "http://127.0.0.1:8788";
  const centrifugoWs =
    Bun.env.COFORGE_EVAL_CENTRIFUGO_WS ?? "ws://127.0.0.1:18000/connection/websocket";
  if (!process.env.COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY)
    throw new Error("missing COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY (source apps/web/.env)");
  if (!process.env.COFORGE_CENTRIFUGO_API_URL || !process.env.COFORGE_CENTRIFUGO_API_KEY)
    throw new Error("missing COFORGE_CENTRIFUGO_API_URL / COFORGE_CENTRIFUGO_API_KEY");
  let probeStatus = 0;
  let probeError = "not started";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const probe = await fetch(webUrl);
      probeStatus = probe.status;
      if (probe.ok || probe.status === 307 || probe.status === 302) break;
      probeError = `status ${probe.status}`;
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  if (probeStatus !== 200 && probeStatus !== 307 && probeStatus !== 302)
    throw new Error(`eval web ${webUrl} returned ${probeStatus || probeError}`);

  const identity = evalHostIdentity(input.label, input.workspace.workspaceId);
  const registrar = new ComputerRegistrar({
    workspaceAccess: new PrismaWorkspaceAccess(input.workspace.db),
    registrations: new PrismaComputerRegistrationRepository(input.workspace.db),
  });
  const registration = await registrar.register(
    {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceSlug: input.workspace.slug,
      name: identity.name,
      displayName: identity.displayName,
      machineId: input.workspace.machineId,
      platform: process.platform,
      osVersion: "eval",
      computerVersion: "eval",
      registrationIdempotencyKey: identity.registrationIdempotencyKey,
    },
    { userId: input.workspace.evalUserId },
  );

  const stateDirectory = identity.stateDirectory;
  process.env.COFORGE_DAEMON_HOME = stateDirectory;
  const { configureDaemonLogging } =
    await import("@lrm/coforge-daemon/src/platform/daemon-logging");
  await configureDaemonLogging(stateDirectory);
  const workspaceRoot = join(stateDirectory, "workspaces");
  const credentials = new FileDaemonCredentialStore(stateDirectory);
  await credentials.save(
    input.workspace.workspaceId,
    registration.computerId,
    registration.daemonApiKey,
  );

  // Every Agent's key is read, and its runtime config sealed, before the daemon starts: a missing
  // key must fail the run before a runtime is running that the caller has no `stop` for.
  const keyed = input.agents.map((agent) => ({ ...agent, apiKey: memoryApiKey(agent.provider) }));
  const isolatedPiHost = join(stateDirectory, "pi-host");
  mkdirSync(isolatedPiHost, { recursive: true });
  copyFileSync(`${process.env.HOME}/.pi/agent/models.json`, join(isolatedPiHost, "models.json"));
  writeFileSync(join(isolatedPiHost, "settings.json"), `${JSON.stringify({ skills: [] })}\n`, {
    mode: 0o600,
  });
  process.env.PI_CODING_AGENT_DIR = isolatedPiHost;
  for (const { agentId } of input.agents) {
    const builtinDir = join(
      workspaceRoot,
      input.workspace.workspaceId,
      "agents",
      agentId,
      ".builtin-runtime",
    );
    mkdirSync(builtinDir, { recursive: true });
    copyFileSync(join(isolatedPiHost, "models.json"), join(builtinDir, "models.json"));
    writeFileSync(join(builtinDir, "settings.json"), `${JSON.stringify({ skills: [] })}\n`, {
      mode: 0o600,
    });
  }
  await input.workspace.db.agent.updateMany({
    where: { workspaceId: input.workspace.workspaceId },
    data: { computerId: null },
  });
  const sealed = [];
  for (const agent of keyed) {
    sealed.push({
      agentId: agent.agentId,
      runtimeConfig: {
        runtime: RUNTIME_PROVIDER.COFORGE,
        provider: {
          kind: "coforge" as const,
          providerId: agent.provider,
          apiKey: await encryptApiKey(agent.agentId, agent.provider, agent.apiKey),
        },
        model: agent.model,
        modelProvider: agent.provider,
        reasoning: "",
      },
    });
  }

  let runtime: DaemonRuntime | undefined;
  const runtimeApi = (): DaemonRuntime => {
    if (!runtime) throw new Error("eval daemon runtime not started");
    return runtime;
  };
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: (context, request, agentApiKey) =>
        runtimeApi().agentMessage(context, request, agentApiKey),
      agentAttachment: (context, attachmentId, agentApiKey) =>
        runtimeApi().agentRequests.agentAttachment(context, attachmentId, agentApiKey),
      inbox: (context, request) => runtimeApi().inbox(context, request),
      issueAgentContext: (agentId, context) => runtimeApi().issueAgentContext(agentId, context),
      agentTask: (context, request, agentApiKey) =>
        runtimeApi().agentTask(context, request, agentApiKey),
      agentOpenviking: (context, request, agentApiKey) =>
        runtimeApi().agentRequests.agentOpenviking(context, request, agentApiKey),
      memoryFence: (agentId) => runtimeApi().memoryFence(agentId),
    },
  });
  // runtime.stop() only revokes the proxy's tokens; the proxy's server ends with proxy.close().
  // Any failure from here on stops both, since the caller gets no EvalDaemon to stop them with.
  try {
    const providerFactory: CodeAgentProviderFactory = (provider) =>
      createCodeAgentProvider(provider);
    const daemonConfig = {
      workspaceId: input.workspace.workspaceId,
      computerId: registration.computerId,
      workspaceRoot,
      serverHttpUrl: webUrl,
    };
    runtime = new DaemonRuntime(
      daemonConfig,
      providerFactory,
      credentials,
      {
        create: () => new DaemonConnection(centrifugoWs, defaultCentrifugeWorkspaceClientFactory),
      },
      proxy,
      {
        runtimes: async () => [
          { provider: RUNTIME_PROVIDER.COFORGE, version: "eval", displayName: "CoForge (Pi)" },
        ],
        cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
        catalogs: async () => ({ catalogs: [], failures: [] }),
      },
      stateDirectory,
    );
    try {
      await runtime.start(daemonConfig);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    for (const { agentId, runtimeConfig } of sealed) {
      await input.workspace.db.agent.update({
        where: { id: agentId },
        data: { computerId: registration.computerId, stoppedAt: null, runtimeConfig },
      });
    }
    input.workspace.computerId = registration.computerId;
    return {
      computerId: registration.computerId,
      workspaceRoot,
      async stop() {
        try {
          await runtime?.stop();
        } finally {
          proxy.close();
        }
      },
    };
  } catch (error) {
    // stop() may throw before it returns its promise; the startup error is the one to report.
    try {
      await runtime?.stop();
    } catch {
      // Ignored: the proxy still closes and `error` is rethrown.
    } finally {
      proxy.close();
    }
    throw error;
  }
}

/** Product Start: server publishes AgentStart over Centrifugo. Message delivery cannot wake an
 * Agent that was never started (`restartConfig` is empty → "Agent is inactive"). */
/** The shared :8788 parser rejects every toolProfile except `{kind:"memory-explorer"}`.
 * Keep the fence off the stored runtimeConfig and attach it only to the Start the eval publishes. */
function centrifugoApiWithFence(fence: MemoryAgentToolProfile | undefined) {
  const api = createCentrifugoServerApi();
  return {
    publishJson: api.publishJson.bind(api),
    async publish(channel: string, data: Uint8Array) {
      if (!fence) return api.publish(channel, data);
      try {
        const intent = decodeAgentStartIntent(data);
        return api.publish(channel, encodeAgentStartIntent({ ...intent, toolProfile: fence }));
      } catch {
        return api.publish(channel, data);
      }
    },
  };
}

export async function startAgent(
  workspace: EvalHostWorkspace,
  agentId: string,
  fence?: MemoryAgentToolProfile,
): Promise<void> {
  const centrifugo = centrifugoApiWithFence(fence);
  const conversations = new PrismaDirectConversationRepository(workspace.db);
  const mentions = new MentionDeliveryReports(
    new PrismaMentionDeliveryRepository(workspace.db),
    centrifugo,
    conversations,
  );
  const control = new AgentControl(
    new PrismaAgentControlStore(workspace.db),
    centrifugo,
    getAgentRuntimeLock(),
    { timeoutMs: 90_000, fallbackMs: 1_000 },
    createAgentSessions(workspace.db, mentions),
    getAgentControlSignal(),
    conversations,
  );
  const result = await control.execute({
    userId: workspace.evalUserId,
    workspaceId: workspace.workspaceId,
    agentId,
    requestId: crypto.randomUUID(),
    action: "start",
  });
  if (result.phase !== "completed") {
    throw new Error(
      `Agent ${agentId} start ${result.phase}${result.error ? `: ${result.error}` : ""}`,
    );
  }
}
