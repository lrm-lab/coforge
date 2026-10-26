import { parseRuntimeProvider, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";

export const DSH_RUNTIME_SELECTION_REFUSAL = "dsh-runtime-not-yet-available";

/** Known vocabulary is not rollout permission. Form and server writes share this admission rule. */
export function runtimeProviderSelectionRefusal(provider: unknown) {
  if (parseRuntimeProvider(provider) === undefined) return "agent-provider-unsupported";
  // Remove this gate only with the separately reviewed D activation.
  return provider === RUNTIME_PROVIDER.DSH ? DSH_RUNTIME_SELECTION_REFUSAL : undefined;
}
