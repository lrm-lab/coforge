import { appClientSecretMatches } from "#src/server/apps/app-client-secret.server";
import type { GrantStore, TokenClient } from "./grants.server";
import { NO_STORE } from "./http-headers.server";

/** What a token request presented to authenticate its app: one method's credentials, more than
 * one method (RFC 6749 §2.3: `invalid_request`), or none it can read (`invalid_client`). */
export type PresentedClientCredentials =
  | { status: "presented"; clientId: string; clientSecret: string }
  | { status: "ambiguous" }
  | { status: "invalid" };

/**
 * Reads the app's credentials from a token request: exactly one of HTTP Basic
 * (`client_secret_basic`), whose id and secret are each form-encoded and joined by the first colon
 * (RFC 6749 §2.3.1), or `client_id` and `client_secret` in the form (`client_secret_post`). A form
 * `client_id` beside Basic only names the same app again.
 */
export function readClientCredentials(
  authorization: string | null,
  form: URLSearchParams,
): PresentedClientCredentials {
  const formId = form.get("client_id");
  const formSecret = form.get("client_secret");
  if (authorization === null)
    return formId && formSecret !== null
      ? { status: "presented", clientId: formId, clientSecret: formSecret }
      : { status: "invalid" };
  if (formSecret !== null) return { status: "ambiguous" };
  const basic = basicCredentials(authorization);
  if (!basic || (formId !== null && formId !== basic.clientId)) return { status: "invalid" };
  return { status: "presented", ...basic };
}

function basicCredentials(
  authorization: string,
): { clientId: string; clientSecret: string } | undefined {
  const match = /^Basic +([A-Za-z0-9+/]+=*) *$/i.exec(authorization);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  const clientId = formDecode(decoded.slice(0, colon));
  const clientSecret = formDecode(decoded.slice(colon + 1));
  if (!clientId || clientSecret === undefined) return undefined;
  return { clientId, clientSecret };
}

/** `application/x-www-form-urlencoded` decoding; `undefined` for a malformed escape. */
function formDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}

/**
 * Authenticates the app that made `request` with the credentials it presented (RFC 6749 §2.3):
 * the app, or the response that refuses it. Two methods at once are 400 `invalid_request`; no
 * readable credentials, an unknown app and a wrong secret alike are 401 `invalid_client`, which
 * names the `Basic` scheme (RFC 9110 §15.5.2) whichever method the app tried. `form` carries
 * `client_secret_post` credentials, when the request has a form. An unknown `client_id` is
 * refused without a secret comparison: client ids are public, so timing reveals nothing secret.
 */
export async function authenticateClient(
  request: Request,
  store: Pick<GrantStore, "findClient">,
  issuer: string,
  form: URLSearchParams = new URLSearchParams(),
): Promise<{ client: TokenClient; clientId: string } | Response> {
  const credentials = readClientCredentials(request.headers.get("authorization"), form);
  if (credentials.status === "ambiguous")
    return Response.json(
      { error: "invalid_request", error_description: "use one client authentication method" },
      { status: 400, headers: NO_STORE },
    );
  const client =
    credentials.status === "presented" ? await store.findClient(credentials.clientId) : undefined;
  if (
    credentials.status !== "presented" ||
    !client ||
    !appClientSecretMatches(client.clientSecretHash, credentials.clientSecret)
  )
    return Response.json(
      { error: "invalid_client", error_description: "client authentication failed" },
      { status: 401, headers: { ...NO_STORE, "www-authenticate": `Basic realm="${issuer}"` } },
    );
  return { client, clientId: credentials.clientId };
}
