import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { isVersionBelow } from "#src/code-agent/version-gate";
import { asRecord } from "#src/code-agent/json-record";
import type { JsonlProcess } from "#src/code-agent/jsonl-process";
import { CatalogDiscoveryError, within, withJsonlProcess } from "#src/code-agent/catalog-discovery";

/**
 * The oldest Claude Code that can run a pinned model, from "Version history" and the model notes
 * in https://code.claude.com/docs/en/model-config. Only a minimum the page states belongs here: a
 * model it states none for is listed for every version. The aliases (`opus`, `sonnet`, `fable`,
 * `haiku`) are never gated; an older CLI resolves each to an older model.
 */
const CLAUDE_CODE_MODEL_MINIMUM_VERSION: Readonly<Record<string, string>> = {
  "claude-sonnet-5-5": "2.1.284",
  "claude-opus-5-5": "2.1.280",
  "claude-fable-5-1": "2.1.257",
  "claude-haiku-5-5": "2.1.293",
};

/**
 * The maintained Claude Code catalog for the installed CLI. A pinned model appears only when
 * `claudeCodeVersion` reaches its minimum; an unknown or unparseable version lists every model,
 * because a failed probe must not hide one.
 */
export function claudeStaticCatalog(claudeCodeVersion?: string): CodeAgentModelCatalog {
  // Follows Raft Computer 1.0.51's static Claude catalog: all five effort levels for every model
  // but the `haiku` alias and Haiku 4.5; a level the model lacks runs as the highest supported
  // level at or below it (code.claude.com/docs/en/model-config, "Adjust effort level").
  const full = ["low", "medium", "high", "xhigh", "max"];
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    models: [
      claudeStaticModel("opus", "Claude Opus", full),
      claudeStaticModel("fable", "Claude Fable", full),
      claudeStaticModel("sonnet", "Claude Sonnet", full),
      claudeStaticModel("haiku", "Claude Haiku"),
      claudeStaticModel("claude-opus-5-5", "Claude Opus 5.5", full),
      claudeStaticModel("claude-opus-5", "Claude Opus 5", full),
      claudeStaticModel("claude-opus-4-8", "Claude Opus 4.8", full),
      claudeStaticModel("claude-opus-4-7", "Claude Opus 4.7", full),
      claudeStaticModel("claude-opus-4-6", "Claude Opus 4.6", full),
      claudeStaticModel("claude-fable-5-1", "Claude Fable 5.1", full),
      claudeStaticModel("claude-fable-5", "Claude Fable 5", full),
      claudeStaticModel("claude-sonnet-5-5", "Claude Sonnet 5.5", full),
      claudeStaticModel("claude-sonnet-5", "Claude Sonnet 5", full),
      claudeStaticModel("claude-sonnet-4-6", "Claude Sonnet 4.6", full),
      claudeStaticModel("claude-haiku-5-5", "Claude Haiku 5.5", full),
      claudeStaticModel("claude-haiku-4-5", "Claude Haiku 4.5"),
    ].filter((model) => {
      const minimum = CLAUDE_CODE_MODEL_MINIMUM_VERSION[model.id];
      return (
        minimum === undefined ||
        claudeCodeVersion === undefined ||
        !isVersionBelow(claudeCodeVersion, minimum)
      );
    }),
  };
}

/**
 * The arguments that start Claude Code as a stream-json peer for one `list_models` request.
 * `disableAllHooks` keeps the user's hooks (SessionStart and the rest) from running during
 * discovery: measured on Claude Code 2.1.306, they fire without it.
 */
export const CLAUDE_CODE_CATALOG_ARGUMENTS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  '{"disableAllHooks":true}',
] as const;

/**
 * The maintained static catalog, with `supportsFastMode` taken from Claude Code's own
 * `list_models` answer. The answer only decides Fast support: the model set stays static. A
 * model is Fast-capable when a listed entry with `supportsFastMode: true` names it by `value` or
 * `resolvedModel`. Undefined when no answer arrives (a failed, timed-out or malformed one), like
 * any provider's failed discovery: the caller then reports the static catalog, with Fast support
 * unknown, and does not cache it.
 */
export async function discoverClaudeCodeCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  /** The wait for Claude Code's `list_models` answer. */
  timeoutMs: number,
  claudeCodeVersion?: string,
): Promise<CodeAgentModelCatalog | undefined> {
  const fastModelIds = await listFastModelIds(command, cwd, environment, timeoutMs).catch(
    () => undefined,
  );
  if (!fastModelIds) return undefined;
  const catalog = claudeStaticCatalog(claudeCodeVersion);
  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      supportsFastMode: fastModelIds.has(model.id),
    })),
  };
}

/** The ids and resolved ids of every listed model that reports Fast mode; undefined when no
 * answer arrives. A spawn failure rejects, and an established probe that fails returns undefined. */
async function listFastModelIds(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<ReadonlySet<string> | undefined> {
  return withJsonlProcess(
    RUNTIME_PROVIDER.CLAUDE_CODE,
    command,
    cwd,
    async (process, progress) => {
      const requestId = crypto.randomUUID();
      const answer = awaitControlResponse(process, requestId);
      progress.stage = "list_models";
      await process.send({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "list_models" },
      });
      const response = await within(answer, timeoutMs);
      progress.stage = "decode_catalog";
      const models = asRecord(response.response)?.models;
      if (response.subtype !== "success" || !Array.isArray(models))
        throw new CatalogDiscoveryError("Claude Code model list is unavailable");
      return new Set(
        models
          .map(asRecord)
          .filter((model) => model?.supportsFastMode === true)
          .flatMap((model) => [model?.value, model?.resolvedModel])
          .filter((id): id is string => typeof id === "string"),
      );
    },
    environment,
  );
}

/** The inner `response` of the `control_response` that answers `requestId`. Other lines (such as
 * the `system` line before it) are ignored; a process that closes or fails first rejects at once
 * rather than leaving the caller to wait out its deadline. */
function awaitControlResponse(
  process: JsonlProcess,
  requestId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const stops = [
      process.onRecord((record) => {
        const response = asRecord(record.response);
        if (record.type !== "control_response" || !response || response.request_id !== requestId)
          return;
        settle();
        resolve(response);
      }),
      process.onClose(() => {
        settle();
        reject(new CatalogDiscoveryError("Claude Code closed before listing its models"));
      }),
      process.onFailure((error) => {
        settle();
        reject(error);
      }),
    ];
    function settle(): void {
      for (const stop of stops) stop();
    }
  });
}

function claudeStaticModel(
  id: string,
  displayName: string,
  reasoningEfforts: string[] = [],
  recommended = false,
): CodeAgentModelMetadata {
  return {
    id,
    displayName,
    description: "",
    modelProvider: "",
    reasoningEfforts: [...reasoningEfforts],
    defaultReasoning: reasoningEfforts.length > 0 ? "medium" : "",
    recommended,
  };
}
