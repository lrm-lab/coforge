import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createECDH } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const secretsScript = new URL("./deploy-secrets.sh", import.meta.url).pathname;

describe("staging Web Push key validation", () => {
  const keyPair = () => {
    const ecdh = createECDH("prime256v1");
    const publicKey = ecdh.generateKeys().toString("base64url");
    return { publicKey, privateKey: ecdh.getPrivateKey().toString("base64url") };
  };

  test("rejects a mismatched pair before any remote deployment step", async () => {
    const first = keyPair();
    const second = keyPair();
    const validator = Bun.spawn(["bun", "scripts/deploy/validate-web-push-keys.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...Bun.env,
        COFORGE_WEB_PUSH_PUBLIC_KEY: second.publicKey,
        COFORGE_WEB_PUSH_PRIVATE_KEY: first.privateKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await validator.exited).not.toBe(0);

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow.indexOf("Validate Web Push key pair")).toBeLessThan(
      workflow.indexOf("Prepare the SSH identity"),
    );
  });

  test("accepts a matching pair", async () => {
    const pair = keyPair();
    const validator = Bun.spawn(["bun", "scripts/deploy/validate-web-push-keys.ts"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...Bun.env,
        COFORGE_WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        COFORGE_WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await validator.exited).toBe(0);
  });
});

describe("staging user file persistence", () => {
  test("user file bytes are stored in the staging OSS bucket, not a local volume", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    // The block ends at migrate, not centrifugo: migrate sits between them, so a
    // wider slice would also pass if the config were attached to the wrong service.
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    expect(migrateStart).toBeGreaterThan(webStart);
    const webBlock = compose.slice(webStart, migrateStart);

    // Without the OSS adapter selected, the app falls back to a container-local
    // directory, and every deployment silently discards what users uploaded.
    expect(webBlock).toContain("COFORGE_FILE_STORAGE: oss");
    expect(webBlock).toContain("COFORGE_OSS_BUCKET: coforge-files-staging");
    expect(webBlock).toContain("COFORGE_OSS_REGION: cn-beijing");
    expect(webBlock).toContain("ALIBABA_CLOUD_ECS_METADATA: coforge-staging-web");
    expect(webBlock).not.toContain("COFORGE_FILE_STORAGE_DIR");
    expect(webBlock).not.toContain("ACCESS_KEY");
  });

  test("chat images are delivered from the private CDN domain, with the signing key mounted as a secret", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);

    expect(webBlock).toContain("COFORGE_FILE_DELIVERY_URL: https://files-staging.coforge.cn");
    // Profile images ride a second bucket and an unsigned domain. The two settings
    // are asserted together because the Web process refuses to boot with only one of them.
    expect(webBlock).toContain("COFORGE_IMAGE_OSS_BUCKET: coforge-images-staging");
    expect(webBlock).toContain("COFORGE_IMAGE_DELIVERY_URL: https://images-staging.coforge.cn");
    expect(webBlock).toContain(
      "COFORGE_FILE_DELIVERY_KEY_FILE: /run/secrets/coforge_file_delivery_key",
    );
    expect(webBlock).toContain("source: coforge_file_delivery_key");
    // The Web container runs as uid 1000 under a rootless daemon; only an `environment:`
    // sourced secret is written with the declared uid/mode. A `file:` source is unreadable.
    expect(compose).toContain(
      "coforge_file_delivery_key:\n    environment: COFORGE_FILE_DELIVERY_KEY",
    );
    const deploy = await Bun.file(secretsScript).text();
    expect(deploy).toContain(
      'COFORGE_FILE_DELIVERY_KEY="$(cat "$secrets_dir/coforge_file_delivery_key")"',
    );

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("secrets.COFORGE_FILE_DELIVERY_KEY");
    expect(workflow).toContain(" COFORGE_FILE_DELIVERY_KEY ");
    expect(workflow).not.toMatch(/echo "\$COFORGE_FILE_DELIVERY_KEY"/);
  });

  test("staging web receives the cloud cluster token from its secret file", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);
    expect(webBlock).toContain(
      "COFORGE_CLOUD_CLUSTER_TOKEN: ${COFORGE_CLOUD_CLUSTER_TOKEN:?staging cloud cluster token}",
    );
    // Swarm host is intranet-only; staging ECS cannot reach :6090, so desktop
    // opens that address directly until ECS → host is routable.
    expect(webBlock).toContain("COFORGE_CLOUD_DESKTOP_ORIGIN: http://10.110.158.143:6090");

    const functions = await Bun.file(secretsScript).text();
    const directory = await mkdtemp(join(tmpdir(), "coforge-cluster-token-"));
    try {
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
        "centrifugo_token_hmac_secret_key",
      ])
        await writeFile(join(directory, name), "fixture");
      for (const token of ["", "0123456789abcdef0123456789abcdef"]) {
        if (token) await writeFile(join(directory, "coforge_cloud_cluster_token"), token);
        const child = Bun.spawn(
          [
            "bash",
            "-euc",
            `${functions}
            secrets_dir="$1"
            COMPOSE_ARGS=()
            docker() { test "\${COFORGE_CLOUD_CLUSTER_TOKEN-unset}" = "$2"; }
            load_compose_secrets
            compose "$2"
          `,
            "test",
            directory,
            token,
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

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("secrets.COFORGE_CLOUD_CLUSTER_TOKEN");
    expect(workflow).toContain(" COFORGE_CLOUD_CLUSTER_TOKEN");
    expect(workflow).not.toMatch(/echo "\$COFORGE_CLOUD_CLUSTER_TOKEN"/);
  });

  test("staging serves install.sh pointing at the staging feed, not the production one", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);

    // Unset, and /computer/install.sh answers 503 instead of installing anything; set to the
    // production feed, and `curl https://staging.coforge.cn/... | sh` would install the
    // production build on a staging machine. Both are silent from CI's point of view.
    expect(webBlock).toContain("COFORGE_RELEASE_FEED_URL: https://releases-staging.coforge.cn");
  });

  test("the image owns the mount point so the volume is not created root-owned", async () => {
    const dockerfile = await Bun.file(new URL("../../apps/web/Dockerfile", import.meta.url)).text();
    const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

    const mountPoint = runtimeStage.indexOf("mkdir -p /data/attachments");
    const dropPrivileges = runtimeStage.indexOf("USER bun");
    expect(mountPoint).toBeGreaterThanOrEqual(0);
    expect(runtimeStage).toContain("chown -R bun:bun /data");
    expect(mountPoint).toBeLessThan(dropPrivileges);
  });
});

