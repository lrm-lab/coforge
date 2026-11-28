import { getDatabaseClient } from "#src/server/db/client.server";
import { revokeUserTerminalAttachments } from "#src/server/computers/computer-terminal-production.server";
import { AuthConfigError, readSessionSecret } from "./config.server";
import { handleCurrentUser, handleLogout } from "./http.server";
import { optionalBrowserSignIn } from "./require-user.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

const LOGOUT_REVOCATION_TIMEOUT_MS = 2_000;

export async function logoutHandler({ request }: { request: Request }): Promise<Response> {
  try {
    const signIn = await optionalBrowserSignIn(request.headers.get("cookie") ?? undefined);
    const db = signIn ? getDatabaseClient() : undefined;
    if (signIn) {
      await Promise.race([
        Promise.all([
          db
            ? db.user
                .update({
                  where: { id: signIn.user.id },
                  data: { webLoginGeneration: { increment: 1 } },
                })
                .catch(() => {})
            : Promise.resolve(),
          revokeUserTerminalAttachments(signIn.user.id),
        ]),
        Bun.sleep(LOGOUT_REVOCATION_TIMEOUT_MS),
      ]);
    }
  } catch {}
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
