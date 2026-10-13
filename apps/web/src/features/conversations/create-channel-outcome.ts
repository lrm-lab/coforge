/** What `CreateChannelDialog`'s create callback reports: the channel exists, and whether the
 * picked members were added and the Chat list re-read. */
export type CreatedChannel = {
  id: string;
  membersAddFailed: boolean;
  sidebarRefreshed: boolean;
};

/** What the dialog does after a create. `open` opens the channel and closes; `result` keeps the
 * dialog open on an inline notice with an "Open channel" button, so a create is never retried. */
export type CreateChannelOutcome =
  | { kind: "closed" }
  | { kind: "open"; channelId: string }
  | { kind: "result"; channelId: string; notice: "members" | "created" };

/** Decides the dialog's next step from a create result. A channel that exists is never offered
 * again as a create, whichever part after the create failed. */
export function createChannelOutcome(created: CreatedChannel | void): CreateChannelOutcome {
  if (!created) return { kind: "closed" };
  if (created.membersAddFailed) return { kind: "result", channelId: created.id, notice: "members" };
  if (!created.sidebarRefreshed)
    return { kind: "result", channelId: created.id, notice: "created" };
  return { kind: "open", channelId: created.id };
}
