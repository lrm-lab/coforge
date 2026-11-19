import { describe, expect, test } from "bun:test";
import { ClaudeStartupPromptBudgetError } from "@lrm/coforge-anvil/claude-code";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  isNonRetryableLaunchFailure,
  LAUNCH_FAILURE_REASON,
  launchFailureActivity,
} from "#src/agent-runtime/launch-failure";
import { buildClaudeLaunchEnvironment } from "#src/code-agent/claude-code/host";
import { CredentialDiskWatch } from "#src/daemon-runtime/credential-disk-watch";
import { CredentialInvalidLedger } from "#src/daemon-runtime/credential-invalid-ledger";

describe("buildClaudeLaunchEnvironment", () => {
  test("strips undeclared host Claude provider vars while preserving explicit Agent envVars", () => {
    const { environment } = buildClaudeLaunchEnvironment(
      {
        runtime: {
          provider: RUNTIME_PROVIDER.CLAUDE_CODE,
          model: "sonnet",
          reasoning: "medium",
          envVars: {
            ANTHROPIC_BASE_URL: "https://agent-configured.example",
            ANTHROPIC_AUTH_TOKEN: "agent-token",
          },
        },
      },
      {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        ANTHROPIC_API_KEY: "host-leaked-key",
        ANTHROPIC_BASE_URL: "https://host-leaked.example",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6-v1:0",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        CLAUDE_CODE_USE_GATEWAY: "1",
        CLAUDECODE: "1",
      },
    );

    expect(environment.ANTHROPIC_BASE_URL).toBe("https://agent-configured.example");
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("agent-token");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_GATEWAY).toBeUndefined();
    expect(environment.CLAUDECODE).toBeUndefined();
    expect(environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  test("classifies ClaudeStartupPromptBudgetError as non-retryable with surfaced detail", () => {
    const error = new ClaudeStartupPromptBudgetError(175_000, 160_000, 200_000);
    expect(isNonRetryableLaunchFailure(error)).toBe(true);
    const activity = launchFailureActivity(error, "Claude Code");
    expect(activity.runtimeError.errorReason).toBe(LAUNCH_FAILURE_REASON.STARTUP_PROMPT_TOO_LARGE);
    expect(activity.detail).toContain("175,000 tokens");
    expect(activity.runtimeError.providerMessage).toContain("175,000 tokens");
  });

  test("CredentialDiskWatch ignores host ANTHROPIC_AUTH_TOKEN when watching Claude login files", async () => {
    const ledger = new CredentialInvalidLedger();
    let content = "token-v1";
    let version = 1;
    const released: string[] = [];
    const watch = new CredentialDiskWatch({
      ledger,
      release: (key) => void released.push(key),
      baseEnv: () => ({ ANTHROPIC_AUTH_TOKEN: "stale-host-token" }),
      homeDir: "/tmp/claude-home",
      platform: "linux",
      fs: {
        stat: async (path) =>
          path === "/tmp/claude-home/.claude/.credentials.json"
            ? {
                key: `${content.length}:${version}`,
                read: async () => new TextEncoder().encode(content),
              }
            : undefined,
      },
    });
    try {
      ledger.record(
        "shared:claude-code",
        { reason: "user_reauth", recordedAtMs: Date.now() },
        "agent-1",
        {
          provider: RUNTIME_PROVIDER.CLAUDE_CODE,
          model: "sonnet",
          reasoning: "medium",
        },
      );
      await Bun.sleep(10);
      content = "token-v2";
      version = 2;
      await watch.check();
      expect(released).toEqual(["shared:claude-code"]);
    } finally {
      watch.stop();
    }
  });
});
