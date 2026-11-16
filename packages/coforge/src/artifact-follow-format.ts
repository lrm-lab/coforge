import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";

export type TellingAnswer = {
  newlyFollowing?: boolean;
  notified?: { name: string; reason: string }[];
  notNotified?: { name: string; reason: string }[];
};

export type FollowAnswer = {
  artifact: { id: string; name: string; title: string; currentVersion: number };
  following: boolean;
};

const WHY_TOLD: Record<string, string> = {
  mentioned: "mentioned",
  subscribed: "following",
  your_file_changed: "file changed",
  your_comment_resolved: "comment resolved",
};

const WHY_NOT: Record<string, string> = {
  "not-agent": "a person, not told",
  "cannot-see": "cannot read the artifact",
  "delivery-failed": "delivery failed: tell them yourself",
};

const who = (entry: { name: string }) => `@${foldUntrustedLine(entry.name)}`;

export function formatTelling(artifact: string, answer: TellingAnswer): string[] {
  const told = answer.notified ?? [];
  const notTold = answer.notNotified ?? [];
  return [
    ...(answer.newlyFollowing
      ? [
          `You now follow this artifact: others' comments, and their changes to files you last changed, reach you. To stop: coforge artifact unfollow ${artifact}`,
        ]
      : []),
    ...(told.length > 0
      ? [
          `Told: ${told.map((entry) => `${who(entry)} (${WHY_TOLD[entry.reason] ?? foldUntrustedLine(entry.reason)})`).join(", ")}. They know; no need to announce it in a conversation.`,
        ]
      : []),
    ...(notTold.length > 0
      ? [
          `Not told: ${notTold.map((entry) => `${who(entry)} (${WHY_NOT[entry.reason] ?? foldUntrustedLine(entry.reason)})`).join(", ")}.`,
        ]
      : []),
  ];
}

export function formatFollow(answer: FollowAnswer): string {
  const { id, title } = answer.artifact;
  return answer.following
    ? `You follow "${foldUntrustedLine(title)}" (${id}): others' comments, and their changes to files you last changed, reach you. To stop: coforge artifact unfollow ${id}`
    : `You do not follow "${foldUntrustedLine(title)}" (${id}) any more: only mentions reach you. Your own writes do not follow it again; to follow: coforge artifact follow ${id}`;
}
