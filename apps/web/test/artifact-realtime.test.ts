import { expect, test } from "bun:test";
import { decodeArtifactVersionPublishedEvent } from "#src/features/artifacts/artifact-realtime";

const event = {
  type: "artifact.version.published.v1",
  workspaceId: "w1",
  artifactId: "a1",
  number: 3,
} as const;

test("a page reads a version announcement, and nothing else as one", () => {
  expect(decodeArtifactVersionPublishedEvent(event)).toEqual(event);
  expect(
    decodeArtifactVersionPublishedEvent(new TextEncoder().encode(JSON.stringify(event))),
  ).toEqual(event);
  expect(
    decodeArtifactVersionPublishedEvent({ ...event, type: "task.changed.v1" }),
  ).toBeUndefined();
  expect(decodeArtifactVersionPublishedEvent({ ...event, number: 0 })).toBeUndefined();
  expect(
    decodeArtifactVersionPublishedEvent({ ...event, publisher: { agentId: "agent-1" } }),
  ).toEqual(event);
});
