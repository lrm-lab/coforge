import { createContext, useContext, type ReactNode } from "react";

import type { Mentionable } from "./mention-text";

const MemberDirectoryContext = createContext<readonly Mentionable[] | undefined>(undefined);

/** The conversation's members, which rows name people from by face: a seen-by list's readers, a
 * system notice's people (task #521). */
export function MemberDirectory({
  members,
  children,
}: {
  members?: readonly Mentionable[];
  children: ReactNode;
}) {
  return <MemberDirectoryContext value={members}>{children}</MemberDirectoryContext>;
}

/** The members of the conversation the row is in; none outside one. */
export function useMemberDirectory(): readonly Mentionable[] | undefined {
  return useContext(MemberDirectoryContext);
}
