import type { AgentSessionOptions } from "@coforge/agent";
import type {
  CodexRuntimeHost,
  CodexCatalogHost,
  CodexAuthHost,
  CodexCliResult,
} from "@lrm/coforge-anvil/codex";
import { agentEnvironment } from "#src/code-agent/environment";
import { processSpawner } from "#src/code-agent/process-host";
import { jsonlCatalogHost } from "#src/code-agent/catalog-host";
import { maskEmail } from "#src/code-agent/mask-email";
import { COFORGE_DAEMON_VERSION } from "#src/version";

export const codexClientInfo = {
  name: "coforge_daemon",
  title: "CoForge Daemon",
  version: COFORGE_DAEMON_VERSION,
};

export const codexRuntimeHost: CodexRuntimeHost = {
  clientInfo: codexClientInfo,
  usageClientInfo: {
    name: "coforge-daemon-usage",
    title: "CoForge Daemon Usage",
    version: COFORGE_DAEMON_VERSION,
  },
  processTreeSpawner: processSpawner,
  maskAccountLabel: maskEmail,
  buildSessionEnvironment: (options: AgentSessionOptions) =>
    agentEnvironment(options.environment, Bun.env, undefined, {
      envVars: options.runtime?.envVars,
      extraEnv: { NO_COLOR: "1" },
      gitHooks: options.gitHooks,
    }),
  buildUsageEnvironment: (environment) => agentEnvironment(environment),
};

export const codexCatalogHost: CodexCatalogHost = {
  clientInfo: codexClientInfo,
  processTreeSpawner: processSpawner,
  buildCatalogEnvironment: (environment) => jsonlCatalogHost.buildCatalogEnvironment(environment),
  readJsonFile: (path) => Bun.file(path).json(),
};

export function createCodexAuthHost(
  options: {
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  } = {},
): CodexAuthHost {
  const environment = () =>
    agentEnvironment(undefined, options.environment ?? Bun.env, options.platform, {
      extraEnv: { NO_COLOR: "1" },
    });
  return {
    clientInfo: codexClientInfo,
    processTreeSpawner: processSpawner,
    maskAccountLabel: maskEmail,
    buildAuthEnvironment: environment,
    runCli: (command, cwd, timeoutMs) => runCodexCli(command, cwd, timeoutMs, environment()),
  };
}

async function runCodexCli(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<CodexCliResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let handle: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([text, stderr, exitCode]) => ({ text, stderr, exitCode })),
    new Promise<CodexCliResult>((resolve) => {
      handle = setTimeout(() => {
        child.kill();
        resolve({ text: "", stderr: "", exitCode: -1, timedOut: true });
      }, timeoutMs);
    }),
  ]);
  if (handle) clearTimeout(handle);
  return result;
}
