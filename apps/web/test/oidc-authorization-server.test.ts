import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, type JWK } from "jose";

import { readAuthorizationServerConfiguration } from "#src/server/authorization-server/configuration.server";
import { AuthorizationServerConfigError } from "#src/server/authorization-server/configuration-error.server";
import { oidcDiscovery, oidcJwks } from "#src/server/authorization-server/http.server";
import { assertStartupConfig } from "#src/server/startup-config.server";

const ISSUER = "https://coforge.example/oidc";

/** A fresh private signing key; tests never carry key material in source. */
async function signingKey(kid: string, keyAlgorithm = "ES256"): Promise<JWK> {
  const { privateKey } = await generateKeyPair(keyAlgorithm, { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}

const CURRENT = await signingKey("current");
const PREVIOUS = await signingKey("previous");

function configured(overrides: Record<string, string | undefined> = {}) {
  return {
    COFORGE_OIDC_ISSUER: ISSUER,
    COFORGE_OIDC_SIGNING_JWKS: JSON.stringify({ keys: [CURRENT] }),
    ...overrides,
  };
}

/** What the JWKS must publish for a configured key: its public members only. */
function publicHalf({ x, y, kid }: JWK) {
  return { kty: "EC", crv: "P-256", x, y, kid, alg: "ES256", use: "sig" };
}

const startupLog = spyOn(console, "info").mockImplementation(() => {});
afterEach(() => startupLog.mockClear());
afterAll(() => startupLog.mockRestore());

const temporaryDirectories: string[] = [];
afterAll(async () => {
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

async function keysetFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-oidc-keyset-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "signing-jwks.json");
  await writeFile(path, contents);
  return path;
}

/** The boot refuses the configuration, and its message carries no key material. */
async function expectBootRefused(environment: Record<string, string | undefined>) {
  const error = await assertStartupConfig(environment).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AuthorizationServerConfigError);
  const message = (error as Error).message;
  for (const member of [CURRENT.d, CURRENT.x, CURRENT.y, PREVIOUS.d])
    expect(message).not.toContain(member as string);
}

/** The `startup_config_checked` line the boot logged. */
function bootLogged(): Record<string, unknown> {
  const line = startupLog.mock.calls.flat().find((value) => String(value).includes("startup_"));
  return JSON.parse(String(line)) as Record<string, unknown>;
}

test("the boot accepts no issuer, and the server is then not there", async () => {
  for (const environment of [{}, { COFORGE_OIDC_ISSUER: "  " }]) {
    startupLog.mockClear();
    await expect(assertStartupConfig(environment)).resolves.toBeUndefined();
    expect(bootLogged().authorization_server).toBe("disabled");
    const configuration = await readAuthorizationServerConfiguration(environment);
    for (const endpoint of [oidcDiscovery, oidcJwks]) {
      const response = endpoint(configuration);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  }
});

test("before the boot has remembered a configuration the server is not there", async () => {
  for (const endpoint of [oidcDiscovery, oidcJwks]) {
    const response = endpoint();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  }
});

test("the boot accepts a configured issuer and keyset", async () => {
  await expect(assertStartupConfig(configured())).resolves.toBeUndefined();
  expect(bootLogged().authorization_server).toBe("configured");
});

test("discovery advertises the configured issuer and only what this server supports", async () => {
  const response = oidcDiscovery(await readAuthorizationServerConfiguration(configured()));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await response.json()).toEqual({
    issuer: "https://coforge.example/oidc",
    authorization_endpoint: "https://coforge.example/oidc/auth",
    token_endpoint: "https://coforge.example/oidc/token",
    userinfo_endpoint: "https://coforge.example/oidc/me",
    jwks_uri: "https://coforge.example/oidc/jwks",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["openid", "profile", "identity", "email"],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "at_hash",
      "name",
      "preferred_username",
      "picture",
      "email",
      "email_verified",
      "type",
      "workspace_id",
      "workspace_slug",
      "workspace_role",
    ],
    authorization_response_iss_parameter_supported: true,
    // Discovery §3 defaults this to true when omitted; this server takes no `request_uri`.
    request_uri_parameter_supported: false,
  });
});

