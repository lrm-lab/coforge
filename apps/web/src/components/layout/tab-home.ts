/** The four pages the phone's bottom tab bar leads to. */
export type TabHome = "chat" | "activity" | "workspace" | "me";

/** The Chat pages whose list can be on screen while their own address is a conversation's. */
const CHAT_PAGES: readonly string[] = ["channel", "dm", "saved", "drafts"];

/**
 * Which tab's home page is on a phone's screen, or null when the bar is hidden: only a tab's home
 * shows it, never a conversation, thread, task, project, settings or any other inner page.
 *
 * `section` is the first path segment under the Workspace (`""` for its home). Chat's list is
 * the Workspace home, and also what a conversation's back arrow brings back over that
 * conversation's own address (`chatListOpen`). Activity opens an item full screen through `open`.
 */
export function tabHomeOf({
  section,
  search,
  chatListOpen,
}: {
  section: string;
  search: { readonly open?: unknown };
  chatListOpen: boolean;
}): TabHome | null {
  if (section === "") return "chat";
  if (CHAT_PAGES.includes(section)) return chatListOpen ? "chat" : null;
  if (section === "activity") return search.open === undefined ? "activity" : null;
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
  "pi-chat",
];

export function backTargetOf(section: string): BackTarget {
  if (WORKSPACE_PAGES.includes(section)) return "workspace";
  if (section === "settings") return "me";
  return "history";
}
