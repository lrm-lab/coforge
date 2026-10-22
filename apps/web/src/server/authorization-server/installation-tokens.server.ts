import {
  APP_PERMISSION_GROUPS,
  effectivePermissionGroups,
  type AppPermissionGroup,
} from "#src/features/apps/app-permissions";
import {
  INSTALLATION_TOKEN_TTL_SECONDS,
  mintInstallationAccessToken,
  verifyInstallationAccessToken,
  type TokenIssuer,
} from "./issued-tokens.server";

/** Where an installation's data is read, under the issuer's origin: the token's audience (RFC 8707
 * resource indicator). */
const INSTALLATION_RESOURCE_PATH = "/api/app-installations/";
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_PREFIX = "installation:";

/** An app installed in a Workspace, with what it declares and what that installation approved. */
export type TokenInstallation = {
  id: string;
  appId: string;
  appKey: string;
  workspaceId: string;
  workspaceSlug: string;
  declared: AppPermissionGroup[];
  approved: AppPermissionGroup[];
};

export interface InstallationTokenStore {
  findInstallation(id: string): Promise<TokenInstallation | undefined>;
}

/** Whether `app-data-permissions` is on for the Workspace. */
export type AppDataPermissionsEnabled = (workspace: {
  workspaceId: string;
  workspaceSlug: string;
}) => Promise<boolean>;

/** RFC 6749 §5.2 and RFC 8707 §2 refusals of a `client_credentials` request. */
export type InstallationTokenRefusal =
  | "invalid_request"
  | "invalid_target"
  | "invalid_scope"
  | "unauthorized_client";

export type IssuedInstallationToken =
  | {
      status: "issued";
      body: { access_token: string; token_type: "Bearer"; expires_in: number; scope: string };
    }
  | { status: "refused"; error: InstallationTokenRefusal; description: string };

/** RFC 6750 §3.1: an unusable token is 401 `invalid_token`; a token for less than is asked is 403
 * `insufficient_scope`. */
export type InstallationTokenVerification =
  | {
      status: "verified";
      installationId: string;
      workspaceId: string;
      appKey: string;
      groups: AppPermissionGroup[];
    }
  | { status: "refused"; error: "invalid_token" | "insufficient_scope" };

/** The scope name of a data group. */
export const installationScope = (group: AppPermissionGroup) => `${SCOPE_PREFIX}${group}`;
export const INSTALLATION_SCOPES = APP_PERMISSION_GROUPS.map(installationScope);

/** The resource URI of the installation `installationId`: a token's audience. */
export function installationResource(issuer: string, installationId: string): string {
  return `${new URL(issuer).origin}${INSTALLATION_RESOURCE_PATH}${installationId}`;
}

/**
 * Installation tokens (RFC 6749 §4.4 `client_credentials`, RFC 8707 resource, RFC 9068 JWT): a
 * short-lived token with which an app reads its installation's Workspace data, in the groups the
 * Workspace approved. The token only records what was true when it was issued; verifying it reads
 * the installation again, so an uninstall or a narrowed approval ends it at once. Behind the
 * `app-data-permissions` flag.
 */
export class InstallationTokens {
  constructor(
    private readonly store: InstallationTokenStore,
    private readonly appDataPermissionsEnabled: AppDataPermissionsEnabled,
    private readonly options: TokenIssuer,
  ) {}

  /** The token for the authenticated app `client` asking with `form`'s `resource` and `scope`. */
  async issue(
    client: { id: string; key: string },
    form: URLSearchParams,
    now: Date,
  ): Promise<IssuedInstallationToken> {
    const scope = form.get("scope");
    const { installationId, result } = await this.decide(client, form, scope, now);
    console.info(
      JSON.stringify({
        event:
          result.status === "issued"
            ? "authorization_server:installation_token_issued"
            : "authorization_server:installation_token_refused",
        app_key: client.key,
        installation_id: installationId ?? null,
        // As asked for, cut short: a refused request's scope is whatever the app sent.
        groups: (scope ?? "").split(" ").filter(Boolean).slice(0, 8),
        outcome: result.status === "issued" ? "issued" : result.error,
      }),
    );
    return result;
  }

