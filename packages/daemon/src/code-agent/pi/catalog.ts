import { RUNTIME_PROVIDER, type CodeAgentModelCatalog } from "@lrm/coforge-sdk/internal";
import { COFORGE_PROVIDER_MODELS_GENERATED } from "@coforge/agent";

export function discoverCoforgeCatalog(): CodeAgentModelCatalog {
  return {
    provider: RUNTIME_PROVIDER.COFORGE,
    models: COFORGE_PROVIDER_MODELS_GENERATED.map((model) => ({ ...model })),
  };
}
