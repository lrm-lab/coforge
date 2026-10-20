import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";

/**
 * Login with CoForge end to end over real HTTP against a running Web: the authorization endpoint
 * gives a code, the token endpoint redeems it once, and UserInfo answers the access token — then
 * what is refused: a second redemption (which also ends the first token), a wrong code_verifier, a
 * wrong client secret.
 *
 * Opt-in like the other E2Es. Needs a local Web started with `COFORGE_DEV_SKIP_AUTH=1` and
 * `COFORGE_OIDC_ISSUER` set, `COFORGE_E2E_WEB_URL` pointing at it and `DATABASE_URL` at its
 * database. The dev user's consent is recorded as the consent page records it, so the code comes
 * without a click; the click itself is the browser step in `.amp/e2e/oidc-token/transcript.md`.
 * Registers its own app and removes it. Writes `.amp/e2e/oidc-token/http.md` (tokens truncated).
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/oidc-token");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const suffix = crypto.randomUUID().slice(0, 8);
const REDIRECT = "http://localhost:9999/cb";
/** RFC 7636 Appendix B. */
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const transcript: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

let key = "";
let secret = "";
let issuer = "";
let discovery: Record<string, string> = {};

beforeAll(async () => {
  const response = await fetch(`${origin}/oidc/.well-known/openid-configuration`);
  if (response.status !== 200) throw new Error("the Web must run with COFORGE_OIDC_ISSUER set");
  discovery = (await response.json()) as Record<string, string>;
  issuer = discovery.issuer!;
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  key = `e2e-token-${suffix}`;
  ({ clientSecret: secret } = await createAppRegistry(db).registerApp(
    { workspaceId: membership.workspaceId, actorUserId: DEV_BROWSER_USER.id },
    {
      key,
      name: "E2E Token",
      description: "",
      whenToUse: "",
      homepageUrl: null,
      redirectUris: [REDIRECT],
      category: "productivity",
      allowedScopes: ["openid", "profile", "identity", "email"],
    },
  ));
  const app = await db.app.findUniqueOrThrow({ where: { key } });
  cleanups.push(() => db.app.deleteMany({ where: { key } }));
  await db.userAppConsent.create({
    data: {
      userId: DEV_BROWSER_USER.id,
      appId: app.id,
      workspaceId: membership.workspaceId,
      scopes: ["openid", "profile", "email", "identity"],
    },
  });
});

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  await db.$disconnect();
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "http.md"), `${transcript.join("\n")}\n`);
});

/** Shortens every token-like value so the transcript carries no usable credential. */
const redact = (text: string) =>
  text.replace(/(eyJ[\w-]{6})[\w.-]+|(cfa_secret_)[\w-]+|(code=)[\w-]{6}[\w-]*/g, "$1$2$3…");

function record(title: string, request: string, response: Response, body: string) {
  transcript.push(
    `### ${title}`,
    "```",
    redact(request),
    `HTTP ${response.status}`,
    ...[...response.headers]
      .filter(([name]) =>
        ["location", "cache-control", "pragma", "www-authenticate", "content-type"].includes(name),
      )
      .map(([name, value]) => redact(`${name}: ${value}`)),
    redact(body),
    "```",
  );
}

/** A code from `/oidc/auth`, for the dev user's remembered consent. */
async function authorize(): Promise<string> {
  const search = new URLSearchParams({
    client_id: key,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile email identity",
    state: "st-e2e",
    nonce: "n-e2e",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  const response = await fetch(`${origin}/oidc/auth?${search}`, {
    redirect: "manual",
    headers: { "sec-fetch-dest": "document" },
  });
  const location = response.headers.get("location") ?? "";
  record("GET /oidc/auth (remembered consent)", `GET /oidc/auth?${search}`, response, "");
  expect(response.status).toBe(302);
  const answer = new URL(location).searchParams;
  expect(answer.get("state")).toBe("st-e2e");
  expect(answer.get("iss")).toBe(issuer);
  return answer.get("code")!;
}

/** A token request, by default correct and authenticated with client_secret_basic. */
async function redeem(
  code: string,
  { verifier = VERIFIER, clientSecret = secret, title = "POST /oidc/token" } = {},
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }).toString();
  const authorization = `Basic ${btoa(`${encodeURIComponent(key)}:${encodeURIComponent(clientSecret)}`)}`;
  const response = await fetch(discovery.token_endpoint!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization },
    body,
  });
  const text = await response.text();
  record(title, `POST /oidc/token\nauthorization: Basic …\n\n${body}`, response, text);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  return { response, body: JSON.parse(text) as Record<string, string | number> };
}

