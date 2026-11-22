import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { CatalogDiscoveryError, catalogErrorMessage, within } from "#src/catalog-discovery";
import {
  acpConfigOptions,
  acpModelEfforts,
  acpReadModelEfforts,
  acpSelectEntries,
} from "#src/acp/config-options";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { scrubStderrHint } from "#src/stderr-hint";
import { asRecord, nonEmptyString } from "#src/json-record";
import { ANTIGRAVITY_ACP_PROFILE } from "./acp-session";
import { antigravityAcpSessionExtraArgs } from "./acp-args";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { assertAntigravityAcpVersionSupported } from "./acp-version";
import { withoutSshSessionVariables } from "./ssh-environment";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

export const ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS = 15_000;

export async function discoverAntigravityAcpCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: AntigravityAcpRuntimeHost,
  timeoutMs = ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  const deadline = performance.now() + timeoutMs;
  const timeRemaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const requireTimeRemaining = () => {
    const remainingMs = timeRemaining();
    if (remainingMs === 0) throw new CatalogDiscoveryError("agy acp catalog discovery timed out");
    return remainingMs;
  };
  let transport: AcpConnection | undefined;
  let sessionId: string | undefined;
  let stderrHint: string | undefined;
  let initialModel: { id: string; value: string } | undefined;
  let initialEffort: { id: string; value: string } | undefined;
  let switchedModel = false;
  let failed = false;
  try {
    await within(assertAntigravityAcpVersionSupported(command, host.versionReader), timeoutMs);
    const initializeTimeout = requireTimeRemaining();
    const launchEnvironment = withoutSshSessionVariables({ ...environment, PWD: cwd });
    transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
      command,
      extraArgs: antigravityAcpSessionExtraArgs(launchEnvironment),
      cwd,
      environment: launchEnvironment,
      clientInfo: host.clientInfo,
      processTreeSpawner: host.processTreeSpawner,
      onStderr: (line) => {
        if (stderrHint === undefined && line.trim()) stderrHint = scrubStderrHint(line);
      },
    });
    await transport.initialize(initializeTimeout);
    const openTimeout = requireTimeRemaining();
    const session = await within(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
      openTimeout,
    );
    sessionId = nonEmptyString(asRecord(session)?.sessionId);
    if (!sessionId) throw new Error("agy acp model catalog unavailable");
    const initialOptions = acpConfigOptions(session);
    const model = initialOptions.find((entry) => entry.category === "model");
    if (model?.type !== "select") throw new Error("agy acp model catalog unavailable");
    if (typeof model.currentValue === "string" && model.currentValue)
      initialModel = { id: model.id, value: model.currentValue };
    const effort = initialOptions.find((entry) => entry.category === "thought_level");
    if (effort?.type === "select" && typeof effort.currentValue === "string" && effort.currentValue)
      initialEffort = { id: effort.id, value: effort.currentValue };
    const currentEfforts = acpModelEfforts(initialOptions, model.id, model.currentValue);
    const models = acpSelectEntries(model).map<CodeAgentModelMetadata>((entry) => {
      const recommended = entry.value === model.currentValue;
      return {
        id: entry.value,
        displayName: entry.name || entry.value,
        description: entry.description ?? "",
        modelProvider: "",
        reasoningEfforts: recommended ? currentEfforts?.values : undefined,
        defaultReasoning: recommended ? (currentEfforts?.current ?? "") : "",
        recommended,
      };
    });
    if (models.length === 0) throw new Error("agy acp model catalog unavailable");

    const effortTimeout = "agy acp session/set_config_option timed out";
    for (const entry of models) {
      if (entry.recommended) continue;
      const remainingMs = timeRemaining();
      if (remainingMs <= 0) break;
      switchedModel = true;
      try {
        const efforts = await acpReadModelEfforts(
          transport,
          sessionId,
          model,
          entry.id,
          remainingMs,
          effortTimeout,
        );
        entry.reasoningEfforts = efforts?.values;
        entry.defaultReasoning = efforts?.current ?? "";
      } catch (error) {
        failed = true;
        logger.warn("code_agent_catalog:effort_probe_interrupted", {
          provider: RUNTIME_PROVIDER.ANTIGRAVITY,
          error_code: diagnosticErrorCode(error),
          error_message: catalogErrorMessage(error),
        });
        break;
      }
    }
    return { provider: RUNTIME_PROVIDER.ANTIGRAVITY, models };
  } catch (error) {
    failed = true;
    logger.warn("code_agent_catalog:discovery_failed", {
      provider: RUNTIME_PROVIDER.ANTIGRAVITY,
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    if (transport && sessionId && !transport.closed && !failed) {
      const cleanupTimeout = () => Math.min(timeRemaining(), 5_000);
      if (switchedModel && initialModel) {
        const agent = transport.connection.agent;
        const probeSessionId = sessionId;
        const restore = async (setting: { id: string; value: string }) => {
          const timeout = cleanupTimeout();
          if (timeout === 0) return [];
          return acpBounded(
            agent.request("session/set_config_option", {
              sessionId: probeSessionId,
              configId: setting.id,
              value: setting.value,
            }),
            timeout,
            "agy acp session/set_config_option timed out",
          ).then(acpConfigOptions, () => []);
        };
        const modelSetting = initialModel;
        const matches = (
          config: ReturnType<typeof acpConfigOptions>,
          setting: typeof modelSetting,
        ) =>
          config.some(
            (entry) => asRecord(entry)?.id === setting.id && entry.currentValue === setting.value,
          );
        const modelConfig = await restore(modelSetting);
        let restored = matches(modelConfig, modelSetting);
        if (restored && initialEffort) {
          const restoredConfig = await restore(initialEffort);
          restored =
            matches(restoredConfig, modelSetting) && matches(restoredConfig, initialEffort);
        }
        if (!restored) {
          logger.warn("code_agent_catalog:restore_unconfirmed", {
            provider: RUNTIME_PROVIDER.ANTIGRAVITY,
          });
        }
      }
      const closeTimeout = cleanupTimeout();
      if (closeTimeout > 0)
        await acpBounded(
          transport.connection.agent.request("session/close", { sessionId }),
          closeTimeout,
          "agy acp session/close timed out",
        ).catch(() => undefined);
    }
    if (transport) await transport.dispose().catch(() => {});
  }
}
