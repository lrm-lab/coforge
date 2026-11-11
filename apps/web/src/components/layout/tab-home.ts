import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";

/** The four pages the phone's bottom tab bar leads to. */
export type TabHome = "chat" | "activity" | "workspace" | "me";

/** Chat's sections: its home (`""`, the list) and the pages whose list can be on screen while
 * their own address is a conversation's. The sidebar's Chat item is current on all of them. */
export const CHAT_SECTIONS: readonly string[] = ["", "channel", "dm", "saved", "drafts"];

/** The first path segment under the Workspace (`""` for its home or outside one). */
export function sectionOf(pathname: string): string {
  return splitWorkspacePath(pathname)?.rest.split("/")[1] ?? "";
}

/**
 * Which tab's home page is on a phone's screen, or null when the bar is hidden: only a tab's home
 * shows it, never a conversation, thread, task, project, settings or any other inner page.
 *
 * Chat's list is the Workspace home (`section` `""`), and also what a conversation's back arrow
 * brings back over that conversation's own address (`chatListOpen`). Activity opens an item full
 * screen (`itemOpen`).
 */
export function tabHomeOf({
  section,
  itemOpen,
  chatListOpen,
}: {
  section: string;
  /** Activity's `open` param is set: an item fills the screen. */
  itemOpen: boolean;
  chatListOpen: boolean;
}): TabHome | null {
  if (section === "") return "chat";
  if (CHAT_SECTIONS.includes(section)) return chatListOpen ? "chat" : null;
  if (section === "activity") return itemOpen ? null : "activity";
  if (section === "workspace" || section === "me") return section;
  return null;
}

/** Where an inner page's back button goes: the tab home its page belonged to, or one step back. */
type BackTarget = "workspace" | "me" | "history";

/** What the old sidebar listed under Workspace and AI Workbench belongs to the Workspace tab;
 * Settings is reached from Me. */
const WORKSPACE_PAGES: readonly string[] = [
  "projects",
  "tasks",
  "members",
  "records",
  "computers",
  "computer",
  "agent",
  "pi-chat",
];

export function backTargetOf(section: string): BackTarget {
  if (WORKSPACE_PAGES.includes(section)) return "workspace";
  if (section === "settings") return "me";
  return "history";
}
