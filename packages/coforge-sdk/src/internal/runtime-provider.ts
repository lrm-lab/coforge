export const RUNTIME_PROVIDER = {
  COFORGE: "coforge",
  CODEX: "codex",
  CLAUDE_CODE: "claude-code",
  PI: "pi",
  KIRO: "kiro",
  CURSOR: "cursor",
  OPENCODE: "opencode",
  GROK: "grok",
  ANTIGRAVITY: "antigravity",
} as const;
export type RuntimeProvider = (typeof RUNTIME_PROVIDER)[keyof typeof RUNTIME_PROVIDER];
/** Every RuntimeProvider value, for a zod `z.enum` or other exhaustive-tuple consumer. */
export const RUNTIME_PROVIDER_VALUES = Object.values(RUNTIME_PROVIDER) as [
  RuntimeProvider,
  ...RuntimeProvider[],
];
const RUNTIME_PROVIDERS: ReadonlySet<string> = new Set(RUNTIME_PROVIDER_VALUES);
/** The RuntimeProvider a persisted or user-supplied value names, or undefined. */
/**
 * `parseRuntimeProvider`, but an unknown value is an error rather than an absence. The callers read
 * a runtime provider that the daemon or the database already stored, so an unrecognized one means
 * the stored data and this build disagree — not that the caller should fall back to a default.
 *
 * Three copies of the two-line check lived in this file's Agent lifecycle codec, Web's Computer
 * runtimes repository and Web's Computer server functions. Each passes its own message, because
 * those messages name the surface that failed.
 */
export function requireRuntimeProvider(value: unknown, message: string): RuntimeProvider {
  const provider = parseRuntimeProvider(value);
  if (provider === undefined) throw new Error(message);
  return provider;
}

export function parseRuntimeProvider(value: unknown): RuntimeProvider | undefined {
  return typeof value === "string" && RUNTIME_PROVIDERS.has(value)
    ? (value as RuntimeProvider)
    : undefined;
}

/**
 * Whether the Daemon runs this provider as a spawned external CLI process (Codex, Claude Code,
 * Kiro) rather than in-process through the Pi SDK (Pi, CoForge). Governs whether a
 * CoForge-managed model-provider API key applies (only the in-process providers accept one).
 * A separate capability below describes which adapters implement usage scanning.
 */
export const RUNTIME_PROVIDER_USES_EXTERNAL_CLI: Record<RuntimeProvider, boolean> = {
  [RUNTIME_PROVIDER.COFORGE]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.KIRO]: true,
  [RUNTIME_PROVIDER.CURSOR]: true,
  [RUNTIME_PROVIDER.OPENCODE]: true,
  [RUNTIME_PROVIDER.GROK]: true,
  [RUNTIME_PROVIDER.ANTIGRAVITY]: true,
};

/**
 * Whether this provider's adapter accepts a Fast service tier: Claude Code applies one with
 * `--settings {"fastMode":true}`, Codex with `serviceTier:"fast"` on thread/start. The one
 * definition every surface reads — the Web's runtime picker and a saved-selection check, the
 * Daemon's model catalog, and the reference Computer's own `{claude, codex}` set all agree here.
 * A model must still report that it accepts the tier (`CodeAgentModelMetadata.supportsFastMode`).
 */
export const RUNTIME_PROVIDER_SUPPORTS_FAST_MODE: Record<RuntimeProvider, boolean> = {
  [RUNTIME_PROVIDER.COFORGE]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.KIRO]: false,
  [RUNTIME_PROVIDER.CURSOR]: false,
  [RUNTIME_PROVIDER.OPENCODE]: false,
  [RUNTIME_PROVIDER.GROK]: false,
  [RUNTIME_PROVIDER.ANTIGRAVITY]: false,
};

/** Whether the shipped adapter implements `readUsage`. Cursor, OpenCode, Pi, and CoForge
 * are not connected yet — this table does not say the official product has no quota endpoint.
 * A connected reader may still return unsupported for a particular account.
 * The daemon registry test checks this table against the actual adapters. */
export const RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN: Record<RuntimeProvider, boolean> = {
  [RUNTIME_PROVIDER.COFORGE]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.KIRO]: true,
  [RUNTIME_PROVIDER.CURSOR]: false,
  [RUNTIME_PROVIDER.OPENCODE]: false,
  [RUNTIME_PROVIDER.GROK]: true,
  [RUNTIME_PROVIDER.ANTIGRAVITY]: true,
};
