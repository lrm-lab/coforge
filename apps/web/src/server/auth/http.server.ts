import { readBrowserSession, sessionEndingCookie, type BrowserUser } from "./browser-login.server";
import { safeReturnTo, signInHref } from "#src/features/auth/return-to";

/** Signs out: expires the session cookie and sends the browser to the sign-in page. */
export function handleLogout(input: {
  origin: string;
  /** The page to sign in to again afterwards, when someone is switching account. */
  returnTo?: string | null;
}): Response {
  return redirect(signInHref(safeReturnTo(input.returnTo)), {
    "set-cookie": sessionEndingCookie(input.origin.startsWith("https:")),
    "cache-control": "no-store",
  });
}

export function handleCurrentUser(input: { request: Request; sessionSecret: string }): Response {
  const user = readRequestUser(input.request, input.sessionSecret);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore() });
  }
  return Response.json({ user }, { headers: noStore() });
}

function readRequestUser(request: Request, sessionSecret: string): BrowserUser | null {
  return readBrowserSession({
    sessionSecret,
    cookieHeader: request.headers.get("cookie") ?? "",
  });
}

/** A `302` to `location`, never cached, setting the cookies `headers` lists. */
export function redirect(
  location: string,
  headers: { "set-cookie"?: string | string[]; "cache-control"?: string },
): Response {
  const response = new Headers({
    location,
    "cache-control": headers["cache-control"] ?? "no-store",
  });
  const cookies = headers["set-cookie"];
  if (typeof cookies === "string") response.append("set-cookie", cookies);
  if (Array.isArray(cookies)) {
    for (const cookie of cookies) response.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers: response });
}

function noStore(): HeadersInit {
  return { "cache-control": "no-store" };
}
