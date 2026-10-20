import { signInHref } from "#src/features/auth/return-to";
import { AUTHORIZATION_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import {
  AUTHORIZATION_CODE_TTL_MS,
  mintAuthorizationCode,
  type StoredAuthorizationCode,
} from "./authorization-codes.server";
import { openAuthorization, sealAuthorization } from "./authorization-handle.server";
import {
  parseAuthorizationRequest,
  type AuthorizationClient,
  type AuthorizationErrorCode,
  type AuthorizationRequest,
  type InvalidClientReason,
} from "./authorization-request.server";
import {
  authorizationResponseUrl,
  type AuthorizationResponseParams,
} from "./authorization-response.server";
import {
  MAX_AUTHORIZATION_REQUEST_LENGTH,
  asksForRecentSignIn,
  signInAgainHref,
  signInIsRecentEnough,
  signInRequestedAt,
} from "./sign-in-freshness.server";

/** A registered app, with the id its codes and consents are stored under. */
type AuthorizationApp = AuthorizationClient & { id: string };

/** A Workspace the person may authorize the app in, with the scopes they consented to there. */
export type OfferedWorkspace = { id: string; slug: string; name: string; consentScopes?: string[] };

/** The signed-in person, and when they last signed in (epoch seconds). */
export type AuthorizationSubject = { userId: string; authTime: number };

/** A person's consent to an app in one Workspace. */
export type ConsentGrant = { userId: string; appId: string; workspaceId: string; scopes: string[] };

export interface AuthorizationStore {
  findClient(key: string): Promise<AuthorizationApp | undefined>;
  /** The Workspaces where `userId` is a member and the app is installed, by name. */
  listOfferedWorkspaces(appId: string, userId: string): Promise<OfferedWorkspace[]>;
  /** One of them, or `undefined` when `workspaceId` is not offered to `userId`. */
  findOfferedWorkspace(
    appId: string,
    userId: string,
    workspaceId: string,
  ): Promise<OfferedWorkspace | undefined>;
  saveCode(code: StoredAuthorizationCode): Promise<void>;
  /** Records the consent (un-revoking it) and the code together. */
  saveApproval(consent: ConsentGrant, code: StoredAuthorizationCode): Promise<void>;
}

type AppSummary = { name: string; homepageUrl: string | null };

/** What the authorization page shows instead of redirecting. */
export type AuthorizationPage =
  | { view: "invalid_client"; reason: InvalidClientReason }
  | { view: "unavailable"; app: AppSummary }
  | { view: "expired" }
  | {
      view: "consent";
      app: AppSummary;
      workspaces: { id: string; slug: string; name: string }[];
      scopes: string[];
      /** What the page answers with (`decide`): the request it shows, signed by the server. */
      handle: string;
    };

type AuthorizationOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "page"; page: AuthorizationPage };

type AuthorizationDecision = { approve: false } | { approve: true; workspaceId: string };

type ResponseTarget = { redirectUri: string; state?: string };

/**
 * The authorization endpoint (RFC 6749 §4.1, OIDC Core §3.1.2): `begin` answers the browser's
 * request, and `decide` the person's answer on the consent page, for the request the page's
 * handle binds.
 */
export class AuthorizationEndpoint {
  private readonly now: () => Date;

