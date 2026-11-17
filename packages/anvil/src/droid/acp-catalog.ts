import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { acpConfigOptions, acpReadModelEfforts, acpSelectEntries } from "#src/acp/config-options";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubStderrHint } from "#src/stderr-hint";
import { DROID_ACP_PROFILE } from "./acp-session";
import type { DroidAcpRuntimeHost } from "./acp-host";
import { assertDroidAcpVersionSupported } from "./acp-version";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DROID]);

export const DROID_ACP_CATALOG_TIMEOUT_MS = 60_000;

const EFFORT_SWEEP_LIMIT = 120;

export async function discoverDroidAcpCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: DroidAcpRuntimeHost,
  timeoutMs = DROID_ACP_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: AcpConnection | undefined;
  let sessionId: string | undefined;
  let stderrHint: string | undefined;
  try {
    await assertDroidAcpVersionSupported(command, host.versionReader);
    transport = acpProcess(DROID_ACP_PROFILE, {
      command,
      cwd,
      environment: { ...environment, PWD: cwd },
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
    if (!sessionId) throw new Error("droid acp model catalog unavailable");
    const model = acpConfigOptions(session).find(
      (entry) => entry.id === "model" || entry.category === "model",
    );
    if (model?.type !== "select") throw new Error("droid acp model catalog unavailable");
    const models = [];
    for (const entry of acpSelectEntries(model).slice(0, EFFORT_SWEEP_LIMIT)) {
      if (!entry.value) continue;
      const efforts = await acpReadModelEfforts(
        transport,
        sessionId,
        model,
        entry.value,
        timeoutMs,
        "droid acp session/set_config_option timed out",
      );
      models.push({
        id: entry.value,
        displayName: entry.name ?? entry.value,
        description: entry.description ?? "",
        modelProvider: "",
        reasoningEfforts: efforts.values,
        defaultReasoning: efforts.current,
        recommended: entry.value === model.currentValue,
      });
    }
    if (models.length === 0) throw new Error("droid acp model catalog unavailable");
    return { provider: RUNTIME_PROVIDER.DROID, models };
  } catch (error) {
    logger.warning("Droid model catalog discovery unavailable", {
      event: "droid.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    if (transport && sessionId && !transport.closed)
      await acpBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        timeoutMs,
        "droid acp session/close timed out",
      ).catch(() => undefined);
    if (transport) await transport.dispose().catch(() => {});
  }
}
