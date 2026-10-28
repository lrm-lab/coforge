import type { CodexRuntimeHost, CodexCatalogHost, CodexAuthHost } from "@lrm/coforge-anvil/codex";
import { fixturePerTurnHost } from "./runtime-host";

function defined(environment: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const clientInfo = { name: "coforge_daemon", title: "CoForge Daemon", version: "fixture" };
const labels: Record<string, string> = {
  "user@example.com": "u****@example.com",
  "codexuser@example.com": "cod****er@example.com",
};

/** History reads a test replaces. The default answers "no rollout". */
export const fixtureCodexHistory = {
  readHostEnvironment: () => undefined,
  homeDirectory: () => "/home/fixture",
  readDirectoryEntries: async () => [],
  async readFileTail(): Promise<{ text: string; startOffset: number }> {
    throw new Error("fixture has no rollout");
  },
};

/** Fixture subprocesses only; daemon tests exercise real environment and masking policies. */
export const fixtureCodexHost: CodexRuntimeHost = {
  ...fixtureCodexHistory,
  clientInfo,
  usageClientInfo: {
    name: "coforge-daemon-usage",
    title: "CoForge Daemon Usage",
    version: "fixture",
  },
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  maskAccountLabel: (value) => labels[value],
  async readFileText(): Promise<string> {
    throw new Error("fixture has no settings file");
  },
  buildSessionEnvironment: (options) => ({
    ...defined(Bun.env),
    FORCE_COLOR: "0",
    ...options.runtime?.envVars,
    NO_COLOR: "1",
    ...options.environment,
  }),
  buildUsageEnvironment: (environment) => ({
    ...defined(Bun.env),
    FORCE_COLOR: "0",
    ...environment,
  }),
};

export const fixtureCodexCatalogHost: CodexCatalogHost = {
  clientInfo,
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  buildCatalogEnvironment: (environment) => ({ ...defined(environment), FORCE_COLOR: "0" }),
  readJsonFile: (path) => Bun.file(path).json(),
};

export const fixtureCodexAuthHost: CodexAuthHost = {
  clientInfo,
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  maskAccountLabel: (value) => labels[value],
  buildAuthEnvironment() {
    throw new Error("Native auth test must inject its app-server");
  },
  async runCli() {
    throw new Error("Native auth test must inject its CLI result");
  },
};