  constructor(
    private readonly store: AuthorizationStore,
    private readonly options: { issuer: string; secret: string; now?: () => Date },
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** `search` is the request's raw query, without `?`. */
  async begin(search: string, subject: AuthorizationSubject | null): Promise<AuthorizationOutcome> {
    const query = new URLSearchParams(search);
    const parsed = await parseAuthorizationRequest(query, (key) => this.store.findClient(key));
    if (parsed.status === "invalid_client")
      return page({ view: "invalid_client", reason: parsed.reason });
    const target = parsed.status === "valid" ? parsed.request : parsed;
    // The whole request must fit where sign-in comes back to (`safeReturnTo`).
    if (`${AUTHORIZATION_ENDPOINT_PATH}?${search}`.length > MAX_AUTHORIZATION_REQUEST_LENGTH)
      return this.fail(target, "invalid_request", "the request is too long");
    if (parsed.status === "error") return this.fail(target, parsed.error, parsed.description);
    const { client: app, request } = parsed;
    const silent = request.prompt.includes("none");
    const now = this.now();
    const requestedAt = signInRequestedAt(query, this.options.secret, now);

    if (!subject) {
      if (silent) return this.fail(request, "login_required", "the person is not signed in");
      return redirect(
        asksForRecentSignIn(request)
          ? signInAgainHref(search, this.options.secret, now)
          : signInHref(`${AUTHORIZATION_ENDPOINT_PATH}?${search}`),
      );
    }
    if (!signInIsRecentEnough(request, subject.authTime, now, requestedAt)) {
      // Back from the sign-in it asked for, and still not recent: answer, never ask again.
      if (silent || requestedAt !== undefined)
        return this.fail(request, "login_required", "the person must sign in again");
      return redirect(signInAgainHref(search, this.options.secret, now));
    }

    const workspaces = await this.store.listOfferedWorkspaces(app.id, subject.userId);
    const [only] = workspaces;
    if (!only) {
      if (silent) return this.fail(request, "access_denied", "the app is not available");
      return page({ view: "unavailable", app: summary(app) });
    }
    const askAgain =
      request.prompt.includes("consent") || request.prompt.includes("select_account");
    if (workspaces.length === 1 && !askAgain && covers(only.consentScopes, request.scopes)) {
      const code = this.mintCode(app, request, subject, only.id);
      await this.store.saveCode(code.stored);
      return this.respond(request, { code: code.code });
    }
    if (silent)
      return workspaces.length > 1
        ? this.fail(request, "interaction_required", "the person must choose a Workspace")
        : this.fail(request, "consent_required", "the person has not consented");
    const handle = sealAuthorization(
      {
        appId: app.id,
        userId: subject.userId,
        request,
        ...(requestedAt === undefined ? {} : { signInRequestedAt: requestedAt }),
      },
      this.options.secret,
      now,
    );
    return page({
      view: "consent",
      app: summary(app),
      workspaces: workspaces.map(({ id, slug, name }) => ({ id, slug, name })),
      scopes: request.scopes,
      handle,
    });
  }

  /** The person's answer on the consent page whose handle is `handle`. */
  async decide(
    handle: string,
    subject: AuthorizationSubject,
    decision: AuthorizationDecision,
  ): Promise<AuthorizationOutcome> {
    const now = this.now();
    const bound = openAuthorization(handle, subject.userId, this.options.secret, now);
    if (!bound) return page({ view: "expired" });
    const { request } = bound;
    // The app may have changed since the page was shown.
    const app = await this.store.findClient(request.clientId);
    if (!app || app.id !== bound.appId)
      return page({ view: "invalid_client", reason: "unknown_client" });
    if (!app.redirectUris.includes(request.redirectUri))
      return page({ view: "invalid_client", reason: "invalid_redirect_uri" });
    if (!request.scopes.every((scope) => app.allowedScopes.includes(scope)))
      return this.fail(request, "invalid_scope", "a requested scope is not allowed for this app");
    if (!decision.approve) return this.fail(request, "access_denied", "the person denied access");
    if (!signInIsRecentEnough(request, subject.authTime, now, bound.signInRequestedAt))
      return this.fail(request, "login_required", "the person must sign in again");

    const workspace = await this.store.findOfferedWorkspace(
      app.id,
      subject.userId,
      decision.workspaceId,
    );
    if (!workspace) return page({ view: "unavailable", app: summary(app) });
    const code = this.mintCode(app, request, subject, workspace.id);
    await this.store.saveApproval(
      {
        userId: subject.userId,
        appId: app.id,
        workspaceId: workspace.id,
        // A narrower request never narrows what the person granted before.
        scopes: [...new Set([...(workspace.consentScopes ?? []), ...request.scopes])],
      },
      code.stored,
    );
    return this.respond(request, { code: code.code });
  }

  private mintCode(
    app: AuthorizationApp,
    request: AuthorizationRequest,
    subject: AuthorizationSubject,
    workspaceId: string,
  ): { code: string; stored: StoredAuthorizationCode } {
    const { code, codeHash } = mintAuthorizationCode();
    return {
      code,
      stored: {
        codeHash,
        appId: app.id,
        userId: subject.userId,
        workspaceId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        ...(request.nonce ? { nonce: request.nonce } : {}),
        scopes: request.scopes,
        authTime: new Date(subject.authTime * 1000),
        expiresAt: new Date(this.now().getTime() + AUTHORIZATION_CODE_TTL_MS),
      },
    };
  }

  /** The redirect back to the app with `params`, the request's `state` and `iss`. */
  private respond(
    target: ResponseTarget,
    params: AuthorizationResponseParams,
  ): AuthorizationOutcome {
    return redirect(
      authorizationResponseUrl(target.redirectUri, this.options.issuer, {
        ...params,
        ...(target.state ? { state: target.state } : {}),
      }),
    );
  }

  private fail(
    target: ResponseTarget,
    error: AuthorizationErrorCode,
    description: string,
  ): AuthorizationOutcome {
    return this.respond(target, { error, error_description: description });
  }
}

/** Whether a consent granted `granted` covers every scope in `requested`. */
function covers(granted: string[] | undefined, requested: string[]): boolean {
  return granted !== undefined && requested.every((scope) => granted.includes(scope));
}

const redirect = (location: string): AuthorizationOutcome => ({ kind: "redirect", location });
const page = (shown: AuthorizationPage): AuthorizationOutcome => ({ kind: "page", page: shown });
const summary = (app: AuthorizationApp): AppSummary => ({
  name: app.name,
  homepageUrl: app.homepageUrl,
});
