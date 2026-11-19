import { expect, test } from "bun:test";
import {
  runAgentArtifactOperation,
  type AgentArtifactServices,
} from "#src/server/artifacts/agent-artifacts.server";
import { handleAgentArtifactDownload } from "#src/server/artifacts/agent-artifact-files.server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";

test("Workspace assistant delegates list and title-resolved read to owner readActor", async () => {
  const seenActors: unknown[] = [];
  const services: AgentArtifactServices = {
    db: {
      artifactReadPosition: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
      artifactCommentPosition: { findUnique: async () => null },
      artifactComment: { findMany: async () => [] },
      artifactVersion: { findMany: async () => [] },
      workspace: { findUnique: async () => ({ slug: "acme" }) },
    } as never,
    documents: {
      list: async (scope: { actor: unknown }) => {
        seenActors.push(scope.actor);
        return [];
      },
      listPage: async (scope: { actor: unknown }) => {
        seenActors.push(scope.actor);
        return {
          artifacts: [
            {
              id: ARTIFACT_ID,
              title: "Owner Plan",
              description: "",
              entryPath: "plan.md",
              currentVersion: 1,
              updatedAt: new Date("2026-11-19T00:00:00Z"),
            },
          ],
        };
      },
      load: async (scope: { actor: unknown }) => {
        seenActors.push(scope.actor);
        return {
          artifact: {
            id: ARTIFACT_ID,
            workspaceId: WORKSPACE_ID,
            homeKey: "workspace",
            access: "workspace",
            title: "Owner Plan",
            description: "",
            entryPath: "plan.md",
            currentVersion: 1,
            originMessageId: null,
          },
          version: {
            number: 1,
            entryPath: "plan.md",
            note: "",
            label: null,
            createdAt: new Date("2026-11-19T00:00:00Z"),
            files: [{ path: "plan.md", sizeBytes: 5 }],
          },
          body: "hello",
        } as never;
      },
    } as never,
    blobs: {} as never,
    enabled: async () => true,
    readActor: { userId: OWNER_USER_ID },
  };

  await runAgentArtifactOperation(
    services,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    { operation: "list" },
  );
  await runAgentArtifactOperation(
    services,
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    { operation: "read", artifact: "Owner Plan" },
  );

  expect(seenActors).toEqual([
    { userId: OWNER_USER_ID },
    { userId: OWNER_USER_ID },
    { userId: OWNER_USER_ID },
  ]);
});

test("handleAgentArtifactDownload delegates file read visibility to readActor", async () => {
  const seenReaders: unknown[] = [];
  const response = await handleAgentArtifactDownload(
    new Request("https://coforge.example/api/agent/v1/artifacts/x/files/plan.md"),
    { artifact: ARTIFACT_ID, path: "plan.md" },
    { workspaceId: WORKSPACE_ID, agentId: AGENT_ID },
    {
      artifacts: {
        reads: {
          listPage: async () => ({ artifacts: [] }),
          file: async (input: { reader: unknown }) => {
            seenReaders.push(input.reader);
            return {
              path: "plan.md",
              sha256: "a".repeat(64),
              sizeBytes: 5,
            };
          },
        },
      } as never,
      blobs: {
        upload: async () => ({ sha256: "a".repeat(64), sizeBytes: 0, kind: "text/plain" }),
        open: async () => ({
          body: new Blob(["hello"]),
          contentType: "text/markdown",
          sizeBytes: 5,
        }),
      },
      enabled: async () => true,
      readActor: { userId: OWNER_USER_ID },
    },
  );
  expect(response.status).toBe(200);
  expect(seenReaders).toEqual([{ userId: OWNER_USER_ID }]);
});
