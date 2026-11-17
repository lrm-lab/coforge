import {
  nextHrefAfterSignIn,
  readPrompt,
  safeReturnTo,
  signInHref,
} from "#src/features/auth/return-to";
import { getDatabaseClient } from "#src/server/db/client.server";
import { readGitHubSignInConfigOrNull, readSessionSecret } from "./config.server";
import { contactBindCookie, contactBindStore } from "./contact-binding.server";
import {
  completeGitHubSignIn,
  githubSignInEndingCookie,
  startGitHubSignIn,
} from "./github-sign-in.server";
import { redirect } from "./http.server";
import { optionalBrowserUser } from "./require-user.server";
import { signInRequestContext } from "./sign-in-request.server";
import { publicOrigin } from "#src/server/http/public-origin.server";
import { textResponse } from "#src/server/http/text-response.server";

/** `/auth/github` and `/auth/github/callback`: the browser's way out to GitHub and back, raw HTTP
 * because both are navigations. Thin adapters over `github-sign-in.server.ts`; a deployment
 * without GitHub sign-in answers both with 404. */

const noStore = { "cache-control": "no-store" } as const;

function notFound(): Response {
  return textResponse("Not found", { status: 404, headers: noStore });
}

function appendQueryParam(path: string, key: string, value: string): string {
  const url = new URL(path, "http://placeholder.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function githubSignInStartHandler({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const config = readGitHubSignInConfigOrNull(process.env);
  if (!config) return notFound();
  const params = new URL(request.url).searchParams;
  const returnTo = safeReturnTo(params.get("returnTo"));
  const prompt = readPrompt(params.get("prompt"));
  const bindMode = params.get("mode") === "bind";
  let bindUserId: string | undefined;
  if (bindMode) {
    const user = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
    if (!user) return redirect(signInHref(returnTo, { prompt }), {});
    bindUserId = user.id;
  }
  const sessionSecret = await readSessionSecret(process.env).catch(() => null);
  if (!sessionSecret) {
    return redirect(signInHref(returnTo, { prompt, error: "github_failed" }), {});
  }
  const { location, cookie } = startGitHubSignIn({
    config,
    sessionSecret,
    origin: publicOrigin(request),
    returnTo,
    prompt,
    bindUserId,
  });
  return redirect(location, { "set-cookie": cookie });
}

export async function githubSignInCallbackHandler({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const config = readGitHubSignInConfigOrNull(process.env);
  if (!config) return notFound();
  const { signIn, secure, clientAddress } = await signInRequestContext(request);
  const ending = githubSignInEndingCookie(secure);
  if (!signIn) {
    return redirect(signInHref(undefined, { error: "github_failed" }), { "set-cookie": ending });
  }
  const currentUser = await optionalBrowserUser(request.headers.get("cookie") ?? undefined);
  const result = await completeGitHubSignIn({
    query: new URL(request.url).searchParams,
    cookieHeader: request.headers.get("cookie") ?? "",
    config,
    authingConfig: signIn.config,
    sessionSecret: signIn.sessionSecret,
    secure,
    clientAddress,
    currentUserId: currentUser?.id,
    contactBindStore: contactBindStore(),
    db: getDatabaseClient() ?? undefined,
  });
  if (result.status === "bind_staged") {
    return redirect(appendQueryParam(result.returnTo ?? "/", "bind", "1"), {
      "set-cookie": [contactBindCookie(result.bindToken, secure), ending],
    });
  }
  if (result.status === "bind_failed") {
    return redirect(appendQueryParam(result.returnTo ?? "/", "bindError", result.error), {
      "set-cookie": ending,
    });
  }
  if (result.status === "back") {
    return redirect(signInHref(result.returnTo, { prompt: result.prompt, error: result.error }), {
      "set-cookie": ending,
    });
  }
  return redirect(nextHrefAfterSignIn(result.welcomed, result.returnTo), {
    "set-cookie": [result.sessionCookie, ending],
  });
}
