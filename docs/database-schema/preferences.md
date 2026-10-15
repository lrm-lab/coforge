# Preference tables

## `user_preferences`

One row per user for account-level settings (time zone, time format, browser
notifications, conversation open mode), keyed by `userId` with `ON DELETE CASCADE`. Every setting
column is nullable and NULL means the code default; closed sets are TEXT with a
`CHECK` constraint.

## `workspace_member_preferences`

One row per Workspace membership for a member's own settings inside that Workspace, keyed by
`(workspaceId, userId)` with a foreign key to `workspace_memberships` and `ON DELETE CASCADE`.
`conversationTabOrder` and `agentProfileTabOrder` are `TEXT[]` tab-id lists (empty = default
order, first tab opens by default), each limited to its panel's ids by a `CHECK`.

## `chat_sections`

A member's personal Chat groups inside one Workspace. Each section has a UUIDv7 id,
name (at most 18 characters), optional emoji, collapsed state and saved order. Its `(workspaceId, userId)`
foreign key points to `workspace_memberships` with `ON DELETE CASCADE`.

`conversation_members.chatSectionId` assigns a member's channel or direct conversation
to one section; `chatSectionSortOrder` keeps its position there. `chat_sections.sortOrder`
keeps the member's group order. Section writes authorize the member and conversation in that Workspace;
they never change another member's grouping. Removing a section sets these references
to NULL and keeps every conversation and message. Pinned conversations stay in Pinned;
unpinning returns them to their assigned section. Moving a pinned conversation to a
section unpins it. Unassigned conversations stay in Channels or Direct messages.

The Chat list's blank-space context menu creates sections with a name and optional emoji;
Channels and Direct messages headers keep only their own creation actions. Members edit section names and
icons, collapses them, and moves conversations through each row's menu. A section's
collapse state is saved with it. Section headings display uppercase without changing
the saved name or its edit field, truncating with an ellipsis when space runs out.
Members drag conversation rows directly between groups and drag headings to reorder custom groups; both orders
are saved. Other devices read changes when Chat opens, regains
focus, and periodically while visible; this does not add a realtime wire event.
