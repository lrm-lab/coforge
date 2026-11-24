import { hasOwnRuntimeLogin, isRuntimeAuthProvider } from "@lrm/coforge-anvil";
import { RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { decryptAgentEnvironment } from "#src/server/agents/agent-environment.server";
import { readAgentRuntimeCredentialEncryptionKey } from "#src/server/agents/agent-runtime-credentials.server";

export type AgentRuntimeAuthSource = "shared" | "own" | "unknown";

export async function agentRuntimeAuthSource(
  agentId: string,
  config: AgentRuntimeConfig | undefined,
  readKey: () => Promise<Uint8Array<ArrayBuffer> | undefined>,
): Promise<AgentRuntimeAuthSource> {
  if (!config) return "unknown";
  const usesSharedPool =
    isRuntimeAuthProvider(config.runtime) ||
    Boolean(RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[config.runtime]);
  if (!usesSharedPool) return "own";
  if (config.provider.kind !== "default") return "own";
  if (!config.environment) return "shared";
  const key = await readKey();
  if (!key) return "unknown";
  try {
    const env = await decryptAgentEnvironment(agentId, config.environment, key);
    return hasOwnRuntimeLogin(config.runtime, env) ? "own" : "shared";
  } catch {
    return "unknown";
  }
}

export function lazyRuntimeCredentialKeyReader(): () => Promise<
  Uint8Array<ArrayBuffer> | undefined
> {
  let pending: Promise<Uint8Array<ArrayBuffer> | undefined> | undefined;
  return () => {
    if (!pending) {
      pending = readAgentRuntimeCredentialEncryptionKey(process.env).catch(() => undefined);
    }
    return pending;
  };
}
