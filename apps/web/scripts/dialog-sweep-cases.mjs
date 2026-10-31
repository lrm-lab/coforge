// Dialog definitions for the screenshot sweep.
// ---------------------------------------------------------------------------
// Steps. A `role` is a WAI-ARIA role, explicit or implied by the tag; a `name` is a
// case-insensitive regular expression source matched against the accessible name.
// ---------------------------------------------------------------------------
/** Navigates to a path under the Workspace (`/<locale>/w/<slug><path>`). */
const goto = (target) => ({ kind: "goto", target });
/** Navigates to the href of the link with this name, which is how a seeded id is found. */
const follow = (name) => ({ kind: "follow", name });
/** Clicks the first visible element with this role and name; `inDialog` restricts the search. */
const click = (role, name, inDialog = false) => ({
  kind: "click",
  role,
  name,
  inDialog,
});
const clickIn = (role, name) => click(role, name, true);
/** Focuses the element and presses Enter: how a keyboard-only control (a context menu) opens. */
const activate = (role, name) => ({ kind: "activate", role, name });
/** Types into the first visible element with this role and name. */
const fill = (role, name, text) => ({ kind: "fill", role, name, text });
const press = (key) => ({ kind: "press", key });
/** Waits for an element to exist, without touching it. */
const waitFor = (role, name, inDialog = false) => ({
  kind: "wait",
  role,
  name,
  inDialog,
});

const agentsList = goto("/members?memberType=agent&owner=all");
const atlasProfile = [agentsList, follow("^Open Atlas's profile$")];
const productSettings = [
  goto(""),
  follow("^#product"),
  click("button", "^Channel Details and Settings$"),
];
const channelMembers = [...productSettings, clickIn("button", "^Members")];
const cloudComputer = [goto("/computers"), follow("^Cloud Sandbox")];

/**
 * `expect` is a regular expression the opened dialog's text must match (it tells the dialog under
 * test from the panel or popover it was opened from). `unreachable` explains why the seed cannot
 * open the dialog; it becomes the failure reason when the steps cannot get there.
 */
