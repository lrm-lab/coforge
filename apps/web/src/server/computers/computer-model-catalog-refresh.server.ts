import type {
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
  ProviderModelRefreshResult,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

type RefreshResults = {
  begin(pending: {
    request: DaemonRuntimeProviderModelRefreshRequest;
    userId: string;
    revision: string;
  }): Promise<void>;
  read(requestId: string): Promise<DaemonRuntimeProviderModelRefreshResponse | undefined>;
  clear(requestId: string): Promise<void>;
};

/** Allows runtime version probes, sequential CLI listings, cleanup and the inventory report. */
export const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 45_000;

export type ModelCatalogRefreshOutcome =
  | { status: "refreshed"; results: ProviderModelRefreshResult[] }
  | { status: "error"; results: ProviderModelRefreshResult[] }
  | { status: "timeout" };

/** Waits for this Computer's reply to this probe, rather than a newer inventory timestamp. The
 * Computer reads as detecting its runtimes meanwhile, whatever the outcome. */
export class ComputerModelCatalogRefresh {
  constructor(
    private readonly dependencies: {
      publish(request: DaemonRuntimeProviderModelRefreshRequest): Promise<void>;
      results: RefreshResults;
      detection: {
        begin(scope: { workspaceId: string; computerId: string }): Promise<unknown>;
        end(scope: { workspaceId: string; computerId: string }): Promise<unknown>;
      };
    },
    private readonly timing = {
      now: Date.now,
      wait: () => Bun.sleep(100),
      timeoutMs: MODEL_CATALOG_REFRESH_TIMEOUT_MS,
    },
  ) {}

  async execute(
    viewer: { userId: string; workspaceId: string },
    computerId: string,
    provider?: RuntimeProvider,
  ) {
    const request: DaemonRuntimeProviderModelRefreshRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
      ...(provider ? { provider } : {}),
    };
    const { results, publish, detection } = this.dependencies;
    const scope = { workspaceId: viewer.workspaceId, computerId };
    const deadline = this.timing.now() + this.timing.timeoutMs;
    try {
      await detection.begin(scope);
      await results.begin({ request, userId: viewer.userId, revision: "" });
      await publish(request);
      do {
        const result = await results.read(request.requestId);
        if (result) {
          // `refreshed` names the request's answer; each provider's own outcome lives in
          // `results`, so one failed runtime never hides another's fresh catalog.
          if (!result.accepted) return { status: "error" as const, results: [] };
          return { status: "refreshed" as const, results: result.results };
        }
        await this.timing.wait();
      } while (this.timing.now() < deadline);
      return { status: "timeout" as const };
    } catch {
      return { status: "error" as const };
    } finally {
      await results.clear(request.requestId).catch(() => {});
      await detection.end(scope).catch(() => {});
    }
  }
}

/** Maps a terminal per-provider answer to the browser's shape: a named refresh returns its own
 * outcome; a whole-Computer rescan returns every fresh catalog, or the first failure's reason. */
export function refreshOutcomeFor(
  results: ProviderModelRefreshResult[],
  visibleProviders: ReadonlySet<RuntimeProvider>,
  provider?: RuntimeProvider,
) {
  const visible = results.filter((entry) => visibleProviders.has(entry.provider));
  if (provider) {
    const entry = visible.find((outcome) => outcome.provider === provider);
    if (!entry) return { status: "error" as const };
    if (entry.status !== "refreshed" || !entry.catalog)
      return {
        status: "error" as const,
        provider: entry.provider,
        code: entry.code,
        diagnostic: entry.diagnostic,
      };
    return { status: "refreshed" as const, catalog: entry.catalog };
  }
  const failure = visible.find((entry) => entry.status !== "refreshed");
  if (failure)
    return {
      status: "error" as const,
      provider: failure.provider,
      code: failure.code,
      diagnostic: failure.diagnostic,
    };
  return {
    status: "refreshed" as const,
    catalogs: visible.flatMap((entry) => (entry.catalog ? [entry.catalog] : [])),
  };
}
