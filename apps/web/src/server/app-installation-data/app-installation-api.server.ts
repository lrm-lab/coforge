import type { AppPermissionGroup } from "#src/features/apps/app-permissions";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import {
  bearerChallenge,
  bearerToken,
  isBearerScheme,
  type BearerError,
} from "#src/server/authorization-server/bearer-challenge.server";
import {
  NO_STORE,
  refuseIfRateLimited,
} from "#src/server/authorization-server/http-headers.server";
import {
  installationScope,
  type InstallationTokens,
} from "#src/server/authorization-server/installation-tokens.server";
import type { AppInstallationData } from "./app-installation-data.server";

/** The group of data an endpoint reads: the one `installation:` scope it needs. */
export type InstallationDataGroup = AppPermissionGroup;

const DESCRIPTIONS: Record<BearerError, string> = {
  invalid_request: "the Authorization header is not a Bearer token",
  invalid_token: "the access token is not valid for this installation",
  insufficient_scope: "the access token does not carry the scope this endpoint needs",
};

/**
 * The read endpoints under `/api/app-installations/<installation id>/`: authenticates the
 * installation token (RFC 6750 §2.1, the Authorization header only) against the installation
 * named in the path, checks that it carries the endpoint's group, and answers that group's
 * projection with `no-store`. Every refusal is RFC 6750 §3: a missing token gets the bare
 * challenge, an unusable one (including an installation id that is malformed, unknown or another
 * token's) 401 `invalid_token`, a token without the group 403 `insufficient_scope` naming the
 * scope. Once the token verifies, a request counts against the installation's rate limit; over it
 * the answer is 429 with `Retry-After`.
 */
export class AppInstallationApi {
  constructor(
    private readonly tokens: Pick<InstallationTokens, "verify">,
    private readonly data: AppInstallationData,
    private readonly issuer: string,
    private readonly now: () => Date,
    private readonly installationLimit: AppRateLimit,
  ) {}

  async read(
    request: Request,
    installationId: string,
    group: InstallationDataGroup,
  ): Promise<Response> {
    const authorization = request.headers.get("authorization");
    if (!isBearerScheme(authorization)) return this.refuse(401);
    const token = bearerToken(authorization);
    if (!token) return this.refuse(400, "invalid_request");
    const verified = await this.tokens.verify(token, installationId, this.now());
    if (verified.status === "refused")
      return verified.error === "invalid_token"
        ? this.refuse(401, "invalid_token")
        : this.refuse(403, "insufficient_scope", group);
    // Counted once the token verifies, so a flood of bad tokens cannot spend an installation's budget.
    const limited = await refuseIfRateLimited(this.installationLimit, verified.installationId);
    if (limited) return limited;
    if (!verified.groups.includes(group)) return this.refuse(403, "insufficient_scope", group);
    return this.respond(verified.installationId, verified.workspaceId, group);
  }

  private async respond(installationId: string, workspaceId: string, group: InstallationDataGroup) {
    return Response.json(
      { installation_id: installationId, ...(await this.projectionOf(workspaceId, group)) },
      { headers: NO_STORE },
    );
  }

  private async projectionOf(workspaceId: string, group: InstallationDataGroup) {
    switch (group) {
      case "workspace":
        return { workspace: await this.data.workspace(workspaceId) };
      case "agent":
        return { agents: await this.data.agents(workspaceId) };
      case "channel":
        return { channels: await this.data.channels(workspaceId) };
      case "computer":
        return { computers: await this.data.computers(workspaceId) };
    }
  }

  private refuse(status: 401): Response;
  private refuse(status: 400, error: "invalid_request"): Response;
  private refuse(status: 401, error: "invalid_token"): Response;
  private refuse(status: 403, error: "insufficient_scope", group: InstallationDataGroup): Response;
  private refuse(
    status: 400 | 401 | 403,
    error?: BearerError,
    group?: InstallationDataGroup,
  ): Response {
    if (!error) return bearerChallenge(this.issuer, status);
    return bearerChallenge(this.issuer, status, {
      error,
      description: DESCRIPTIONS[error],
      ...(group ? { scope: installationScope(group) } : {}),
    });
  }
}
