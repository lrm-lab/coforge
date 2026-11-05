import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { asRecord, nonEmptyString } from "#src/json-record";
import { scrubStderrHint } from "#src/stderr-hint";
import { DROID_ACP_PROFILE } from "./acp-session";
import type { DroidAcpRuntimeHost } from "./acp-host";
import { assertDroidAcpVersionSupported } from "./acp-version";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DROID]);

/** A probe session is a full launch plus one model switch per listed model. */
export const DROID_ACP_CATALOG_TIMEOUT_MS = 60_000;

/** How many models get their effort options read in one probe: Droid 1.4.1 lists 70, and a
 * bound keeps a runaway list from turning discovery into minutes of RPCs. */
const EFFORT_SWEEP_LIMIT = 120;

/**
 * The model catalog Droid itself offers: `session/new`'s `model` select, whose values are the
 * ids `session/set_config_option` accepts. Each model's `reasoning_effort` choices are published
 * by the server after the model applies, so one probe session switches through the list and
 * records them; a model whose switch fails keeps the catalog entry with no efforts rather than
 * dropping the model.
 */
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
    // The version gate runs before the server spawns: a below-floor droid is an upgrade prompt,
    // not a failed ACP launch.
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
    let config = readConfigOptions(session);
    const model = config.find((entry) => entry.id === "model" || entry.category === "model");
    if (model?.type !== "select") throw new Error("droid acp model catalog unavailable");
    const entries = model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    const models = [];
    for (const entry of entries.slice(0, EFFORT_SWEEP_LIMIT)) {
      if (!entry.value) continue;
      const efforts = await readModelEfforts(transport, sessionId, entry.value, config, timeoutMs);
      models.push({
        id: entry.value,
        displayName: entry.name ?? entry.value,
        description: entry.description ?? "",
        modelProvider: "",
        reasoningEfforts: efforts.values,
        defaultReasoning: efforts.current,
        recommended: entry.value === model.currentValue,
      });
      config = efforts.config;
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
    if (transport) await transport.dispose().catch(() => {});
  }
}

/** Applies one model and reads the `reasoning_effort` options it publishes. */
async function readModelEfforts(
  transport: AcpConnection,
  sessionId: string,
  modelId: string,
  initial: SessionConfigOption[],
  timeoutMs: number,
): Promise<{ values: string[]; current: string; config: SessionConfigOption[] }> {
  const empty = { values: [], current: "", config: initial };
  try {
    const configured = await acpBounded(
      transport.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: modelId,
      }),
      timeoutMs,
      "droid acp session/set_config_option timed out",
    );
    const config = readConfigOptions(configured);
    if (!config.some((entry) => entry.id === "model" && entry.currentValue === modelId))
      return empty;
    const effort = config.find((entry) => entry.category === "thought_level");
    if (effort?.type !== "select") return { values: [], current: "", config };
    const values = effort.options.flatMap((entry) =>
      "value" in entry ? [entry.value] : entry.options.map((child) => child.value),
    );
    const current = typeof effort.currentValue === "string" ? effort.currentValue : "";
    return { values, current: values.includes(current) ? current : "", config };
  } catch {
    // A model that will not apply keeps its catalog entry; its efforts stay unknown.
    return empty;
  }
}

function readConfigOptions(response: unknown): SessionConfigOption[] {
  const config = asRecord(response)?.configOptions;
  return Array.isArray(config) ? (config as SessionConfigOption[]) : [];
}
