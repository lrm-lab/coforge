import { expect, test } from "bun:test";
import { decodeArtifactVersionPublishedEvent } from "#src/features/artifacts/artifact-realtime";

const event = {
  type: "artifact.version.published.v1",
  workspaceId: "w1",
  artifactId: "a1",
  number: 3,
  publisher: { agentId: "agent-1" },
};

test("a page reads a version announcement, and nothing else as one", () => {
  expect(decodeArtifactVersionPublishedEvent(event)).toEqual(event);
  // As raw bytes, the way a publication can arrive.
  expect(
    decodeArtifactVersionPublishedEvent(new TextEncoder().encode(JSON.stringify(event))),
  ).toEqual(event);
  expect(
    decodeArtifactVersionPublishedEvent({ ...event, type: "task.changed.v1" }),
  ).toBeUndefined();
  expect(decodeArtifactVersionPublishedEvent({ ...event, number: 0 })).toBeUndefined();
  expect(decodeArtifactVersionPublishedEvent({ ...event, publisher: {} })).toBeUndefined();
});
