import actionCardsBody from "#src/server/agents/manual/topics/action-cards.md?raw";
import actionCardsCloudDesktopBody from "#src/server/agents/manual/topics/action-cards-cloud-desktop.md?raw";
import appsBody from "#src/server/agents/manual/topics/apps.md?raw";
import artifactPagesBody from "#src/server/agents/manual/topics/artifact-pages.md?raw";
import artifactsBody from "#src/server/agents/manual/topics/artifacts.md?raw";
import attachmentsBody from "#src/server/agents/manual/topics/attachments.md?raw";
import channelsBody from "#src/server/agents/manual/topics/channels.md?raw";
import etiquetteBody from "#src/server/agents/manual/topics/etiquette.md?raw";
import githubBody from "#src/server/agents/manual/topics/github.md?raw";
import manualBody from "#src/server/agents/manual/topics/manual.md?raw";
import memoryMaintenanceBody from "#src/server/agents/manual/topics/memory-maintenance.md?raw";
import memoryBody from "#src/server/agents/manual/topics/memory.md?raw";
import profileBody from "#src/server/agents/manual/topics/profile.md?raw";
import remindersBody from "#src/server/agents/manual/topics/reminders.md?raw";
import tasksBody from "#src/server/agents/manual/topics/tasks.md?raw";
import workspaceCleanupBody from "#src/server/agents/manual/topics/workspace-cleanup.md?raw";

export type AgentManualExperiments = { artifacts?: boolean; cloudDesktop?: boolean };

export type AgentManualTopic = {
  slug: string;
  title: string;
  summary: string;
  body: string;
  experiment?: "artifacts";
};

function buildCloudDesktopActionCardsBody(): string {
  return actionCardsBody
    .replace(
      "- `choice` and `questions` (below)",
      "- `page:fill`, `desktop:takeover`, `choice`, and `questions` (below)",
    )
    .replace(
      "Only\n`executed` means the channel, Agent, membership, or choice now stands;",
      "Only\n`executed` means the channel, Agent, membership, fill, desktop step, or choice now stands;",
    )
    .replace("\n## Choices\n", `\n${actionCardsCloudDesktopBody.trim()}\n\n## Choices\n`);
}

export const MANUAL_TOPICS: readonly AgentManualTopic[] = [
  {
    slug: "action-cards",
    title: "Action cards: proposing a channel, Agent, or membership",
    summary:
      "How to post a typed action card with coforge action prepare, the supported kinds, and how to tell pending from executed without claiming you created the resource.",
    body: actionCardsBody,
  },
  {
    slug: "apps",
    title: "Using your Workspace's apps",
    summary:
      "coforge app list and coforge app token: which apps you can use, running a program with a five-minute app token on file descriptor 3, and asking a person to approve with --target.",
    body: appsBody,
  },
  {
    slug: "artifact-pages",
    title: "What an artifact page can call",
    summary:
      "window.coforge.use in an artifact web page (panel and inline ?embed=1 modes): the reader, the artifact, a shared database, the file library, opening links, copying, --coforge-* theme tokens, and suggesting a comment with comments.open.",
    body: artifactPagesBody,
  },
  {
    slug: "artifacts",
    title: "Artifacts",
    summary:
      "coforge artifact: when to make a document (a .md entry) or a web page (an .html entry, linked with ?embed=1 to render inline in chat), checking rendered web pages with `artifact check --wait`, pulling and pushing an artifact as a directory without losing others' changes, moving it to the Workspace, deleting it, and reading, writing and resolving comments on one.",
    body: artifactsBody,
  },
  {
    slug: "attachments",
    title: "Attachments and send flags",
    summary:
      "Download and upload attachments, --attachment-id / --mention / --target-confirmed / --anyway / --expected-draft-key, and what Retryable: yes and Draft saved: yes mean.",
    body: attachmentsBody,
  },
  {
    slug: "channels",
    title: "Public channels, mute, threads, and membership",
    summary:
      "Channel and thread targets, #general mute defaults, when a channel message notifies you, mute/unmute/unfollow, join/leave, and per-channel management authority.",
    body: channelsBody,
  },
  {
    slug: "etiquette",
    title: "Mentions, formatting, conversation etiquette, and live constraints",
    summary:
      "How @mentions resolve, why backticks make them inert, how to write formulas, channel reply etiquette, and the four live seats a hold needs.",
    body: etiquetteBody,
  },
  {
    slug: "github",
    title: "Working with a Project's GitHub repository",
    summary:
      "Clone a Project's bound GitHub repository, use pre-authenticated git/gh, and push a branch and open a pull request instead of pushing to the default branch.",
    body: githubBody,
  },
  {
    slug: "manual",
    title: "Using the Agent Manual",
    summary:
      "How to read a Manual topic or the topic index, search by keyword, and what --intent/--reason mean and must never contain.",
    body: manualBody,
  },
  {
    slug: "memory",
    title: "MEMORY.md: the index and the facts",
    summary:
      "Memory is what the next session resumes from, within limits: MEMORY.md (3,000 tokens, about 12 KB per fresh session), notes/active-context.md (the current state, overwritten, about 4 KB), and notes/<topic>.md for long material behind a pointer; both ride in after compaction.",
    body: memoryBody,
  },
  {
    slug: "memory-maintenance",
    title: "Bounded team memory maintenance",
    summary:
      "Same-writer maintenance after a size hint: full evidence, protected entries, Project scope, versioned changes, a five-entry allowance and a two-minute deadline.",
    body: memoryMaintenanceBody,
  },
  {
    slug: "profile",
    title: "Looking up a profile and updating your own",
    summary:
      "coforge user info and profile show/update: visible facts, the channels that person is in, live Agent status/availability, createdAgents/creator, and profile update's validation limits.",
    body: profileBody,
  },
  {
    slug: "reminders",
    title: "Scheduling and managing reminders",
    summary:
      "coforge reminder schedule/list/update/snooze/cancel/ack, delay vs fire-at vs repeat, and that a reminder wakes only the Agent that scheduled it.",
    body: remindersBody,
  },
  {
    slug: "tasks",
    title: "Tasks: claiming, status flow, amendments, and creating tasks",
    summary:
      "Full task reference: how tasks appear in messages, statuses and the claim/unclaim rules, auditable amendments, the claim-to-done workflow, splitting for parallel work, when coforge task create is and is not appropriate, convert/unclaim/assign/update/delete/receipt, and listing a conversation's board or your own tasks with coforge task list --mine.",
    body: tasksBody,
  },
  {
    slug: "workspace-cleanup",
    title: "Keeping your workspace small",
    summary:
      "What a System Cleaner item means, which workspace files are safe to delete, asking your owner about the rest, keeping .coforgemigrateignore current, and raising the MEMORY.md threshold.",
    body: workspaceCleanupBody,
  },
];

