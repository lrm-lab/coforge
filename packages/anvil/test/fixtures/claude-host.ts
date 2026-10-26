import {
  ClaudeCodeProvider,
  readClaudeCodeUsage as readNativeUsage,
  withoutClaudeCodeMarker,
  withDefaultAutoCompactWindow,
  parseClaudeAutoCompactWindow,
  CLAUDE_AUTO_COMPACT_WINDOW_ENV,
  type ClaudeRuntimeHost,
  type ClaudeAuthHost,
} from "@lrm/coforge-anvil/claude-code";
import { fixturePerTurnHost } from "./runtime-host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function unexpected(): never {
  throw new Error("Native fixture must supply this host capability");
}

function defined(environment: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const labels: Record<string, string> = {
  "frank.an@Example.com": "fra****n@example.com",
  "someone.long@example.com": "som****ng@example.com",
};

/** Fixture executables only; daemon tests cover real environment, masking and filesystem policy. */
export const fixtureClaudeHost: ClaudeRuntimeHost = {
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  buildSessionEnvironment(options) {
    const environment = withoutClaudeCodeMarker({
      ...defined(withDefaultAutoCompactWindow(Bun.env)),
      FORCE_COLOR: "0",
      ...options.runtime?.envVars,
      ...options.environment,
    });
    return {
      environment,
      autoCompactWindow: parseClaudeAutoCompactWindow(environment[CLAUDE_AUTO_COMPACT_WINDOW_ENV]),
    };
  },
  async createPromptFile(instructions) {
    const directory = await mkdtemp(join(tmpdir(), "anvil-claude-prompt-"));
    try {
      const path = join(directory, "prompt.md");
      await Bun.write(path, instructions);
      let removal: Promise<void> | undefined;
      return { path, remove: () => (removal ??= rm(directory, { recursive: true, force: true })) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  },
  createReplyIntentScanner: () => ({
    feed: () => undefined,
    complete: () => {},
    reset: () => [],
  }),
  isShellToolName: () => false,
  buildUsageEnvironment: (environment) =>
    withoutClaudeCodeMarker({ ...defined(Bun.env), ...environment, FORCE_COLOR: "0", TZ: "UTC" }),
  async runCli(command, cwd, environment, timeoutMs) {
    const child = Bun.spawn({
      cmd: [...command],
      cwd,
      env: environment,
      stdout: "pipe",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return { stdout, exitCode, timedOut };
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  },
  spawnUsageProcess: (command, cwd, environment) =>
    fixturePerTurnHost.processTreeSpawner.spawn(command, cwd, environment),
  withUsageCapabilityCache: (_command, _cwd, _environment, load) => load(() => {}),
  maskAccountLabel: (value) => labels[value],
  readHostEnvironment: unexpected,
  homeDirectory: unexpected,
  readDirectoryEntries: unexpected,
  readDirectoryNames: unexpected,
  lstat: unexpected,
  readFileTail: unexpected,
  realWorkspaceRoot: unexpected,
  rereadFile: unexpected,
};

export const fixtureClaudeAuthHost: ClaudeAuthHost = {
  buildAuthEnvironment: () => ({ NO_COLOR: "1" }),
  createAuthProcess: unexpected,
  maskAccountLabel: (value) => labels[value],
};

export function claudeProvider(
  options: Omit<ConstructorParameters<typeof ClaudeCodeProvider>[0], "host"> = {},
) {
  return new ClaudeCodeProvider({ ...options, host: fixtureClaudeHost });
}

export function readClaudeCodeUsage(
  workingDirectory: string,
  options: Omit<Parameters<typeof readNativeUsage>[1], "host"> = {},
) {
  return readNativeUsage(workingDirectory, { ...options, host: fixtureClaudeHost });
}
