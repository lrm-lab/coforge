import { AUTHORIZATION_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import { AUTHORIZATION_PAGE_HEADERS } from "./authorization-page-headers";

/**
 * `POST /oidc/auth`, which OIDC Core §3.1.2.1 requires beside GET: the form's parameters become
 * the same request as a GET, answered there. A cross-site POST carries no `SameSite=Lax` session
 * cookie; the GET it is turned into does.
 */
export async function answerAuthorizationForm(request: Request): Promise<Response> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded")
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: AUTHORIZATION_PAGE_HEADERS },
    );
  const search = new URLSearchParams(await request.text()).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: `${AUTHORIZATION_ENDPOINT_PATH}?${search}`,
      ...AUTHORIZATION_PAGE_HEADERS,
    },
  });
}
