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
        authing_redirect_uri: "https://staging.coforge.cn/auth/callback",
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

describe("Login with CoForge signing keyset", () => {
  test("production web receives the keyset as an environment-sourced secret, staging none", async () => {
    const production = await readCompose("production");
    const web = production.services.web;
    expect(web?.environment).toMatchObject({
      COFORGE_OIDC_ISSUER: "https://coforge.cn/oidc",
      COFORGE_OIDC_SIGNING_JWKS_FILE: "/run/secrets/coforge_oidc_signing_jwks",
    });
    expect(web?.secrets).toContainEqual({
      source: "coforge_oidc_signing_jwks",
      uid: "1000",
      gid: "1000",
      mode: 400,
    });
    expect(production.secrets.coforge_oidc_signing_jwks).toEqual({
      environment: "COFORGE_OIDC_SIGNING_JWKS",
    });
    const staging = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    expect(staging).not.toContain("OIDC");
    expect(staging).not.toContain("coforge_oidc_signing_jwks");
  });
});
