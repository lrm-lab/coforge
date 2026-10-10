import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";

/**
 * What the project page reads of a Project: its own fields, and for each of its channels who is in
 * it now and the last message with its sender. `satisfies` makes a field removed from the schema a
 * type error here instead of a failure of every project page at run time.
 */
export const PROJECT_DETAIL_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  iconObjectKey: true,
  githubFullName: true,
  githubHtmlUrl: true,
  commitCoAuthor: true,
  conversations: {
    select: {
      id: true,
      channelName: true,
      createdAt: true,
      // Who is in the channel now: not someone who left it, or left the Workspace.
      _count: { select: { members: { where: ACTIVE_MEMBER_WHERE }, messages: true } },
      messages: {
        take: 1,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          createdAt: true,
          sender: {
            select: {
              user: {
                select: {
                  id: true,
                  displayName: true,
                  username: true,
                  avatarObjectKey: true,
                },
              },
              agent: { select: { displayName: true } },
            },
          },
        },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.ProjectSelect;
