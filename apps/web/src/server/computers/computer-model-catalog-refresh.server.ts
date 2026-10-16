import type {
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
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

  async execute(viewer: { userId: string; workspaceId: string }, computerId: string) {
    const request: DaemonRuntimeProviderModelRefreshRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
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
          if (!result.accepted || result.status !== "refreshed" || !result.catalogs)
            return { status: "error" as const };
          return { status: "refreshed" as const, catalogs: result.catalogs };
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
