import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import { RUNTIME_AUTH_PROVIDERS, type RuntimeAuthProvider } from "@lrm/coforge-sdk/internal";

import type { AccountState } from "./runtime-usage-status";

/**
 * Providers whose login the Computer chip shows and signs in and out: the SDK list. A web test
 * locks it to Anvil's auth-status list so the two cannot drift.
 */
export function isSignableRuntimeProvider(provider: string): provider is RuntimeAuthProvider {
  return (RUNTIME_AUTH_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * What the Computer chip does with one runtime's login report. A reported state is shown for
 * every signable provider, `unknown` included, so usage can still read it. A missing report is
 * `unreported` only for someone who can press Sign in.
 */
export function runtimeLoginChip(input: {
  provider: string;
  status: RuntimeAuthStatus | undefined;
  canSignIn: boolean;
}): {
  auth: RuntimeAuthStatus | undefined;
  account: AccountState | undefined;
  signable: boolean;
} {
  const signInFlow = isSignableRuntimeProvider(input.provider);
  const auth = signInFlow ? input.status : undefined;
  const signable = input.canSignIn && signInFlow;
  const account: AccountState | undefined = auth?.state ?? (signable ? "unreported" : undefined);
  return { auth, account, signable };
}