export const DIALOGS = [
  {
    id: "agent-avatar",
    steps: [...atlasProfile, click("button", "^Change mascot$")],
    expect: "Choose a Mascot",
  },
  {
    id: "agent-control-stop",
    steps: [...atlasProfile, click("button", "^Stop$")],
    expect: "Stop Agent",
    unreachable:
      "the Stop control only exists on a running Agent and every seeded Agent is stopped",
  },
  {
    id: "agent-control-restart",
    steps: [...atlasProfile, click("button", "^Restart / Reset$")],
    expect: "^Restart Atlas",
  },
  {
    id: "agent-control-full-reset",
    steps: [
      ...atlasProfile,
      click("button", "^Restart / Reset$"),
      clickIn("button", "^Full Reset & Restart$"),
    ],
    expect: "^Restart Atlas",
  },
  {
    id: "agent-create",
    steps: [agentsList, click("button", "^New Agent$")],
    expect: "Create Agent",
  },
  {
    id: "agent-delete",
    steps: [...atlasProfile, click("button", "^Archive Agent$")],
    expect: "^Archive atlas",
  },
  {
    id: "agent-runtime-config",
    steps: [...atlasProfile, click("button", "^Edit Runtime Configuration$")],
    expect: "^Edit Runtime Configuration",
  },
  {
    id: "agent-visibility",
    steps: [
      ...atlasProfile,
      click("button", "^Edit Visibility$"),
      click("menuitem", "^Private$"),
      // The impact preview loads after the dialog opens.
      waitFor("button", "^Make Private$", true),
    ],
    expect: "^Make Atlas private",
  },
  {
    id: "cloud-agent-create",
    steps: [
      goto(""),
      click("button", "^New Direct Message$"),
      clickIn("button", "^Create Cloud Bot$"),
    ],
    expect: "^Create Cloud Bot",
  },
  {
    id: "person-profile-dialog",
    steps: [
      goto("/members?memberType=human&owner=all"),
      follow("^Open Casey Morgan's profile$"),
      click("button", "^Remove from Workspace$"),
    ],
    expect: "^Remove Casey Morgan from this Workspace",
  },
  {
    id: "agent-migration-1",
    steps: [...atlasProfile, click("button", "^Cancel Move$")],
    expect: "Cancel the move",
    unreachable: "the seed holds no Agent move in progress, so no Cancel Move control exists",
  },
  {
    id: "agent-migration-2",
    steps: [...atlasProfile, click("button", "^Move to Another Computer$")],
    expect: "^Move Atlas to another Computer",
    unreachable:
      "Move to Another Computer is hidden: the dev server has no migration bucket (COFORGE_MIGRATION_OSS_BUCKET, which needs OSS file storage), so the move is not available",
  },
  {
    id: "app-editor",
    steps: [goto("/settings?section=applications"), click("button", "^Register App$")],
    expect: "Register App",
  },
  {
    id: "add-computer",
    steps: [goto("/computers"), click("button", "^Add Computer$")],
    expect: "^Add Computer",
  },
  {
    id: "add-computer-install",
    steps: [
      goto("/computers"),
      click("button", "^Add Computer$"),
      clickIn("button", "^Your computer"),
      clickIn("button", "^Next$"),
    ],
    expect: "Install CoForge Computer",
  },
  {
    id: "computer-release-notes",
    steps: [goto("/computers"), click("button", "^What's new$")],
    expect: "What's new",
    unreachable:
      "the What's new link only shows when the release catalog has notes for the Computer's available upgrade, and the seed has none",
  },
  {
    id: "format-cloud-computer",
    steps: [...cloudComputer, click("button", "^Format Disk$")],
    expect: "^Format",
  },
  {
    id: "runtime-sign-in",
    steps: [goto("/computers"), click("button", "^Claude Code"), click("button", "^Sign In$")],
    expect: "Sign In",
    unreachable:
      "the seeded runtimes report their account as unavailable (the popover says Update Computer to sign in or out here), so there is no Sign In control",
  },
  {
    id: "confirm-dialog",
    steps: [...cloudComputer, click("button", "^Delete Computer$")],
    expect: "^Delete Cloud Sandbox",
  },
  {
    id: "channel-action-confirm",
    steps: [...productSettings, clickIn("button", "^Archive Channel$")],
    expect: "Members keep read access",
  },
  {
    id: "channel-action-confirm-leave",
    steps: [...productSettings, clickIn("button", "^Leave Channel$")],
    expect: "^Leave Channel\\s*You will stop receiving",
  },
  {
    id: "channel-action-confirm-delete",
    steps: [...productSettings, clickIn("button", "^Delete Channel$")],
    expect: "and all of its messages",
  },
  {
    id: "channel-add-members",
    steps: [],
    unreachable:
      "ChannelAddMembersDialog only opens from an Agent-posted channel:add_member action card in a conversation, and the seed has none",
  },
  {
    id: "channel-member-1",
    steps: [...channelMembers, clickIn("button", "^Remove channel admin from Jordan Lee$")],
    expect: "Can't demote Workspace admins",
  },
  {
    id: "channel-member-2",
    steps: [...channelMembers, clickIn("button", "^Remove Nova$")],
    expect: "^Remove Member",
  },
  {
    id: "channel-settings-dialog",
    steps: [...productSettings, fill("textbox", "^Name", "renamed"), press("Escape")],
    expect: "Unsaved Changes",
  },
  {
    id: "chat-section",
    steps: [goto(""), waitFor("link", "^#general"), activate("button", "^New Section")],
    expect: "Create Section",
  },
  {
    id: "create-channel",
    steps: [goto("/projects"), follow("^Open .*project"), click("button", "^Create Channel$")],
    expect: "Channel name",
    unreachable:
      "the single-column CreateChannelDialog opens from a Project's detail page or an Agent action card, and the seed has no Project",
  },
  {
    id: "create-group-chat",
    steps: [goto(""), click("button", "^Create Channel$")],
    expect: "Channel name",
  },
  {
    id: "stop-channel-agents",
    steps: [...productSettings, clickIn("button", "^Stop Agents$")],
    expect: "Stop All Agents",
  },
  {
    id: "pi-chat-session",
    steps: [goto("/pi-chat"), click("button", "^Conversation actions$")],
    expect: "Rename",
    unreachable:
      "AI Workbench is not available on the dev server (no cloud chat connection), so there is no Pi chat session to rename or delete",
  },
  {
    id: "create-project-1",
    steps: [goto("/projects"), click("button", "^Create Project$")],
    expect: "^New Project",
  },
  {
    id: "create-project-2",
    steps: [
      goto("/projects"),
      click("button", "^Create Project$"),
      clickIn("button", "^Start from scratch"),
    ],
    expect: "^New Project",
  },
  {
    id: "create-weekly-template",
    steps: [goto("/records/settings"), click("button", "^Create Template$")],
    expect: "Template Details",
  },
  {
    id: "record-side-panel-dialog",
    steps: [goto("/records?tab=weekly"), click("link", "^Weekly report$")],
    expect: "Rename",
    unreachable:
      "the rename dialog lives in a record's side panel chat and the seed has no weekly report or note to open (a weekly report needs an applied template first)",
  },
  {
    id: "records-delete",
    steps: [goto("/records/settings"), click("button", "^Delete$")],
    expect: "^Delete template",
  },
  {
    id: "weekly-send-confirm",
    steps: [goto("/records?tab=weekly"), click("link", "^Weekly report$")],
    expect: "Send",
    unreachable:
      "the send confirmation opens from a weekly report record or a weekly-report message card, and the seed has neither",
  },
  {
    id: "create-task",
    steps: [
      goto(""),
      follow("^#product"),
      click("tab", "^Tasks$"),
      click("button", "^Create Task$"),
    ],
    expect: "Add Another",
  },
  {
    id: "workspace-danger",
    steps: [goto("/settings?section=workspace-profile"), click("button", "^Delete Workspace$")],
    expect: "^Delete Workspace",
  },
  {
    id: "workspace-switcher",
    steps: [
      goto(""),
      click("button", "^Current workspace$"),
      click("menuitem", "^Create Workspace$"),
    ],
    expect: "^Create a New Workspace",
  },
];

// ---------------------------------------------------------------------------
// In-page helpers, injected into every evaluation.
