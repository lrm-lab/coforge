# Agents UI

These rules apply to `src/features/agents/`.

## Agent state in the browser

- Opening the runtime model list reads the stored catalog. Only the explicit
  refresh button probes the Computer; it waits for that request's terminal
  reply. A failed probe retains the old list and names the runtime's classified reason; a timeout shows an error.

- `WorkspaceAgentsProvider` (`workspace-agents-realtime.tsx`) is the app
  shell's one Agent status subscription and one Activity subscription.
  Avatars, pages, and panels read through its hooks (`useLiveAgents`,
  `useLiveAgent`, `useLiveAgentDisplay`, `useAgentRecentActivity`,
  `useAgentActivityFeed`, `usePrefetchAgentActivityFeed`,
  `useReadAgentActivityFeed`) and never
  open connections or subscribe themselves. The conversations feature does not
  own Agent state. The live Agents are a TanStack Store: a reader of one Agent
  (`useLiveAgent`, `useLiveAgentDisplay`) re-renders only when that Agent
  changes, so a list row reads its own Agent rather than the whole list.
  `useRefreshAgentDirectory` re-reads that store after a committed write; a failed read preserves the snapshot and rejects to the caller without replacing the Workspace route.
- The Agents beyond the viewer's roster (`loadExtraAgents`, scoped like the Members directory,
  without the viewer's own) are one query in the provider; each is a named `isExtra` entry of
  `useAgentStatuses`' list, so the status publications on the shared channel and on a private
  Agent's own channel update it in place, and a private one gets its per-Agent subscriptions. Only
  busy extras and held ones get a display: those shown busy or lapsed (`heldDisplayAgentIds`, so a
  stale busy display clears) and those a mounted view reads (`useWatchAgentDisplay`; an idle extra
  has none otherwise). The provider's `refresh` reads the roster and these together, the extras
  failing soft, so the display-expiry timer, a resubscribe gap and directory and visibility events
  cover them. `useLiveAgents` leaves them out; the chat list header reads the busy ones through
  `useWorkspaceBusyAgents`. Never subscribe to a private Agent's channel twice (not ref-counted).
- The model beside an Agent's name in chat (`agent-models.ts`, Settings → Show
  agent model) is one query per Workspace over every Agent the viewer may see
  (`listVisibleAgentModels`, scoped by `visibleAgentWhere`), wider than
  `listAgents`. A row reads its own Agent with `select` and never receives the
  map. The query is read again on focus and reconnect, when an unknown Agent
  newer than the list appears, and after a runtime save or a visibility change.
- `agent-status-realtime.ts` consumes backend display snapshots from the
  initial server response and the realtime status channel and accepts newer
  revisions. At display expiry it refreshes from the backend and retries on
  failure. It implements no reducer. It keeps the last snapshot when a refresh
  fails; an unavailable initial snapshot with no prior value is unknown, not
  offline.
- Activity lives in the TanStack Query cache (`agent-activity-queries.ts`).
  Publications patch it with `setQueryData`; every (re)subscribe invalidates
  it; it refetches when the tab becomes visible or the network returns.
  History and live entries deduplicate by launch ID and client sequence.
  Timeline history never changes the display snapshot.
- The client Activity window is `AGENT_ACTIVITY_WINDOW` in
  `agent-activity-window.ts`, the same value the server's
  `AgentActivityRepository` reads; both import it, so it cannot drift.

## Activity display

- UI renders the cloud-authored unified Agent display. It never reduces raw
  facts, interprets provider message text, or owns transport. Current state and
  expiry decisions belong to the cloud reducer.
- Render `agent:activity` fields `detail`, `detailKind`, `entries`,
  `observedAtMs`, and the CoForge `level` extension in the Agent-owned timeline
  in this directory.
- Model-request waiting labels and elapsed-time captions are localized in the timeline,
  Agent card, and chat header. Other existing Activity labels remain plain English.
  Preserve provider content in its original language. Navigation, tabs, and general UI
  remain localized.
- The model-wait clock uses the retained request observation, never heartbeat time.
  Only the cloud display authorizes a live clock; hide timing without matching history
  and stop its live claim when that display lease expires. It never decides availability.
- Preserve provider text, thinking, errors, and warnings in their original
  language and wording, subject to required secret redaction.
- Display backend status detail. Tool labels come from structured tool names,
  never commands or paths. Working and thinking use the yellow work treatment.
