import { expect, test } from "bun:test";

/**
 * The scheduled Web integration run (`.github/workflows/web-integration.yml`) tests against the
 * images staging deploys, by digest. A service container cannot share staging's Compose file, so the
 * three references are written twice; this keeps them from drifting apart, in either direction. The
 * same goes for Centrifugo's channel namespaces, which the workflow sets through the environment
 * instead of the staging config file.
 */
const SERVICES = ["postgres", "redis", "centrifugo"] as const;

type Compose = { services: Record<string, { image?: string }> };
type Namespace = { name: string } & Record<string, unknown>;
type Workflow = {
  jobs: {
    integration: {
      services: Record<string, { image: string; env?: Record<string, string> }>;
    };
  };
};

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

/** A namespace as the Web's own calls see it: the proxies call a running Web, which a service
 * container has not got, so every proxy setting is left out. */
const withoutProxy = ({ name, ...settings }: Namespace) => [
  name,
  Object.fromEntries(Object.entries(settings).filter(([key]) => !/proxy/.test(key))),
];

test("the Web integration Centrifugo has the channel namespaces staging configures", async () => {
  const config = Bun.YAML.parse(await Bun.file("infra/staging/centrifugo/config.yaml").text()) as {
    channel: { namespaces: Namespace[] };
  };
  const env = workflow.jobs.integration.services.centrifugo?.env?.CENTRIFUGO_CHANNEL_NAMESPACES;
  const scheduled = JSON.parse(env ?? "[]") as Namespace[];
  // Non-vacuity: both sides name namespaces.
  expect(config.channel.namespaces.length).toBeGreaterThan(3);
  expect(Object.fromEntries(scheduled.map(withoutProxy))).toEqual(
    Object.fromEntries(config.channel.namespaces.map(withoutProxy)),
  );
});

test("the browser e2e run uses the images staging runs, by digest", async () => {
  const e2e = Bun.YAML.parse(await Bun.file(".github/workflows/web-e2e.yml").text()) as {
    jobs: { e2e: { services: Record<string, { image: string }>; env: Record<string, string> } };
  };
  // PostgreSQL and Redis are service containers; Centrifugo is started by the runner from the
  // job's CENTRIFUGO_IMAGE, because its proxies need host networking.
  const images: Record<(typeof SERVICES)[number], string | undefined> = {
    postgres: e2e.jobs.e2e.services.postgres?.image,
    redis: e2e.jobs.e2e.services.redis?.image,
    centrifugo: e2e.jobs.e2e.env.CENTRIFUGO_IMAGE,
  };
  for (const service of SERVICES) {
    const staging = compose.services[service]?.image;
    expect(staging, `staging ${service}`).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(images[service], `web-e2e ${service}`).toBe(staging);
  }
});
