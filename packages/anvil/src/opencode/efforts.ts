import { RUNTIME_PROVIDER, diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { within } from "#src/catalog-discovery";
import { OPENCODE_ACP_CATALOG_TIMEOUT_MS } from "./acp-catalog";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { OPENCODE_ACP_PROFILE } from "./acp-session";
import type { OpenCodeAcpRuntimeHost } from "./acp-host";
import { scrubStderrHint } from "#src/stderr-hint";

/** opencode's own `default` is the provider default. Callers store that as an empty string. */
const PROVIDER_DEFAULT_EFFORT = "default";
const EFFORT_VALUE_LIMIT = 16;
const EFFORT_VALUE_MAX_LENGTH = 64;
const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.OPENCODE]);

export type OpenCodeEffortFailureCode = "timeout" | "process_closed" | "rpc_error" | "unavailable";

/** `ready` with an empty list means this model has no effort control. `failed` is not that. */
export type OpenCodeEffortRead =
  | { status: "ready"; efforts: string[] }
  | { status: "failed"; code: OpenCodeEffortFailureCode };

/** Values of the current `thought_level` select, in CLI order, without `default`. */
export function openCodeEffortValues(config: readonly SessionConfigOption[]): string[] {
  const effort = config.find((entry) => entry.category === "thought_level");
  if (effort?.type !== "select") return [];
  const values: string[] = [];
  for (const entry of effort.options) {
    const choices = "value" in entry ? [entry] : entry.options;
    for (const choice of choices) {
      const value = choice.value;
      if (!value || value === PROVIDER_DEFAULT_EFFORT || values.includes(value)) continue;
      if (value.length > EFFORT_VALUE_MAX_LENGTH) continue;
      if (values.length >= EFFORT_VALUE_LIMIT) return values;
      values.push(value);
    }
  }
  return values;
}

function failureCode(error: unknown): OpenCodeEffortFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (message.toLowerCase().includes("timed out")) return "timeout";
  if (
    message.includes("closed") ||
    message.includes("exited") ||
    message.includes("invalid output")
  )
    return "process_closed";
  if (error instanceof RequestError) return "rpc_error";
  return "unavailable";
}

/**
 * Reads each model's `thought_level` choices in one `opencode acp` session: the `effort` select
 * only appears after a model is applied, so one `session/set_config_option model` per model
 * returns every model's list. A model with no `thought_level` select is ready and empty; a model
 * the session refuses is a failure for that model only. A dead process fails the models still
 * unread. The probe session is deleted so discovery leaves nothing in the user's history.
 */
export async function readOpenCodeModelEfforts(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: OpenCodeAcpRuntimeHost,
  modelIds: readonly string[],
  timeoutMs = OPENCODE_ACP_CATALOG_TIMEOUT_MS,
  /** The whole sweep's budget: on expiry the transport dies, and every model still unread is
   * answered `process_closed` while the reads already gathered are returned. */
  sweepTimeoutMs = 2 * timeoutMs,
): Promise<ReadonlyMap<string, OpenCodeEffortRead>> {
  const reads = new Map<string, OpenCodeEffortRead>();
  let transport: AcpConnection | undefined;
  let sessionId: string | undefined;
  let stderrHint: string | undefined;
  const expires = setTimeout(() => {
    void transport?.dispose();
  }, sweepTimeoutMs);
  try {
    transport = acpProcess(OPENCODE_ACP_PROFILE, {
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
    sessionId = session.sessionId;
    if (!sessionId?.trim()) throw new Error("OpenCode effort discovery unavailable");
    for (const modelId of modelIds) {
      if (reads.has(modelId)) continue;
      try {
        const configured = await acpBounded(
          transport.connection.agent.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: modelId,
          }),
          timeoutMs,
          "opencode acp effort read timed out",
        );
        const options = Array.isArray(configured?.configOptions)
          ? (configured.configOptions as SessionConfigOption[])
          : [];
        const applied = (list: readonly SessionConfigOption[]) =>
          list.some(
            (entry) =>
              (entry.id === "model" || entry.category === "model") &&
              entry.currentValue === modelId,
          );
        // A rapid model switch occasionally answers with the previous model's currentValue —
        // that answer is for the earlier call, so the model gets one retry before it fails.
        let match = applied(options);
        let next = options;
        if (!match) {
          const retry = await acpBounded(
            transport.connection.agent.request("session/set_config_option", {
              sessionId,
              configId: "model",
              value: modelId,
            }),
            timeoutMs,
            "opencode acp effort read timed out",
          );
          next = Array.isArray(retry?.configOptions)
            ? (retry.configOptions as SessionConfigOption[])
            : [];
          match = applied(next);
        }
        reads.set(
          modelId,
          match
            ? { status: "ready", efforts: openCodeEffortValues(next) }
            : { status: "failed", code: "unavailable" },
        );
      } catch (error) {
        if (transport.closed) throw error;
        reads.set(modelId, { status: "failed", code: failureCode(error) });
      }
    }
    return reads;
  } catch (error) {
    logger.warn("code_agent_catalog:effort_sweep_failed", {
      provider: RUNTIME_PROVIDER.OPENCODE,
      error_code: diagnosticErrorCode(error),
      error_message: error instanceof Error ? error.message : String(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    const failed: OpenCodeEffortRead = { status: "failed", code: failureCode(error) };
    for (const modelId of modelIds) if (!reads.has(modelId)) reads.set(modelId, failed);
    return reads;
  } finally {
    if (transport && sessionId && !transport.closed) {
      // The probe's session is deleted too, not just closed: `session/close` leaves the
      // untitled entry in the user's session list.
      await acpBounded(
        transport.connection.agent.request("session/delete", { sessionId }),
        timeoutMs,
        "opencode acp session/delete timed out",
      ).catch(() => undefined);
    }
    clearTimeout(expires);
    await transport?.dispose();
  }
}
