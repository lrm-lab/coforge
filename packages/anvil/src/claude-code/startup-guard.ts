export const CLAUDE_HOST_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_CCR_V2",
] as const;

const CLAUDE_HOST_PROVIDER_ENV_KEY_SET = new Set<string>(CLAUDE_HOST_PROVIDER_ENV_KEYS);

const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CLAUDE_STARTUP_RESERVED_TOKENS = 40_000;
const CLAUDE_STARTUP_MIN_BUDGET_TOKENS = 40_000;

export function withoutHostClaudeProviderEnv(
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (CLAUDE_HOST_PROVIDER_ENV_KEY_SET.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}

function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function estimateStartupPromptTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCodePoint(text.charCodeAt(i))) cjkChars += 1;
  }
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + nonCjkChars / 4);
}

function positiveFinite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

export function claudeStartupContextWindow(
  model: string | undefined,
  autoCompactWindow?: number,
  configuredContextWindow?: number,
): number {
  const baseWindow =
    positiveFinite(configuredContextWindow) ??
    (/\[1m\]$/i.test(model?.trim() ?? "")
      ? CLAUDE_EXTENDED_CONTEXT_WINDOW_TOKENS
      : CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
  const compactCap = positiveFinite(autoCompactWindow);
  return compactCap !== undefined ? Math.min(baseWindow, compactCap) : baseWindow;
}

export class ClaudeStartupPromptBudgetError extends Error {
  readonly code = "startup_prompt_too_large";
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  readonly contextWindowTokens: number;

  constructor(estimatedTokens: number, budgetTokens: number, contextWindowTokens: number) {
    super(
      `Claude Code startup instructions (~${estimatedTokens.toLocaleString("en-US")} tokens) ` +
        `exceed the startup budget (${budgetTokens.toLocaleString("en-US")} tokens for a ` +
        `${contextWindowTokens.toLocaleString("en-US")}-token window). Trim agent instructions, ` +
        `workspace apps/skills, or increase the context/auto-compact window and retry.`,
    );
    this.name = "ClaudeStartupPromptBudgetError";
    this.estimatedTokens = estimatedTokens;
    this.budgetTokens = budgetTokens;
    this.contextWindowTokens = contextWindowTokens;
  }
}

export function assertClaudeStartupPromptWithinBudget(
  instructions: string,
  options?: { model?: string; autoCompactWindow?: number; contextWindow?: number },
): void {
  const contextWindowTokens = claudeStartupContextWindow(
    options?.model,
    options?.autoCompactWindow,
    options?.contextWindow,
  );
  const budgetTokens = Math.min(
    contextWindowTokens,
    Math.max(
      CLAUDE_STARTUP_MIN_BUDGET_TOKENS,
      contextWindowTokens - CLAUDE_STARTUP_RESERVED_TOKENS,
    ),
  );
  if (Math.ceil(instructions.length / 1.5) <= budgetTokens) return;
  const estimatedTokens = estimateStartupPromptTokens(instructions);
  if (estimatedTokens > budgetTokens) {
    throw new ClaudeStartupPromptBudgetError(estimatedTokens, budgetTokens, contextWindowTokens);
  }
}
