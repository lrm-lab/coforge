import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { LocalSessionCatalog } from "#src/local-session/local-session-catalog";

type Queries = {
  connection: { workspaceId: string; computerId: string };
  catalog: Pick<LocalSessionCatalog, "search" | "excerpt">;
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
};

/** Owner authorization is enforced by Web; this binds each accepted request to this connection. */
export function subscribeLocalSessionQueries(
  transport: DaemonConnectionClient,
  queries: Queries,
): ((() => void) | undefined)[] {
  const catalog = queries.catalog;
  const accepts = (request: { workspaceId: string; computerId: string }) =>
    !queries.isStopping() &&
    request.workspaceId === queries.connection.workspaceId &&
    request.computerId === queries.connection.computerId;
  return [
    transport.onLocalSessionSearch?.(async (request) => {
      if (!accepts(request)) return;
      const result = await catalog.search(request.query);
      if (accepts(request) && queries.currentTransport() === transport)
        await transport.sendLocalSessionSearchResult?.({ ...request, ...result });
    }),
    transport.onLocalSessionExcerpt?.(async (request) => {
      if (!accepts(request)) return;
      const result = await catalog.excerpt(request.provider, request.sessionId, request.cwd);
      if (accepts(request) && queries.currentTransport() === transport)
        await transport.sendLocalSessionExcerptResult?.({ ...request, ...result });
    }),
  ];
}
