import type { ArtifactVersionPublishedEvent } from "#src/features/artifacts/artifact-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { ArtifactActor } from "./artifact-access.server";

/** Where an artifact's events go: one realtime channel at a time. */
export type ArtifactSignals = {
  publish(channel: string, event: ArtifactVersionPublishedEvent): Promise<void>;
};

/** The signals over Centrifugo; the API is built only when one is sent. */
export function centrifugoArtifactSignals(
  centrifugo: () => Pick<CentrifugoServerApi, "publishJson">,
): ArtifactSignals {
  return { publish: (channel, event) => centrifugo().publishJson(channel, event) };
}

/**
 * Tells the pages of the artifact's home that a version was saved: a conversation's pages, or
 * the Workspace's for a Workspace artifact (whose every member reads it). Best effort, after the
 * commit: a page that misses it reads the version on its next read.
 */
export async function announceVersion(
  signals: ArtifactSignals | undefined,
  input: {
    workspaceId: string;
    homeKey: string;
    artifactId: string;
    number: number;
    publisher: ArtifactActor;
  },
) {
  if (!signals) return;
  const conversationId = input.homeKey.startsWith("conversation:")
    ? input.homeKey.slice("conversation:".length)
    : undefined;
  const channel = conversationId
    ? conversationRealtimeChannel(conversationId)
    : workspaceConversationChannel(input.workspaceId);
  const event: ArtifactVersionPublishedEvent = {
    type: REALTIME_EVENTS.artifactVersionPublished,
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    number: input.number,
    publisher: input.publisher.agentId
      ? { agentId: input.publisher.agentId }
      : { userId: input.publisher.userId! },
  };
  try {
    await signals.publish(channel, event);
  } catch (error) {
    console.warn(
      JSON.stringify({ event: "artifacts:version_signal_failed", error_type: errorType(error) }),
    );
  }
}
