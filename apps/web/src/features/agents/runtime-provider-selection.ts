import { parseRuntimeProvider } from "@lrm/coforge-sdk/internal";

/** Only a known runtime may be chosen. Form and server writes share this admission rule. */
export function runtimeProviderSelectionRefusal(provider: unknown) {
  return parseRuntimeProvider(provider) === undefined ? "agent-provider-unsupported" : undefined;
}
