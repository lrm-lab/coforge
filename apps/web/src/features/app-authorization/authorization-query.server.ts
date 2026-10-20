import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

import { AUTHORIZATION_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import { readSessionSecret } from "#src/server/auth/config.server";
import { openQuery, sealQuery } from "#src/server/authorization-server/sealed-query.server";
import { AUTHORIZATION_PAGE_HEADERS } from "./authorization-page-headers";

/**
 * The router re-serializes a page URL's query through its search parser (`defaultParseSearch`,
 * which reads values as JSON) and redirects to that form before any loader runs, which would
 * change an authorization request's values: `state="x"` becomes `x`, a long number loses digits.
 * RFC 6749 §4.1.2 needs `state` back exactly, so such a query is carried sealed in one parameter
 * the router leaves alone.
 */
const SEALED = "coforge_request";

/** `GET /oidc/auth` before the router: the page, or a redirect to the sealed form of the query. */
export async function answerAuthorizationGet<Rendered>(
  request: Request,
  render: () => Rendered,
): Promise<Response | Rendered> {
  const query = new URL(request.url).search.slice(1);
  if (keptByRouter(query)) return render();
  const sealed = sealQuery(query, await readSessionSecret(process.env), new Date());
  return new Response(null, {
    status: 302,
    headers: {
      location: `${AUTHORIZATION_ENDPOINT_PATH}?${SEALED}=${encodeURIComponent(sealed)}`,
      ...AUTHORIZATION_PAGE_HEADERS,
    },
  });
}

/** The request the page is for: `query` itself, or the one it carries sealed; `undefined` for a
 * sealed one the server did not sign or that has expired. */
export async function requestedAuthorizationQuery(query: string): Promise<string | undefined> {
  const params = new URLSearchParams(query);
  const sealed = params.get(SEALED);
  if (sealed === null || [...params.keys()].length !== 1) return query;
  return openQuery(sealed, await readSessionSecret(process.env), new Date());
}

/** Whether the router keeps every parameter of `query`, in order, with its value: then the loader
 * reads the same request (an encoding the router writes differently, `+` for `%20`, changes no
 * value). */
function keptByRouter(query: string): boolean {
  const search = query ? `?${query}` : "";
  const written = defaultStringifySearch(defaultParseSearch(search));
  const entries = (value: string) => JSON.stringify([...new URLSearchParams(value)]);
  return entries(written) === entries(search);
}
