import { describe, expect, test } from "bun:test";

describe("production cloud computer deploy wiring", () => {
  test("production web can receive the cloud cluster token from its secret file", async () => {
    const compose = await Bun.file(
      new URL("../../infra/production/docker-compose.yml", import.meta.url),
    ).text();
    const webStart = compose.indexOf("\n  web:\n");
    const migrateStart = compose.indexOf("\n  migrate:\n");
    const webBlock = compose.slice(webStart, migrateStart);
    expect(webBlock).toContain("COFORGE_CLOUD_CLUSTER_TOKEN: ${COFORGE_CLOUD_CLUSTER_TOKEN:-}");
    expect(webBlock).toContain("COFORGE_CLOUD_DESKTOP_ORIGIN: http://10.110.158.147:6090");
    expect(webBlock).toContain(
      "COFORGE_CLOUD_SERVICE_PASSWORD: ${COFORGE_CLOUD_SERVICE_PASSWORD:-}",
    );

    const caddy = await Bun.file(
      new URL("../../infra/production/caddy/Caddyfile", import.meta.url),
    ).text();
    expect(caddy).toContain("@desktop path /desktop /desktop/*");
    expect(caddy).toContain("{$COFORGE_DESKTOP_UPSTREAM}");

    const productionComposeHead = compose.slice(0, compose.indexOf("\n  web:\n"));
    expect(productionComposeHead).toContain("COFORGE_DESKTOP_UPSTREAM: 10.110.158.147:6090");

    const workflow = await Bun.file(
      new URL("../../.github/workflows/deploy-production.yml", import.meta.url),
    ).text();
    expect(workflow).toContain("Sync cloud-computer secrets");
    expect(workflow).toContain("secrets.COFORGE_CLOUD_CLUSTER_TOKEN");
    expect(workflow).toContain("secrets.COFORGE_CLOUD_SERVICE_PASSWORD");
    expect(workflow).toContain("coforge_cloud_cluster_token");
    expect(workflow).not.toMatch(/echo "\$COFORGE_CLOUD_CLUSTER_TOKEN"/);
  });
});