test("the JWKS publishes every configured key's public half, in configured order", async () => {
  const response = oidcJwks(
    await readAuthorizationServerConfiguration(
      configured({ COFORGE_OIDC_SIGNING_JWKS: JSON.stringify({ keys: [CURRENT, PREVIOUS] }) }),
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  // Exactly the public members: no `d`, and nothing else a private JWK may carry.
  expect(await response.json()).toEqual({ keys: [publicHalf(CURRENT), publicHalf(PREVIOUS)] });
});

test("the boot refuses an issuer that is not a plain HTTPS URL", async () => {
  for (const issuer of [
    "not a url",
    "/oidc",
    "https://coforge.example/oidc/",
    "https://coforge.example/oidc?tenant=a",
    "https://coforge.example/oidc?",
    "https://coforge.example/oidc#top",
    "https://user:secret@coforge.example/oidc",
    "http://coforge.example/oidc",
    "http://10.0.0.1/oidc",
    "ftp://coforge.example/oidc",
    // The routes are fixed at `/oidc`, and metadata must be fetched from the issuer's own path
    // (Discovery §4.3, RFC 8414 §3.3).
    "https://coforge.example",
    "https://coforge.example/auth",
    "https://coforge.example/a/oidc",
    // The configured string is the issuer byte for byte.
    " https://coforge.example/oidc",
    "https://coforge.example/oidc ",
  ])
    await expectBootRefused(configured({ COFORGE_OIDC_ISSUER: issuer }));
});

test("plain HTTP is accepted only for a loopback issuer", async () => {
  for (const issuer of [
    "http://localhost:8788/oidc",
    "http://127.0.0.1:8788/oidc",
    "http://[::1]:8788/oidc",
  ]) {
    const environment = configured({ COFORGE_OIDC_ISSUER: issuer });
    await expect(assertStartupConfig(environment)).resolves.toBeUndefined();
    const response = oidcDiscovery(await readAuthorizationServerConfiguration(environment));
    expect(((await response.json()) as { issuer: string }).issuer).toBe(issuer);
  }
});

test("the boot refuses a missing or unusable signing keyset without echoing keys", async () => {
  const publicOnly = { kty: "EC", crv: "P-256", x: CURRENT.x, y: CURRENT.y, kid: "current" };
  const keysets: Record<string, string | undefined> = {
    missing: undefined,
    "not JSON": `{"keys":[${JSON.stringify(CURRENT)}`,
    "not a key set": JSON.stringify([CURRENT]),
    "no keys": JSON.stringify({ keys: [] }),
    "a P-384 key": JSON.stringify({ keys: [await signingKey("p384", "ES384")] }),
    "an Ed25519 key": JSON.stringify({ keys: [await signingKey("ed", "EdDSA")] }),
    "a public key only": JSON.stringify({ keys: [publicOnly] }),
    "a key without kid": JSON.stringify({ keys: [{ ...CURRENT, kid: undefined }] }),
    "an empty kid": JSON.stringify({ keys: [{ ...CURRENT, kid: "" }] }),
    "a duplicate kid": JSON.stringify({ keys: [CURRENT, { ...PREVIOUS, kid: "current" }] }),
    "another algorithm": JSON.stringify({ keys: [{ ...CURRENT, alg: "ES384" }] }),
    "an encryption key": JSON.stringify({ keys: [{ ...CURRENT, use: "enc" }] }),
    "a key not for signing": JSON.stringify({ keys: [{ ...CURRENT, key_ops: ["verify"] }] }),
    "malformed key_ops": JSON.stringify({ keys: [{ ...CURRENT, key_ops: "sign" }] }),
    "a private scalar that is not on the curve": JSON.stringify({
      keys: [{ ...CURRENT, d: "AA" }],
    }),
  };
  for (const keyset of Object.values(keysets))
    await expectBootRefused(configured({ COFORGE_OIDC_SIGNING_JWKS: keyset }));
});

test("a key may declare that it is for ES256 signing", async () => {
  const declared = { ...CURRENT, alg: "ES256", use: "sig", key_ops: ["sign"] };
  const environment = configured({
    COFORGE_OIDC_SIGNING_JWKS: JSON.stringify({ keys: [declared] }),
  });
  await expect(assertStartupConfig(environment)).resolves.toBeUndefined();
  const response = oidcJwks(await readAuthorizationServerConfiguration(environment));
  expect(await response.json()).toEqual({ keys: [publicHalf(CURRENT)] });
});

test("the signing keyset can be read from a file", async () => {
  const path = await keysetFile(`${JSON.stringify({ keys: [PREVIOUS] })}\n`);
  const environment = configured({
    COFORGE_OIDC_SIGNING_JWKS: undefined,
    COFORGE_OIDC_SIGNING_JWKS_FILE: path,
  });
  await expect(assertStartupConfig(environment)).resolves.toBeUndefined();
  const response = oidcJwks(await readAuthorizationServerConfiguration(environment));
  expect(await response.json()).toEqual({ keys: [publicHalf(PREVIOUS)] });
});

test("the boot refuses a keyset given both inline and as a file, or as an unreadable file", async () => {
  const path = await keysetFile(JSON.stringify({ keys: [PREVIOUS] }));
  await expectBootRefused(configured({ COFORGE_OIDC_SIGNING_JWKS_FILE: path }));
  await expectBootRefused(
    configured({
      COFORGE_OIDC_SIGNING_JWKS: undefined,
      COFORGE_OIDC_SIGNING_JWKS_FILE: join(path, "..", "absent.json"),
    }),
  );
});
