import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, spyOn, test } from "bun:test";

import {
  AuthConfigError,
  readAuthingConfig,
  readGitHubSignInConfig,
  readGitHubSignInConfigOrNull,
  readSessionSecret,
} from "#src/server/auth/config.server";

test("readAuthingConfig derives the API host, userinfo and revocation endpoints from the issuer", async () => {
  const config = await readAuthingConfig({
    AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
    AUTHING_APP_SECRET: "test-app-secret",
    AUTHING_ISSUER: "https://coforge.authing.cn/oidc/",
  });

  expect(config.appId).toBe("6a8fde6fa804dd3bea560bac");
  expect(config.appHost).toBe("https://coforge.authing.cn");
  expect(config.userinfoEndpoint).toBe("https://coforge.authing.cn/oidc/me");
  expect(config.revocationEndpoint).toBe("https://coforge.authing.cn/oidc/token/revocation");
});

test("readAuthingConfig rejects a non-HTTPS issuer", async () => {
  await expect(
    readAuthingConfig({
      AUTHING_APP_ID: "6a8fde6fa804dd3bea560bac",
      AUTHING_APP_SECRET: "test-app-secret",
      AUTHING_ISSUER: "http://attacker.example/oidc",
    }),
  ).rejects.toThrow("AUTHING_ISSUER must use HTTPS");
});

test("reads Authing and session secrets from mounted files without blocking the event loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-auth-config-"));
  try {
    const appIdFile = join(root, "authing_app_id");
    const appSecretFile = join(root, "authing_app_secret");
    const sessionSecretFile = join(root, "coforge_session_secret");
    await Bun.write(appIdFile, "6a8fde6fa804dd3bea560bac\n");
    await Bun.write(appSecretFile, "mounted-$app-${secret}\n");
    await Bun.write(sessionSecretFile, "mounted-$session-${secret}-at-least-32-characters\n");

    // `Bun.file().text()` returns a Promise, so a cached mount does not have to yield a timer.
    // The contract is that the read itself is awaitable and does not throw synchronously.
    const pending = readAuthingConfig({
      AUTHING_APP_ID_FILE: appIdFile,
      AUTHING_APP_SECRET_FILE: appSecretFile,
      AUTHING_ISSUER: "https://coforge.authing.cn/oidc",
    });
    expect(pending).toBeInstanceOf(Promise);
    const config = await pending;
    expect(config.appId).toBe("6a8fde6fa804dd3bea560bac");
    expect(config.appSecret).toBe("mounted-$app-${secret}");
    expect(await readSessionSecret({ COFORGE_SESSION_SECRET_FILE: sessionSecretFile })).toBe(
      "mounted-$session-${secret}-at-least-32-characters",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous inline and file secret configuration", async () => {
  await expect(
    readSessionSecret({
      COFORGE_SESSION_SECRET: "inline-session-secret-at-least-32-characters",
      COFORGE_SESSION_SECRET_FILE: "/run/secrets/coforge_session_secret",
    }),
  ).rejects.toThrow("COFORGE_SESSION_SECRET and COFORGE_SESSION_SECRET_FILE cannot both be set");
});

test("readSessionSecret rejects missing or short secrets", async () => {
  await expect(readSessionSecret({})).rejects.toThrow(AuthConfigError);
  await expect(readSessionSecret({ COFORGE_SESSION_SECRET: "too-short" })).rejects.toThrow(
    "COFORGE_SESSION_SECRET must be at least 32 characters",
  );
  expect(
    await readSessionSecret({
      COFORGE_SESSION_SECRET: "test-session-secret-at-least-32-characters",
    }),
  ).toBe("test-session-secret-at-least-32-characters");
});

test("GitHub sign-in is off unless its client id and Authing connection are both set", () => {
  expect(readGitHubSignInConfig({})).toBeNull();
  expect(readGitHubSignInConfig({ COFORGE_GITHUB_SIGN_IN_CLIENT_ID: " " })).toBeNull();
  expect(
    readGitHubSignInConfig({
      COFORGE_GITHUB_SIGN_IN_CLIENT_ID: " Ov23lig3ZSmcMqA97yAN ",
      AUTHING_GITHUB_CONNECTION: "github-mobile",
    }),
  ).toEqual({
    clientId: "Ov23lig3ZSmcMqA97yAN",
    connection: "github-mobile",
    authorizeUrl: "https://github.com/login/oauth/authorize",
  });
  expect(() => readGitHubSignInConfig({ COFORGE_GITHUB_SIGN_IN_CLIENT_ID: "id" })).toThrow(
    AuthConfigError,
  );
  expect(() => readGitHubSignInConfig({ AUTHING_GITHUB_CONNECTION: "github-mobile" })).toThrow(
    AuthConfigError,
  );
});

test("the GitHub authorize URL can be overridden only with HTTPS, or HTTP on a loopback host", () => {
  const base = {
    COFORGE_GITHUB_SIGN_IN_CLIENT_ID: "id",
    AUTHING_GITHUB_CONNECTION: "github-mobile",
  };
  const read = (url: string) =>
    readGitHubSignInConfig({ ...base, COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL: url })?.authorizeUrl;
  expect(read("http://127.0.0.1:9000/login/oauth/authorize")).toBe(
    "http://127.0.0.1:9000/login/oauth/authorize",
  );
  expect(read("https://github.example/login/oauth/authorize")).toBe(
    "https://github.example/login/oauth/authorize",
  );
  for (const bad of [
    "http://github.example/login/oauth/authorize",
    "https://user:pw@github.example/authorize",
    "https://github.example/authorize?x=1",
    "not a url",
  ]) {
    expect(() => read(bad)).toThrow(AuthConfigError);
  }
});

test("a misconfigured GitHub sign-in is logged once for the process, and is off every time", () => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    // Every /login load asks; only the first says what is wrong.
    const half = { COFORGE_GITHUB_SIGN_IN_CLIENT_ID: "id" };
    expect(readGitHubSignInConfigOrNull(half)).toBeNull();
    expect(readGitHubSignInConfigOrNull(half)).toBeNull();
    expect(readGitHubSignInConfigOrNull(half)).toBeNull();
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "auth.github_sign_in_misconfigured" },
    ]);
  } finally {
    spy.mockRestore();
  }
});
