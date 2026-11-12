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
  models: catalog.models.map(({ contextWindow, maxOutputTokens, ...model }) => ({
    ...model,
    reasoningEfforts: model.reasoningEfforts ?? [],
    reasoningEffortsPending: model.reasoningEfforts === undefined,
    // `uint64` on the wire, a number in the contract: a size no Computer can hold decodes absent
    // rather than as a wrong number (task #30).
    ...(contextWindow === undefined ? {} : { contextWindow: BigInt(contextWindow) }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens: BigInt(maxOutputTokens) }),
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
    contextWindow?: bigint;
    maxOutputTokens?: bigint;
  }>;
}): CodeAgentModelCatalog => ({
  provider: requireRuntimeProvider(
    catalog.provider,
    `unsupported runtime provider: ${catalog.provider}`,
  ),
  models: catalog.models.map((model) => {
    const contextWindow = modelSize(model.contextWindow);
    const maxOutputTokens = modelSize(model.maxOutputTokens);
    return {
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      modelProvider: model.modelProvider,
      reasoningEfforts: model.reasoningEffortsPending ? undefined : [...model.reasoningEfforts],
      defaultReasoning: model.defaultReasoning,
      recommended: model.recommended,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };
  }),
});

/** A model size off the wire, or undefined for a zero, an unsafe size, or none at all: a provider
 * that reports nonsense must leave the form blank rather than show a number (task #30). */
function modelSize(value: bigint | undefined): number | undefined {
  if (value === undefined || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    return undefined;
  return Number(value);
}
