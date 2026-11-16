import type {
  ArtifactAccessChangedEvent,
  ArtifactVersionPublishedEvent,
} from "#src/features/artifacts/artifact-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import { artifactHomeConversationId, type ArtifactTier } from "./artifact-access.server";

/** Where an artifact's events go: one realtime channel at a time. */
export type ArtifactSignals = {
  publish(
    channel: string,
    event: ArtifactVersionPublishedEvent | ArtifactAccessChangedEvent,
  ): Promise<void>;
};

/** The signals over Centrifugo; the API is built only when one is sent. */
export function centrifugoArtifactSignals(
  centrifugo: () => Pick<CentrifugoServerApi, "publishJson">,
): ArtifactSignals {
  return { publish: (channel, event) => centrifugo().publishJson(channel, event) };
}

function channelsOf(input: { workspaceId: string; homeKey: string; wide: boolean }) {
  const conversationId = artifactHomeConversationId(input.homeKey);
  const workspaceChannel = workspaceConversationChannel(input.workspaceId);
  if (!conversationId) return [workspaceChannel];
  const homeChannel = conversationRealtimeChannel(conversationId);
  return input.wide ? [homeChannel, workspaceChannel] : [homeChannel];
}

async function publishBestEffort(
  signals: ArtifactSignals,
  channels: readonly string[],
  event: ArtifactVersionPublishedEvent | ArtifactAccessChangedEvent,
  failure: string,
) {
  for (const channel of channels) {
    try {
      await signals.publish(channel, event);
    } catch (error) {
      console.warn(JSON.stringify({ event: failure, error_type: errorType(error) }));
    }
  }
}

export async function announceVersion(
  signals: ArtifactSignals | undefined,
  input: {
    workspaceId: string;
    homeKey: string;
    wide: boolean;
    artifactId: string;
    number: number;
  },
) {
  if (!signals) return;
  await publishBestEffort(
    signals,
    channelsOf(input),
    {
      type: REALTIME_EVENTS.artifactVersionPublished,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      number: input.number,
    },
    "artifacts:version_signal_failed",
  );
}

export async function announceAccessChange(
  signals: ArtifactSignals | undefined,
  input: {
    workspaceId: string;
    homeKey: string;
    artifactId: string;
    tier: ArtifactTier;
  },
) {
  if (!signals) return;
  await publishBestEffort(
    signals,
    channelsOf({ ...input, wide: input.tier === "workspace" }),
    {
      type: REALTIME_EVENTS.artifactAccessChanged,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    },
    "artifacts:access_signal_failed",
  );
}
