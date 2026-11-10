import type {
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
  ProviderModelRefreshResult,
  RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

type Viewer = { userId: string; workspaceId: string };
type Scope = { workspaceId: string; computerId: string };

/** How long a refresh request is pending: the Daemon's reply is stored only while it is, and a
 * stored reply then lives 30 seconds. */
export const MODEL_CATALOG_REFRESH_PENDING_TTL_SECONDS = 60;

/** How long a rescan marks the Computer as detecting its runtimes at most: the Daemon's 45 second
 * probe budget, which is shorter than the page's wait, so the page never gives up on a rescan
 * while the mark remains. */
export const MODEL_CATALOG_REFRESH_DETECTING_TTL_SECONDS = 45;

/** What starting a refresh tells the page: the request whose answer `read` returns; a refusal, the
 * Computer being none the viewer reaches; or a failure, with nothing asked of the Computer. */
export type ModelCatalogRefreshStart =
  | { status: "started"; requestId: string }
  | { status: "refused" }
  | { status: "failed" };

/** What reading a refresh tells the page: no answer yet, the Computer's answer as the page draws
 * it, or a refusal, the viewer no longer reaching the Computer. */
export type ModelCatalogRefreshRead =
  | { status: "pending" }
  | { status: "settled"; outcome: ModelCatalogRefreshOutcome }
  | { status: "refused" };

/** Each provider's own outcome is in the answer, so one failed runtime never hides another's
 * fresh catalog. */
export type ModelCatalogRefreshOutcome = ReturnType<typeof refreshOutcomeFor>;

/**
 * An explicit model probe of a Computer, scoped to one provider when the request names it, which is
 * also the Computer page's "Rescan runtimes". Production closes a request idle for about ten
 * seconds and a whole-Computer rescan runs its runtimes one after another, so starting publishes
 * the probe and returns at once and the page polls `read`, as the reference Computer acknowledges a
 * rescan and reports its results separately. The Computer reads as detecting its runtimes from the
 * start until this request's result arrives (`createDaemonRuntimeProviderModelRefreshResultMethod`
 * ends it), or the mark expires.
 */
export class ComputerModelCatalogRefresh {
  constructor(
    private readonly dependencies: {
      publish(request: DaemonRuntimeProviderModelRefreshRequest): Promise<void>;
      results: {
        begin(pending: {
          request: DaemonRuntimeProviderModelRefreshRequest;
          userId: string;
          revision: string;
        }): Promise<void>;
        read(requestId: string): Promise<DaemonRuntimeProviderModelRefreshResponse | undefined>;
      };
      detection: {
        begin(scope: Scope, requestId: string): Promise<unknown>;
        end(scope: Scope, requestId: string): Promise<unknown>;
      };
      /** Whether the viewer reaches this Computer in their Workspace. */
      authorize(viewer: Viewer, computerId: string): Promise<boolean>;
      /** The runtimes of the Computer the viewer may see; only those are returned. */
      visibleProviders(viewer: Viewer, computerId: string): Promise<ReadonlySet<RuntimeProvider>>;
    },
  ) {}

  async start(
    viewer: Viewer,
    input: { computerId: string; provider?: RuntimeProvider },
  ): Promise<ModelCatalogRefreshStart> {
    const { authorize, results, publish, detection } = this.dependencies;
    if (!(await authorize(viewer, input.computerId))) return { status: "refused" };
    const request: DaemonRuntimeProviderModelRefreshRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: input.computerId,
      ...(input.provider ? { provider: input.provider } : {}),
    };
    const scope = { workspaceId: viewer.workspaceId, computerId: input.computerId };
    try {
      await detection.begin(scope, request.requestId);
      await results.begin({ request, userId: viewer.userId, revision: "" });
      await publish(request);
    } catch {
      // A probe is safe to ask again, so one that did not go out is simply a failed refresh; one
      // that did is left to expire.
      await detection.end(scope, request.requestId).catch(() => {});
      return { status: "failed" };
    }
    return { status: "started", requestId: request.requestId };
  }

  /**
   * The Computer's answer to one probe. While nothing matching has arrived the answer is pending
   * and nothing else is read: an answer that names another Workspace or Computer is none of the
   * caller's. An answer is checked against the viewer's access before it is returned. It is left
   * to expire, so a poll that lost the reply can ask again.
   */
  async read(
    viewer: Viewer,
    input: { computerId: string; provider?: RuntimeProvider; requestId: string },
  ): Promise<ModelCatalogRefreshRead> {
    const { authorize, results, visibleProviders } = this.dependencies;
    const answer = await results.read(input.requestId);
    if (
      !answer ||
      answer.workspaceId !== viewer.workspaceId ||
      answer.computerId !== input.computerId
    )
      return { status: "pending" };
    // `accepted` names the request's answer; a Computer that rejected it has no reason to give, so
    // its runtimes are not looked up.
    const [allowed, visible] = await Promise.all([
      authorize(viewer, input.computerId),
      answer.accepted ? visibleProviders(viewer, input.computerId) : undefined,
    ]);
    if (!allowed) return { status: "refused" };
    return {
      status: "settled",
      outcome: visible
        ? refreshOutcomeFor(answer.results, visible, input.provider)
        : { status: "error" },
    };
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
