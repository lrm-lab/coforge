import { piRuntimeHost } from "#src/code-agent/pi/host";
import { antigravityRuntimeHost } from "#src/code-agent/antigravity/host";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import {
  AntigravityProvider,
  type RuntimeAuthAdapter,
  type RuntimeAuthProvider,
  type CodeAgentProvider,
  CursorProvider,
  OpenCodeProvider,
  KiroProvider,
  GrokProvider,
} from "@lrm/coforge-anvil";
import { PiProvider } from "@lrm/coforge-anvil/pi";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { CodexProvider } from "#src/code-agent/codex/provider";
import { ClaudeRuntimeAuthAdapter } from "#src/code-agent/claude-code/auth";
import { CodexRuntimeAuthAdapter } from "#src/code-agent/codex/auth";
import { perTurnSessionHost } from "./per-turn-host";
import { CoforgeProvider } from "#src/code-agent/pi/provider";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import {
  resolveHostCodeAgentExecutable,
  type ExternalCodeAgentProvider,
} from "#src/code-agent/runtime-executable";
import { readVersionOutput } from "./version-probe";

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

export function createRuntimeAuthAdapter(provider: RuntimeAuthProvider): RuntimeAuthAdapter {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return new CodexRuntimeAuthAdapter();
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeRuntimeAuthAdapter();
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime auth provider: ${unreachable}`);
    }
  }
}

export function createCodeAgentProvider(
  provider: RuntimeProvider,
  options: CodeAgentProviderRegistryOptions = {},
): CodeAgentProvider {
  switch (provider) {
    case RUNTIME_PROVIDER.COFORGE:
      return new CoforgeProvider();
    case RUNTIME_PROVIDER.PI:
      return new PiProvider({ host: piRuntimeHost });
    case RUNTIME_PROVIDER.CODEX: {
      const executable = providerExecutable(RUNTIME_PROVIDER.CODEX, options);
      return new CodexProvider(executable ? { command: [executable, "app-server"] } : undefined);
    }
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeProvider();
    case RUNTIME_PROVIDER.KIRO:
      return new KiroProvider({ host: kiroRuntimeHost });
    case RUNTIME_PROVIDER.CURSOR:
      return new CursorProvider({ host: perTurnSessionHost });
    case RUNTIME_PROVIDER.OPENCODE: {
      const executable = providerExecutable(RUNTIME_PROVIDER.OPENCODE, options);
      return new OpenCodeProvider({
        command: executable ? [executable] : undefined,
        host: perTurnSessionHost,
        versionReader: readVersionOutput,
      });
    }
    case RUNTIME_PROVIDER.GROK: {
      const executable = providerExecutable(RUNTIME_PROVIDER.GROK, options);
      return new GrokProvider({
        host: grokRuntimeHost,
        ...(executable ? { command: [executable] } : {}),
      });
    }
    case RUNTIME_PROVIDER.ANTIGRAVITY:
      return new AntigravityProvider({ host: antigravityRuntimeHost });
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
  }
}
