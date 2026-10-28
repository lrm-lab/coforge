import type { RuntimeAuthStatus } from "@lrm/coforge-anvil";
import {
  RUNTIME_AUTH_PROVIDERS,
  RUNTIME_PROVIDER,
  type RuntimeAuthProvider,
} from "@lrm/coforge-sdk/internal";

import type { AccountState } from "./runtime-usage-status";

/**
 * Providers whose login status the Computer chip shows. Same set as Anvil's auth-status list,
 * including Command Code. The SDK `RUNTIME_AUTH_PROVIDERS` list stays the sign-in set: it also
 * gates the login and logout requests, and Command Code login stays in the user's terminal.
 * A web test locks this array to Anvil's list so the two cannot drift.
 */
export const RUNTIME_LOGIN_STATE_PROVIDERS = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.COMMAND_CODE,
  RUNTIME_PROVIDER.DEVIN,
] as const;

export type RuntimeLoginStateProvider = (typeof RUNTIME_LOGIN_STATE_PROVIDERS)[number];

export function isRuntimeLoginStateProvider(
  provider: string,
): provider is RuntimeLoginStateProvider {
  return (RUNTIME_LOGIN_STATE_PROVIDERS as readonly string[]).includes(provider);
}

export function isSignableRuntimeProvider(provider: string): provider is RuntimeAuthProvider {
  return (RUNTIME_AUTH_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * What the Computer chip does with one runtime's login report. A reported state is shown for
 * every provider in `RUNTIME_LOGIN_STATE_PROVIDERS`. Sign in and Sign out stay on the SDK list.
 * `unknown` on a provider with no Sign in flow is not shown as logged out: Command Code uses it
 * when `cmd status --json` did not produce a trustworthy state. A provider that has a Sign in
 * flow keeps `unknown` for every viewer, so usage can still read it. A missing report is
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
  const auth = isRuntimeLoginStateProvider(input.provider) ? input.status : undefined;
  const signInFlow = isSignableRuntimeProvider(input.provider);
  const signable = input.canSignIn && signInFlow;
  const account: AccountState | undefined =
    auth?.state === "unknown" && !signInFlow
      ? undefined
      : (auth?.state ?? (signable ? "unreported" : undefined));
  return { auth, account, signable };
}
