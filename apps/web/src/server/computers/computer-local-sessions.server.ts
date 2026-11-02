import type {
  HandoffRuntimeProvider,
  LocalSessionExcerptRequest,
  LocalSessionExcerptResult,
  LocalSessionSearchRequest,
  LocalSessionSearchResult,
} from "@lrm/coforge-sdk/internal";

export type LocalSessionViewer = { userId: string; workspaceId: string };
export type PendingLocalSessionSearch = { request: LocalSessionSearchRequest; userId: string };
export type PendingLocalSessionExcerpt = { request: LocalSessionExcerptRequest; userId: string };

export interface LocalSessionSearchResults {
  begin(pending: PendingLocalSessionSearch): Promise<void>;
  read(requestId: string): Promise<LocalSessionSearchResult | undefined>;
  clear(requestId: string): Promise<void>;
}
export interface LocalSessionExcerptResults {
  begin(pending: PendingLocalSessionExcerpt): Promise<void>;
  read(requestId: string): Promise<LocalSessionExcerptResult | undefined>;
  clear(requestId: string): Promise<void>;
}

type Response<Result> =
  | { status: "ready"; result: Result }
  | { status: "offline" | "timeout" | "unavailable" };

export function sameLocalSessionSearchScope(
  request: LocalSessionSearchRequest,
  result: LocalSessionSearchResult,
) {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.query === result.query
  );
}

export function sameLocalSessionExcerptScope(
  request: LocalSessionExcerptRequest,
  result: LocalSessionExcerptResult,
) {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.provider === result.provider &&
    request.sessionId === result.sessionId &&
    request.cwd === result.cwd
  );
}

function pollDelayMs(attempt: number) {
  return attempt < 25 ? 20 : 100;
}

/** Browser-to-Daemon local session observations, fenced to the Computer owner at both ends. */
export class ComputerLocalSessions {
  constructor(
    private readonly dependencies: {
      owned(viewer: LocalSessionViewer, computerId: string): Promise<boolean>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publishSearch(request: LocalSessionSearchRequest): Promise<void>;
      publishExcerpt(request: LocalSessionExcerptRequest): Promise<void>;
      searchResults: LocalSessionSearchResults;
      excerptResults: LocalSessionExcerptResults;
    },
    private readonly timing: {
      now(): number;
      wait(ms: number): Promise<void>;
      timeoutMs: number;
    } = { now: Date.now, wait: (ms) => Bun.sleep(ms), timeoutMs: 5_000 },
  ) {}

  async search(
    viewer: LocalSessionViewer,
    computerId: string,
    query: string,
  ): Promise<Response<LocalSessionSearchResult>> {
    const request: LocalSessionSearchRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
      query,
    };
    return this.execute(
      viewer,
      computerId,
      request,
      this.dependencies.searchResults,
      () => this.dependencies.publishSearch(request),
      sameLocalSessionSearchScope,
    );
  }

  async excerpt(
    viewer: LocalSessionViewer,
    computerId: string,
    provider: HandoffRuntimeProvider,
    sessionId: string,
    cwd: string,
  ): Promise<Response<LocalSessionExcerptResult>> {
    const request: LocalSessionExcerptRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId,
      provider,
      sessionId,
      cwd,
    };
    return this.execute(
      viewer,
      computerId,
      request,
      this.dependencies.excerptResults,
      () => this.dependencies.publishExcerpt(request),
      sameLocalSessionExcerptScope,
    );
  }

  private async execute<
    Request extends LocalSessionSearchRequest | LocalSessionExcerptRequest,
    Result,
  >(
    viewer: LocalSessionViewer,
    computerId: string,
    request: Request,
    results: {
      begin(pending: { request: Request; userId: string }): Promise<void>;
      read(requestId: string): Promise<Result | undefined>;
      clear(requestId: string): Promise<void>;
    },
    publish: () => Promise<void>,
    sameScope: (request: Request, result: Result) => boolean,
  ): Promise<Response<Result>> {
    if (!(await this.dependencies.owned(viewer, computerId))) return { status: "unavailable" };
    try {
      if (!(await this.dependencies.online({ workspaceId: viewer.workspaceId, computerId })))
        return { status: "offline" };
      await results.begin({ request, userId: viewer.userId });
      await publish();
      const deadline = this.timing.now() + this.timing.timeoutMs;
      let attempt = 0;
      do {
        const result = await results.read(request.requestId);
        if (result) {
          if (!(await this.dependencies.owned(viewer, computerId)) || !sameScope(request, result))
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await results.clear(request.requestId).catch(() => {});
    }
  }
}
