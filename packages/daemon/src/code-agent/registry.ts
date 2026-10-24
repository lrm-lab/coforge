import { AntigravityProvider } from "#src/code-agent/antigravity/provider";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { CodexProvider } from "#src/code-agent/codex/provider";
import type { CodeAgentProvider } from "@lrm/coforge-anvil";
import { CursorProvider } from "#src/code-agent/cursor/provider";
import { CoforgeProvider, PiProvider } from "#src/code-agent/pi/provider";
import { KiroProvider } from "#src/code-agent/kiro/provider";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { OpenCodeProvider } from "#src/code-agent/opencode/provider";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  resolveHostCodeAgentExecutable,
  type ExternalCodeAgentProvider,
} from "#src/code-agent/runtime-executable";

type CodeAgentProviderRegistryOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
};

function providerExecutable(
  provider: ExternalCodeAgentProvider,
  options: CodeAgentProviderRegistryOptions,
): string | undefined {
  return resolveHostCodeAgentExecutable(provider, options.environment, options.platform);
}

export function createCodeAgentProvider(
  provider: RuntimeProvider,
  options: CodeAgentProviderRegistryOptions = {},
): CodeAgentProvider {
  switch (provider) {
    case RUNTIME_PROVIDER.COFORGE:
      return new CoforgeProvider();
    case RUNTIME_PROVIDER.PI:
      return new PiProvider();
    case RUNTIME_PROVIDER.CODEX: {
      const executable = providerExecutable(RUNTIME_PROVIDER.CODEX, options);
      return new CodexProvider(executable ? { command: [executable, "app-server"] } : undefined);
    }
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeProvider();
    case RUNTIME_PROVIDER.KIRO:
      return new KiroProvider();
    case RUNTIME_PROVIDER.CURSOR:
      return new CursorProvider();
    case RUNTIME_PROVIDER.OPENCODE: {
      const executable = providerExecutable(RUNTIME_PROVIDER.OPENCODE, options);
      return new OpenCodeProvider(executable ? { command: [executable] } : undefined);
    }
    case RUNTIME_PROVIDER.GROK: {
      const executable = providerExecutable(RUNTIME_PROVIDER.GROK, options);
      return new GrokProvider(executable ? { command: [executable] } : undefined);
    }
    case RUNTIME_PROVIDER.ANTIGRAVITY:
      return new AntigravityProvider();
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
  }
}
