import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { readCompose, registryImage } from "./deploy-test-support";

const secretsScript = new URL("./deploy-secrets.sh", import.meta.url).pathname;

test("optional GitHub deployment credentials reach Compose without entering stdout", async () => {
  const functions = await readFile(secretsScript, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "coforge-github-deploy-"));
  try {
    for (const name of [
      "authing_app_id",
      "authing_app_secret",
      "coforge_session_secret",
      "coforge_agent_credential_encryption_key",
      "coforge_web_push_public_key",
      "coforge_web_push_private_key",
      "coforge_file_delivery_key",
      "centrifugo_token_hmac_secret_key",
    ])
      await writeFile(join(directory, name), "fixture");
    for (const configured of [false, true]) {
      if (configured) {
        await writeFile(join(directory, "coforge_github_client_secret"), "github-fixture");
        await writeFile(join(directory, "coforge_github_credential_encryption_key"), "key-fixture");
        await writeFile(join(directory, "coforge_github_app_slug"), "fixture-app");
        await writeFile(join(directory, "coforge_commit_coauthor"), "C <c@x.io>");
        await writeFile(join(directory, "coforge_github_webhook_secret"), "hook-fixture");
        await writeFile(join(directory, "coforge_oidc_signing_jwks"), '{"keys":[]}');
      }
      const child = Bun.spawn(
        [
          "bash",
          "-euc",
          `${functions}
        secrets_dir="$1"
        COMPOSE_ARGS=()
        docker() {
          test "\${COFORGE_GITHUB_CLIENT_SECRET-unset}" = "$2"
          test "\${COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY-unset}" = "$3"
          test "\${COFORGE_GITHUB_APP_SLUG-unset}" = "$4"
          test "\${COFORGE_COMMIT_COAUTHOR-unset}" = "$5"
          test "\${COFORGE_GITHUB_WEBHOOK_SECRET-unset}" = "$6"
          test "\${COFORGE_OIDC_SIGNING_JWKS-unset}" = "$7"
        }
        load_compose_secrets
        compose "$2" "$3" "$4" "$5" "$6" "$7"
      `,
          "test",
          directory,
          configured ? "github-fixture" : "",
          configured ? "key-fixture" : "",
          configured ? "fixture-app" : "",
          configured ? "C <c@x.io>" : "",
          configured ? "hook-fixture" : "",
          configured ? '{"keys":[]}' : "",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compose exports the loaded secrets to the docker process environment", async () => {
  // A docker() shell function cannot catch a broken env-prefix chain: unexported
  // assignments still reach it. Only an external process sees what Compose gets.
  const root = await mkdtemp(join(tmpdir(), "coforge-compose-env-"));
  try {
    const binDir = join(root, "bin");
    const secretsDir = join(root, "secrets");
    const envDump = join(root, "docker-env.txt");
    await mkdir(binDir);
    await mkdir(secretsDir);
    const secrets: Record<string, string> = {
      authing_app_id: "app-id-value",
      authing_app_secret: "app-secret-value",
      coforge_session_secret: "session-secret-value",
      coforge_agent_credential_encryption_key: "credential-key-value",
      coforge_web_push_public_key: "push-public-value",
      coforge_web_push_private_key: "push-private-value",
      coforge_file_delivery_key: "file-delivery-value",
      centrifugo_token_hmac_secret_key: "hmac-value",
      coforge_cloud_cluster_token: "cluster-token-value",
      coforge_oidc_signing_jwks: '{"keys":[]}',
    };
    for (const [name, value] of Object.entries(secrets)) {
      await writeFile(join(secretsDir, name), value);
    }
    await writeFile(join(binDir, "docker"), `#!/bin/sh\nenv > ${JSON.stringify(envDump)}\n`, {
      mode: 0o700,
    });
    const functions = await readFile(secretsScript, "utf8");
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        [
          "set -euo pipefail",
          `export PATH=${JSON.stringify(binDir)}:"$PATH"`,
          `secrets_dir=${JSON.stringify(secretsDir)}`,
          "COMPOSE_ARGS=(-p coforge-test)",
          functions,
          "load_compose_secrets",
          "compose config --quiet",
        ].join("\n"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);
    const env = new Map(
      (await readFile(envDump, "utf8"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as const;
        }),
    );
    const expected: Record<string, string> = {
      AUTHING_APP_ID: "app-id-value",
      AUTHING_APP_SECRET: "app-secret-value",
      COFORGE_SESSION_SECRET: "session-secret-value",
      COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY: "credential-key-value",
      COFORGE_WEB_PUSH_PUBLIC_KEY: "push-public-value",
      COFORGE_WEB_PUSH_PRIVATE_KEY: "push-private-value",
      COFORGE_FILE_DELIVERY_KEY: "file-delivery-value",
      COFORGE_CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: "hmac-value",
      COFORGE_CLOUD_CLUSTER_TOKEN: "cluster-token-value",
      COFORGE_OIDC_SIGNING_JWKS: '{"keys":[]}',
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(env.get(name), name).toBe(value);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("write_deploy_env", () => {
  test("keeps Authing values out of compose .env and replaces it with mode 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-write-deploy-env-"));
    try {
      const secretsDir = join(root, "secrets");
      await mkdir(secretsDir, { mode: 0o700 });
      await writeFile(join(root, "docker-compose.yml"), "name: coforge-staging\n");
      await mkdir(join(root, "centrifugo"));
      await writeFile(join(root, "centrifugo/config.yaml"), "client:\n  allowed_origins: []\n");
      await mkdir(join(root, "caddy"));
      const caddyfile = "staging.example.test {\n\treverse_proxy web:3000\n}\n";
      await writeFile(join(root, "caddy/Caddyfile"), caddyfile);
      const files: Record<string, string> = {
        postgres_password: "pg-pass",
        redis_password: "redis-pass",
        centrifugo_http_api_key: "centrifugo-api",
        centrifugo_proxy_secret: "centrifugo-proxy",
        worker_jwt_key_id: "coforge-staging",
        worker_jwt_private_jwk: '{"kty":"OKP"}',
        authing_app_id: "staging-app-id",
        authing_app_secret: "staging-app-secret",
        authing_issuer: "https://coforge-staging.authing.cn/oidc",
        coforge_session_secret: "staging-session-secret-at-least-32-chars",
      };
      for (const [name, value] of Object.entries(files)) {
        await writeFile(join(secretsDir, name), value, { mode: 0o600 });
      }
      const envPath = join(root, ".env");
      await writeFile(envPath, "STALE=value\n", { mode: 0o644 });
      await chmod(envPath, 0o644);

      const fn = await Bun.file(secretsScript).text();

      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          [
            "set -euo pipefail",
            `compose_file=${JSON.stringify(join(root, "docker-compose.yml"))}`,
            `secrets_dir=${JSON.stringify(secretsDir)}`,
            fn,
            `write_deploy_env ${JSON.stringify(registryImage)}`,
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, stderr).toBe(0);

      const envFile = await readFile(join(root, ".env"), "utf8");
      expect(envFile).not.toContain("AUTHING_");
      expect(envFile).not.toContain("COFORGE_SESSION_SECRET");
      expect(envFile).toContain("COFORGE_CENTRIFUGO_CONFIG_SHA256=");
      expect(envFile).toContain(
        `COFORGE_CADDYFILE_SHA256=${createHash("sha256").update(caddyfile).digest("hex")}`,
      );
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("takes DATABASE_URL and REDIS_URL verbatim from secret files when no bundled datastore password exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-write-deploy-env-external-"));
    try {
      const secretsDir = join(root, "secrets");
      await mkdir(secretsDir, { mode: 0o700 });
      await writeFile(join(root, "docker-compose.yml"), "name: coforge-production\n");
      await mkdir(join(root, "centrifugo"));
      await writeFile(join(root, "centrifugo/config.yaml"), "client:\n  allowed_origins: []\n");
      await mkdir(join(root, "caddy"));
      await writeFile(join(root, "caddy/Caddyfile"), "coforge.example.test {\n}\n");
      const databaseUrl =
        "postgresql://coforge:db-pass@pg.example.test:5432/coforge?sslmode=require";
      const redisUrl = "redis://fixture-instance:redis-pass@redis.example.test:6379";
      const files: Record<string, string> = {
        database_url: databaseUrl,
        redis_url: redisUrl,
        centrifugo_http_api_key: "centrifugo-api",
        centrifugo_proxy_secret: "centrifugo-proxy",
        worker_jwt_key_id: "coforge-production",
        worker_jwt_private_jwk: '{"kty":"OKP"}',
      };
      for (const [name, value] of Object.entries(files)) {
        await writeFile(join(secretsDir, name), value, { mode: 0o600 });
      }

      const fn = await Bun.file(secretsScript).text();

      const proc = Bun.spawn(
        [
          "bash",
          "-c",
          [
            "set -euo pipefail",
            `compose_file=${JSON.stringify(join(root, "docker-compose.yml"))}`,
            `secrets_dir=${JSON.stringify(secretsDir)}`,
            fn,
            `write_deploy_env ${JSON.stringify(registryImage)}`,
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(exitCode, stderr).toBe(0);

      const envLines = (await readFile(join(root, ".env"), "utf8")).split("\n");
      expect(envLines.filter((line) => line.startsWith("DATABASE_URL="))).toEqual([
        `DATABASE_URL=${databaseUrl}`,
      ]);
      expect(envLines.filter((line) => line.startsWith("REDIS_URL="))).toEqual([
        `REDIS_URL=${redisUrl}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Authing webhook secret", () => {
  for (const environment of ["staging", "production"]) {
    test(`${environment} web receives the webhook secret as an environment-sourced secret file`, async () => {
      const compose = await readCompose(environment);
      const web = compose.services.web;
      expect(web?.environment?.COFORGE_AUTHING_WEBHOOK_SECRET_FILE).toBe(
        "/run/secrets/coforge_authing_webhook_secret",
      );
      expect(web?.secrets).toContainEqual({
        source: "coforge_authing_webhook_secret",
        uid: "1000",
        gid: "1000",
        mode: 400,
      });
      expect(compose.secrets.coforge_authing_webhook_secret).toEqual({
        environment: "COFORGE_AUTHING_WEBHOOK_SECRET",
      });
    });
  }
});

describe("Login with CoForge signing keyset", () => {
  test.each([
    ["production", "https://coforge.cn/oidc"],
    ["staging", "https://staging.coforge.cn/oidc"],
  ] as const)(
    "%s web receives its own issuer and the keyset as an environment-sourced secret",
    async (environment, issuer) => {
      const compose = await readCompose(environment);
      const web = compose.services.web;
      expect(web?.environment).toMatchObject({
        COFORGE_OIDC_ISSUER: issuer,
        COFORGE_OIDC_SIGNING_JWKS_FILE: "/run/secrets/coforge_oidc_signing_jwks",
      });
      expect(web?.secrets).toContainEqual({
        source: "coforge_oidc_signing_jwks",
        uid: "1000",
        gid: "1000",
        mode: 400,
      });
      expect(compose.secrets.coforge_oidc_signing_jwks).toEqual({
        environment: "COFORGE_OIDC_SIGNING_JWKS",
      });
    },
  );
});
