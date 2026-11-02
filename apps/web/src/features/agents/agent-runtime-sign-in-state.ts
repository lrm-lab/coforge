import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import {
  RUNTIME_PROVIDER,
  type RuntimeAuthProvider,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import {
  isRuntimeLoginStateProvider,
  isSignableRuntimeProvider,
} from "#src/features/computers/runtime-login-chip";

/** What the notice needs to know of a Computer: its stored login reports and who may sign in. */
export type RuntimeSignInComputer = {
  displayName: string;
  platform?: string | null;
  ownedByCurrentUser?: boolean;
  canManageAgents?: boolean;
  runtimeAuth?: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
};

/**
 * Whether the create dialog says the runtime is not signed in on the Computer: only for a stored
 * "logged out" report (an unknown or missing one says nothing either way). `signInProvider` is set
 * when this viewer may sign it in from here: the Computer's owner or a Workspace owner or admin,
 * for a runtime with a sign-in flow, which Kiro on Windows has not.
 */
export function runtimeSignInNotice(
  computer: RuntimeSignInComputer,
  provider: RuntimeProvider,
): { signInProvider?: RuntimeAuthProvider } | undefined {
  if (!isRuntimeLoginStateProvider(provider)) return undefined;
  if (computer.runtimeAuth?.[provider as RuntimeAuthProvider]?.state !== "logged_out")
    return undefined;
  const signable =
    isSignableRuntimeProvider(provider) &&
    (computer.ownedByCurrentUser || computer.canManageAgents) &&
    !(provider === RUNTIME_PROVIDER.KIRO && computer.platform === "win32");
  return signable ? { signInProvider: provider } : {};
}
