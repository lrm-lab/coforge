import type {
  ArtifactAccessChangedEvent,
  ArtifactCommentsChangedEvent,
  ArtifactDataChangedEvent,
  ArtifactVersionPublishedEvent,
} from "#src/features/artifacts/artifact-realtime";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
  type ActivityChangedEvent,
} from "#src/features/conversations/conversation-realtime";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import {
  artifactHomeConversationId,
  artifactTier,
  type ArtifactAccessTier,
} from "./artifact-access.server";

export type ArtifactSignalEvent =
  | ArtifactVersionPublishedEvent
  | ArtifactAccessChangedEvent
  | ArtifactDataChangedEvent
  | ArtifactCommentsChangedEvent
  | ActivityChangedEvent;

export type ArtifactSignals = {
  publish(channel: string, event: ArtifactSignalEvent): Promise<void>;
  background?(work: () => Promise<void>): void;
};

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
  event: ArtifactSignalEvent,
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
    tier: ArtifactAccessTier;
  },
) {
  if (!signals) return;
  await publishBestEffort(
    signals,
    channelsOf({ ...input, wide: input.tier !== "conversation" }),
    {
      type: REALTIME_EVENTS.artifactAccessChanged,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
    },
    "artifacts:access_signal_failed",
  );
}

export async function announceDataChange(
  signals: ArtifactSignals | undefined,
  input: { workspaceId: string; homeKey: string | null; artifactId: string; collection: string },
) {
  if (!signals || input.homeKey === null) return;
  await publishBestEffort(
    signals,
    channelsOf({ workspaceId: input.workspaceId, homeKey: input.homeKey, wide: false }),
    {
      type: REALTIME_EVENTS.artifactDataChanged,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      collection: input.collection,
    },
    "artifacts:data_signal_failed",
  );
}

export async function announceArtifactComments(
  signals: ArtifactSignals | undefined,
  workspaceId: string,
  artifact: { id: string; homeKey: string; access: string },
  change: { change: ArtifactCommentsChangedEvent["change"]; commentIds: readonly string[] },
) {
  if (!signals) return;
  await publishBestEffort(
    signals,
    channelsOf({
      workspaceId,
      homeKey: artifact.homeKey,
      wide: artifactTier(artifact) === "workspace",
    }),
    {
      type: REALTIME_EVENTS.artifactCommentsChanged,
      workspaceId,
      artifactId: artifact.id,
      change: change.change,
      commentIds: [...change.commentIds],
    },
    "artifacts:comments_signal_failed",
  );
}
