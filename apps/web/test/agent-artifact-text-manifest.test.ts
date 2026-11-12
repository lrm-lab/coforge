import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { runAgentArtifactOperation } from "#src/server/artifacts/agent-artifacts.server";

/** One version is either a `text` or a manifest of files; both together are refused before
 * anything is read or written, so these checks need no database. */

const services = {
  db: undefined,
  artifacts: undefined,
  documents: undefined,
  enabled: async () => true,
} as unknown as Parameters<typeof runAgentArtifactOperation>[0];
const principal = { workspaceId: "w", agentId: "a" };
const KEY = crypto.randomUUID();
const ARTIFACT = crypto.randomUUID();
const HASH = "a".repeat(64);

const manifests = {
  files: { files: [{ path: "a.md", sha256: HASH }] },
  delete: { delete: ["a.md"] },
  entry: { entry: "a.md" },
};

for (const [name, manifest] of Object.entries(manifests))
  for (const operation of ["create", "push"] as const)
    test(`${operation} refuses text together with ${name}`, async () => {
      const request =
        operation === "create"
          ? { operation, title: "T", text: "# x", ...manifest }
          : {
              operation,
              artifact: ARTIFACT,
              baseVersion: 1,
              idempotencyKey: KEY,
              text: "# x",
              ...manifest,
            };
      const error = await runAgentArtifactOperation(services, principal, request as never).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("INVALID_INPUT");
    });
