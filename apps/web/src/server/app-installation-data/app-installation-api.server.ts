import type { AppPermissionGroup } from "#src/features/apps/app-permissions";
import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import {
  NO_STORE,
  refuseIfRateLimited,
} from "#src/server/authorization-server/http-headers.server";
import {
  insufficientScope,
  verifyInstallationBearer,
} from "#src/server/authorization-server/installation-bearer.server";
import {
  INSTALLATION_FLAGS,
  installationScope,
  type InstallationTokens,
} from "#src/server/authorization-server/installation-tokens.server";
import type { AppInstallationData } from "./app-installation-data.server";

/** The group of data an endpoint reads: the one `installation:` scope it needs. */
export type InstallationDataGroup = AppPermissionGroup;

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
    const scope = installationScope(group);
    const verified = await verifyInstallationBearer(request, installationId, {
      tokens: this.tokens,
      flag: INSTALLATION_FLAGS.data,
      issuer: this.issuer,
      now: this.now(),
      scope,
    });
    if (verified instanceof Response) return verified;
    // Counted once the token verifies, so a flood of bad tokens cannot spend an installation's budget.
    const limited = await refuseIfRateLimited(this.installationLimit, verified.installationId);
    if (limited) return limited;
    if (!verified.groups.includes(group)) return insufficientScope(this.issuer, scope);
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
}
