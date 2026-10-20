# Agents

Creating, configuring and controlling Agents, and reading their status in the
Web. Code: `apps/web/src/features/agents/` (profile panel under
`profile-panel/`). English strings: `apps/web/messages/en/agents.json`.
For what happens inside a turn see [Agent runtimes](agent-runtimes.md).

## Shared facts

- **Profile URL**: `/en/w/<slug>/agent/<id>` only redirects to
  `/en/w/<slug>/members?profile=agent:<id>&agentTab=<tab>`
  (`apps/web/src/routes/w.$workspaceSlug/agent.$agentId.tsx`); `agentTab` is
  `profile`, `activity`, `reminders` or `workspace`.
- **Tabs**: tablist named "Agent" with Profile, Reminders, Activity, Workspace.
  Reminders and Activity are for managers and owners; Workspace for the Agent's
  owner only (`profile-panel-search.ts`).
- **Header buttons** (tooltip doubles as accessible name): "Message", "Start"
  or "Stop", "Restart / Reset", "Close" (`agent-profile-header.tsx`).
- **Status**: the avatar is `role="img"` named "<name>, <status label>"
  (`agent-display-avatar.tsx`); labels come from `agentDisplay()` in
  `agent-activity-presentation.ts` and are not translated. Live changes arrive
  as `agent:display` realtime messages; status is `active`/`inactive` with a
  90-second lease ([status and activity](../../../../docs/observability/agent-status-and-activity.md)).

## agent-create

- **Reach**: four entries open the same `AgentCreateDialog`:
  "New agent" on the Members page's Agents tab (if you may create Agents);
  a channel's "Channel details and settings" → "Add members" → "Create a new
  Agent" (or "Create Agent “<search>”"); "Create agent" on a Computer's detail
  page; and an Agent's `agent:create` [action card](tasks.md#action-card).
- **Drive**: "Computer" select (options named "<name>, Online/Offline"),
  "Username" (`input[name="name"]`), description (`name="description"`),
  "Runtime provider", "Model provider", "Model", "Refresh model catalog",
  "Reasoning", the "Make private" checkbox, then "Create Agent".
- **Success**: the dialog closes, the Agent appears on the Members page (and,
  from a channel, joins it), and its first DM gets a reply
  ([agent-dm](conversations.md#agent-dm)). Errors show in `[role=alert]`.
- **Traps**:
  - The default runtime "CoForge" needs a model API key; pick a runtime the
    Computer actually has (the channel e2e switches to "Claude Code").
  - From a channel the form opens locked to public; a non-admin sees "only a
    Workspace owner or admin can create Agents" instead of the entry.
  - The native harness still looks for "Name *" and "Create agent"; the form now
    says "Username" and "Create Agent".
- **Covered by**: `apps/web/test/e2e-channel-create-agent-entry.e2e.ts`
  (screenshots `.amp/e2e/channel-create-agent-entry/`; its
  `button[aria-label^="Visibility"]` check may be stale, unverified).
  `native-browser.e2e.ts` creates one on a real Computer. A new Agent DMs its
  creator an introduction on its first start, once:
  `apps/web/test/e2e-agent-introduction.e2e.ts`
  (`scripts/e2e/run-agent-introduction.sh`; report `.amp/e2e/agent-introduction/`).

## agent-configure

- **Reach**: Profile tab.
- **Drive**: "Edit runtime configuration" (runtime, model, reasoning);
  "Environment variables" with "Add variable" and "Remove variable <n>";
  "Skills (<n>)" (owner only; each skill is one collapsed row, name then the
  description cut off with an ellipsis, and pressing the row expands the full
  description, `agent-skills.tsx`); "Visibility" with "Make private"/"Make
  public"; "Archive agent" under Actions (`agent-profile-tab.tsx`,
  `agent-runtime-config-dialog.tsx`). The Runtime field is one pill: the
  runtime part (hover or keyboard focus opens its usage peek; a click does
  not; its health dot follows the name, the state also in its name
  "<Runtime> · Usage · Usage OK") and, once the Agent has reported
  context, a thin divider then "Context <n>% used" ("上下文 已用 <n>%"; the
  used share turns yellow from 70% and red from 90%), which opens the
  context peek for Claude Code and a tooltip otherwise.
- **Success**: the Profile tab shows the saved values after reload, and the
  next turn uses them (check the model in Activity, or ask the Agent).
- **Traps**: only user-entered overrides are stored in the cloud; inherited
  Daemon environment never is, so do not expect to see it here.
- **Covered by**: no browser e2e found.

## agent-control

- **Reach**: profile header, or a Computer page's "Agents on this computer"
  bulk Select → Start / Stop / Restart / Reset.
- **Drive**: "Restart / Reset" opens "Restart <name>" with options
  `[data-control-action=restart|reset-session|full-reset]` ("Restart",
  "Reset session & restart", "Full reset & restart"; `aria-pressed`) and submit
  `[data-control-submit]`. "Stop" asks in a "Stop Agent" dialog whose confirm
  is "Stop" (`agent-control-dialogs.tsx`).
- **Success**: the avatar status moves through starting to idle (or offline
  after Stop) and Activity records the lifecycle; a DM after restart is answered.
- **Traps**: Full reset is irreversible. Stop revokes capabilities and removes
  restart configuration; do not use it to simulate a Daemon disconnection.
- **Covered by**: `apps/web/test/agent-control.e2e.ts` needs
  `COFORGE_CONTROL_E2E=1`, is hard-coded to 127.0.0.1:8790, and waits for
  `[data-agent-control]`, link-role tabs and "Refresh skills", none of which
  exist in the current source: expect it to fail until updated (not run here).

## agent-error-banner

- **Reach**: any tab of an Agent's profile panel while its display is in the
  error state (`display.activityKind === "error"`) and it is not archived
  (`agent-profile-panel.tsx`).
- **Drive**: put an Agent in a real error state on a disposable Agent, for
  example a launch or provider error from a misconfigured runtime or model.
  Which provider errors reach `activityKind === "error"` is decided by the
  Daemon and `agent-activity-presentation.ts`; confirm with Activity first.
- **Success**: a `role="status"` row under the header reads
  "Error: <provider text>" (clamped to two lines, full text in a tooltip).
  Off the Activity tab it offers "Copy diagnostic info" and, if you can see
  Activity, "View logs", which opens the Activity tab; on the Activity tab both
  are hidden and the tab's own band has the copy button. The banner leaves on
  its own once the display leaves the error state
  (`profile-panel/agent-error-banner.tsx`).
- **Covered by**: no browser e2e found.

## agent-activity-tab

- **Reach**: `agentTab=activity`.
- **Success**: a chronological timeline: time, action, and message; tool rows
  show a generic label ("Running command…") with the command or path only in
  the expanded row; adjacent text frames merge into one paragraph
  ([Activity web display](../../../../docs/observability/activity-web-display.md)).
- **Traps**: Activity is best-effort and is never proof that a message was
  delivered; the canonical message is. Heartbeats and progress pings are not
  rows.
