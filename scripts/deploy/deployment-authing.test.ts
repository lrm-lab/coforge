import { describe, expect, test } from "bun:test";

const authingRuntimeSecretKeys = [
  "AUTHING_APP_ID",
  "AUTHING_APP_SECRET",
  "COFORGE_SESSION_SECRET",
] as const;

describe("staging Authing runtime injection", () => {
  test("compose mounts Authing values only into web and fixes the trusted endpoints", async () => {
    const compose = await Bun.file(
      new URL("../../infra/staging/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const centrifugoStart = compose.indexOf("\n  centrifugo:\n");
    expect(webStart).toBeGreaterThanOrEqual(0);
    expect(centrifugoStart).toBeGreaterThan(webStart);
    const webBlock = compose.slice(webStart, centrifugoStart);
    for (const key of authingRuntimeSecretKeys) {
      expect(webBlock).toContain(`${key}_FILE: /run/secrets/${key.toLowerCase()}`);
      expect(webBlock).not.toContain(`${key}: \${`);
    }
    expect(webBlock).toContain("AUTHING_ISSUER: https://coforge-staging.authing.cn/oidc");
    expect(webBlock).toContain("source: authing_app_id");
    expect(webBlock).toContain("source: authing_app_secret");
    expect(webBlock).toContain("source: coforge_session_secret");
    expect(webBlock).toContain(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_FILE: /run/secrets/otel_traces_endpoint",
    );
    expect(webBlock).toContain("source: otel_traces_endpoint");

    const migrationStart = compose.indexOf("\n  migrate:\n");
    expect(migrationStart).toBeGreaterThan(webStart);
    const migrationBlock = compose.slice(migrationStart, centrifugoStart);
    expect(migrationBlock).not.toContain("AUTHING_");
    expect(migrationBlock).not.toContain("COFORGE_SESSION_SECRET");
  });

  test("deploy workflow copies Authing GitHub Environment values into the secrets directory", async () => {
    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("vars.AUTHING_APP_ID");
    expect(workflow).toContain("secrets.AUTHING_APP_SECRET");
    expect(workflow).toContain("secrets.COFORGE_SESSION_SECRET");
    expect(workflow).toContain("secrets.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
    expect(workflow).toContain("secrets.COFORGE_AUTHING_WEBHOOK_SECRET");
    expect(workflow).toContain("otel_traces_endpoint");
    expect(workflow).not.toContain("OSS_ACCESS_KEY");
    expect(workflow).toContain("infra/staging/secrets");
    expect(workflow).toContain('trap \'rm -rf -- "$tar_dir" "$payload"\' EXIT');
    expect(workflow).toContain(String.raw`chmod 700 \"\$secrets_dir\"`);
    expect(workflow).not.toMatch(/echo "\$AUTHING_APP_SECRET"/);
    expect(workflow).not.toMatch(/echo "\$COFORGE_SESSION_SECRET"/);
  });
});
