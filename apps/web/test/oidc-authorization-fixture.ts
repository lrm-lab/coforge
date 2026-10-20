import {
  AuthorizationEndpoint,
  type AuthorizationStore,
  type AuthorizationSubject,
  type OfferedWorkspace,
} from "#src/server/authorization-server/authorization-endpoint.server";
import type { StoredAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";

/** A registered app, two Workspaces, and an endpoint over an in-memory store, shared by the
 * authorization endpoint's tests. */

export const ISSUER = "https://coforge.example/oidc";
export const SECRET = "test-session-secret-at-least-32-characters";
export const NOW = new Date("2026-10-20T08:00:00.000Z");
export const NOW_SECONDS = NOW.getTime() / 1000;
export const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
export const APP = {
  id: "app-1",
  key: "acme-notes",
  name: "Acme Notes",
  homepageUrl: "https://notes.acme.example/" as string | null,
  logoUrl: null as string | null,
  redirectUris: ["https://notes.acme.example/cb"],
  allowedScopes: ["openid", "profile", "email", "identity"],
};
export const ACME = { id: "ws-acme", slug: "acme", name: "Acme" };
export const BETA = { id: "ws-beta", slug: "beta", name: "Beta" };
/** Signed in an hour before `NOW`. */
export const SIGNED_IN: AuthorizationSubject = { userId: "user-1", authTime: NOW_SECONDS - 3600 };

export const search = (overrides: Record<string, string | undefined> = {}) =>
  new URLSearchParams(
    Object.entries({
      client_id: "acme-notes",
      redirect_uri: "https://notes.acme.example/cb",
      response_type: "code",
      scope: "openid profile",
      state: "s-1",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      ...overrides,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ).toString();

/** The query of a redirect's location. */
export const query = (location: string) =>
  Object.fromEntries(new URL(location, "https://coforge.example").searchParams);

/**
 * An endpoint whose store offers `offered` to `user-1` with the `consents` given per Workspace,
 * keeps every write, and whose clock `clock.now` a test may move.
 */
export function storeWith({
  offered = [ACME],
  consents = {},
}: {
  offered?: { id: string; slug: string; name: string }[];
  consents?: Record<string, string[]>;
} = {}) {
  const codes: StoredAuthorizationCode[] = [];
  const savedConsents: { userId: string; appId: string; workspaceId: string; scopes: string[] }[] =
    [];
  const clock = { now: NOW };
  const app = { ...APP };
  const offer = (userId: string): OfferedWorkspace[] =>
    userId === "user-1"
      ? offered.map((workspace) => ({ ...workspace, consentScopes: consents[workspace.id] }))
      : [];
  const store: AuthorizationStore = {
    async findClient(key) {
      return key === app.key ? app : undefined;
    },
    async listOfferedWorkspaces(appId, userId) {
      return appId === app.id ? offer(userId) : [];
    },
    async findOfferedWorkspace(appId, userId, workspaceId) {
      return appId === app.id ? offer(userId).find(({ id }) => id === workspaceId) : undefined;
    },
    async saveCode(code) {
      codes.push(code);
    },
    async saveApproval(consent, code) {
      savedConsents.push(consent);
      codes.push(code);
    },
  };
  const endpoint = new AuthorizationEndpoint(store, {
    issuer: ISSUER,
    secret: SECRET,
    now: () => clock.now,
  });
  return { endpoint, codes, savedConsents, clock, app };
}

/** The handle of the consent page `begin` showed, or a failure naming what it showed instead. */
export async function consentHandle(
  endpoint: AuthorizationEndpoint,
  raw = search(),
  subject: AuthorizationSubject = SIGNED_IN,
): Promise<string> {
  const outcome = await endpoint.begin(raw, subject);
  if (outcome.kind !== "page" || outcome.page.view !== "consent")
    throw new Error(`expected the consent page, got ${JSON.stringify(outcome)}`);
  return outcome.page.handle;
}
