import { expect, test } from "bun:test";
import { ArtifactAbuseReporter } from "#src/server/artifacts/artifact-public-abuse.server";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";

test("ArtifactAbuseReporter records valid reports for link-shared artifacts", async () => {
  const logged: unknown[] = [];
  const reporter = new ArtifactAbuseReporter({
    perClient: { admit: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    lookup: async () => ({
      shared: true,
      page: {
        workspaceId: "ws-1",
        artifactId: ARTIFACT_ID,
        title: "Public Report",
        kind: "html",
        entryPath: "index.html",
        sha256: "a".repeat(64),
        sizeBytes: 100,
        access: "link",
        workspaceSlug: "acme",
        version: 1,
      },
    }),
    onReport: (entry) => logged.push(entry),
  });

  await reporter.submit({
    artifactId: ARTIFACT_ID,
    reason: "phishing",
    details: "  suspicious login form  ",
    client: "203.0.113.1",
  });

  expect(logged).toEqual([
    {
      event: "artifacts:abuse_report",
      artifactId: ARTIFACT_ID,
      workspaceId: "ws-1",
      reason: "phishing",
      details: "suspicious login form",
    },
  ]);
});

test("ArtifactAbuseReporter rejects unshared artifacts and rate-limited clients", async () => {
  const unshared = new ArtifactAbuseReporter({
    perClient: { admit: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    lookup: async () => ({ shared: false, page: null }),
    onReport: () => {},
  });
  await expect(
    unshared.submit({ artifactId: ARTIFACT_ID, reason: "spam", client: "203.0.113.2" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const limited = new ArtifactAbuseReporter({
    perClient: { admit: async () => ({ allowed: false, retryAfterSeconds: 30 }) },
    lookup: async () => ({ shared: true, page: null }),
    onReport: () => {},
  });
  await expect(
    limited.submit({ artifactId: ARTIFACT_ID, reason: "spam", client: "203.0.113.2" }),
  ).rejects.toMatchObject({ code: "RATE_LIMITED" });
});
