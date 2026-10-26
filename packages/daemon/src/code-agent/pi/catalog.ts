import { join } from "node:path";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type CodeAgentModelMetadata,
} from "@lrm/coforge-sdk/internal";
import {
  COFORGE_PROVIDER_MODELS_GENERATED,
  discoverPiModels,
  getAgentDir,
  PI_MODEL_REFRESH_TIMEOUT_MS,
  supportedReasoningEfforts,
} from "@coforge/agent";
import { getLogger } from "@logtape/logtape";
import {
  asRecord,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  catalogErrorMessage,
  isModel,
  within,
} from "@lrm/coforge-anvil";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { type CatalogProgress } from "#src/code-agent/catalog-discovery";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

/** Pi's model discovery is in-process (the Pi SDK), not a spawned CLI. */
export type PiModelDiscovery = typeof discoverPiModels;

/**
 * How long Pi's in-process catalog discovery may run: the network refresh cap plus one wait for the
 * stages around it. A healthy Pi discovery can legitimately outlast one wait. Its network refresh
 * is capped at `PI_MODEL_REFRESH_TIMEOUT_MS` (`refreshPiModelCatalog` in
 * `packages/agent/src/runner.ts` aborts `ModelRuntime.refresh` of
 * `@earendil-works/pi-coding-agent@0.99.1`, `dist/core/model-runtime.d.ts`), and creating the model
 * runtime and `createAgentSessionServices` (its resource loader) run around it. A flat single wait
 * would cut a discovery the SDK itself still bounds.
 */
export const PI_CATALOG_DISCOVERY_TIMEOUT_MS =
  PI_MODEL_REFRESH_TIMEOUT_MS + CATALOG_DISCOVERY_TIMEOUT_MS;

export function piAgentDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const home = environment.HOME ?? environment.USERPROFILE;
  return environment.PI_CODING_AGENT_DIR ?? (home ? join(home, ".pi", "agent") : getAgentDir());
}

export function discoverCoforgeCatalog(): CodeAgentModelCatalog {
  return {
    provider: RUNTIME_PROVIDER.COFORGE,
    models: COFORGE_PROVIDER_MODELS_GENERATED.map((model) => ({ ...model })),
  };
}

/**
 * Pi's catalog comes from the embedded SDK, in this process, and is bounded by `within` like every
 * spawned provider's, for `timeoutMs` (production's is `PI_CATALOG_DISCOVERY_TIMEOUT_MS`). A
 * discovery that fails or outlives the deadline leaves Pi out of this pass
 * (so nothing is cached for it) and is logged with the vocabulary of `withJsonlProcess`.
 *
 * The deadline abandons the SDK call; it cannot stop it. `discoverPiModels` takes no AbortSignal,
 * and the resource loader under it (`createAgentSessionServices`) has no way to be cancelled. The
 * race still subscribes to the abandoned call, so a rejection that arrives later is observed.
 */
export async function discoverPiCatalog(
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  discover: PiModelDiscovery,
  timeoutMs: number,
  force = false,
): Promise<CodeAgentModelCatalog | undefined> {
  const startedAt = performance.now();
  try {
    const agentDir = piAgentDirectory(environment);
    const models = await within(
      discover(cwd, {
        agentDir,
        environment: definedEnvironment(environment),
        ...(force ? { force: true } : {}),
      }),
      timeoutMs,
    );
    return {
      provider: RUNTIME_PROVIDER.PI,
      models: models.map(piModel).filter(isModel),
    };
  } catch (error) {
    logger.warning("Code Agent model catalog discovery failed", {
      event: "code_agent_catalog:discovery_failed",
      provider: RUNTIME_PROVIDER.PI,
      discovery_id: crypto.randomUUID(),
      stage: "get_available_models" satisfies CatalogProgress["stage"],
      elapsed_ms: Math.round(performance.now() - startedAt),
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      outcome: "unavailable",
    });
    return undefined;
  }
}

function definedEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function piModel(value: unknown): CodeAgentModelMetadata | undefined {
  const model = asRecord(value);
  if (typeof model?.id !== "string" || typeof model.provider !== "string") return undefined;
  const reasoningEfforts = supportedReasoningEfforts(model);
  return {
    id: model.id,
    displayName: typeof model.name === "string" ? model.name : model.id,
    description: "",
    modelProvider: model.provider,
    reasoningEfforts,
    defaultReasoning: "",
    recommended: false,
  };
}