- Computer lifecycle kinds (`computer_*`) render their own label, never the
  generic Activity row. Only `computer_operation_failed` shows the row's
  detail; the others read as the label alone, whatever detail a stored row has.
- Render unknown detail kinds with a generic activity presentation and the
  original detail instead of dropping the record.
- Show command and workspace-relative file path messages as copyable
  monospace text. Never expect or render file contents, diffs, prompts,
  secrets, or raw provider stderr in an activity record.
- The user-approved display-content exception is structured `entries`
  containing provider-exposed assistant text and thinking intended for
  display. Never extract hidden reasoning or copy raw tool arguments, outputs,
  or patches. Render that text as plain text, not HTML; redaction is best
  effort, not a guarantee that every sensitive statement can be recognized.
- Merge consecutive text (or thinking) fragments of the same launch, conversation, and
  subagent into one row; the Daemon delivers one statement in several frames.
- Show a `subagent_activity` frame's entries as their own rows, like the main Agent's (never one
  merged "Subagent working" row); its tool and system rows carry the badge `Subagent: <type>`
  (`subagentBadgeLabel`, else `Subagent`), its thinking and text rows none. The Agent's current
  label stays "Subagent working…"; an entry-less progress row keeps the daemon's phase text.
- The Activity log is complete: show every persisted frame, including
  `tool_end`, `thinking_end`, and `compaction_finished` as status rows. The
  Daemon's `detail` wins; fall back to the "… finished" wording only when
  `detail` is empty.
