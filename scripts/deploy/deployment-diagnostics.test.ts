import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parseRemoteOutputs } from "./deployment";
import { registryImage, timeoutShim } from "./deploy-test-support";

const secretsScript = new URL("./deploy-secrets.sh", import.meta.url).pathname;

describe("remote-deploy.sh compose invocation shape", () => {
  test("passes secrets only to Compose and places global arguments before its subcommand", async () => {
    const script = await Bun.file(secretsScript).text();
    expect(script.split("\n").filter((line) => line.includes("docker compose"))).toEqual([
      '\t\tdocker compose "${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"}" "$@"',
    ]);
    expect(script).not.toContain("export AUTHING_APP_ID");
  });

  test("keeps the migration container output off the key=value report", async () => {
    const script = await Bun.file(new URL("./remote-deploy.sh", import.meta.url)).text();
    const runIndex = script.split("\n").findIndex((line) => line.includes("compose run"));
    expect(runIndex).toBeGreaterThanOrEqual(0);
    const runBlock = script.slice(script.indexOf("compose run")).split("then")[0];
    // The script itself arrives on stdin over SSH; the container must not
    // inherit it (it would consume the rest of the deploy script), and its
    // output must not corrupt the key=value report on stdout.
    expect(runBlock).toContain("</dev/null");
    expect(runBlock).toContain("1>&2");
  });
});

