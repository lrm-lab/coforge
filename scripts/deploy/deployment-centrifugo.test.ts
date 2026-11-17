import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { digest, ipShim, readCompose, requiredSecretNames } from "./deploy-test-support";

const secretsScript = new URL("./deploy-secrets.sh", import.meta.url).pathname;

const centrifugoSecretNames = [
  "centrifugo_http_api_key",
  "centrifugo_proxy_secret",
  "centrifugo_token_hmac_secret_key",
  "redis_url",
] as const;

// Runs a Centrifugo launch snippet with `cat` and `centrifugo` replaced, so a secret can be made
// unreadable (or empty) without a container. Returns the exit code and whether centrifugo ran.
const runCentrifugoLaunch = async (snippet: string, unreadable: string, emptied: string) => {
  const root = await mkdtemp(join(tmpdir(), "coforge-centrifugo-launch-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin/cat"),
      `#!/bin/sh
case "$1" in
  "$UNREADABLE") printf "cat: can't open '%s': Permission denied\\n" "$1" >&2; exit 1 ;;
  "$EMPTIED") exit 0 ;;
esac
printf 'fixture-%s' "\${1##*/}"
`,
      { mode: 0o700 },
    );
    await writeFile(join(root, "bin/centrifugo"), `#!/bin/sh\necho "$@" > "$MARKER"\n`, {
      mode: 0o700,
    });
    const proc = Bun.spawn(["sh", "-c", snippet], {
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        MARKER: join(root, "ran"),
        UNREADABLE: unreadable,
        EMPTIED: emptied,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return { code, ran: await Bun.file(join(root, "ran")).exists() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("Centrifugo secrets under a rootless Docker daemon", () => {
  for (const environment of ["staging", "production"]) {
    test(`${environment}: Compose creates every Centrifugo secret for the image's non-root user`, async () => {
      const compose = await readCompose(environment);
      const grants = compose.services.centrifugo?.secrets ?? [];
      expect(
        grants.map((grant) => (typeof grant === "string" ? grant : grant.source)).sort(),
      ).toEqual([...centrifugoSecretNames]);
      for (const grant of grants) {
        expect(grant).toEqual({ source: expect.any(String), uid: "1000", gid: "1000", mode: 400 });
        const source = typeof grant === "string" ? grant : grant.source;
        expect(compose.secrets[source]).toEqual({ environment: expect.any(String) });
      }
    });

    test(`${environment}: every environment-sourced secret resolves when remote-deploy.sh runs Compose`, async () => {
      const compose = await readCompose(environment);
      const names = Object.values(compose.secrets).flatMap((secret) =>
        secret.environment ? [secret.environment] : [],
      );
      const loaders = await readFile(secretsScript, "utf8");
      const root = await mkdtemp(join(tmpdir(), "coforge-compose-secret-sources-"));
      try {
        await mkdir(join(root, "secrets"));
        await mkdir(join(root, "centrifugo"));
        await writeFile(join(root, "centrifugo/config.yaml"), "client: {}\n");
        await mkdir(join(root, "caddy"));
        await writeFile(join(root, "caddy/Caddyfile"), "example.test {\n}\n");
        await writeFile(join(root, "docker-compose.yml"), "services: {}\n");
        const datastore =
          environment === "production"
            ? ["database_url", "redis_url"]
            : ["postgres_password", "redis_password"];
        // The optional GitHub App values are configured here, so every source must resolve.
        const optional = [
          "coforge_github_client_secret",
          "coforge_github_credential_encryption_key",
          "coforge_github_webhook_secret",
          "coforge_oidc_signing_jwks",
          "coforge_authing_webhook_secret",
        ];
        await mkdir(join(root, "bin"));
        await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
        for (const name of [...requiredSecretNames, ...datastore, ...optional])
          await writeFile(join(root, "secrets", name), `fixture-${name}`, { mode: 0o600 });
        const proc = Bun.spawn(
          [
            "bash",
            "-euc",
            `${loaders}
secrets_dir="$1/secrets"
compose_file="$1/docker-compose.yml"
env_file="$1/.env"
COMPOSE_ARGS=()
docker() {
  shift
  for name in "$@"; do
    [ -n "\${!name:-}" ] || grep -Eq "^$name=.+" "$env_file" || echo "unresolved $name"
  done
}
load_compose_secrets
write_deploy_env coforge/web@${digest}
compose "\${@:2}"
`,
            "test",
            root,
            ...names,
          ],
          {
            env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout).toBe("");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${environment}: Centrifugo refuses to start on an unreadable or empty secret`, async () => {
      const command = (await readCompose(environment)).services.centrifugo?.command ?? [];
      expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
      // Compose unescapes `$$` to `$` before the container's shell sees the command.
      const snippet = (command[2] ?? "").replaceAll("$$", "$");
      expect(await runCentrifugoLaunch(snippet, "", "")).toEqual({ code: 0, ran: true });
      for (const name of centrifugoSecretNames) {
        for (const [unreadable, emptied] of [
          [`/run/secrets/${name}`, ""],
          ["", `/run/secrets/${name}`],
        ]) {
          const result = await runCentrifugoLaunch(snippet, unreadable, emptied);
          expect(result.ran, `${name} unreadable=${unreadable} emptied=${emptied}`).toBe(false);
          expect(result.code).not.toBe(0);
        }
      }
    });
  }

  test("the pre-deploy checkconfig fails on any unreadable or empty Centrifugo secret", async () => {
    const script = await readFile(new URL("./remote-deploy.sh", import.meta.url), "utf8");
    const snippet = script.match(/--entrypoint sh centrifugo \\\n\t-c '([^']*)'/)?.[1];
    expect(snippet).toContain("checkconfig");
    expect(await runCentrifugoLaunch(snippet ?? "", "", "")).toEqual({ code: 0, ran: true });
    for (const name of centrifugoSecretNames) {
      for (const [unreadable, emptied] of [
        [`/run/secrets/${name}`, ""],
        ["", `/run/secrets/${name}`],
      ]) {
        const result = await runCentrifugoLaunch(snippet ?? "", unreadable, emptied);
        expect(result.ran, `${name} unreadable=${unreadable} emptied=${emptied}`).toBe(false);
        expect(result.code).not.toBe(0);
      }
    }
  });
});

describe("check-centrifugo-config.sh", () => {
  test("checks both configuration files against the digest-pinned image the staging Compose file ships", async () => {
    const script = await Bun.file(new URL("./check-centrifugo-config.sh", import.meta.url)).text();
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();

    // Mirrors the script's own extraction: the exact image line under the
    // centrifugo: service, and it must be digest-pinned - this test never
    // runs docker, only proves the shape the script depends on holds today.
    const centrifugoStart = compose.indexOf("\n  centrifugo:\n");
    const redisStart = compose.indexOf("\n  redis:\n");
    expect(centrifugoStart).toBeGreaterThanOrEqual(0);
    expect(redisStart).toBeGreaterThan(centrifugoStart);
    const centrifugoBlock = compose.slice(centrifugoStart, redisStart);
    const imageLine = centrifugoBlock.match(/^ {4}image: (\S+)$/m);
    expect(imageLine).not.toBeNull();
    expect(imageLine?.[1]).toMatch(/@sha256:[0-9a-f]{64}$/);

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("infra/centrifugo/config.yaml");
    expect(script).toContain("infra/staging/centrifugo/config.yaml");
    expect(script).toContain("checkconfig -c /config.yaml");
    expect(script).toContain("CENTRIFUGO_VAR_RPC_PROXY_SECRET");
    expect(script).toContain("is not pinned to a digest");
  });

  test("is wired into check:deploy alongside the other deploy scripts", async () => {
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    expect(packageJson).toContain("check-centrifugo-config.sh");
    expect(packageJson).toContain("remote-deploy.sh");
  });
});

describe("check-caddy-config.sh", () => {
  test("validates the staging Caddyfile with the digest-pinned image the staging Compose file ships, in check:deploy", async () => {
    const script = await Bun.file(new URL("./check-caddy-config.sh", import.meta.url)).text();
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("infra/staging/caddy/Caddyfile");
    expect(script).toContain("caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile");
    expect(script).toContain("is not pinned to a digest");
    const packageJson = await Bun.file(new URL("../../package.json", import.meta.url)).text();
    expect(packageJson).toContain("check-caddy-config.sh");
  });
});
