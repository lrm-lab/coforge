import type { CodeAgentModelCatalog, RuntimeMetadata } from "./computer-agent-messages";
import { requireRuntimeProvider, parseRuntimeUnavailableCode } from "./index";

export const runtimeMetadata = (runtime: RuntimeMetadata) => ({
  ...runtime,
});

export const decodedRuntimeMetadata = (runtime: {
  provider: string;
  version: string;
  displayName: string;
  unavailableCode?: string;
  diagnostic?: string;
}): RuntimeMetadata => {
  // A newer daemon's code reads as `unknown`, never as a usable runtime.
  const unavailableCode = parseRuntimeUnavailableCode(runtime.unavailableCode);
  return {
    provider: requireRuntimeProvider(
      runtime.provider,
      `unsupported runtime provider: ${runtime.provider}`,
    ),
    version: runtime.version,
    displayName: runtime.displayName,
    ...(unavailableCode ? { unavailableCode } : {}),
    ...(unavailableCode && runtime.diagnostic ? { diagnostic: runtime.diagnostic } : {}),
  };
};

export const modelCatalog = (catalog: CodeAgentModelCatalog) => ({
  provider: catalog.provider,
  models: catalog.models.map((model) => ({
    ...model,
    reasoningEfforts: model.reasoningEfforts ?? [],
    reasoningEffortsPending: model.reasoningEfforts === undefined,
  })),
});

export const decodedModelCatalog = (catalog: {
  provider: string;
  models: Array<{
    id: string;
    displayName: string;
    description: string;
    modelProvider: string;
    reasoningEfforts: string[];
    reasoningEffortsPending: boolean;
    defaultReasoning: string;
    recommended: boolean;
  }>;
}): CodeAgentModelCatalog => ({
  provider: requireRuntimeProvider(
    catalog.provider,
    `unsupported runtime provider: ${catalog.provider}`,
  ),
  models: catalog.models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    description: model.description,
    modelProvider: model.modelProvider,
    reasoningEfforts: model.reasoningEffortsPending ? undefined : [...model.reasoningEfforts],
    defaultReasoning: model.defaultReasoning,
    recommended: model.recommended,
  })),
});
