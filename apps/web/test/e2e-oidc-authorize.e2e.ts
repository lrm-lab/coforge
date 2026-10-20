import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { hashAuthorizationCode } from "#src/server/authorization-server/authorization-codes.server";

/**
 * `/oidc/auth` over real HTTP against a running Web: the status and headers of every kind of
 * answer — a refused link (400), an app the person may not use (403), the consent page, a redirect
 * with an error or a code, and a form POST — and what a code is stored as.
 *
 * Opt-in like the other E2Es. Needs a local Web started with `COFORGE_DEV_SKIP_AUTH=1` and
 * `COFORGE_OIDC_ISSUER` set, `COFORGE_E2E_WEB_URL` pointing at it and `DATABASE_URL` at its
 * database. Registers its own apps and removes them. Writes `.amp/e2e/oidc-authorize/http.md`.
 */
const origin = Bun.env.COFORGE_E2E_WEB_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error("COFORGE_E2E_WEB_URL must target the local Web service");
const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must target local PostgreSQL");
const artifacts = join(import.meta.dir, "../../../.amp/e2e/oidc-authorize");

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const suffix = crypto.randomUUID().slice(0, 8);
const REDIRECT = "http://localhost:9999/cb?tenant=a";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const transcript: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];

const registration = (key: string) => ({
  key,
  name: "E2E Notes",
  description: "",
  whenToUse: "",
  homepageUrl: "https://notes.example.com/",
  redirectUris: [REDIRECT],
  category: "productivity" as const,
  allowedScopes: ["openid", "profile", "identity", "email"],
});

/** The dev user's own app, and one installed only in a Workspace they are not in. */
let own = "";
let foreign = "";

beforeAll(async () => {
  const discovery = await fetch(`${origin}/oidc/.well-known/openid-configuration`);
  if (discovery.status !== 200) throw new Error("the Web must run with COFORGE_OIDC_ISSUER set");
  const membership = await db.workspaceMembership.findFirstOrThrow({
    where: { userId: DEV_BROWSER_USER.id, role: "owner" },
  });
  own = `e2e-own-${suffix}`;
  await createAppRegistry(db).registerApp(
    { workspaceId: membership.workspaceId, actorUserId: DEV_BROWSER_USER.id },
    registration(own),
  );
  const stranger = await db.user.create({
    data: { displayName: `oidc-e2e-${suffix}`, username: `oidc-e2e-${suffix}` },
  });
  const elsewhere = await db.workspace.create({
    data: {
      slug: `oidc-e2e-${suffix}`,
      name: "Elsewhere",
      members: { create: { userId: stranger.id, role: "owner" } },
    },
  });
  foreign = `e2e-foreign-${suffix}`;
  await createAppRegistry(db).registerApp(
    { workspaceId: elsewhere.id, actorUserId: stranger.id },
    registration(foreign),
  );
  cleanups.push(
    () => db.app.deleteMany({ where: { key: { in: [own, foreign] } } }),
    () => db.workspace.delete({ where: { id: elsewhere.id } }),
    () => db.user.delete({ where: { id: stranger.id } }),
  );
});

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  await db.$disconnect();
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "http.md"), `${transcript.join("\n")}\n`);
});

const request = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({
    client_id: own,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile",
    state: "st-e2e",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  }).toString();

/** One answer of `/oidc/auth`, recorded in the transcript, with the headers every answer has. */
async function authorize(search: string, init?: RequestInit) {
  const response = await fetch(`${origin}/oidc/auth${search ? `?${search}` : ""}`, {
    redirect: "manual",
    ...init,
    headers: { "sec-fetch-dest": "document", ...init?.headers },
  });
  transcript.push(
    `### ${init?.method ?? "GET"} /oidc/auth?${search.slice(0, 120)}…`,
    "```",
    `HTTP ${response.status}`,
    ...[...response.headers]
      .filter(([name]) =>
        ["location", "cache-control", "content-security-policy", "x-frame-options"].includes(name),
      )
      .map(([name, value]) => `${name}: ${value}`),
    "```",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  return response;
}

test("a link naming no registered app is a 400 page, never a redirect", async () => {
  const response = await authorize(request({ client_id: `nobody-${suffix}` }));
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
});

test("an app installed in none of the person's Workspaces is a 403 page", async () => {
  expect((await authorize(request({ client_id: foreign }))).status).toBe(403);
});

test("a protocol error is a 302 back to the app with the error, state and iss", async () => {
  const response = await authorize(request({ code_challenge_method: "plain" }));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe("http://localhost:9999/cb");
  expect(Object.fromEntries(location.searchParams)).toMatchObject({
    tenant: "a",
    error: "invalid_request",
    state: "st-e2e",
  });
});

test("without consent the consent page renders, with the page headers", async () => {
  const response = await authorize(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
});

test("a remembered consent answers with a code, of which only the hash is stored", async () => {
  const app = await db.app.findUniqueOrThrow({ where: { key: own } });
  await db.userAppConsent.create({
    data: {
      userId: DEV_BROWSER_USER.id,
      appId: app.id,
      workspaceId: app.ownerWorkspaceId,
      scopes: ["openid", "profile"],
    },
  });
  const response = await authorize(request());
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  const code = location.searchParams.get("code")!;
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const rows = await db.oAuthAuthorizationCode.findMany({
    where: { appId: app.id },
    select: { codeHash: true, scopes: true, redirectUri: true, expiresAt: true, createdAt: true },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.codeHash).toBe(hashAuthorizationCode(code));
  expect(JSON.stringify(rows)).not.toContain(code);
  transcript.push("### The stored code row", "```json", JSON.stringify(rows[0], null, 2), "```");
});

test("a form POST is a 303 to the same request as a GET", async () => {
  const response = await authorize("", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: request(),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`/oidc/auth?${request()}`);
});

test("a state the router would rewrite comes back to the app exactly as sent", async () => {
  const raw =
    `${request({ code_challenge_method: "plain" })}&state=${encodeURIComponent('"x"')}`.replace(
      "state=st-e2e&",
      "",
    );
  const sealed = await authorize(raw);
  expect(sealed.status).toBe(302);
  const page = new URL(sealed.headers.get("location")!, origin);
  expect([...page.searchParams.keys()]).toEqual(["coforge_request"]);
  const answered = await authorize(page.search.slice(1));
  expect(answered.status).toBe(302);
  const location = new URL(answered.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe('"x"');
  expect(location.searchParams.get("error")).toBe("invalid_request");
});
