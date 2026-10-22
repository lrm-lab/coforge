import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import { isVersionBelow } from "#src/code-agent/version-gate";

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
