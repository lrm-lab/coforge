import { createContext, useContext, useEffect, type FC, type ReactNode } from "react";

/** One row of the Workspace tab's page, taken from the nav items the sidebar is drawn from. */
type WorkspaceHubItem = {
  label: string;
  href: string;
  icon: FC<{ className?: string }>;
  badge?: ReactNode;
};

/**
 * What the phone's tab pages take from `AppShell`, which owns the nav items, the Workspace
 * switcher and the signed-in user: the Workspace tab's rows, the Me page's identity and sign-out,
 * and the switcher the header's mark opens.
 */
export type PhoneShell = {
  /** The Workspace switcher with the CoForge mark as its trigger. */
  workspaceSwitcher: ReactNode;
  /** The sidebar's items under Chat and Activity, in its order. */
  workspaceItems: readonly WorkspaceHubItem[];
  user: { name: string; email: string | null; avatarUrl?: string | null };
  onSignOut: () => Promise<void> | void;
};

export const PhoneShellContext = createContext<PhoneShell | null>(null);

/** How a conversation page tells the shell whether Chat's list is on screen. A context of its own:
 * the setter never changes, so reporting re-renders none of the tab pages. */
export const ChatListOpenContext = createContext<((open: boolean) => void) | null>(null);

/** The shell's phone context; the tab pages render only inside `AppShell`. */
export function usePhoneShell(): PhoneShell {
  const shell = useContext(PhoneShellContext);
  if (!shell) throw new Error("usePhoneShell needs the AppShell");
  return shell;
}

/** Tells the shell that Chat's list is on screen, which a conversation's address does not say:
 * its back arrow brings the list back over it. */
export function useReportChatListOpen(open: boolean) {
  const setChatListOpen = useContext(ChatListOpenContext);
  useEffect(() => {
    setChatListOpen?.(open);
    return () => setChatListOpen?.(false);
  }, [open, setChatListOpen]);
}
