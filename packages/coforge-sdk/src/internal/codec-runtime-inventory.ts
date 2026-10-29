import type {
  CodeAgentModelCatalog,
  RuntimeMetadata,
  RuntimeUnavailableCode,
} from "./computer-agent-messages";
import { requireRuntimeProvider } from "./index";

export const runtimeMetadata = (runtime: RuntimeMetadata) => ({
  ...runtime,
});

/** A code this build knows, or undefined. A newer daemon's code is dropped rather than read as
 * one of ours, and a runtime without a known code stays usable. */
const runtimeUnavailableCode = (value: string | undefined): RuntimeUnavailableCode | undefined =>
  value === "version_unsupported" || value === "start_failed" || value === "probe_failed"
    ? value
    : undefined;

export const decodedRuntimeMetadata = (runtime: {
  provider: string;
  version: string;
  displayName: string;
  unavailableCode?: string;
  diagnostic?: string;
}): RuntimeMetadata => {
  const unavailableCode = runtimeUnavailableCode(runtime.unavailableCode);
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
