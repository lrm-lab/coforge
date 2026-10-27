import { claudeRuntimeHost } from "#src/code-agent/claude-code/host";
import { claudeAuthHost } from "#src/code-agent/claude-code/auth-host";
import { DshProvider } from "@lrm/coforge-anvil/dsh";
import {
  CommandCodeProvider,
  CommandCodeRuntimeAuthAdapter,
} from "@lrm/coforge-anvil/command-code";
import {
  commandCodeRuntimeHost,
  createCommandCodeAuthHost,
} from "#src/code-agent/command-code/host";
import { dshRuntimeHost } from "#src/code-agent/dsh/host";
import { piRuntimeHost } from "#src/code-agent/pi/host";
import { antigravityRuntimeHost } from "#src/code-agent/antigravity/host";
import { grokRuntimeHost } from "#src/code-agent/grok/host";
import { kiroRuntimeHost } from "#src/code-agent/kiro/host";
import { AntigravityProvider } from "@lrm/coforge-anvil/antigravity";
import {
  type RuntimeAuthAdapter,
  type RuntimeAuthProvider,
  type CodeAgentProvider,
} from "@lrm/coforge-anvil";
import { CursorProvider } from "@lrm/coforge-anvil/cursor";
import { OpenCodeProvider } from "@lrm/coforge-anvil/opencode";
import { createKiroAuthHost } from "#src/code-agent/kiro/auth-host";
import { KiroRuntimeAuthAdapter } from "@lrm/coforge-anvil/kiro";
import { KiroProvider } from "@lrm/coforge-anvil/kiro";
import { GrokProvider } from "@lrm/coforge-anvil/grok";
import { PiProvider } from "@lrm/coforge-anvil/pi";
import { ClaudeCodeProvider } from "@lrm/coforge-anvil/claude-code";
import { CodexProvider, CodexRuntimeAuthAdapter } from "@lrm/coforge-anvil/codex";
import { codexRuntimeHost, createCodexAuthHost } from "#src/code-agent/codex/host";
import { ClaudeRuntimeAuthAdapter } from "@lrm/coforge-anvil/claude-code";
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
  provider:
    | ExternalCodeAgentProvider
    | typeof RUNTIME_PROVIDER.DSH
    | typeof RUNTIME_PROVIDER.COMMAND_CODE,
  options: CodeAgentProviderRegistryOptions,
): string | undefined {
  return resolveHostCodeAgentExecutable(provider, options.environment, options.platform);
}

export function createRuntimeAuthAdapter(
  provider: RuntimeAuthProvider,
  options: CodeAgentProviderRegistryOptions = {},
): RuntimeAuthAdapter {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return new CodexRuntimeAuthAdapter({
        host: createCodexAuthHost(options),
        command: [
          providerExecutable(RUNTIME_PROVIDER.CODEX, options) ?? RUNTIME_PROVIDER.CODEX,
          "app-server",
        ],
      });
    case RUNTIME_PROVIDER.KIRO:
      return new KiroRuntimeAuthAdapter(createKiroAuthHost(options.platform));
    case RUNTIME_PROVIDER.COMMAND_CODE: {
      const executable =
        providerExecutable(RUNTIME_PROVIDER.COMMAND_CODE, options) ??
        (options.platform === "win32" ? "cmdc" : "cmd");
      return new CommandCodeRuntimeAuthAdapter(createCommandCodeAuthHost([executable]));
    }
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeRuntimeAuthAdapter({
        host: claudeAuthHost,
        command: providerExecutable(RUNTIME_PROVIDER.CLAUDE_CODE, options),
      });
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
      return new CodexProvider({
        host: codexRuntimeHost,
        ...(executable ? { command: [executable, "app-server"] } : {}),
      });
    }
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return new ClaudeCodeProvider({ host: claudeRuntimeHost });
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
    case RUNTIME_PROVIDER.DSH: {
      const executable = providerExecutable(RUNTIME_PROVIDER.DSH, options);
      return new DshProvider({
        host: dshRuntimeHost,
        ...(executable ? { command: [executable] } : {}),
      });
    }
    case RUNTIME_PROVIDER.COMMAND_CODE: {
      const executable = providerExecutable(RUNTIME_PROVIDER.COMMAND_CODE, options);
      return new CommandCodeProvider({
        host: commandCodeRuntimeHost,
        command: [executable ?? (options.platform === "win32" ? "cmdc" : "cmd")],
      });
    }
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled runtime provider: ${unreachable}`);
    }
  }
}
