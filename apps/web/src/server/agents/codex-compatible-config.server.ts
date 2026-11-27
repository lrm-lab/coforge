import {
  codexCompatibleBaseUrl,
  codexCompatibleEnvironment,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { AppError } from "#src/lib/app-error";
import { decryptAgentEnvironment, encryptAgentEnvironment } from "./agent-environment.server";
import type { AgentRuntimeProviderConfig } from "./agent-runtime-config.server";

type CompatibleProvider = Extract<AgentRuntimeProviderConfig, { kind: "codex-compatible" }>;

export async function configureCodexCompatibleProvider(
  agentId: string,
  input: { model: string; baseUrl?: string; apiKey?: string },
  current: AgentRuntimeProviderConfig | undefined,
  getEncryptionKey: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<CompatibleProvider> {
  const previous = current?.kind === "codex-compatible" ? current : undefined;
  const baseUrl = codexCompatibleBaseUrl(input.baseUrl ?? previous?.baseUrl);
  if (!baseUrl || !input.model)
    throw new AppError("INVALID_INPUT", { errorId: "agent-codex-compatible-endpoint-required" });

  const suppliedKey = input.apiKey?.trim();
  const sameOrigin = previous && new URL(previous.baseUrl).origin === new URL(baseUrl).origin;
  if (!suppliedKey && (!sameOrigin || !previous.environment))
    throw new AppError("INVALID_INPUT", { errorId: "agent-codex-compatible-key-required" });
  if (!suppliedKey && previous?.baseUrl === baseUrl) return previous;

  const encryptionKey = await getEncryptionKey();
  const existing =
    !suppliedKey && previous
      ? await readCodexCompatibleEnvironment(agentId, previous, encryptionKey)
      : undefined;
  const pair = codexCompatibleEnvironment({
    OPENAI_API_KEY: suppliedKey || existing?.OPENAI_API_KEY,
    OPENAI_BASE_URL: baseUrl,
  });
  if (!pair)
    throw new AppError("INVALID_INPUT", { errorId: "agent-codex-compatible-key-required" });

  return {
    kind: "codex-compatible",
    baseUrl,
    environment: await encryptAgentEnvironment(agentId, pair, encryptionKey),
  };
}

export async function readCodexCompatibleEnvironment(
  agentId: string,
  provider: CompatibleProvider,
  encryptionKey: Uint8Array<ArrayBuffer> | undefined,
) {
  const pair = codexCompatibleEnvironment(
    await decryptAgentEnvironment(agentId, provider.environment, encryptionKey),
  );
  if (!pair || pair.OPENAI_BASE_URL !== provider.baseUrl)
    throw new Error("Invalid saved Codex compatible provider environment");
  return pair;
}
