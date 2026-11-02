import type { ChannelVisibility } from "./channel-visibility";
import type { DraftTarget } from "./composer-draft";
import type { DeviceDraft } from "./composer-drafts-index";

/** A channel as a draft row shows it. */
export type DraftChannel = { name: string; visibility: ChannelVisibility };

/** A DM as a draft row shows it: the name it goes by, and who it is with, which is all drawing the
 * face takes (an Agent's live look is read by its avatar). */
export type DraftDirect = {
  name: string;
  peer:
    | { kind: "people"; userId: string; avatarUrl: string | null }
    | { kind: "agent"; agentId: string; avatarUrl: string | null };
};

/** The channel or DM of the current Workspace a draft was written in. */
export type DraftHome =
  | { kind: "channel"; channel: DraftChannel }
  | { kind: "dm"; direct: DraftDirect };

export type DraftRow = {
  key: string;
  body: string;
  updatedAt: number | null;
  /** The channel or DM, or for a Task its board's conversation, the draft belongs to. */
  conversationId: string;
  home: DraftHome;
  target: DraftTarget;
};

/** What decides whether a draft is listed besides its conversation. */
export type DraftScope = {
  /** Task discussion drafts exist only while task conversations are on, so they are listed only then. */
  taskDrafts: boolean;
};

/** The home of a draft's conversation if the Workspace owns it, and the draft is one to list. */
function listedHome(
  { place }: DeviceDraft,
  homes: ReadonlyMap<string, DraftHome>,
  scope: DraftScope,
): DraftHome | undefined {
  return scope.taskDrafts || place.target.kind !== "task"
    ? homes.get(place.conversationId)
    : undefined;
}

/**
 * The drafts the current Workspace owns, as rows, in the order given. `homes` holds the
 * Workspace's channels and DMs by conversation id; a draft written in another Workspace, or in a
 * conversation the viewer can no longer see, is left out rather than shown as unknown.
 */
export function resolveDrafts(
  drafts: readonly DeviceDraft[],
  homes: ReadonlyMap<string, DraftHome>,
  scope: DraftScope,
): DraftRow[] {
  return drafts.flatMap((draft): DraftRow[] => {
    const home = listedHome(draft, homes, scope);
    const { key, body, updatedAt, place } = draft;
    return home
      ? [{ key, body, updatedAt, conversationId: place.conversationId, home, target: place.target }]
      : [];
  });
}

/** How many of `drafts` are listed: `resolveDrafts(...).length` without building rows. */
export function countDrafts(
  drafts: readonly DeviceDraft[],
  homes: ReadonlyMap<string, DraftHome>,
  scope: DraftScope,
): number {
  return drafts.reduce((count, draft) => count + (listedHome(draft, homes, scope) ? 1 : 0), 0);
}

/** The route a draft row opens, spreadable into `Link`: its channel or DM, with the thread pane or
 * the Task's popup open when the draft was written there. */
export function draftRoute(
  { home, conversationId, target }: Pick<DraftRow, "home" | "conversationId" | "target">,
  workspaceSlug: string,
) {
  const search =
    target.kind === "thread"
      ? { threadRootId: target.threadRootId }
      : target.kind === "task"
        ? { task: target.number }
        : {};
  return home.kind === "channel"
    ? ({
        to: "/w/$workspaceSlug/channel/$channelId",
        params: { workspaceSlug, channelId: conversationId },
        search,
      } as const)
    : ({
        to: "/w/$workspaceSlug/dm/$dmId",
        params: { workspaceSlug, dmId: conversationId },
        search,
      } as const);
}
