import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { AppAuthorizationPage } from "#src/features/app-authorization/app-authorization-page";
import { getAuthorizationPage } from "#src/features/app-authorization/app-authorization.functions";
import { answerAuthorizationForm } from "#src/features/app-authorization/authorization-form-post";
import { answerAuthorizationGet } from "#src/features/app-authorization/authorization-query.server";
import { AUTHORIZATION_PAGE_HEADERS } from "#src/features/app-authorization/authorization-page-headers";

/**
 * Login with CoForge's authorization endpoint (`AUTHORIZATION_ENDPOINT_PATH`). The loader is the
 * one pass over the request: it redirects (back to the app, or to sign in), answers 404 with no
 * issuer configured, or renders the consent page or a refusal. A form POST becomes the same GET,
 * and a GET whose query the router would rewrite comes back sealed first.
 * Outside the Workspace layout and the locale prefix, like `/oauth/verify`.
 */
export const Route = createFileRoute("/oidc/auth")({
  server: {
    handlers: {
      // Only a query the router would rewrite is answered here, by its sealed form; every other
      // GET goes on to the loader.
      GET: ({ request, next }) => answerAuthorizationGet(request, next),
      POST: ({ request }) => answerAuthorizationForm(request),
    },
  },
  headers: () => AUTHORIZATION_PAGE_HEADERS,
  loader: async ({ location }) => {
    const result = await getAuthorizationPage({
      data: { search: location.searchStr.replace(/^\?/, "") },
    });
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "redirect")
      throw redirect({
        href: result.location,
        statusCode: 302,
        headers: AUTHORIZATION_PAGE_HEADERS,
        reloadDocument: true,
      });
    return { page: result.page, account: result.account, search: result.query };
  },
  component: AppAuthorization,
});

function AppAuthorization() {
  const { page, account, search } = Route.useLoaderData();
  return <AppAuthorizationPage page={page} account={account} search={search} />;
}
