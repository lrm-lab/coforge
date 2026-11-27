import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import {
  RUNTIME_PROVIDER,
  type RuntimeAuthProvider,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { selectsCodexCompatible } from "@lrm/coforge-sdk/internal/codex-compatible-provider";

import {
  isRuntimeLoginStateProvider,
  isSignableRuntimeProvider,
} from "#src/features/computers/runtime-login-chip";

export type RuntimeSignInComputer = {
  displayName: string;
  platform?: string | null;
  ownedByCurrentUser?: boolean;
  canManageAgents?: boolean;
  runtimeAuth?: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
};

export function runtimeSignInNotice(
  computer: RuntimeSignInComputer,
  provider: RuntimeProvider,
  options?: {
    modelProvider?: string;
    codexCompatibleSupported?: boolean;
  },
): { signInProvider?: RuntimeAuthProvider; canUseCodexCompatible?: boolean } | undefined {
  if (selectsCodexCompatible(provider, options?.modelProvider)) return undefined;
  if (!isRuntimeLoginStateProvider(provider)) return undefined;
  if (computer.runtimeAuth?.[provider as RuntimeAuthProvider]?.state !== "logged_out")
    return undefined;
  const signable =
    isSignableRuntimeProvider(provider) &&
    (computer.ownedByCurrentUser || computer.canManageAgents) &&
    !(provider === RUNTIME_PROVIDER.KIRO && computer.platform === "win32");
  const canUseCodexCompatible =
    provider === RUNTIME_PROVIDER.CODEX && options?.codexCompatibleSupported === true;
  if (!signable && !canUseCodexCompatible) return {};
  return {
    ...(signable ? { signInProvider: provider } : {}),
    ...(canUseCodexCompatible ? { canUseCodexCompatible: true } : {}),
  };
}
