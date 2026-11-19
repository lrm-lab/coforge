import { expect, test } from "bun:test";
import { encodeArtifactShortId } from "#src/features/artifacts/artifact-short-id";
import {
  artifactReadContext,
  artifactWebUrl,
} from "#src/server/artifacts/agent-artifact-context.server";
import { resolveArtifactReference } from "#src/server/artifacts/artifact-reference.server";

const ARTIFACT_ID = "0f8c3b52-6d0e-4f3a-9a51-3c1d2e4f5a6b";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";

function fakeDb(options?: {
  slug?: string | null;
  channelName?: string | null;
  directKey?: string | null;
  users?: { id: string; displayName: string }[];
}) {
  return {
    workspace: {
      findUnique: async () => (options?.slug === null ? null : { slug: options?.slug ?? "acme" }),
    },
    conversation: {
      findFirst: async () => ({
        channelName: options?.channelName ?? "launch",
        directKey: options?.directKey ?? null,
      }),
    },
    agent: { findMany: async () => [] },
    user: { findMany: async () => options?.users ?? [] },
  } as never;
}

test("artifactWebUrl builds canonical short-ID URL using workspace slug and app origin", async () => {
  const shortId = encodeArtifactShortId(ARTIFACT_ID);
  const url = await artifactWebUrl(
    fakeDb(),
    WORKSPACE_ID,
    ARTIFACT_ID,
    () => "https://coforge.app",
  );
  expect(url).toBe(`https://coforge.app/w/acme/artifacts/${shortId}`);
});

test("resolveArtifactReference accepts Base58 short IDs and short URLs", async () => {
  const shortId = encodeArtifactShortId(ARTIFACT_ID);
  const none = async () => [];
  expect(await resolveArtifactReference(shortId, none)).toEqual({ artifactId: ARTIFACT_ID });
  expect(
    await resolveArtifactReference(`https://coforge.app/w/acme/artifacts/${shortId}?v=2`, none),
  ).toEqual({ artifactId: ARTIFACT_ID, version: 2 });
  expect(await resolveArtifactReference(`/artifacts/${shortId}`, none)).toEqual({
    artifactId: ARTIFACT_ID,
  });
  expect(await resolveArtifactReference(`/a/${shortId}`, none)).toEqual({
    artifactId: ARTIFACT_ID,
  });
});

test("artifactReadContext returns URL, channel home, origin target, and live viewers", async () => {
  const shortId = encodeArtifactShortId(ARTIFACT_ID);
  const context = await artifactReadContext(
    fakeDb({
      users: [
        { id: "u1", displayName: "Alice" },
        { id: "u2", displayName: "Bob" },
      ],
    }),
    {
      workspaceId: WORKSPACE_ID,
      artifact: {
        id: ARTIFACT_ID,
        access: "conversation",
        homeKey: `conversation:${CONV_ID}`,
        homeKind: "channel",
        origin: { messageId: "m-1", conversationId: CONV_ID, homeKind: "channel" },
      },
      appOrigin: () => "https://coforge.app",
      presence: async () => [{ user: "u1" }, { user: "u1" }, { user: "u2" }],
    },
  );
  expect(context).toEqual({
    url: `https://coforge.app/w/acme/artifacts/${shortId}`,
    home: "#launch",
    origin: { messageId: "m-1", target: "#launch" },
    viewing: ["Alice", "Bob"],
  });
});

test("artifactReadContext formats workspace/link homes and fails open when presence errors", async () => {
  const context = await artifactReadContext(fakeDb(), {
    workspaceId: WORKSPACE_ID,
    artifact: {
      id: ARTIFACT_ID,
      access: "link",
      homeKey: "workspace",
      homeKind: "workspace",
      origin: { hidden: true },
    },
    appOrigin: () => "https://coforge.app",
    presence: async () => {
      throw new Error("centrifugo down");
    },
  });
  expect(context).toEqual({
    url: `https://coforge.app/w/acme/artifacts/${encodeArtifactShortId(ARTIFACT_ID)}`,
    home: "Workspace (anyone with the link)",
    origin: null,
    viewing: [],
  });
});