test("authenticates and declares the Computer-directed Daemon channel in Centrifugo", async () => {
  for (const [path, connectEndpoint] of [
    [
      "../../infra/centrifugo/config.yaml",
      "endpoint: http://host.docker.internal:8789/api/internal/centrifugo-connect",
    ],
    [
      "../../infra/staging/centrifugo/config.yaml",
      "endpoint: http://web:3000/api/internal/centrifugo-connect",
    ],
  ]) {
    const config = await Bun.file(new URL(path, import.meta.url)).text();
    const channelConfig = config.slice(config.indexOf("\nchannel:\n"), config.indexOf("\nrpc:\n"));
    const rpcConfig = config.slice(config.indexOf("\nrpc:\n"));
    expect(config).toContain(connectEndpoint);
    expect(channelConfig).toContain("    - name: daemon\n");
    expect(channelConfig).toContain("    - name: agent\n");
    expect(channelConfig).toContain("    - name: chat\n");
    expect(rpcConfig).toContain("    - name: daemon\n");
  }
});

describe("staging environment configuration", () => {
  test("non-secret deploy targets are variables, not write-only secrets", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();

    // A secret cannot be read back, so a hostname stored as one is invisible when it is
    // wrong and has to be re-entered to change. Only values that must stay unreadable
    // belong in secrets.
    expect(workflow).toContain("${{ vars.DEPLOY_SSH_HOST }}");
    expect(workflow).toContain("${{ vars.DEPLOY_SSH_USER }}");
    expect(workflow).not.toContain("secrets.DEPLOY_SSH_HOST }}");
    expect(workflow).not.toContain("secrets.DEPLOY_SSH_USER }}");

    // The private key, the host fingerprint and the OTLP endpoint stay secrets: the first
    // two are credentials, and the endpoint embeds an access token.
    expect(workflow).toContain("${{ secrets.DEPLOY_SSH_KEY }}");
    expect(workflow).toContain("${{ secrets.DEPLOY_SSH_HOST_KEY }}");
    expect(workflow).toContain("${{ secrets.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }}");
  });
});

