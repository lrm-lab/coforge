import type { AgentContextReport, RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
export type { AgentContextReport } from "@lrm/coforge-sdk/internal";
import type { AgentSession, AgentSessionOptions, UsageSnapshot } from "@coforge/agent";
export type {
  AgentActivity,
  AgentActivityLevel,
  AgentNoticeOptions,
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentRuntimeProviderConfig,
  AgentSession,
  AgentSessionOptions,
} from "@coforge/agent";
export type {
  UsageOfficialBucket,
  UsageOfficialGroup,
  UsageSnapshot,
  UsageWindow,
} from "@coforge/agent";
export interface CodeAgentProvider {
  readonly provider: RuntimeProvider;
  createAgentSession(options: AgentSessionOptions): Promise<AgentSession>;
  readUsage?(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<UsageSnapshot | null>;
  /**
   * Reads a one-shot breakdown of the Agent's current context-window composition,
   * against the Agent's own already-running native session — never a fresh one. `undefined` means
   * "ran, but no report could be made of it" (the caller reports this as `unparsed`), matching
   * `readUsage`'s own `null`-means-no-signal convention. Only the Claude Code provider implements
   * this today; a provider with no equivalent signal never offers it.
   */
  readContextReport?(options: {
    workingDirectory: string;
    sessionId: string;
    timeoutMs?: number;
  }): Promise<AgentContextReport | undefined>;
  /**
   * What the native session's own record says about it, for the idle-recycle decision: its last
   * activity and the context it last carried. `undefined` (or a missing field) means the record is
   * absent or unreadable, which the caller treats as "resume". `envVars` are the Agent's own
   * overrides, which may relocate the provider's session store.
   */
  readSessionResumeFacts?(options: {
    sessionId: string;
    envVars?: Readonly<Record<string, string>>;
  }): Promise<SessionResumeFacts | undefined>;
  /**
   * The briefing a fresh session opens with when it replaces `sessionId`, built from that session's
   * own record within `budgetTokens`; `undefined` when there is nothing worth carrying over.
   */
  readRecycleBriefing?(options: {
    sessionId: string;
    workingDirectory: string;
    budgetTokens: number;
    envVars?: Readonly<Record<string, string>>;
  }): Promise<string | undefined>;
}
export type SessionResumeFacts = {
  lastActivityAtMs?: number;
  lastContextTokens?: number;
};

/** Runtime providers whose native authentication can be driven by the Computer. */
export const RUNTIME_AUTH_PROVIDERS = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
] as const;
export type RuntimeAuthProvider = (typeof RUNTIME_AUTH_PROVIDERS)[number];

export function isRuntimeAuthProvider(value: unknown): value is RuntimeAuthProvider {
  return (RUNTIME_AUTH_PROVIDERS as readonly string[]).includes(value as string);
}

/** Maximum size accepted for a code pasted back from a browser login flow. */
export const RUNTIME_AUTH_CODE_MAX_LENGTH = 1024;

/**
 * Normalizes a browser-pasted login code without allowing arbitrary control data into a provider
 * process. Newlines and other Unicode whitespace are presentation around the code; after removing
 * it, non-whitespace control characters are rejected and the value stays bounded.
 */
export function normalizeRuntimeAuthCode(value: string): string {
  const normalized = value.replace(/\s/gu, "");
  if (!normalized) throw new Error("runtime auth code is empty");
  if ([...normalized].length > RUNTIME_AUTH_CODE_MAX_LENGTH)
    throw new Error("runtime auth code is too long");
  if (/[\p{Cc}\p{Cf}]/u.test(normalized))
    throw new Error("runtime auth code contains control characters");
  return normalized;
}

/** Provider-neutral snapshot safe to send to the Web; it never contains credentials. */
export type RuntimeAuthStatus = Readonly<{
  provider: RuntimeAuthProvider;
  state: "logged_in" | "logged_out" | "unknown" | "unavailable";
  accountLabel?: string;
  plan?: string;
  loginMethod?: string;
  unavailableReason?: "not_installed" | "version_unsupported" | "unsupported_installation";
}>;

export type RuntimeAuthFailure =
  | "timed_out"
  | "rejected"
  | "not_logged_in"
  | "interaction_failed"
  | "process_failed";

/** Provider-neutral login progress. Values are sanitized before an adapter emits them. */
export type RuntimeAuthLoginEvent =
  | Readonly<{ kind: "auth_url"; verificationUrl: string }>
  | Readonly<{
      kind: "device_code";
      verificationUrl?: string;
      userCode: string;
      expiresAtMs: number;
    }>
  | Readonly<{ kind: "code_prompt"; message: string }>
  | Readonly<{ kind: "info"; message: string }>;

export type RuntimeAuthLoginResult =
  | Readonly<{ status: "logged_in"; authStatus: RuntimeAuthStatus }>
  | Readonly<{
      status: "failed";
      reason: RuntimeAuthFailure;
      detail?: string;
    }>
  | Readonly<{ status: "cancelled" }>;

export type RuntimeAuthLogoutResult =
  | Readonly<{ status: "logged_out"; authStatus: RuntimeAuthStatus }>
  | Readonly<{
      status: "failed";
      reason:
        | "still_logged_in"
        | "version_unsupported"
        | "timed_out"
        | "rejected"
        | "process_failed";
      detail?: string;
    }>;

export type RuntimeAuthLoginInteraction = Readonly<{
  onEvent(event: RuntimeAuthLoginEvent): void;
  prompt(input: { kind: "manual_code"; message?: string }): Promise<string>;
  signal?: AbortSignal;
}>;

/** Lets an adapter register raw provider secrets with the caller's redactor immediately. */
export type RuntimeAuthSecretSink = (secret: string) => void;

/** The provider-neutral adapter seam; provider output parsing stays below this contract. */
export interface RuntimeAuthAdapter {
  readonly provider: RuntimeAuthProvider;
  readStatus(options: { workingDirectory: string; timeoutMs?: number }): Promise<RuntimeAuthStatus>;
  startLogin(
    options: {
      workingDirectory: string;
      timeoutMs?: number;
      onSecret?: RuntimeAuthSecretSink;
    },
    interaction: RuntimeAuthLoginInteraction,
  ): Promise<RuntimeAuthLoginResult>;
  submitCode(options: { operationId: string; code: string }): Promise<void>;
  cancel(options: { operationId: string }): Promise<void>;
  logout(options: {
    workingDirectory: string;
    timeoutMs?: number;
  }): Promise<RuntimeAuthLogoutResult>;
}
export type CodeAgentProviderFactory = (provider: RuntimeProvider) => CodeAgentProvider;
export interface CodeAgentProbe {
  which(name: string, searchPath?: string): string | undefined;
  /** `env` is the discovery environment (`agentEnvironment` for the real probe): npm-style
   * launchers (`#!/usr/bin/env node`) only resolve when the found PATH reaches the probe.
   * Process implementations may keep their own process env as a fallback base. */
  spawn(
    executable: string,
    env?: Readonly<Record<string, string>>,
  ): {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  };
  probe?(
    provider: RuntimeProvider,
    executable: string,
    env: Readonly<Record<string, string>>,
  ): Promise<string | undefined>;
  resolve?(
    provider: RuntimeProvider,
    name: string,
    searchPath?: string,
  ): string | undefined | Promise<string | undefined>;
}
export const AGENT_RUNTIME_EVENT_TYPE = {
  USAGE: "usage",
  // A provider-observed context-window reading, distinct from the plan-usage
  // `USAGE` event above. Claude Code only today; a provider with no such signal never emits it.
  CONTEXT_USAGE: "context-usage",
  // A provider-observed service-tier reading for the launch (Claude Code's `fast_mode_state`),
  // normalized by the adapter to the SDK's closed vocabulary. Claude Code only today.
  SERVICE_TIER: "service-tier",
} as const;
/** The account is authenticated but its quota cannot be represented safely. */
export class UsageUnavailableError extends Error {
  constructor() {
    super("Provider usage is unavailable");
  }
}
/** The signed-in account has no plan usage to scan at all (a Codex API-key or Bedrock account,
 * or `requiresOpenaiAuth === false`, has no rate-limit windows) — mapped to the `unsupported`
 * scan status like Pi's static answer, not a misleading empty reading. */
export class UsageUnsupportedError extends Error {
  constructor() {
    super("Usage scanning is unsupported for this account");
  }
}

/** A `readContextReport` call did not finish before its timeout; the caller reports
 * this as `timeout`, distinct from `unparsed` (ran, produced nothing parseable) or a generic
 * `error` (the CLI itself failed). */
export class AgentContextReportTimeoutError extends Error {
  constructor() {
    super("Context scan timed out");
  }
}

/*
 * Typed launch failures. A provider throws one of these when it knows why a launch cannot start;
 * `code` is the launch failure reason `agent-runtime/launch-failure.ts` reports, so the layers
 * above never read provider-specific errors or message text. `RuntimeExecutableNotFoundError`
 * (`platform/runtime-executable-not-found.ts`) follows the same convention.
 */

/** The runtime's CLI is below the version CoForge supports; the launch is refused before spawn.
 * The message names the found and required versions and what to upgrade. */
export class RuntimeVersionUnsupportedError extends Error {
  readonly code = "runtime_version_too_old";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeVersionUnsupportedError";
  }
}

