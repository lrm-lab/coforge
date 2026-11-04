import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { acpProcess, type AcpConnection } from "#src/acp/connection";
import { scrubStderrHint } from "#src/stderr-hint";
import { asRecord } from "#src/json-record";
import { ANTIGRAVITY_ACP_PROFILE } from "./acp-session";
import type { AntigravityAcpRuntimeHost } from "./acp-host";
import { assertAntigravityAcpVersionSupported } from "./acp-version";
import { withoutSshSessionVariables } from "./ssh-environment";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.ANTIGRAVITY]);

/** The server takes 15-25 s to unpack on a cold start; a probe session is a full launch. */
export const ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS = 60_000;

/** The model catalog the server itself offers: `session/new`'s `model` config select — the same
 * source a session's model setting applies to, and independent of the `agy` CLI's own catalog. */
export async function discoverAntigravityAcpCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: AntigravityAcpRuntimeHost,
  timeoutMs = ANTIGRAVITY_ACP_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: AcpConnection | undefined;
  let stderrHint: string | undefined;
  try {
    // The version gate runs before the server spawns: a below-floor agy is an upgrade prompt,
    // not a failed ACP launch.
    await assertAntigravityAcpVersionSupported(command, host.versionReader);
    transport = acpProcess(ANTIGRAVITY_ACP_PROFILE, {
      command,
      cwd,
      environment: withoutSshSessionVariables({ ...environment, PWD: cwd }),
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
    const options = Array.isArray(session.configOptions) ? session.configOptions : [];
    const model = options.find(
      (entry) => asRecord(entry)?.id === "model" || asRecord(entry)?.category === "model",
    );
    const record = asRecord(model);
    const entries = Array.isArray(record?.options) ? record.options : [];
    const models = entries.flatMap((entry) => {
      const option = asRecord(entry);
      const id = typeof option?.value === "string" && option.value ? option.value : undefined;
      if (!id) return [];
      return [
        {
          id,
          displayName: typeof option?.name === "string" && option.name ? option.name : id,
          description: "",
          modelProvider: "",
          reasoningEfforts: [] as string[],
          defaultReasoning: "",
          recommended: false,
        },
      ];
    });
    if (models.length === 0) throw new Error("agy acp model catalog unavailable");
    return { provider: RUNTIME_PROVIDER.ANTIGRAVITY, models };
  } catch (error) {
    logger.warn("code_agent_catalog:discovery_failed", {
      provider: RUNTIME_PROVIDER.ANTIGRAVITY,
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    if (transport) await transport.dispose().catch(() => {});
  }
}
