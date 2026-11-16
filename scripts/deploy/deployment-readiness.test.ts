import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parseRemoteOutputs } from "./deployment";
import { registryImage, requiredSecretNames, timeoutShim } from "./deploy-test-support";

describe("Web image pull under a deadline", () => {
  // The fixture's `timeout` stands in for a deadline that expired for the first STALLED_PULLS Web
  // pulls. The first exits 124, GNU timeout's status for a timed-out command; later ones exit
  // 137, its status when the command also had to be KILLed.
  const previous = `coforge/web@sha256:${"c".repeat(64)}`;
  const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
  const healthyCaddyfile = "staging.example.test {\n}\n# last healthy\n";

  async function deployWithWebPull(fixture: {
    stalledPulls: number;
    pullFails?: boolean;
    wildcardProbe?: { host: string; handshakeSucceeds: boolean };
  }) {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-web-pull-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await mkdir(join(root, "caddy"));
      await Bun.write(join(root, "caddy/Caddyfile"), "staging.example.test {\n}\n# candidate\n");
      await mkdir(join(root, "last-healthy/caddy"), { recursive: true });
      await Bun.write(join(root, "last-healthy/caddy/Caddyfile"), healthyCaddyfile);
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      await Bun.write(join(root, "state.env"), state);
      await writeFile(
        join(root, "bin/timeout"),
        `#!/bin/bash
echo "timeout $*" >> "$FIXTURE_ROOT/calls"
while [[ "$1" == -* ]]; do shift; done
shift
if [[ "$1 $2" = "docker pull" ]]; then
  echo stalled >> "$FIXTURE_ROOT/stalled-pulls"
  stalled=$(wc -l < "$FIXTURE_ROOT/stalled-pulls")
  if [[ $stalled -le $STALLED_PULLS ]]; then
    if [[ $stalled -eq 1 ]]; then exit 124; fi
    exit 137
  fi
fi
exec "$@"
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = pull ]]; then
  if [[ -n "$PULL_FAILS" ]]; then echo "Error response from daemon: fixture pull error" >&2; exit 1; fi
  echo "$3"
elif [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    ps) echo "container-$3" ;;
  esac
elif [[ "$1" = inspect ]]; then
  if [[ "$*" == *Config.Image* ]]; then
    echo "$IMAGE_REF"
  elif [[ "$*" == *Health.Status* ]]; then
    echo healthy
  fi
fi
exit 0
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, "bin/curl"),
        `#!/bin/bash
echo "curl $*" >> "$FIXTURE_ROOT/calls"
if [[ "$*" = *--resolve* ]]; then exit "$WILDCARD_CURL_EXIT"; fi
if [[ "$*" = *http_code* ]]; then echo 200; fi
exit 0
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
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
          ...(fixture.wildcardProbe
            ? ["--wildcard-probe-host", fixture.wildcardProbe.host, "--wildcard-probe-timeout", "0"]
            : []),
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
            FIXTURE_ROOT: root,
            IMAGE_REF: registryImage,
            WILDCARD_CURL_EXIT: fixture.wildcardProbe?.handshakeSucceeds ? "0" : "60",
            STALLED_PULLS: String(fixture.stalledPulls),
            PULL_FAILS: fixture.pullFails ? "1" : "",
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
      return {
        stdout,
        stderr,
        code,
        calls: await Bun.file(join(root, "calls")).text(),
        finalState: await Bun.file(join(root, "state.env")).text(),
        liveCaddyfile: await Bun.file(join(root, "caddy/Caddyfile")).text(),
        env: await Bun.file(join(root, ".env")).text(),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const webPulls = (calls: string) =>
    calls
      .split("\n")
      .filter(
        (line) => line.startsWith("timeout ") && line.endsWith(`pull --quiet ${registryImage}`),
      );

  const probeHost = "a-00000000-0000-0000-0000-000000000000.sandbox.example.test";

  test("no probe host means no wildcard probe", async () => {
    const result = await deployWithWebPull({ stalledPulls: 0 });
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).not.toContain("--resolve");
    expect(parseRemoteOutputs(result.stdout).warning).toBeNull();
  });

  test("a served wildcard certificate adds no warning", async () => {
    const result = await deployWithWebPull({
      stalledPulls: 0,
      wildcardProbe: { host: probeHost, handshakeSucceeds: true },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toContain(`--resolve ${probeHost}:443:127.0.0.1`);
    const outputs = parseRemoteOutputs(result.stdout);
    expect(outputs.outcome).toBe("healthy");
    expect(outputs.warning).toBeNull();
  });

  test("a missing wildcard certificate warns, points to the triage and never rolls back", async () => {
    const result = await deployWithWebPull({
      stalledPulls: 0,
      wildcardProbe: { host: probeHost, handshakeSucceeds: false },
    });
    expect(result.code, result.stderr).toBe(0);
    const outputs = parseRemoteOutputs(result.stdout);
    expect(outputs.outcome).toBe("healthy");
    expect(outputs.warning).toContain(probeHost);
    expect(outputs.warning).toContain("may still be issuing");
    expect(outputs.warning).toContain("docs/operations/usercontent-certificate");
  });

  test("a stalled pull is abandoned at its deadline and a fresh one deploys the candidate", async () => {
    const result = await deployWithWebPull({ stalledPulls: 1 });
    expect(result.code, result.stderr).toBe(0);
    expect(parseRemoteOutputs(result.stdout).outcome).toBe("healthy");
    // Each attempt runs under a deadline that ends in SIGKILL, so a client that ignores SIGTERM
    // still drops its connection, which is what makes the Engine abandon the pull. The deploy
    // jobs' timeout-minutes is sized for three such attempts.
    expect(webPulls(result.calls)).toEqual([
      `timeout --kill-after=10s 210s docker pull --quiet ${registryImage}`,
      `timeout --kill-after=10s 210s docker pull --quiet ${registryImage}`,
    ]);
    expect(result.stderr).toContain("Web image pull attempt 1 of 3 timed out after 210s");
    expect(result.stderr).toMatch(/Web image pull attempt 2 of 3 succeeded in \d+s/);
    expect(result.calls.lastIndexOf(`pull --quiet ${registryImage}`)).toBeLessThan(
      result.calls.indexOf("run --rm --entrypoint sh migrate"),
    );
    expect(result.calls).toMatch(/ up -d/);
  });

  test("a pull that stalls on every attempt fails before anything is migrated or recreated", async () => {
    const result = await deployWithWebPull({ stalledPulls: 1_000 });
    expect(result.code, result.stderr).toBe(0);
    // All four keys: the staging workflow rejects a report that lacks any of them.
    const outputs = parseRemoteOutputs(result.stdout);
    expect(outputs.outcome).toBe("failed");
    // The last attempt was KILLed (137), which is still a timeout.
    expect(outputs.healthResult).toBe("failed: Web image pull timed out");
    expect(webPulls(result.calls)).toHaveLength(3);
    expect(result.calls).not.toContain("migrate");
    expect(result.calls).not.toMatch(/ up -d/);
    expect(result.finalState).toBe(state);
    expect(result.liveCaddyfile).toBe(healthyCaddyfile);
    expect(result.env).toContain(`COFORGE_WEB_IMAGE=${previous}\n`);
  });

  test("a pull the registry refuses is reported as a pull failure", async () => {
    const result = await deployWithWebPull({ stalledPulls: 0, pullFails: true });
    expect(result.code, result.stderr).toBe(0);
    const outputs = parseRemoteOutputs(result.stdout);
    expect(outputs.outcome).toBe("failed");
    expect(outputs.healthResult).toBe("failed: Web image pull failed");
    expect(result.calls).not.toContain("migrate");
    expect(result.calls).not.toMatch(/ up -d/);
    expect(result.finalState).toBe(state);
    expect(result.liveCaddyfile).toBe(healthyCaddyfile);
  });
});

describe("public readiness after the candidate starts", () => {
  // A first deployment has no certificate when Caddy starts: until it obtains one, the public
  // HTTPS check fails its TLS handshake (`curl: (35) ... tlsv1 alert internal error`). Production's
  // first deployment was rolled back for exactly that while every container was healthy.
  async function deployWithPublicCurl(curlScript: string, extraArgs: string[] = []) {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-public-health-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await mkdir(join(root, "caddy"));
      await Bun.write(join(root, "caddy/Caddyfile"), "staging.example.test {\n}\n");
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      await Bun.write(
        join(root, "state.env"),
        `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`,
      );
      await writeFile(join(root, "bin/timeout"), timeoutShim({ record: false }), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
if [[ "$1" = compose ]]; then
  shift 5
  case "$1" in
    ps) echo "container-$3" ;;
  esac
  exit 0
elif [[ "$1" = inspect ]]; then
  if [[ "$*" == *Config.Image* ]]; then
    echo "$IMAGE_REF"
  elif [[ "$*" == *Health.Status* ]]; then
    echo healthy
  fi
fi
exit 0
`,
        { mode: 0o700 },
      );
      await writeFile(join(root, "bin/curl"), curlScript, { mode: 0o700 });
      const proc = Bun.spawn(
        [
          "bash",
          new URL("./remote-deploy.sh", import.meta.url).pathname,
          "--image",
          registryImage,
          "--compose-file",
          join(root, "docker-compose.yml"),
          "--secrets-dir",
          join(root, "secrets"),
          "--state-file",
          join(root, "state.env"),
          "--web-health-url",
          "http://127.0.0.1/health",
          "--public-health-url",
          "https://example.test/health",
          ...extraArgs,
        ],
        {
          env: {
            ...Bun.env,
            PATH: `${join(root, "bin")}:${Bun.env.PATH}`,
            FIXTURE_ROOT: root,
            IMAGE_REF: registryImage,
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
      const publicCalls = (await Bun.file(join(root, "public-calls")).exists())
        ? (await Bun.file(join(root, "public-calls")).text()).trim().split("\n").length
        : 0;
      return { stdout, stderr, code, publicCalls };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("a public check that fails while Caddy obtains its certificate is retried until it passes", async () => {
    const { stdout, stderr, code, publicCalls } = await deployWithPublicCurl(`#!/bin/bash
if [[ "$*" = *https://example.test/health* ]]; then
  echo call >> "$FIXTURE_ROOT/public-calls"
  if [[ $(wc -l < "$FIXTURE_ROOT/public-calls") -le 2 ]]; then
    echo "curl: (35) TLS connect error: error:0A000438:SSL routines::tlsv1 alert internal error" >&2
    exit 35
  fi
fi
exit 0
`);
    expect(code, stderr).toBe(0);
    expect(parseRemoteOutputs(stdout).outcome).toBe("healthy");
    expect(publicCalls).toBe(3);
    // Two failed attempts, 3 s apart each.
  }, 20_000);

  test("a public check that never passes still rolls the candidate back once its wait runs out", async () => {
    const { stdout, stderr, code, publicCalls } = await deployWithPublicCurl(
      `#!/bin/bash
if [[ "$*" = *http_code* ]]; then echo 200; exit 0; fi
if [[ "$*" = *https://example.test/health* ]]; then
  echo call >> "$FIXTURE_ROOT/public-calls"
  echo "curl: (35) TLS connect error" >&2
  exit 35
fi
exit 0
`,
      ["--public-health-timeout", "1"],
    );
    expect(code, stderr).toBe(0);
    const outputs = parseRemoteOutputs(stdout);
    expect(outputs.outcome).toBe("rolled_back");
    expect(outputs.reason ?? stdout).toContain("public readiness failed");
    expect(publicCalls).toBeGreaterThan(1);
    // The last attempt's own error is what the log shows.
    expect(stderr).toContain("curl: (35) TLS connect error");
  });
});

test("Caddy and Centrifugo are recreated when their bind-mounted configuration changes", async () => {
  // Compose does not track bind-mount contents; each service reads the hash
  // remote-deploy.sh writes, so a changed file changes the service definition.
  const compose = await Bun.file(
    new URL("../../infra/staging/docker-compose.yml", import.meta.url),
  ).text();
  const service = (name: string) => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = compose.slice(start + 1).search(/\n  [a-z]/);
    return compose.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  expect(service("caddy")).toMatch(
    /^ {6}COFORGE_CADDYFILE_SHA256: \$\{COFORGE_CADDYFILE_SHA256:\?[^}]*\}$/m,
  );
  expect(service("centrifugo")).toMatch(
    /^ {6}COFORGE_CENTRIFUGO_CONFIG_SHA256: \$\{COFORGE_CENTRIFUGO_CONFIG_SHA256:\?[^}]*\}$/m,
  );
});

// Centrifugo's image runs as `centrifugo` (uid 1000). Under the rootless Docker daemon both
// hosts run, a `file:` secret is a bind mount of the deploy user's 600 file, which the
// container sees as root-owned 600, so uid 1000 cannot read it. On 2026-10-12 the first
// production deploy failed exactly so: `cat: can't open '/run/secrets/centrifugo_proxy_secret':
// Permission denied`, an empty-secret checkconfig that still passed, and a Centrifugo that never
// became healthy.
