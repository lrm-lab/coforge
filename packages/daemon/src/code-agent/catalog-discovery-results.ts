import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";

/** A provider's catalog probe failure, classified without leaking native diagnostics. */
export type CatalogDiscoveryFailure = {
  provider: RuntimeProvider;
  code: RuntimeUnavailableCode;
  diagnostic?: string;
};
