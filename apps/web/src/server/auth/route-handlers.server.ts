import { AuthConfigError, readSessionSecret } from "./config.server";
import { handleCurrentUser, handleLogout } from "./http.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

export function logoutHandler({ request }: { request: Request }): Response {
  return handleLogout({
    origin: publicOrigin(request),
    returnTo: new URL(request.url).searchParams.get("returnTo"),
  });
}

export async function currentUserHandler({ request }: { request: Request }): Promise<Response> {
  try {
    return handleCurrentUser({
      request,
      sessionSecret: await readSessionSecret(process.env),
    });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return authUnavailableResponse();
    }
    throw error;
  }
}

function authUnavailableResponse(): Response {
  return Response.json(
    { code: "TEMPORARILY_UNAVAILABLE" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