/** The runtime on this Computer does not offer the Agent's configured model. */
export class RuntimeModelNotFoundError extends Error {
  readonly code = "model_not_found";
  constructor(
    readonly model: string,
    options?: ErrorOptions,
  ) {
    super(`Model ${model} is not available to this runtime`, options);
    this.name = "RuntimeModelNotFoundError";
  }
}

/** The Agent's model provider setting cannot be used: missing, unconfigured, or not matching the
 * selected model. */
export class ModelProviderSettingError extends Error {
  readonly code = "model_provider_not_configured";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelProviderSettingError";
  }
}

/** An Agent environment variable names something the runtime cannot use; its message says what. */
export class AgentEnvironmentError extends Error {
  readonly code = "agent_environment_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentEnvironmentError";
  }
}

export class AgentProcessCleanupError extends Error {
  constructor() {
    super("code agent process tree did not exit");
    this.name = "AgentProcessCleanupError";
  }
}

export type AgentSessionRecoveryCode =
  | "session_missing"
  | "session_in_use"
  | "provider_replay_rejected";

/** Safe signal that lifecycle may retry this launch once without a native session ID. */
export class AgentSessionRecoveryError extends Error {
  constructor(readonly code: AgentSessionRecoveryCode) {
    super(`code agent session recovery required: ${code}`);
    this.name = "AgentSessionRecoveryError";
  }
}