- Memory Activity retains conversation lineage: chat peeks filter to the current group,
  while the member timeline aggregates groups. Timeline rows show no conversation link (like
  every other Agent's); the lineage stays in the data. Unscoped historical rows keep their
  original meaning.
- Reply intents arrive only on authorized open conversation channels (or the viewer's own DM channel), never Activity. `ReplyingAgentsLine` owns one conversation lease; threads share the same channel and the message subscription pool. Reconnect clears only that conversation's live hints; closing the last reader clears it too.
- Mascots and the replying lines (`replying-agents-line.tsx`) follow
  [mascots.md](mascots.md); its store, feeds and clearing: [reply-intent.md](../../../../../docs/observability/reply-intent.md).
- The Agent card (`agent-hover-card.tsx`) peeks from the avatars and the
  @mention chips (`conversations/mention-chip-hover.tsx`; a person's chip peeks
  `conversations/person-hover-card.tsx`) in a message stream, and from the chat list header's
  busy Agents ([mascots.md](mascots.md)), only; conversation and profile headers have no hover card. Its
  Recent activity goes only to the viewers who get the panel's Activity tab
  (`canManageAgent`): the five newest rows, "finished" status rows included,
  oldest at the top, each as clock, round marker and truncated label. The
  profile panel's Activity tab shows the full log
  (`agent-activity-timeline.tsx`): one monospace row per entry, a round
  marker on a connector line, label and detail beside it, the clock on the
  right; no day separators, oldest at the top. Activity markers (both places)
  never pulse, and an error colours only its marker. `StatusDot` stays for
  live status (avatars, Computers).

## Members page

- Tab counts are directory totals. Directory pages come from server cursor
  pages that filter by owner and search in the database; do not
  filter loaded pages on the client.
- Clicking an Agent name opens the same right-hand `AgentProfilePanel` the
  conversation slot uses (`profile`/`agentTab` search params);
  `agent/$agentId` redirects there.
- Clicking a person's name, on a card or as a message's sender, opens
  `PersonProfilePanel` in the same slot (`profile=user:<id>`). It shows the
  person's name (never their username), description, email when the identity
  provider reported one (visible to every member), role, join date, and the
  Agents they created that the viewer may see. An owner or admin changes their
  role and removes them there with the Settings → Members writes and rules
  (`WorkspaceMembers.person` reports which apply); one's own profile is edited
  in Settings → Account.
- Computer prerequisites appear only after the user requests Agent creation.
  Runtime management stays in the profile panel. `cloud-agent-create-dialog.tsx`, opened from the DM picker, asks only for a display name, waits for cloud readiness, and opens the created private Agent's DM; it re-reads the Agent roster, picker directory, and DM list after their writes instead of relying on realtime signals. Creation permissions remain server-owned.
- Who sees what on an Agent, as Raft does: Message (profile header, Members
  card, DM picker, search) follows the server's `canMessage` (any member a
  public Agent, only its creator a private one); the Activity, Chat, Reminders and Workspace tabs
  follow `canManageAgent` (its creator or a Workspace owner/admin; an app's bot shows Profile and
  Chat, Chat to every viewer), and so do the Activity reads behind the tab and the Agent card:
  the server answers no one else and the browser does not ask;
  Start, Stop and Restart are any member's; Full reset is owner/admin only
  (`AgentControl.execute`).
- Workspace directory reads belong to
  `features/workspaces/workspaces.functions.ts` and
  `server/workspaces/members.server.ts`; owner-only Agent operations stay
  separate.
- The per-User weekly-report assistant is an internal Agent identity excluded
  from this directory; its Computer/Runtime setup reuses the panel.

## Controls and profile

- Profile control buttons submit without waiting UI or control-state queries;
  runtime observations stay in Activity. Full Reset requires destructive
  confirmation.
- The profile control (`agent-runtime-controls.ts`) chooses Start or Stop by
  `agentDisplay(display).isOnline`. Start submits immediately; Stop opens a confirm dialog. The `stopped` option
  of `agentDisplay()` only adds an un-internationalized `statusDetail` caption
  when the display is already offline; it never changes `isOnline` or the badge
  label.
- Users see deleting an Agent as archiving it ("Archive", `ARCHIVED`, 已归档);
  code and data keep `deleted`/`deletedAt`. An archived Agent's profile opens
  read-only: the Profile tab alone, no runtime control, message, edit, role,
  visibility, migration or archive. Its managers also see the ARCHIVE section
  (`agent-archive-section.tsx`): when and by whom (`Agent.deletedByUserId`), and
  its workspace, which the Computer's owner or a Workspace owner/admin may scan
  and delete (`archivedAgentWorkspaceAssignment`). Admins reach another member's
  Computer only for an archived Agent's workspace; a live Agent's stays its
  Computer owner's.
- Settings → Workspace profile lists every archived Agent to a Workspace
  owner/admin (`archived-agents-group.tsx`), each opening its read-only
  profile. There is no unarchive: archiving revoked its keys, memberships and
  reminders, and a new Agent may already hold its name.
- While the display says `error` (except `runtime_stalled`), the profile panel shows the provider's
  original error text (not translated or summarized) in a banner under its
  header on every tab (`agent-error-banner.tsx`), with the Activity tab's
  diagnostics copy and a way to that tab
  for whoever gets that tab. Nothing else in the panel repeats it.
- `profile-panel/agent-profile-status.tsx` owns ordinary errors and the localized `runtime_stalled` warning, the panel's only Stop Current Turn entry (text only), with its pending state and response feedback.
- `deleted-agent.tsx` owns archived-sender rendering (grey avatar and `ARCHIVED`
  badge) for every message-history surface. Use it rather than local styling.
- `agent-avatar-dialog.tsx` is the creator's mascot picker, opened by clicking
  the avatar in the Profile tab: a grid of the platform mascots
  (`agent-mascot.ts`) with the current one selected, saved only on Save. Agent
  avatar components fall back to `agentAvatarUrl(agentId)`, never initials, while
  an Agent's data is loading.
- `agent-visibility.ts` holds the `AgentVisibility` vocabulary outside any
  `.server.ts` file so browser validators can import it, and `normalizeAgentVisibility`: read a
  stored value through it, since anything but exactly `public` is private.
- The environment editor edits only user-declared Agent environment overrides.
- The Apps tab (`agent-apps-tab.tsx`, after Raft's web UI) shows every viewer of a live
  Agent its pending requests and active grants; Approve, Deny, Grant access and Revoke only when
  the read's `canManage` says so (Workspace owner/admin or the Agent's creator). Revoke acts at
  once, with no confirmation, and every failure stays inline at the top of the tab.
- The Profile tab's computer row opens that Agent's desktop in its own window, titled with the
  Agent's name, for the cloud computer's owner only. The panel does not embed the desktop.
- The Skills tab displays Global/Workspace metadata only, never skill bodies
  or a claim that a running session has loaded each entry.
- The Context usage row reads passive Agent display observations only: opening a
  runtime popover never launches a context scan. Its colour follows the shared
  `usageLevel` rule (`features/computers/usage-level.ts`), like a usage bar.
