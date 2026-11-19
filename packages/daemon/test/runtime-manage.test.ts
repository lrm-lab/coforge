import { describe, expect, test } from "bun:test";
import {
  RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
  RUNTIME_PROVIDER,
  type RuntimeManageRequest,
  type RuntimeManageResult,
} from "@lrm/coforge-sdk/internal";
import {
  resolveRuntimeInstallPlan,
  resolveRuntimeUpgradePlan,
  sanitizeRuntimeManageEnvironment,
} from "#src/code-agent/runtime-package-plans";
import {
  RuntimeManageRunner,
  subscribeRuntimeManageQueries,
} from "#src/daemon-runtime/runtime-manage-handler";

function makeRequest(overrides: Partial<RuntimeManageRequest> = {}): RuntimeManageRequest {
  return {
    protocolMajor: 1,
    requestId: "rtm_0123456789abcdef0123456789abcdef",
    workspaceId: "ws-1",
    computerId: "comp-1",
    provider: RUNTIME_PROVIDER.CODEX,
    action: "install",
    requestedByUserId: "user-1",
    timeoutMs: RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

describe("runtime package install and upgrade plans", () => {
  test("selects npm first and homebrew fallback for supported CLIs, and rejects built-ins", async () => {
    const withNpm = await resolveRuntimeInstallPlan(RUNTIME_PROVIDER.CODEX, {
      platform: "darwin",
      which: (name) => (name === "npm" ? "/opt/homebrew/bin/npm" : undefined),
    });
    expect(withNpm).toEqual({
      kind: "plan",
      source: "npm",
      steps: [
        {
          command: ["/opt/homebrew/bin/npm", "install", "-g", "@openai/codex"],
          display: "npm install -g @openai/codex",
        },
      ],
    });

    const brewOnly = await resolveRuntimeInstallPlan(RUNTIME_PROVIDER.CLAUDE_CODE, {
      platform: "darwin",
      which: (name) => (name === "brew" ? "/opt/homebrew/bin/brew" : undefined),
    });
    expect(brewOnly).toEqual({
      kind: "plan",
      source: "homebrew",
      steps: [
        {
          command: ["/opt/homebrew/bin/brew", "install", "--cask", "claude-code"],
          display: "brew install --cask claude-code",
        },
      ],
    });

    const missingPm = await resolveRuntimeInstallPlan(RUNTIME_PROVIDER.CODEX, {
      platform: "linux",
      which: () => undefined,
    });
    expect(missingPm).toEqual({ kind: "unsupported", reason: "missing_package_manager" });

    const builtin = await resolveRuntimeInstallPlan(RUNTIME_PROVIDER.PI, {
      platform: "linux",
      which: () => "/usr/bin/npm",
    });
    expect(builtin).toEqual({ kind: "unsupported", reason: "unsupported_provider" });
  });

  test("detects app-bundle, homebrew, npm, and native upgrade strategies from executable paths", async () => {
    const appBundle = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CODEX,
      "/Applications/Codex.app/Contents/Resources/codex",
      {
        platform: "darwin",
        which: () => "/opt/homebrew/bin/npm",
        resolveRealPath: async (p) => p,
      },
    );
    expect(appBundle).toEqual({ kind: "unsupported", reason: "managed_by_app_bundle" });

    const brewCodex = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CODEX,
      "/opt/homebrew/bin/codex",
      {
        platform: "darwin",
        which: (name) => (name === "brew" ? "/opt/homebrew/bin/brew" : undefined),
        resolveRealPath: async () => "/opt/homebrew/Caskroom/codex/0.140.0/codex",
      },
    );
    expect(brewCodex).toEqual({
      kind: "plan",
      source: "homebrew",
      steps: [
        {
          command: ["/opt/homebrew/bin/brew", "upgrade", "--cask", "codex"],
          display: "brew upgrade --cask codex",
        },
      ],
    });

    const nativeClaude = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      "/Users/alice/.local/bin/claude",
      {
        platform: "darwin",
        which: () => undefined,
        resolveRealPath: async () => "/Users/alice/.local/share/claude/versions/2.1.40",
      },
    );
    expect(nativeClaude).toEqual({
      kind: "plan",
      source: "native",
      steps: [
        {
          command: ["/Users/alice/.local/bin/claude", "update"],
          display: "claude update",
        },
      ],
    });
  });

  test("strips internal CoForge and Slock credentials from installer subprocess environment", () => {
    const env = sanitizeRuntimeManageEnvironment({
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/home/alice",
      COFORGE_API_KEY: "secret-key",
      COFORGE_AGENT_ID: "agent-1",
      SLOCK_TOKEN: "slock-secret",
      CLAUDECODE: "1",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    });
    expect(env.PATH).toContain("/usr/bin:/opt/homebrew/bin");
    expect(env.HOME).toBe("/home/alice");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8080");
    expect(env.COFORGE_API_KEY).toBeUndefined();
    expect(env.COFORGE_AGENT_ID).toBeUndefined();
    expect(env.SLOCK_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});

describe("RuntimeManageRunner and query subscription", () => {
  test("plans, installs, upgrades, prevents concurrent runs per provider, and triggers rescan", async () => {
    let installedVersion: string | undefined;
    let executablePath: string | undefined;
    const rescans: string[] = [];
    const executedCommands: string[][] = [];

    const runner = new RuntimeManageRunner({
      platform: "linux",
      which: (name) => (name === "npm" ? "/usr/bin/npm" : undefined),
      resolveRealPath: async (p) => p,
      inspectRuntime: async () =>
        installedVersion && executablePath
          ? { installed: true, version: installedVersion, executablePath }
          : { installed: false },
      runSteps: async (steps) => {
        for (const step of steps) executedCommands.push(step.command);
        if (steps[0]?.command.at(-1) === "@openai/codex") {
          installedVersion = "0.150.0";
          executablePath = "/usr/lib/node_modules/@openai/codex/bin/codex";
        } else if (steps[0]?.command.at(-1) === "@openai/codex@latest") {
          installedVersion = "0.151.0";
        }
        return { ok: true };
      },
      rescan: async (provider) => {
        rescans.push(provider);
      },
    });

    const planResult = await runner.execute(makeRequest({ action: "plan" }));
    expect(planResult).toMatchObject({
      status: "planned",
      source: "npm",
      steps: ["npm install -g @openai/codex"],
    });
    expect(executedCommands).toEqual([]);

    const upgradeMissing = await runner.execute(makeRequest({ action: "upgrade" }));
    expect(upgradeMissing.status).toBe("not_installed");

    const installResult = await runner.execute(makeRequest({ action: "install" }));
    expect(installResult).toMatchObject({
      status: "installed",
      source: "npm",
      currentVersion: "0.150.0",
    });
    expect(rescans).toEqual([RUNTIME_PROVIDER.CODEX]);

    const repeatInstall = await runner.execute(makeRequest({ action: "install" }));
    expect(repeatInstall).toMatchObject({
      status: "already_installed",
      currentVersion: "0.150.0",
    });

    const upgradeResult = await runner.execute(makeRequest({ action: "upgrade" }));
    expect(upgradeResult).toMatchObject({
      status: "upgraded",
      source: "npm",
      previousVersion: "0.150.0",
      currentVersion: "0.151.0",
    });
    expect(rescans).toEqual([RUNTIME_PROVIDER.CODEX, RUNTIME_PROVIDER.CODEX]);
  });

  test("rejects concurrent operations for the same provider with in_progress and reports command failure cleanly", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;

    const runner = new RuntimeManageRunner({
      platform: "linux",
      which: (name) => (name === "npm" ? "/usr/bin/npm" : undefined),
      resolveRealPath: async (p) => p,
      inspectRuntime: async () => ({ installed: false }),
      runSteps: async () => {
        callCount += 1;
        if (callCount === 1) {
          await firstGate;
          return {
            ok: false,
            exitCode: 1,
            diagnostic: "npm ERR! EACCES token=sk_live_secret123456",
          };
        }
        return { ok: true };
      },
      rescan: async () => {},
    });

    const firstPromise = runner.execute(makeRequest({ action: "install" }));
    await Bun.sleep(10);
    const second = await runner.execute(
      makeRequest({
        requestId: "rtm_fedcba9876543210fedcba9876543210",
        action: "install",
      }),
    );
    expect(second).toMatchObject({ status: "error", reason: "in_progress" });

    releaseFirst?.();
    const first = await firstPromise;
    expect(first).toMatchObject({
      status: "failed",
      reason: "command_failed",
      exitCode: 1,
    });
    expect(first.diagnostic).not.toContain("sk_live_secret123456");
  });

  test("subscribeRuntimeManageQueries sends result over live transport and ignores foreign scopes", async () => {
    let handler: ((request: RuntimeManageRequest) => Promise<void>) | undefined;
    const sent: RuntimeManageResult[] = [];
    const transport = {
      onRuntimeManage: (cb: (request: RuntimeManageRequest) => Promise<void>) => {
        handler = cb;
        return () => {
          handler = undefined;
        };
      },
      sendRuntimeManageResult: async (result: RuntimeManageResult) => {
        sent.push(result);
      },
    };
    const runner = new RuntimeManageRunner({
      platform: "linux",
      which: (name) => (name === "npm" ? "/usr/bin/npm" : undefined),
      resolveRealPath: async (p) => p,
      inspectRuntime: async () => ({ installed: false }),
      runSteps: async () => ({ ok: true }),
      rescan: async () => {},
    });

    const unsubscribe = subscribeRuntimeManageQueries(transport, {
      connection: { workspaceId: "ws-1", computerId: "comp-1" },
      runner,
      currentTransport: () => transport,
      isStopping: () => false,
    });

    await handler?.(makeRequest({ workspaceId: "ws-other", action: "plan" }));
    expect(sent).toEqual([]);

    await handler?.(makeRequest({ action: "plan" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.status).toBe("planned");
    unsubscribe();
  });

  test("handles Homebrew Node npm installs, Linux brew cask guard, Claude app bundle, relative paths, and already-installed without pm", async () => {
    const brewNodeCodex = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CODEX,
      "/opt/homebrew/bin/codex",
      {
        platform: "darwin",
        which: (name) =>
          name === "npm"
            ? "/opt/homebrew/bin/npm"
            : name === "brew"
              ? "/opt/homebrew/bin/brew"
              : undefined,
        resolveRealPath: async () => "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
      },
    );
    expect(brewNodeCodex).toMatchObject({ kind: "plan", source: "npm" });

    const linuxBrewClaude = await resolveRuntimeInstallPlan(RUNTIME_PROVIDER.CLAUDE_CODE, {
      platform: "linux",
      which: (name) => (name === "brew" ? "/home/linuxbrew/.linuxbrew/bin/brew" : undefined),
    });
    expect(linuxBrewClaude).toEqual({ kind: "unsupported", reason: "missing_package_manager" });

    const claudeAppBundle = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      "/Applications/Claude Code.app/Contents/MacOS/claude",
      {
        platform: "darwin",
        which: () => undefined,
        resolveRealPath: async (p) => p,
      },
    );
    expect(claudeAppBundle).toEqual({ kind: "unsupported", reason: "managed_by_app_bundle" });

    const relativeBinary = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      "./claude",
      { platform: "linux", which: () => undefined, resolveRealPath: async (p) => p },
    );
    expect(relativeBinary).toEqual({ kind: "unsupported", reason: "unsupported_installation" });

    const unknownSystemClaude = await resolveRuntimeUpgradePlan(
      RUNTIME_PROVIDER.CLAUDE_CODE,
      "/usr/bin/claude",
      { platform: "linux", which: () => undefined, resolveRealPath: async (p) => p },
    );
    expect(unknownSystemClaude).toEqual({
      kind: "unsupported",
      reason: "unsupported_installation",
    });

    const runnerNoPm = new RuntimeManageRunner({
      platform: "linux",
      which: () => undefined,
      inspectRuntime: async () => ({
        installed: true,
        executablePath: "/home/alice/.local/bin/claude",
        version: "2.1.45",
      }),
    });
    expect(
      await runnerNoPm.execute(
        makeRequest({ provider: RUNTIME_PROVIDER.CLAUDE_CODE, action: "plan" }),
      ),
    ).toMatchObject({ status: "already_installed", currentVersion: "2.1.45" });
    expect(
      await runnerNoPm.execute(makeRequest({ provider: RUNTIME_PROVIDER.PI, action: "upgrade" })),
    ).toMatchObject({ status: "unsupported", reason: "unsupported_provider" });

    const env = sanitizeRuntimeManageEnvironment({
      Path: "/usr/bin",
      coforge_api_key: "secret",
    });
    expect(env.coforge_api_key).toBeUndefined();
    expect(env.NONINTERACTIVE).toBe("1");
  });
});