describe("candidate failure diagnostics", () => {
  for (const mode of ["available", "unavailable", "oversized", "invalid_version"]) {
    test(`diagnostics precede rollback without leaking logs (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "coforge-deploy-failure-"));
      try {
        await mkdir(join(root, "bin"));
        await mkdir(join(root, "secrets"));
        await mkdir(join(root, "centrifugo"));
        await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
        await mkdir(join(root, "caddy"));
        await Bun.write(join(root, "caddy/Caddyfile"), "staging.example.test {\n}\n");
        await Bun.write(join(root, "compose.yml"), "services: {}\n");
        for (const name of [
          "authing_app_id",
          "authing_app_secret",
          "coforge_session_secret",
          "coforge_agent_credential_encryption_key",
          "coforge_web_push_public_key",
          "coforge_web_push_private_key",
          "coforge_file_delivery_key",
          "alidns_access_key_id",
          "alidns_access_key_secret",
          "postgres_password",
          "redis_password",
          "centrifugo_http_api_key",
          "centrifugo_proxy_secret",
          "centrifugo_token_hmac_secret_key",
          "worker_jwt_key_id",
          "worker_jwt_private_jwk",
        ])
          await Bun.write(join(root, "secrets", name), "fixture-private-value");
        const previous = `coforge/web@sha256:${"b".repeat(64)}`;
        const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
        await Bun.write(join(root, "state.env"), state);
        await writeFile(join(root, "bin/timeout"), timeoutShim(), { mode: 0o700 });
        await writeFile(
          join(root, "bin/docker"),
          `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    up) if [[ ! -f "$FIXTURE_ROOT/candidate-failed" ]]; then touch "$FIXTURE_ROOT/candidate-failed"; exit 1; fi ;;
    ps) echo abc123 ;;
  esac
elif [[ "$1" = ps || "$1" = logs ]]; then
  if [[ "$DIAGNOSTICS_MODE" = unavailable ]]; then echo fixture-private-value >&2; exit 1; fi
  if [[ "$1" = ps ]]; then
    # The proxy runs its own container, so its diagnostics can be asserted separately.
    if [[ "$*" = *service=caddy* ]]; then echo cadd1e; else echo abc123; fi
  elif [[ "$*" = *cadd1e* ]]; then
    echo '{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","error":"[coforge.cn] solving challenges: connection refused"}'
  else
    if [[ "$DIAGNOSTICS_MODE" = oversized ]]; then printf '%20000s' ''; fi
    echo 'TypeError: createSsrRpc is not a function fixture-private-value'
    echo 'https://user:fixture-private-value@example.test/?token=unknown-private-value'
  fi
elif [[ "$1" = inspect ]]; then
  if [[ "$*" = *RestartCount* ]]; then
    if [[ "$*" = *cadd1e* ]]; then echo 'running 0 0 healthy'; else echo 'running 0 3 unhealthy'; fi
  else echo healthy; fi
elif [[ "$1" = exec ]]; then
  echo fixture-private-value >&2
  shift 2
  shift
  exec "$TEST_BUN" --preload "$FIXTURE_ROOT/feed-preload.ts" "$@"
fi
`,
          { mode: 0o700 },
        );
        await Bun.write(
          join(root, "feed-preload.ts"),
          `globalThis.fetch = async () => {
            if (Bun.env.DIAGNOSTICS_MODE === "invalid_version") {
              return new Response("0.1.2-dev..1\\n");
            }
            throw Object.assign(new Error("fixture-private-value"), {
              code: Bun.env.DIAGNOSTICS_MODE === "oversized"
                ? "unknown-private-value".repeat(2000)
                : "ENOTFOUND",
            });
          };`,
        );
        await writeFile(
          join(root, "bin/curl"),
          `#!/bin/bash
if [[ "$*" = *http_code* ]]; then echo 500; fi
`,
          { mode: 0o700 },
        );
        const proc = Bun.spawn(
          [
            "bash",
            new URL("./remote-deploy.sh", import.meta.url).pathname,
            "--image",
            registryImage,
            "--compose-file",
            join(root, "compose.yml"),
            "--secrets-dir",
            join(root, "secrets"),
            "--state-file",
            join(root, "state.env"),
            "--web-health-url",
            "http://127.0.0.1/health",
            "--public-health-url",
            "https://example.test/health",
          ],
          {
            env: {
              ...Bun.env,
              PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
              FIXTURE_ROOT: root,
              DIAGNOSTICS_MODE: mode,
              TEST_BUN: process.execPath,
              COFORGE_RELEASE_FEED_URL: "https://releases-staging.coforge.cn",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(0);
        expect(parseRemoteOutputs(stdout).outcome).toBe("rolled_back");
        expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
        expect(stderr).toContain("candidate diagnostics");
        expect(stderr.indexOf("candidate diagnostics")).toBeLessThan(stderr.indexOf("rolled back"));
        expect(stdout + stderr).not.toContain("fixture-private-value");
        expect(stdout + stderr).not.toContain("unknown-private-value");
        expect(stderr).toContain("candidate loopback health HTTP status: 500");
        if (mode !== "unavailable") {
          expect(stderr).toContain(
            mode === "oversized"
              ? "startup_signature=unclassified_or_unavailable"
              : "startup_signature=createSsrRpc",
          );
          expect(stderr).toContain("candidate state/exit/restarts/health: running 0 3 unhealthy");
          // The proxy's certificate state explains a public 443 handshake failure that the
          // application's own health cannot: classify it without printing its log.
          expect(stderr).toContain("proxy state/exit/restarts/health: running 0 0 healthy");
          expect(stderr).toContain("proxy_signature=acme_challenge_unreachable");
          expect(stderr).toContain(
            mode === "oversized"
              ? "candidate release feed: network_error"
              : mode === "invalid_version"
                ? "candidate release feed: invalid_version"
                : "candidate release feed: dns_error",
          );
        } else {
          expect(stderr).not.toContain("proxy_signature=");
          expect(stderr).not.toContain("candidate release feed:");
        }
        const calls = await Bun.file(join(root, "calls")).text();
        expect(calls).toContain(
          "timeout --kill-after=1s 5s docker ps --filter label=com.docker.compose.project=coforge-staging",
        );
        if (mode !== "unavailable")
          expect(calls).toContain(
            "timeout --kill-after=1s 5s docker logs --tail 80 --since 5m abc123",
          );
        if (mode !== "unavailable")
          expect(calls).toContain(
            "timeout --kill-after=1s 5s docker logs --tail 120 --since 10m cadd1e",
          );
        if (mode !== "unavailable")
          expect(calls).toContain("timeout --kill-after=1s 5s docker exec abc123 bun -e");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