test("GitHub workflows pin external actions to full commit SHAs", async () => {
  for (const path of [
    "../../.github/workflows/ci.yml",
    "../../.github/workflows/deploy-staging.yml",
    "../../.github/workflows/release-staging.yml",
    "../../.github/workflows/release-installer-staging.yml",
  ]) {
    const workflow = await Bun.file(new URL(path, import.meta.url)).text();
    const references = workflow
      .split("\n")
      .map((line) => line.match(/^\s*-?\s*uses:\s*([^#\s]+)/)?.[1])
      .filter((reference) => reference && !reference.startsWith("./"));

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  }
});

describe("GitHub validation workflow contract", () => {
  test("manual publication refuses refs other than main before running gates", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/release-staging.yml", import.meta.url),
    ).text();
    const gates = workflow.match(/^  gates:\n[\s\S]*?(?=^  [\w-]+:\n)/m)?.[0];
    expect(gates).toContain("if: github.ref == 'refs/heads/main'");
  });

  test("staging deployment and manual release use the shared CI gates", async () => {
    for (const path of [
      "../../.github/workflows/deploy-staging.yml",
      "../../.github/workflows/release-staging.yml",
    ]) {
      const workflow = await Bun.file(new URL(path, import.meta.url)).text();
      const gates = workflow.match(/^  gates:\n[\s\S]*?(?=^  [\w-]+:\n)/m)?.[0];

      expect(gates).toBeDefined();
      expect(gates).toContain("uses: ./.github/workflows/ci.yml");
      expect(gates).not.toContain("runs-on:");
      expect(gates).not.toContain("mise run");
    }
  });

  test("CI covers SDK, Agent, and CLI tests, checks, and buildable libraries", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
    ).text();

    // The selector's behavioral tests cover which packages are selected, and
    // scripts/ci/validate-each.test.ts that each one runs its package-owned test, check, and build.
    expect(workflow).toContain("SELECTED: ${{ needs.changes.outputs.libraries }}");
    expect(workflow).toContain('bash scripts/ci/validate-each.sh libraries "$SELECTED"');
    expect(workflow).toContain("bun run --cwd packages/coforge-sdk generate");
  });
});

// The evidence that the host keeps the toolchain layer is a second consecutive deploy's pull time
// and inbound bytes; this pins the layout that makes it possible.
describe("Web image layer reuse", () => {
  test("the final stage adds the toolchain, then the schema, then the build output", async () => {
    const dockerfile = await Bun.file(new URL("../../apps/web/Dockerfile", import.meta.url)).text();
    const finalFrom = dockerfile.lastIndexOf("FROM ");
    const migrateFrom = dockerfile.indexOf(" AS migrate");
    expect(migrateFrom).toBeGreaterThanOrEqual(0);
    expect(finalFrom).toBeGreaterThan(migrateFrom);

    // The schema and migrations change often; in the toolchain's layer they would renew it.
    expect(dockerfile.slice(migrateFrom, finalFrom)).not.toContain("apps/web/prisma");
    const finalStage = dockerfile.slice(finalFrom);
    const positions = [
      "COPY --from=migrate ",
      "COPY --chown=bun:bun apps/web/prisma ",
      "COPY --chown=bun:bun apps/web/prisma.config.ts ",
      "COPY --from=build ",
    ].map((line) => finalStage.indexOf(line));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // No layer with contents comes before the toolchain.
    expect(finalStage.slice(0, positions[0])).not.toMatch(/^(ADD|COPY|RUN) /m);
  });
});