async function userInfo(accessToken: string, title = "GET /oidc/me") {
  const response = await fetch(discovery.userinfo_endpoint!, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  record(title, `GET /oidc/me\nauthorization: Bearer ${accessToken}`, response, text);
  return { response, text };
}

test("discovery names the token and UserInfo endpoints", () => {
  expect(discovery.token_endpoint).toBe(`${issuer}/token`);
  expect(discovery.userinfo_endpoint).toBe(`${issuer}/me`);
});

test("a code redeems for tokens that verify against the JWKS, and UserInfo reads the person", async () => {
  const { response, body } = await redeem(await authorize());
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
  expect(body.refresh_token).toBeUndefined();

  const keys = createRemoteJWKSet(new URL(discovery.jwks_uri!));
  const accessToken = body.access_token as string;
  expect(decodeProtectedHeader(accessToken).typ).toBe("at+jwt");
  const { payload: access } = await jwtVerify(accessToken, keys, {
    issuer,
    audience: discovery.userinfo_endpoint!,
    typ: "at+jwt",
  });
  expect(access).toMatchObject({ sub: DEV_BROWSER_USER.id, client_id: key });
  const { payload: id } = await jwtVerify(body.id_token as string, keys, {
    issuer,
    audience: key,
  });
  expect(id).toMatchObject({ sub: DEV_BROWSER_USER.id, nonce: "n-e2e" });
  // OIDC Core §5.4: with an access token issued, the scope claims are UserInfo's alone.
  expect(Object.keys(id).sort()).toEqual(
    ["iss", "sub", "aud", "exp", "iat", "auth_time", "nonce", "at_hash"].sort(),
  );
  transcript.push(
    "### The verified token claims",
    "```json",
    JSON.stringify({ access_token: access, id_token: id }, null, 2),
    "```",
  );

  const { response: info, text } = await userInfo(accessToken);
  expect(info.status).toBe(200);
  expect(JSON.parse(text)).toMatchObject({
    sub: DEV_BROWSER_USER.id,
    type: "user",
    workspace_role: "owner",
  });
});

test("a second redemption is refused and ends the first token", async () => {
  const code = await authorize();
  const first = await redeem(code);
  expect(first.response.status).toBe(200);
  const replay = await redeem(code, { title: "POST /oidc/token (the same code again)" });
  expect(replay.response.status).toBe(400);
  expect(replay.body.error).toBe("invalid_grant");
  const { response } = await userInfo(
    first.body.access_token as string,
    "GET /oidc/me (the first token, after the replay)",
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer realm="${issuer}", error="invalid_token"`,
  );
});

test("a wrong code_verifier is invalid_grant and leaves the code redeemable", async () => {
  const code = await authorize();
  const wrong = await redeem(code, {
    verifier: VERIFIER.replace("d", "e"),
    title: "POST /oidc/token (wrong code_verifier)",
  });
  expect(wrong.response.status).toBe(400);
  expect(wrong.body.error).toBe("invalid_grant");
  expect((await redeem(code)).response.status).toBe(200);
});

test("a wrong client secret is a 401 invalid_client with a Basic challenge", async () => {
  const code = await authorize();
  const wrong = await redeem(code, {
    clientSecret: `${secret.slice(0, -1)}x`,
    title: "POST /oidc/token (wrong client secret)",
  });
  expect(wrong.response.status).toBe(401);
  expect(wrong.body.error).toBe("invalid_client");
  expect(wrong.response.headers.get("www-authenticate")).toBe(`Basic realm="${issuer}"`);
});
