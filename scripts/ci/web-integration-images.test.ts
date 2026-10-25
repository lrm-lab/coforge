import { expect, test } from "bun:test";

/**
 * The scheduled Web integration run (`.github/workflows/web-integration.yml`) tests against the
 * images staging deploys, by digest. A service container cannot share staging's Compose file, so the
 * three references are written twice; this keeps them from drifting apart, in either direction.
 */
const SERVICES = ["postgres", "redis", "centrifugo"] as const;

type Compose = { services: Record<string, { image?: string }> };
type Workflow = { jobs: { integration: { services: Record<string, { image: string }> } } };

const compose = Bun.YAML.parse(
  await Bun.file("infra/staging/docker-compose.yml").text(),
) as Compose;
const workflow = Bun.YAML.parse(
  await Bun.file(".github/workflows/web-integration.yml").text(),
) as Workflow;

test("the Web integration services run the images staging runs, by digest", () => {
  for (const service of SERVICES) {
    const staging = compose.services[service]?.image;
    const scheduled = workflow.jobs.integration.services[service]?.image;
    // Non-vacuity: both sides name an image, and it is pinned by digest.
    expect(staging, `staging ${service}`).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(scheduled, `web-integration ${service}`).toBe(staging);
  }
});
