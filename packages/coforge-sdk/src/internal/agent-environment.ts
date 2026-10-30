/**
 * The agent environment rule, shared by the two edges that enforce it: the Web API validates what a
 * Workspace submits, and the daemon re-validates the environment it receives before spawning a code
 * agent. Both used to spell all of it out — the count limit, the name grammar, the reserved names and
 * the two size limits — so a payload the first edge accepted could be refused by the second.
 *
 * The reserved names are part of the rule rather than of either edge: a variable that shadows `PATH`,
 * that claims the `COFORGE_` namespace, or that makes a runtime's own shell or toolchain execute
 * something else (`NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, …) has to be refused wherever
 * the environment is read. The list follows Raft 1.0.56's `agentEnvVarPolicy`.
 */
export const AGENT_ENVIRONMENT_MAX_VARIABLES = 64;
export const AGENT_ENVIRONMENT_MAX_NAME_LENGTH = 128;
export const AGENT_ENVIRONMENT_MAX_VALUE_LENGTH = 32_768;
export const AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH = 131_072;

/** The variable-name grammar: a shell-identifier shape, so a name always survives `env`. */
export const AGENT_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names no environment may set: a runtime's own process, shell, interpreter or toolchain reads
 * each of them and runs whatever they name, so setting one is running code on the Computer. */
export const AGENT_ENVIRONMENT_RESERVED_NAMES: readonly string[] = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "COMSPEC",
  "NODE_OPTIONS",
  "SHELL",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_ENV_FILE",
  "BASH_ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONWARNINGS",
  "BROWSER",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NPM_CONFIG_SCRIPT_SHELL",
  "NPM_CONFIG_NODE_OPTIONS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_TEMPLATE_DIR",
  "GIT_DIR",
];

/** Prefixes no environment may set. `COFORGE_` is the daemon's own namespace; the rest name a
 * family whose effect depends on the suffix (`LD_*`, `DYLD_*`, exported shell functions,
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`). */
export const AGENT_ENVIRONMENT_RESERVED_PREFIXES: readonly string[] = [
  "COFORGE_",
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
];

const RESERVED_NAMES: ReadonlySet<string> = new Set(AGENT_ENVIRONMENT_RESERVED_NAMES);

/** Whether a variable name is one no environment may set. Compared in upper case: Windows names
 * are case-insensitive, and a case-mixed spelling must not slip past on any platform. */
export function isReservedAgentEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_NAMES.has(upper) ||
    AGENT_ENVIRONMENT_RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Whether a value must never reach a launched process. That is every reserved name except the
 * `COFORGE_` namespace: a `COFORGE_` variable in the Agent's own environment overrides the Daemon's
 * knobs by design (docs/observability/agent-status-and-activity/runtime-lifecycle.md), while the
 * capability names among them are cleared before launch (`DAEMON_LAUNCH_ENV_KEYS`).
 */
export function isLaunchUnsafeAgentEnvironmentName(name: string): boolean {
  return !name.toUpperCase().startsWith("COFORGE_") && isReservedAgentEnvironmentName(name);
}

/** The names an environment carries that a launch has to skip, so an edge can report each one
 * instead of failing, or silently dropping the whole map. */
export function launchUnsafeAgentEnvironmentNames(
  environment: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(environment).filter(isLaunchUnsafeAgentEnvironmentName);
}

/** The rule an environment breaks, named so an edge can refuse it with a reason instead of a guess. */
export type AgentEnvironmentViolation =
  | "too-many"
  | "invalid-name"
  | "reserved-name"
  | "invalid-value"
  | "too-large";

export function agentEnvironmentNameViolation(
  name: string,
): Extract<AgentEnvironmentViolation, "invalid-name" | "reserved-name"> | undefined {
  if (!AGENT_ENVIRONMENT_NAME_PATTERN.test(name) || name.length > AGENT_ENVIRONMENT_MAX_NAME_LENGTH)
    return "invalid-name";
  if (isReservedAgentEnvironmentName(name)) return "reserved-name";
  return undefined;
}

/** The first rule `environment` breaks besides a reserved name: the shape that makes the map
 * unusable, for an edge that skips the reserved names instead of refusing the whole map. */
export function agentEnvironmentShapeViolation(
  environment: Readonly<Record<string, unknown>>,
): Exclude<AgentEnvironmentViolation, "reserved-name"> | undefined {
  return firstViolation(environment, false);
}

/** The first rule `environment` breaks, in the order count, each name and value, then total size. */
export function agentEnvironmentViolation(
  environment: Readonly<Record<string, unknown>>,
): AgentEnvironmentViolation | undefined {
  return firstViolation(environment, true);
}

function firstViolation(
  environment: Readonly<Record<string, unknown>>,
  checkReserved: false,
): Exclude<AgentEnvironmentViolation, "reserved-name"> | undefined;
function firstViolation(
  environment: Readonly<Record<string, unknown>>,
  checkReserved: true,
): AgentEnvironmentViolation | undefined;
function firstViolation(
  environment: Readonly<Record<string, unknown>>,
  checkReserved: boolean,
): AgentEnvironmentViolation | undefined {
  const entries = Object.entries(environment);
  if (entries.length > AGENT_ENVIRONMENT_MAX_VARIABLES) return "too-many";
  for (const [name, value] of entries) {
    if (
      !AGENT_ENVIRONMENT_NAME_PATTERN.test(name) ||
      name.length > AGENT_ENVIRONMENT_MAX_NAME_LENGTH
    )
      return "invalid-name";
    // The caller that asks for the shape rule has already decided a reserved name is not its
    // business, so the check is skipped rather than reported and filtered back out.
    if (checkReserved && isReservedAgentEnvironmentName(name)) return "reserved-name";
    if (
      typeof value !== "string" ||
      value.includes("\0") ||
      value.length > AGENT_ENVIRONMENT_MAX_VALUE_LENGTH
    )
      return "invalid-value";
  }
  if (JSON.stringify(environment).length > AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH)
    return "too-large";
  return undefined;
}
