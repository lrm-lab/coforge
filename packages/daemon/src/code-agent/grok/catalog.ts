import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import { agentEnvironment } from "#src/code-agent/environment";
import { withDeadline } from "#src/code-agent/deadline";
import { JsonlProcess } from "#src/code-agent/jsonl-process";
import { asRecord, nonEmptyString } from "#src/code-agent/json-record";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.GROK]);

export const GROK_CATALOG_TIMEOUT_MS = 5_000;

/** Uses Grok's own `grok models` ACP operation, without authentication or a session. Unlike the
 * text command, `x.ai/models/list` retains each model's native reasoning choices and default.
 * Observed on 1.0.52; upstream `xai-grok-shell/src/cli_models.rs` uses this same two-call flow. */
export async function discoverGrokCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs = GROK_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let process: JsonlProcess | undefined;
  try {
    const transport = new JsonlProcess(
      [...command, "agent", "--no-leader", "stdio"],
      cwd,
      agentEnvironment(undefined, environment),
    );
    process = transport;
    return await withDeadline(
      (async () => {
        await transport.request({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "coforge-daemon-catalog", version: "0.1.0" },
            _meta: { cwd },
          },
        });
        const response = await transport.request({
          jsonrpc: "2.0",
          method: "_x.ai/models/list",
          params: {},
        });
        const envelope = asRecord(response.result);
        const state = asRecord(envelope?.result);
        if (envelope?.error || !Array.isArray(state?.availableModels))
          throw new Error("Grok model catalog unavailable");
        const models = state.availableModels.flatMap((value): CodeAgentModelMetadata[] => {
          const model = asRecord(value);
          const id = nonEmptyString(model?.modelId);
          if (!id) return [];
          const meta = asRecord(model?._meta);
          const options = Array.isArray(meta?.reasoningEfforts)
            ? meta.reasoningEfforts.flatMap((value) => {
                const option = asRecord(value);
                const effort = nonEmptyString(option?.value);
                return effort ? [{ effort, isDefault: option?.default === true }] : [];
              })
            : [];
          const reasoningEfforts = [...new Set(options.map((option) => option.effort))];
          const defaultEffort =
            nonEmptyString(meta?.reasoningEffort) ??
            options.find((option) => option.isDefault)?.effort;
          return [
            {
              id,
              displayName: nonEmptyString(model?.name) ?? id,
              description: nonEmptyString(model?.description) ?? "",
              modelProvider: "",
              reasoningEfforts,
              defaultReasoning:
                defaultEffort && reasoningEfforts.includes(defaultEffort) ? defaultEffort : "",
              recommended: id === state.currentModelId,
            },
          ];
        });
        return models.length ? { provider: RUNTIME_PROVIDER.GROK, models } : undefined;
      })(),
      timeoutMs,
      () => new Error("Grok model catalog discovery timed out"),
    );
  } catch (error) {
    logger.warning("Grok model catalog discovery failed", {
      event: "grok.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
    });
    return undefined;
  } finally {
    await process?.dispose();
  }
}