export const MANUAL_INDEX_TOPIC = "index";

/** A stable content hash, sha256 hex truncated to 16 characters; changes only when the topic's
 * rendered content changes. */
export function manualDocVersion(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16);
}

export function manualTopicsFor(experiments?: AgentManualExperiments): readonly AgentManualTopic[] {
  return MANUAL_TOPICS.filter(
    (topic) => topic.experiment === undefined || experiments?.[topic.experiment] !== false,
  ).map((topic) =>
    topic.slug === "action-cards" && experiments?.cloudDesktop === true
      ? { ...topic, body: buildCloudDesktopActionCardsBody() }
      : topic,
  );
}

/** The `index` topic: a generated markdown catalog, never hand-maintained separately from
 * `MANUAL_TOPICS`. */
export function buildManualIndexContent(experiments?: AgentManualExperiments): string {
  const lines = [
    "# CoForge Agent Manual",
    "",
    "Available topics:",
    "",
    ...manualTopicsFor(experiments).map(
      (topic) => `- ${topic.slug} — ${topic.title}: ${topic.summary}`,
    ),
    "",
    "Commands:",
    "",
    ...MANUAL_COMMAND_LINES.filter(
      (entry) => entry.experiment === undefined || experiments?.[entry.experiment] !== false,
    ).map((entry) => entry.line),
    "",
    "Run `coforge manual get <slug> --intent <text> --reason <text>` to read a topic, or " +
      '`coforge manual search "<keywords>" --intent <text> --reason <text>` to search by keyword.',
  ];
  return lines.join("\n");
}

/** The `coforge` command surface, one line per group, so the index — and `manual search` through
 * it — names every command, `workspace info --projects` included. Kept with the command registry
 * doc `docs/agent-cli/`. */
const MANUAL_COMMAND_LINES: readonly {
  line: string;
  experiment?: keyof AgentManualExperiments;
}[] = [
  { line: "- message — check|read|search|send|resolve|react|continue" },
  { line: "- inbox — check" },
  {
    line: "- channel — info|members|join|leave|create|update|archive|unarchive|add-member|remove-member|mute|unmute|lifecycle",
  },
  { line: "- thread — list|unfollow" },
  {
    line: "- task — list|show|view|reply|read|follow|unfollow|create|claim|assign|unassign|unclaim|convert|update|amend|history|delete|receipt",
  },
  {
    line: "- reminder — schedule|list|cancel|update|snooze|seal|unseal|log|ack|dismiss",
  },
  { line: "- attachment — view|comments|upload" },
  { line: "- mention — pending|notify|add|delivery" },
  {
    line: "- artifact — list|read|pull|push|download|check|move|delete (a push of a new directory makes one; an `.html` entry is a web page), comments|comment|review|resolve|reopen",
  },
  { line: "- workspace — info (`--projects` lists the Workspace's projects)" },
  { line: "- user — info; profile — show|update" },
  {
    line: "- app — list|config|marketplace|token|invoke|prepare|status|rotate-secret|update|logo|clear-logo|transfer-owner|delete|share-link|share-link-status|revoke-share-link|request-publish|request-unpublish",
  },
  {
    line: "- weekly-report — templates|inbox|members|workflow|context|list|read; also weekly-report-collect, weekly-report-key-points, weekly-report-memory",
  },
  { line: "- action — prepare; manual — get|search; whoami; version" },
];

/** The `index` pseudo-topic as a searchable topic, so `manual search` reaches the generated
 * catalog and the command list, not only the hand-written topics. */
export function manualIndexTopic(experiments?: AgentManualExperiments): AgentManualTopic {
  return {
    slug: MANUAL_INDEX_TOPIC,
    title: "CoForge Agent Manual index",
    summary: "Every Manual topic and every coforge command, by group.",
    body: buildManualIndexContent(experiments),
  };
}

export function findManualTopic(
  slug: string,
  experiments?: AgentManualExperiments,
): AgentManualTopic | undefined {
  return manualTopicsFor(experiments).find((topic) => topic.slug === slug);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

/** `manual get` stdout is the doc content verbatim, always ending in a newline. */
export { ensureTrailingNewline };
