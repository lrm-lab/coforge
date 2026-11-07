import type {
  CodeAgentModelCatalog,
  RuntimeProvider,
  RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import type { CatalogDiscoverySettled } from "./catalog-discovery-settle";

export type CatalogDiscoveryFailure = {
  provider: RuntimeProvider;
  code: RuntimeUnavailableCode;
  diagnostic?: string;
};

export type CatalogDiscoveryResult = {
  keyPaths?: string[];
  catalog?: CodeAgentModelCatalog;
};

export function selectCatalogDiscoveries<T>(
  discoveries: readonly (readonly [RuntimeProvider, Promise<T>])[],
  provider?: RuntimeProvider,
  providers?: readonly RuntimeProvider[],
): readonly (readonly [RuntimeProvider, Promise<T>])[] {
  const selected = provider
    ? [provider]
    : providers && providers.length > 0
      ? providers
      : undefined;
  return selected ? discoveries.filter(([name]) => selected.includes(name)) : discoveries;
}

export function collectCatalogDiscoveryResults(
  settled: readonly CatalogDiscoverySettled<CatalogDiscoveryResult>[],
): {
  results: Array<{
    provider: RuntimeProvider;
    keyPaths?: string[];
    catalog: CodeAgentModelCatalog;
  }>;
  failures: CatalogDiscoveryFailure[];
} {
  const results: Array<{
    provider: RuntimeProvider;
    keyPaths?: string[];
    catalog: CodeAgentModelCatalog;
  }> = [];
  const failures: CatalogDiscoveryFailure[] = [];
  for (const { provider, result, failure } of settled) {
    if (failure) failures.push({ provider, ...failure });
    else if (result?.catalog !== undefined)
      results.push({ provider, ...result, catalog: result.catalog });
    else failures.push({ provider, code: "unknown" });
  }
  return { results, failures };
}
