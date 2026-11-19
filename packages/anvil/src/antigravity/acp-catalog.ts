import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { acpConfigOptions, acpReadModelEfforts, acpSelectEntries } from "#src/acp/config-options";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { scrubStderrHint } from "#src/stderr-hint";
import { asRecord, nonEmptyString } from "#src/json-record";
import { ANTIGRAVITY_ACP_PROFILE } from "./acp-session";
import { antigravityAcpSessionExtraArgs } from "./acp-args";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { assertAntigravityAcpVersionSupported } from "./acp-version";
import { withoutSshSessionVariables } from "./ssh-environment";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

export const ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS = 60_000;

export async function discoverAntigravityAcpCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: AntigravityAcpRuntimeHost,
  timeoutMs = ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: AcpConnection | undefined;
  let sessionId: string | undefined;
  let stderrHint: string | undefined;
  let initialModel: { id: string; value: string } | undefined;
  let initialEffort: { id: string; value: string } | undefined;
  let switchedModel = false;
  let failed = false;
  try {
    await assertAntigravityAcpVersionSupported(command, host.versionReader);
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
    await transport.initialize(timeoutMs);
    const session = await within(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
      timeoutMs,
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
    const models = [];
    for (const entry of acpSelectEntries(model)) {
      switchedModel = true;
      const efforts = await acpReadModelEfforts(
        transport,
        sessionId,
        model,
        entry.value,
        timeoutMs,
        "agy acp session/set_config_option timed out",
      );
      models.push({
        id: entry.value,
        displayName: entry.name || entry.value,
        description: entry.description ?? "",
        modelProvider: "",
        reasoningEfforts: efforts.values,
        defaultReasoning: efforts.current,
        recommended: entry.value === model.currentValue,
      });
    }
    if (models.length === 0) throw new Error("agy acp model catalog unavailable");
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
      const cleanupTimeoutMs = Math.min(timeoutMs, 5_000);
      if (switchedModel && initialModel) {
        const restored = await acpBounded(
          transport.connection.agent.request("session/set_config_option", {
            sessionId,
            configId: initialModel.id,
            value: initialModel.value,
          }),
          cleanupTimeoutMs,
          "agy acp session/set_config_option timed out",
        ).then(
          () => true,
          () => false,
        );
        if (restored && initialEffort) {
          await acpBounded(
            transport.connection.agent.request("session/set_config_option", {
              sessionId,
              configId: initialEffort.id,
              value: initialEffort.value,
            }),
            cleanupTimeoutMs,
            "agy acp session/set_config_option timed out",
          ).catch(() => undefined);
        }
      }
      await acpBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        cleanupTimeoutMs,
        "agy acp session/close timed out",
      ).catch(() => undefined);
    }
    if (transport) await transport.dispose().catch(() => {});
  }
}
