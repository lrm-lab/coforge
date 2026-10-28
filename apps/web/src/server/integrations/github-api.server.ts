import { z } from "zod";
import { AppError } from "#src/lib/app-error";

import { hasErrorCode } from "@lrm/coforge-sdk/internal";
import { tokensSchema } from "./github-account-shapes.server";

export type Http = (url: string, init: RequestInit) => Promise<Response>;

export class GitHubUnauthorized extends Error {}

/** GitHub refused an OAuth exchange; `reason` is its short error name, never its description. */
export class GitHubOAuthRejected extends Error {
  readonly reason: string;
  constructor(name: string) {
    super("GitHub rejected the OAuth exchange");
    this.reason = /^[a-z_]{1,64}$/.test(name) ? name : "unknown";
  }
}

/**
 * The short reason (`http_502`, `network`, GitHub's OAuth error name) behind a GitHub call's
 * `TEMPORARILY_UNAVAILABLE`, for the logs. A WeakMap rather than a field or subclass: the browser
 * serializer (seroval) copies an error's own properties, so the reason would reach the browser.
 */
const unavailableReasons = new WeakMap<AppError, string>();

export function unavailable(reason: string) {
  const error = new AppError("TEMPORARILY_UNAVAILABLE");
  unavailableReasons.set(error, reason);
  return error;
}

/** What to log about a failed GitHub step: a short identifier, never a message, token or body. */
export function failureReason(error: unknown) {
  if (error instanceof GitHubOAuthRejected) return error.reason;
  if (error instanceof GitHubUnauthorized) return "unauthorized";
  if (error instanceof AppError) return unavailableReasons.get(error) ?? error.code.toLowerCase();
  if (error instanceof z.ZodError) return "invalid_response";
  // Prisma's transaction error: the advisory-lock transaction could not start in time, or expired.
  if (hasErrorCode(error, "P2028")) return "lock_timeout";
  return "error";
}

/** The headers every GitHub REST call carries. */
export const GITHUB_REST_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2026-03-10",
  "user-agent": "CoForge",
} as const;

/** The HTTP transport to GitHub: every call's 401/403/404/timeout semantics live here. */
export class GitHubApi {
  constructor(
    private readonly config: { clientId: string; clientSecret: string },
    private readonly http: Http,
  ) {}

  async exchange(fields: Record<string, string>) {
    const result = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...fields,
      }).toString(),
    });
    if (
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      result.error === "bad_refresh_token"
    )
      throw new GitHubUnauthorized();
    // GitHub answers a refused exchange with HTTP 200 and `{ "error": "<name>" }`. Keep the name
    // (a short identifier) for the log; the description and every other field stay unread.
    if (typeof result === "object" && result !== null && "error" in result)
      throw new GitHubOAuthRejected(String(result.error));
    return tokensSchema.parse(result);
  }

  /**
   * Revokes one user access token GitHub issued to this App
   * (https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token). Best effort:
   * never throws. A failure is logged with a short reason, never the token or GitHub's response.
   */
  async revoke(token: string) {
    const { clientId, clientSecret } = this.config;
    try {
      await this.send(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
        method: "DELETE",
        headers: {
          ...GITHUB_REST_HEADERS,
          authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: token }),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({ event: "github.token_revoke_failed", reason: failureReason(error) }),
      );
    }
  }

  restHeaders(token: string) {
    return {
      ...GITHUB_REST_HEADERS,
      authorization: `Bearer ${token}`,
    };
  }

  api(path: string, token: string) {
    return this.request(`https://api.github.com${path}`, { headers: this.restHeaders(token) });
  }

  /** Every GraphQL caller goes through `request()`, so 401/403/404/timeout semantics stay identical. */
  graphql(query: string, variables: Record<string, unknown>, token: string) {
    return this.request("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": GITHUB_REST_HEADERS["user-agent"],
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  async request(url: string, init: RequestInit): Promise<unknown> {
    try {
      return await (await this.send(url, init)).json();
    } catch (error) {
      if (error instanceof GitHubUnauthorized || error instanceof AppError) throw error;
      throw unavailable("invalid_response");
    }
  }

  /** `request()` without the JSON read, for conditional (304) and streamed responses. */
  async send(
    url: string,
    init: RequestInit,
    { alsoAccept = [], timeoutMs = 8000 }: { alsoAccept?: number[]; timeoutMs?: number } = {},
  ) {
    try {
      const response = await this.http(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401) throw new GitHubUnauthorized();
      if (
        response.status === 404 ||
        (response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") !== "0" &&
          !response.headers.has("retry-after"))
      )
        throw new AppError("ACCESS_DENIED");
      if (!response.ok && !alsoAccept.includes(response.status))
        throw unavailable(`http_${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof GitHubUnauthorized || error instanceof AppError) throw error;
      throw unavailable(
        error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network",
      );
    }
  }
}
