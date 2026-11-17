import { parseRuntimeProvider, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { DAEMON_LAUNCH_ENV_KEYS, usableAgentEnvironment } from "#src/code-agent/environment";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";
import { ProcJobError } from "./proc-job-error";

export function runtimeAllowsProcJobs(provider: string | undefined): boolean {
  return provider !== undefined && parseRuntimeProvider(provider) !== undefined;
}

export function sanitizeProcJobEnvironment(input: {
  provider: string | undefined;
  platform?: NodeJS.Platform;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  agentEnvVars?: Readonly<Record<string, string>>;
  jobEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const provider: RuntimeProvider | undefined = parseRuntimeProvider(input.provider);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(usableAgentEnvironment(input.agentEnvVars, provider))) {
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(input.jobEnv ?? {})) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0"))
      throw new ProcJobError("proc_invalid_request", 400, `Invalid env variable: ${key}`);
    environment[key] = value;
  }
  for (const key of DAEMON_LAUNCH_ENV_KEYS) delete environment[key];
  environment.PATH = codeAgentExecutableSearchPath(environment, input.platform ?? process.platform);
  return environment;
}
