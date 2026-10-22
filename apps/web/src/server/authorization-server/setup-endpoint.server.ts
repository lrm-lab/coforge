import type {
  AppInstallationSetup,
  AppSetupView,
} from "#src/server/app-installation-setup/app-installation-setup.server";
import { bearerChallenge } from "./bearer-challenge.server";
import { authenticateClient } from "./client-authentication.server";
import type { GrantStore } from "./grants.server";
import { NO_STORE } from "./http-headers.server";
import { verifyInstallationBearer } from "./installation-bearer.server";
import {
  ID_PATTERN,
  INSTALLATION_FLAGS,
  type InstallationTokens,
} from "./installation-tokens.server";

/** An installation's setup as the app sees it. */
function setupBody(setup: AppSetupView) {
  return {
    status: setup.status,
    url: setup.link,
    description: setup.description,
    revision: setup.revision,
    completed_at: setup.completedAt?.toISOString() ?? null,
  };
}

const failure = (status: 400 | 404 | 409, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status, headers: NO_STORE });

/**
 * The installation setup API an app calls, behind the `app-installation-setup` flag. An app finds
 * its installation in a Workspace with its client credentials (`lookup`, `client_secret_basic`,
 * RFC 6749 §2.3.1), then reads and reports the setup of that installation with an installation
 * token of any scope (`answer`; RFC 6750), never with the client secret in a body. While the flag
 * is off for the Workspace the token is `invalid_token` and the lookup finds nothing, as if the
 * feature did not exist there.
 */
export class SetupEndpoint {
  private readonly now: () => Date;

  constructor(
    private readonly tokens: InstallationTokens,
    private readonly setup: AppInstallationSetup,
    private readonly store: Pick<GrantStore, "findClient">,
    private readonly options: { issuer: string; now?: () => Date },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** `GET` reads the installation's setup; `PUT {revision, status}` reports it `pending` or
   * `complete` for that revision, and answers the setup as it then is. */
  async answer(request: Request, installationId: string): Promise<Response> {
    const verified = await verifyInstallationBearer(request, installationId, {
      tokens: this.tokens,
      flag: INSTALLATION_FLAGS.setup,
      issuer: this.options.issuer,
      now: this.now(),
    });
    if (verified instanceof Response) return verified;
    if (request.method === "PUT") return this.report(request, verified.installationId);
    const setup = await this.setup.read(verified.installationId);
    return setup ? Response.json(setupBody(setup), { headers: NO_STORE }) : this.invalidToken();
  }

  /** `POST {workspace_id}` with the app's client credentials: its installation in that
   * Workspace and the setup of it. */
  async lookup(request: Request): Promise<Response> {
    const authenticated = await authenticateClient(request, this.store, this.options.issuer);
    if (authenticated instanceof Response) return authenticated;
    const body = await jsonObject(request);
    const workspaceId = body?.workspace_id;
    if (typeof workspaceId !== "string" || !ID_PATTERN.test(workspaceId))
      return failure(400, "invalid_request", "workspace_id must be a Workspace id");
    const setup = await this.setup.lookup(authenticated.clientId, workspaceId);
    if (!setup) return failure(404, "not_found", "the app is not installed in that Workspace");
    return Response.json(
      {
        installation_id: setup.installationId,
        workspace_id: setup.workspaceId,
        setup: setupBody(setup),
      },
      { headers: NO_STORE },
    );
  }

  private async report(request: Request, installationId: string): Promise<Response> {
    const body = await jsonObject(request);
    const { revision, status } = body ?? {};
    if (!Number.isSafeInteger(revision) || (revision as number) < 0)
      return failure(400, "invalid_request", "revision must be a setup revision");
    if (status !== "pending" && status !== "complete")
      return failure(400, "invalid_request", "status must be pending or complete");
    const outcome = await this.setup.report(installationId, {
      revision: revision as number,
      status,
    });
    switch (outcome.outcome) {
      case "recorded":
        return Response.json(setupBody(outcome.setup), { headers: NO_STORE });
      case "stale":
        return failure(
          409,
          "stale_revision",
          "the app's setup has a newer revision; read it again",
        );
      case "not_required":
        return failure(409, "setup_not_required", "the app declares no setup page");
      case "not_found":
        return this.invalidToken();
    }
  }

  private invalidToken(): Response {
    return bearerChallenge(this.options.issuer, 401, {
      error: "invalid_token",
      description: "the access token is not valid",
    });
  }
}

/** The request's JSON object body, or none when it is anything else. */
async function jsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = JSON.parse(await request.text());
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
