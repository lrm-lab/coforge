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
