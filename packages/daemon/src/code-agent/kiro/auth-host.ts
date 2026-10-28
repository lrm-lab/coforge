import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal/runtime-provider";
import type { KiroAuthHost } from "@lrm/coforge-anvil/kiro";
import { agentEnvironment } from "#src/code-agent/environment";
import { resolveHostCodeAgentExecutable } from "#src/code-agent/runtime-executable";
import { maskEmail } from "#src/code-agent/mask-email";
import { processSpawner } from "#src/code-agent/process-host";
import { runtimeAuthProcess } from "#src/code-agent/auth-process";

/** Host process, environment and masking policy for Kiro's native auth adapter. */
export function kiroEnterpriseAuthSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function createKiroAuthHost(platform = process.platform): KiroAuthHost {
  return {
    enterpriseLoginSupported: kiroEnterpriseAuthSupported(platform),
    maskAccountLabel: maskEmail,
    spawn(args, cwd, terminal) {
      const env = agentEnvironment(undefined, Bun.env, undefined, {
        extraEnv: { NO_COLOR: "1", TERM: "xterm-256color" },
      });
      const executable =
        resolveHostCodeAgentExecutable(RUNTIME_PROVIDER.KIRO, env, platform) ?? "kiro-cli";
      return runtimeAuthProcess(
        processSpawner.spawn([executable, ...args], cwd, env, { terminal }),
      );
    },
  };
}
