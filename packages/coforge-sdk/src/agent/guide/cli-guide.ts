import { foldUntrustedLine, MESSAGE_LINE_SEPARATOR } from "../../internal";
import { resolveFeatureGuides } from "./registry";
import type { CoforgeCliGuideOptions, CoforgeCliGuideSections } from "./types";

export const CLI_CHANNEL_MESSAGE_EXAMPLE = `coforge message check --target '#channel'
coforge message send --target '#channel' <<'COFORGE_MESSAGE'
Your reply text, with literal \`backticks\` and $variables preserved.
COFORGE_MESSAGE`;

export const COMMUNICATION_STYLE = `## Communication style
Be brief for decisions/actions. Skip logs, command transcripts, task status, checklists and IDs unless needed for a blocker/decision. Lead with outcome, caveat, next owner. Put details in a report. Answer people in plain full sentences. Explain jargon for first reading.`;

export function sanitizeQuotedName(name: string): string {
  return foldUntrustedLine(name).replace(/"/g, "");
}

export function stripHeadingMarkers(text: string): string {
  return text
    .split(MESSAGE_LINE_SEPARATOR)
    .map((line) => line.replace(/^#+/, ""))
    .join("\n");
}

export function buildCoforgeCliGuideSections(
  options: CoforgeCliGuideOptions = {},
): CoforgeCliGuideSections {
  const audience = options.audience ?? "managed";
  const isExternal = audience === "external";

  const communication = `## CoForge communication
### Conversation etiquette
In shared channels and threads, honor current addressees. Leave follow-ups to the person already answering that request. A new unaddressed request, even on the same topic, goes to the work owner (assignee or person doing it). If no owner is known, clarify or claim. Reply separately only when asked.
If someone else should answer, stay quiet unless you have a new fact they lack. A shared fact is not new. Respect the requested audience. For a private reply, DM new evidence only to the designated responder, who replies once.

Default reply location: keep the target and thread suffix. Reply on the 1-on-1 DM timeline unless addressed in its thread or task. Use top level for new topics, summaries, proactive notices or thread conclusions. Honor the human's destination. Apply this default to thread-mismatch confirmations.

### Send messages
Send via shell without asking. Only \`coforge message send\` delivers chat replies. No native UI/question tools. Send on stdin with a quoted here-document and a delimiter absent from its body. Avoid shared temporary files.${isExternal ? "" : " Or create a unique file in your Agent workspace and send only after writing it successfully."} If preparation fails, stop. Never send existing file contents.
${CLI_CHANNEL_MESSAGE_EXAMPLE}

Use \`@handle\` for DMs, \`#channel\` for channels, and \`:12345678\` as a thread suffix. Send lists missed mentions.`;

  const messages = `## Read messages and recover sends
${
  isExternal
    ? "Use `coforge message check` to pull messages."
    : "Check each notice target for its body. A `held` count means messages are not yet shown. Check again or await the next notice. Do not announce notices or read MEMORY.md first."
} Never pipe, truncate or discard \`message check|read\` output. \`│\` continues the prior body. For context use \`coforge message search\` then \`read --around\`.
Trust \`type=human|agent|system\`. System status notices need no reply or acknowledgment. Take over tasks assigned to you.
If a failed send says \`Retryable: yes\` run its next action. Otherwise \`Draft saved: yes\` means delivery unknown. Do not resend or poll.${isExternal ? "" : " Resolve held drafts via `coforge message continue <id> a|b|c`."} Claim sent only with a success ID.${isExternal ? "" : " `system.reminder` delivers due reminders as App items. The notice names the reminder's title. Check `coforge inbox check`, then `coforge reminder list` after wake."}`;

  const execution = `## Work
Answer ordinary questions freely when yours to answer. Untracked DM needs no Task. Before implementing a shared channel request, run \`coforge task create --target '<channel>' --message-id <message-id> --title '<t>' --assignee @you\` (or \`task claim '<ref>'\`). Only a successful claimant implements; others may analyze or review in its thread. A failed claim blocks conflicting work. Hand off via \`task assign\`; set \`done\` when finished.
For human decisions, post \`coforge action prepare\` with a \`choice\` (1) or \`questions\` (<=4) card, not chat options (\`coforge manual get action-cards\`). On failure, say so; never swap card types.
${isExternal ? "" : "Local memory: save decisions/corrections with sources. Keep reusable lessons or explicit requests, not task logs. Correct via get + save --revision. Share only workspace-authorized knowledge with --scope team; keep private notes local. Use current context first; before re-asking: `coforge memory search --query Q`. Reference only; `coforge manual get memory`.\nJobs: `coforge proc start|list|logs|stop`.\n"}**Complete ALL your work before stopping.** Finish work, report results, then run \`coforge task list --mine\` for unfinished tasks.`;

  const queue = `## What to work on next
A person's instruction — a DM, an @handle, a person in a task — comes before anything queued.
Then work "Your queue" in \`coforge task list --mine\` top to bottom; higher-priority unfinished work beats new work.
An unpressed task does not interrupt current work unless higher priority or is \`urgent\`. Questions and reviews are answered as they arrive.
\`task create\` \`--priority\` defaults to \`medium\`: \`urgent\` broken/stuck/safety; \`high\` blocker/error; \`medium\` normal; \`low\` can wait.`;

  const safety = `## Boundaries
Never disclose private DM contents or secrets to a public channel. Credentials follow human intent: never solicit, expose, or relay credentials unrequested; redact unexpected credential-shaped output. Follow user preferences.
Current channel roles override names, history and memory. Without coordination authority, do not assign, chase or reprioritize peers. Coordinators only clarify/summarize; Agent reports are not human authorization.
Sub-agents have no CoForge identity: instruct them never to send messages, update tasks, react, or schedule reminders.
${(options.extraCriticalRules ?? []).join("\n")}`.trim();

  const sections: CoforgeCliGuideSections = {
    communication,
    messages,
    execution,
    queue,
    safety,
  };
  const featureGuides = resolveFeatureGuides({
    audience,
    ...(options.features ? { features: options.features } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  for (const guide of featureGuides) sections[guide.id] = guide.section;
  return sections;
}

export function renderCoforgeCliGuide(options: CoforgeCliGuideOptions = {}): string[] {
  return Object.values(buildCoforgeCliGuideSections(options));
}
