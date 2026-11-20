import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { parseRemoteOutputs } from "./deployment";
import { ipShim, registryImage, requiredSecretNames, timeoutShim } from "./deploy-test-support";

describe("Centrifugo configuration guard and release snapshot", () => {
  test("a Centrifugo configuration the pinned image rejects stops the deployment before anything is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-centrifugo-reject-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await mkdir(join(root, "caddy"));
      await Bun.write(join(root, "caddy/Caddyfile"), "staging.example.test {\n}\n");
      await mkdir(join(root, "last-healthy/centrifugo"), { recursive: true });
      const healthyConfig = "client: {}\n# last healthy\n";
      await Bun.write(join(root, "last-healthy/centrifugo/config.yaml"), healthyConfig);
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  if [[ "$1" = run && "$*" == *checkconfig* ]]; then
    exit 1
  fi
fi
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
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const outputs = parseRemoteOutputs(stdout);
      expect(outputs.outcome).toBe("failed");
      expect(outputs.healthResult).toBe("failed: Centrifugo configuration validation failed");
      expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
      expect(await Bun.file(join(root, "centrifugo/config.yaml")).text()).toBe(healthyConfig);
      expect(await Bun.file(join(root, ".env")).text()).toContain(
        `COFORGE_CENTRIFUGO_CONFIG_SHA256=${createHash("sha256").update(healthyConfig).digest("hex")}`,
      );
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls).not.toMatch(/ up -d/);
      expect(calls).toContain("pull --quiet centrifugo");
      expect(calls).not.toContain(`pull --quiet ${registryImage}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Centrifugo image the host cannot pull is reported as a pull failure, not a configuration failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-centrifugo-pull-"));
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
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  if [[ "$1" = pull && "$*" == *centrifugo* ]]; then
    exit 1
  fi
fi
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
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const outputs = parseRemoteOutputs(stdout);
      expect(outputs.outcome).toBe("failed");
      expect(outputs.healthResult).toBe("failed: Centrifugo image pull failed");
      expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls).not.toContain("checkconfig");
      expect(calls).not.toMatch(/ up -d/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a Caddyfile the pinned image rejects stops the deployment before anything is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-caddy-reject-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n");
      await mkdir(join(root, "caddy"));
      await Bun.write(
        join(root, "caddy/Caddyfile"),
        "staging.example.test {\n\tnot_a_directive\n}\n",
      );
      await mkdir(join(root, "last-healthy/caddy"), { recursive: true });
      const healthyCaddyfile = "staging.example.test {\n}\n# last healthy\n";
      await Bun.write(join(root, "last-healthy/caddy/Caddyfile"), healthyCaddyfile);
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  if [[ "$1" = run && "$*" == *"caddy validate"* ]]; then
    exit 1
  fi
fi
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
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      const outputs = parseRemoteOutputs(stdout);
      expect(outputs.outcome).toBe("failed");
      expect(outputs.healthResult).toBe("failed: Caddy configuration validation failed");
      expect(await Bun.file(join(root, "state.env")).text()).toBe(state);
      // The rejected file must not stay live: a later Caddy restart (host
      // reboot, daemon restart) would load it and take the site down.
      expect(await Bun.file(join(root, "caddy/Caddyfile")).text()).toBe(healthyCaddyfile);
      const env = await Bun.file(join(root, ".env")).text();
      expect(env).toContain(`COFORGE_WEB_IMAGE=${previous}\n`);
      expect(env).toContain(
        `COFORGE_CADDYFILE_SHA256=${createHash("sha256").update(healthyCaddyfile).digest("hex")}`,
      );
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls).not.toMatch(/ up -d/);
      expect(calls).toContain("run --rm --no-deps caddy caddy validate");
      expect(calls).not.toContain(`pull --quiet ${registryImage}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([false, true])("rollback restores only an isolated checker", async (isolated) => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-rollback-snapshot-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      await mkdir(join(root, "last-healthy/centrifugo"), { recursive: true });
      const marker = "client: {}\n# last healthy\n";
      await Bun.write(join(root, "last-healthy/centrifugo/config.yaml"), marker);
      await Bun.write(join(root, "centrifugo/config.yaml"), "client: {}\n# stale candidate\n");
      await mkdir(join(root, "caddy"));
      await mkdir(join(root, "last-healthy/caddy"), { recursive: true });
      const caddyMarker = "staging.example.test {\n}\n# last healthy\n";
      await Bun.write(join(root, "last-healthy/caddy/Caddyfile"), caddyMarker);
      await Bun.write(
        join(root, "caddy/Caddyfile"),
        "staging.example.test {\n}\n# stale candidate\n",
      );
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = `coforge/web@sha256:${"c".repeat(64)}`;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      const checker = `coforge/checker@sha256:${"d".repeat(64)}`;
      await Bun.write(join(root, "checker-state.env"), `CURRENT_CHECKER_IMAGE=${checker}\n`);
      await Bun.write(join(root, "last-healthy/artifact-checker.compose.yml"), "services: {}\n");
      if (isolated)
        await Bun.write(join(root, "last-healthy/artifact-checker-seccomp.json"), "{}\n");
      await Bun.write(join(root, "state.env"), state);
      await writeFile(join(root, "bin/timeout"), timeoutShim(), { mode: 0o700 });
      await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
if [[ "$1" = compose ]]; then
  shift 5
  while [[ "$1" = -f ]]; do shift 2; done
  case "$1" in
    up)
      if [[ ! -f "$FIXTURE_ROOT/up-failed-once" ]]; then
        touch "$FIXTURE_ROOT/up-failed-once"
        exit 1
      fi
      ;;
    ps) echo "container-$3" ;;
  esac
  exit 0
elif [[ "$1" = ps || "$1" = logs ]]; then
  exit 0
elif [[ "$1" = inspect ]]; then
  if [[ "$*" = *RestartCount* ]]; then
    echo 'running 0 1 unhealthy'
  else
    echo healthy
  fi
fi
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(root, "bin/curl"),
        `#!/bin/bash
if [[ "$*" = *http_code* ]]; then echo 500; fi
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
        ],
        {
          env: { ...Bun.env, PATH: `${join(root, "bin")}:${Bun.env.PATH}`, FIXTURE_ROOT: root },
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
      expect(parseRemoteOutputs(stdout).outcome).toBe("rolled_back");
      expect(await Bun.file(join(root, "centrifugo/config.yaml")).text()).toBe(marker);
      const markerSha256 = createHash("sha256").update(marker).digest("hex");
      const env = await Bun.file(join(root, ".env")).text();
      expect(env).toContain(`COFORGE_CENTRIFUGO_CONFIG_SHA256=${markerSha256}`);
      expect(await Bun.file(join(root, "caddy/Caddyfile")).text()).toBe(caddyMarker);
      const caddyMarkerSha256 = createHash("sha256").update(caddyMarker).digest("hex");
      expect(env).toContain(`COFORGE_CADDYFILE_SHA256=${caddyMarkerSha256}`);
      expect(stderr).toContain("restored the last healthy release configuration");
      const calls = await Bun.file(join(root, "calls")).text();
      // Count the command, not a flag order: the snapshot rollback passes
      // --remove-orphans and a filter on "up -d --wait" would miss it.
      const upCalls = calls.split("\n").filter((line) => / up -d/.test(line));
      expect(upCalls).toHaveLength(2);
      expect(upCalls[0]).not.toContain("artifact-checker.compose.yml");
      expect(upCalls[1]?.trim().endsWith(" web")).toBe(false);
      if (isolated) {
        expect(upCalls[1]).toContain("artifact-checker.compose.yml");
        expect(env).toContain(`COFORGE_ARTIFACT_CHECKER_IMAGE=${checker}`);
        expect(env).toContain(
          "COFORGE_ARTIFACT_CHECK_WORKER_SOCKET=/run/artifact-checker/checker.sock",
        );
      } else {
        expect(upCalls[1]).not.toContain("artifact-checker.compose.yml");
        expect(env).not.toContain("COFORGE_ARTIFACT_CHECK_WORKER_SOCKET");
      }
      expect(await Bun.file(join(root, "checker-state.env")).text()).toContain(
        `CURRENT_CHECKER_IMAGE=${isolated ? checker : ""}\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a healthy deployment records the shipped configuration as the last healthy release", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-deploy-healthy-snapshot-"));
    try {
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "secrets"));
      await mkdir(join(root, "centrifugo"));
      const shipped = "client: {}\n# shipped candidate\n";
      await Bun.write(join(root, "centrifugo/config.yaml"), shipped);
      await mkdir(join(root, "caddy"));
      await Bun.write(join(root, "caddy/Caddyfile"), "staging.example.test {\n}\n");
      await Bun.write(join(root, "docker-compose.yml"), "services: {}\n");
      for (const name of requiredSecretNames) {
        await Bun.write(join(root, "secrets", name), "fixture-private-value");
      }
      const previous = registryImage;
      const state = `CURRENT_WEB_IMAGE=${previous}\nPREVIOUS_WEB_IMAGE=\n`;
      await Bun.write(join(root, "state.env"), state);
      const checker = `coforge/checker@sha256:${"d".repeat(64)}`;
      await Bun.write(join(root, "checker-state.env"), `CURRENT_CHECKER_IMAGE=${checker}\n`);
      await writeFile(join(root, "bin/timeout"), timeoutShim({ record: false }), { mode: 0o700 });
      await writeFile(join(root, "bin/ip"), ipShim(), { mode: 0o700 });
      await writeFile(
        join(root, "bin/docker"),
        `#!/bin/bash
echo "$*" >> "$FIXTURE_ROOT/calls"
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
  exit 0
elif [[ "$1" = image ]]; then
  exit 0
elif [[ "$1" = ps && "$*" = *com.docker.compose.project=* && "$*" = *com.docker.compose.service=* ]]; then
  service="$(cut -d= -f3 <<< "$6")"
  [[ ! -f "$FIXTURE_ROOT/removed-$service" ]] && echo "$service"
elif [[ "$1" = rm && "$2" = -f ]]; then
  cp "$FIXTURE_ROOT/checker-state.env" "$FIXTURE_ROOT/state-at-removal"
  touch "$FIXTURE_ROOT/removed-$3"
fi
exit 0
`,
        { mode: 0o700 },
      );
      await writeFile(join(root, "bin/curl"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
      const deploy = () =>
        Bun.spawn(
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
      const proc = deploy();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(parseRemoteOutputs(stdout).outcome).toBe("healthy");
      expect(await Bun.file(join(root, "removed-artifact-checker")).exists()).toBe(true);
      expect(await Bun.file(join(root, "removed-artifact-checker-proxy")).exists()).toBe(true);
      expect(await Bun.file(join(root, "state-at-removal")).text()).toContain(
        `CURRENT_CHECKER_IMAGE=${checker}\n`,
      );
      expect(await Bun.file(join(root, "checker-state.env")).text()).toContain(
        "CURRENT_CHECKER_IMAGE=\n",
      );
      expect(await Bun.file(join(root, ".env")).text()).not.toContain(
        "COFORGE_ARTIFACT_CHECK_WORKER_SOCKET",
      );
      expect(await Bun.file(join(root, "last-healthy/centrifugo/config.yaml")).text()).toBe(
        shipped,
      );
      const repeat = deploy();
      const [repeatedOutput, repeatedCode] = await Promise.all([
        new Response(repeat.stdout).text(),
        repeat.exited,
      ]);
      expect(repeatedCode).toBe(0);
      expect(parseRemoteOutputs(repeatedOutput).outcome).toBe("healthy");
      const calls = await Bun.file(join(root, "calls")).text();
      expect(calls.split("\n").filter((line) => / up -d/.test(line))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