  private async decide(
    client: { id: string; key: string },
    form: URLSearchParams,
    scope: string | null,
    now: Date,
  ): Promise<{ installationId?: string; result: IssuedInstallationToken }> {
    const resource = form.get("resource");
    if (!resource) return { result: refuseIssue("invalid_target", "resource is required") };
    const installationId = this.installationOf(resource);
    if (!installationId)
      return { result: refuseIssue("invalid_target", "resource is not an installation") };
    const refuse = (error: InstallationTokenRefusal, description: string) => ({
      installationId,
      result: refuseIssue(error, description),
    });
    const installation = await this.store.findInstallation(installationId);
    // Another app's installation is answered like one that does not exist.
    if (!installation || installation.appId !== client.id)
      return refuse("invalid_target", "resource is not an installation of this app");
    if (!(await this.appDataPermissionsEnabled(installation)))
      return refuse("unauthorized_client", "the client may not use this grant type here");
    const groups = requestedGroups(scope);
    if (!groups) return refuse("invalid_scope", "scope names a group that does not exist");
    if (!withinEffective(groups, installation))
      return refuse("invalid_scope", "scope names a group that is not approved");
    const grantedScope = groups.map(installationScope).join(" ");
    const accessToken = await mintInstallationAccessToken(
      this.options,
      {
        appKey: client.key,
        installationId: installation.id,
        workspaceId: installation.workspaceId,
        scope: grantedScope,
      },
      resource,
      now,
    );
    return {
      installationId,
      result: {
        status: "issued",
        body: {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: INSTALLATION_TOKEN_TTL_SECONDS,
          scope: grantedScope,
        },
      },
    };
  }

  /**
   * Whether `token` lets its app read the installation `installationId` now. The signature,
   * `iss`, `typ`, `aud` (this installation's resource URI, which pins the installation), `exp`
   * and claims are checked, then the installation: still installed for this app, the flag still
   * on, and every group of the token still approved and declared.
   */
  async verify(
    token: string,
    installationId: string,
    now: Date,
  ): Promise<InstallationTokenVerification> {
    if (!INSTALLATION_ID.test(installationId)) return refuseVerify("invalid_token");
    const claims = await verifyInstallationAccessToken(
      this.options,
      token,
      installationResource(this.options.issuer, installationId),
      now,
    );
    if (!claims || claims.subject !== claims.appKey) return refuseVerify("invalid_token");
    const groups = requestedGroups(claims.scope);
    if (!groups) return refuseVerify("invalid_token");
    const installation = await this.store.findInstallation(installationId);
    if (
      !installation ||
      installation.appKey !== claims.appKey ||
      installation.workspaceId !== claims.workspaceId ||
      !(await this.appDataPermissionsEnabled(installation))
    )
      return refuseVerify("invalid_token");
    if (!withinEffective(groups, installation)) return refuseVerify("insufficient_scope");
    return {
      status: "verified",
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      appKey: installation.appKey,
      groups,
    };
  }

  /** The installation id a resource URI names, when it is one under this issuer's origin. */
  private installationOf(resource: string): string | undefined {
    const prefix = installationResource(this.options.issuer, "");
    if (!resource.startsWith(prefix)) return undefined;
    const id = resource.slice(prefix.length);
    return INSTALLATION_ID.test(id) ? id : undefined;
  }
}

const refuseIssue = (error: InstallationTokenRefusal, description: string) =>
  ({ status: "refused", error, description }) as const;

const refuseVerify = (error: "invalid_token" | "insufficient_scope") =>
  ({ status: "refused", error }) as const;

/** Whether every one of `groups` is both declared by the app and approved for the installation. */
function withinEffective(groups: AppPermissionGroup[], installation: TokenInstallation): boolean {
  const effective = effectivePermissionGroups(installation.declared, installation.approved);
  return groups.every((group) => effective.includes(group));
}

/** The groups a scope string names, once each in group order; `undefined` when it names anything
 * but the four `installation:` scopes. An empty scope names none. */
function requestedGroups(scope: string | null): AppPermissionGroup[] | undefined {
  const names = (scope ?? "").split(" ").filter(Boolean);
  const groups = APP_PERMISSION_GROUPS.filter((group) => names.includes(installationScope(group)));
  return names.every((name) => INSTALLATION_SCOPES.includes(name)) ? groups : undefined;
}
