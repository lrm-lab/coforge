import { humanLabel } from "#src/lib/human-label";

/** An app as the token endpoint authenticates it. */
export type TokenClient = { id: string; clientSecretHash: string };

/** What a code granted, as the authorization endpoint stored it. A code is redeemed once and
 * yields one access token, so the code's row id is the grant's id and the access token's `jti`. */
type CodeGrant = {
  id: string;
  appId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
  authTime: Date;
  nonce?: string;
};

/** A code as the token endpoint checks a redemption against it. */
export type RedeemableCode = CodeGrant & {
  redirectUri: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

/** A redeemed code, as UserInfo finds it by the access token's `jti`. */
export type RedeemedCode = CodeGrant & {
  /** The code was presented again after it was redeemed (RFC 6749 §4.1.2, §10.5). */
  replayed: boolean;
};

/** The person, the app and the Workspace a code names, as they are now. */
export type GrantSubject = {
  /** The app's key (`client_id`). */
  clientId: string;
  /** The scopes the app may ask for now. */
  appScopes: string[];
  /** What the person's consent to the app in the Workspace covers now; none once revoked. */
  consentScopes?: string[];
  /** The app is still installed in the Workspace. */
  installed: boolean;
  /** The person's role in the Workspace now; none once they left it. */
  role?: string;
  person: {
    username: string;
    displayName: string;
    email: string | null;
    /** An avatar an app can fetch without a CoForge session — absolute, or a path on the
     * issuer's origin — or none. */
    picture: string | null;
  };
  workspace: { id: string; slug: string };
};

export interface GrantStore {
  findClient(key: string): Promise<TokenClient | undefined>;
  /** The code whose SHA-256 is `codeHash`. */
  findCode(codeHash: string): Promise<RedeemableCode | undefined>;
  /** Redeems the code once: true for the one call that redeemed it, false when it already was. */
  redeemCode(id: string, at: Date): Promise<boolean>;
  /** Records that a redeemed code was presented again, which ends its grant. */
  markCodeReplayed(id: string, at: Date): Promise<void>;
  findRedeemedCode(id: string): Promise<RedeemedCode | undefined>;
  findGrantSubject(code: {
    userId: string;
    appId: string;
    workspaceId: string;
  }): Promise<GrantSubject | undefined>;
}

/** A grant whose tokens still work, with the scopes it releases now. */
export type ActiveGrant = {
  id: string;
  clientId: string;
  userId: string;
  scopes: string[];
  authTime: Date;
  nonce?: string;
  role: string;
  person: GrantSubject["person"];
  workspace: GrantSubject["workspace"];
};

/**
 * The grant of `code`, or none once it has ended: its code was presented twice, the consent was
 * revoked, the app uninstalled, or the person left the Workspace. It releases the code's scopes
 * that the app may still ask for and the consent still covers, so narrowing either takes effect at
 * once.
 */
export function activeGrant(
  code: CodeGrant & { replayed: boolean },
  subject: GrantSubject | undefined,
): ActiveGrant | undefined {
  if (code.replayed || !subject?.installed || !subject.consentScopes || !subject.role)
    return undefined;
  const { appScopes, consentScopes } = subject;
  return {
    id: code.id,
    clientId: subject.clientId,
    userId: code.userId,
    scopes: code.scopes.filter(
      (scope) => appScopes.includes(scope) && consentScopes.includes(scope),
    ),
    authTime: code.authTime,
    ...(code.nonce ? { nonce: code.nonce } : {}),
    role: subject.role,
    person: subject.person,
    workspace: subject.workspace,
  };
}

/**
 * The claims each released scope adds at UserInfo, read fresh (OIDC Core §5.4; the ID token
 * carries none of them, since an access token is always issued): `profile` — name,
 * preferred_username (the CoForge username) and picture; `email` — email and email_verified, which
 * is false because CoForge does not record whether the sign-in provider verified the address;
 * `identity` — who the person is in the Workspace the app was authorized in.
 */
export function scopeClaims(grant: ActiveGrant, issuer: string): Record<string, string | boolean> {
  const { person, workspace, scopes } = grant;
  return {
    ...(scopes.includes("profile") && {
      name: humanLabel(person),
      preferred_username: person.username,
      ...(person.picture && { picture: new URL(person.picture, issuer).href }),
    }),
    ...(scopes.includes("email") && person.email && { email: person.email, email_verified: false }),
    ...(scopes.includes("identity") && {
      type: "user",
      workspace_id: workspace.id,
      workspace_slug: workspace.slug,
      workspace_role: grant.role,
    }),
  };
}
