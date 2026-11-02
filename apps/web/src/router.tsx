import { ErrorPageFrame } from "#src/features/errors/error-page-frame";
import { QueryClient } from "@tanstack/react-query";
import { DbClient, DbProvider } from "@tanstack/react-db";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { lazy, Suspense } from "react";
import { installBrowserQueryCachePersistence } from "#src/features/cache-persistence/browser-query-cache";
import { GlobalError } from "#src/features/errors/page-load-error";
import { deLocalizeUrl, localizeUrl } from "#src/paraglide/runtime";
import { PENDING_DELAY_MS, PENDING_MIN_MS } from "#src/lib/pending-policy";
import { PRELOAD_STALE_MS } from "#src/lib/preload-policy";
import { isNonLocalizedPath } from "#src/lib/non-localized-path";
import { routeTree } from "./routeTree.gen";

/** The page for a URL no route matches, loaded on demand.
 *
 * It is the app's only user of the official EmptyState, which statically imports
 * `@untitledui/file-icons` — a `FileIcon` whose extension-to-icon map references 157 icon modules,
 * about 30% of the initial vendor chunk (`bun run --cwd apps/web bundle:attribute`). Importing this
 * page from the router put that whole package in every page load's closure for a page almost nobody
 * sees; behind `lazy` it costs one request on an actual 404 instead. */
const NotFoundPage = lazy(async () => ({
  default: (await import("#src/features/errors/not-found-page")).NotFoundPage,
}));

function NotFound() {
  return (
    <Suspense fallback={<ErrorPageFrame />}>
      <NotFoundPage />
    </Suspense>
  );
}

export function getRouter() {
  // One QueryClient per request on the server and per app on the client; the SSR
  // integration dehydrates it into the document and hydrates it before render.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Live pages keep themselves current over realtime; a remount need not refetch.
        staleTime: 30_000,
        retry: false,
      },
    },
  });
  // TanStack DB's collections live on one `DbClient` per QueryClient, provided to the whole app:
  // every component that materializes a collection shares the one instance (`useDbClient`).
  const dbClient = new DbClient({ queryClient });
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    Wrap: ({ children }) => <DbProvider client={dbClient}>{children}</DbProvider>,
    scrollRestoration: true,
    // The pending fallback policy, stated once for every route (see lib/pending-policy.ts).
    defaultPendingMs: PENDING_DELAY_MS,
    defaultPendingMinMs: PENDING_MIN_MS,
    defaultPreload: "intent",
    defaultPreloadStaleTime: PRELOAD_STALE_MS,
    defaultErrorComponent: GlobalError,
    defaultNotFoundComponent: NotFound,
    rewrite: {
      input: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : deLocalizeUrl(url)),
      output: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : localizeUrl(url)),
    },
  });
  setupRouterSsrQueryIntegration({ router, queryClient });
  // Browser only: a later page load opens Chat from the queries this one kept (there is no
  // IndexedDB on the server, and the server render's QueryClient lives one request). Who is signed
  // in is what the Workspace layout's loader last answered, known before the first render.
  installBrowserQueryCachePersistence(
    queryClient,
    () =>
      router.state.matches.find((match) => match.routeId === "/w/$workspaceSlug")?.loaderData?.user
        .id,
  );

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
