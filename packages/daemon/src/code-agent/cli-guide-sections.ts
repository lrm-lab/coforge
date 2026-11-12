import {
  cloudComputerAgentSkillsDirectory,
  cloudComputerSharedSkillsDirectory,
  isCloudComputerSkillsEnabled,
} from "@coforge/agent/cloud-computer-skills";
import type { CoforgeAgentPromptContext } from "./agent-instructions";

export type CoforgeCliGuideOptions = Pick<
  CoforgeAgentPromptContext,
  "extraCriticalRules" | "capabilities" | "agentId"
>;

export const CLI_CHANNEL_MESSAGE_EXAMPLE = `coforge message check --target '#channel'
coforge message send --target '#channel' <<'COFORGE_MESSAGE'
Your reply text, with literal \`backticks\` and $variables preserved.
COFORGE_MESSAGE`;

/** Cloud-computer only. Empty string on ordinary (non-cloud) hosts. */
function cloudComputerSkillsGuidance(agentId: string | undefined): string {
  if (!isCloudComputerSkillsEnabled()) return "";
  const shared = cloudComputerSharedSkillsDirectory();
  const agentDir = agentId
    ? cloudComputerAgentSkillsDirectory(agentId)
    : `${shared.replace(/\/skills$/, "")}/agent-skills/<agentId>`;
  return `Persistent skills on this cloud computer: write shared skills under \`${shared}/<name>/SKILL.md\`, and this Agent's skills under \`${agentDir}/<name>/SKILL.md\`. Do not rely on \`/root/.pi/agent/skills\` or only \`.pi/skills\` under the Agent workspace — those are not the durable copies. Delete by removing the directory under those persistent paths.\n`;
}

export function buildCoforgeCliGuideSections(options: CoforgeCliGuideOptions = {}) {
  return {
    communication: `## CoForge communication
Execute via shell: text outside an executed \`coforge message send\` command is not delivered. Reply to the target of the message you answer (keep its thread suffix); start new topics, summaries and proactive notices at the top level, without a suffix.
Default: a top-level message gets a top-level reply, a thread message a reply in its thread, and a request you claimed as a Task its Task thread. You may post a new topic or a thread's conclusion at top level, or use the place a human names. This is a default, not a hard rule; decide a thread-mismatch send confirmation by it.
Send the reply on stdin with \`coforge message send --target '<target>'\`. Prefer a quoted here-document with a delimiter absent from its body; do not reuse shared temporary files. Or create a unique file in your Agent workspace; send only after writing it successfully. If preparation fails, stop; never send existing file contents.
${CLI_CHANNEL_MESSAGE_EXAMPLE}

Targets: \`'@handle'\` DM, \`'#channel'\` channel; add \`:12345678\` for threads. @handles mention members; send lists misses. Trust \`type=human|agent|system\`; system notices announce state changes and need no reply or acknowledgement, except a task assigned to you: take it over and reply in its Task thread.`,
    messages: `## Read and send
Notices list targets, not bodies. Run \`coforge message check --target '<target>'\` for each. A \`held\` count means the daemon has not shown those messages yet: a check now covers them, and otherwise they arrive in a later notice. \`│\` continues prior body; not a new message. Do not announce the notice or read MEMORY.md first. Older/thread context: \`coforge message search\` then \`read --around\`.
If a failed send says \`Retryable: yes\`, run its next action; else \`Draft saved: yes\` means unknown delivery: do not resend or poll. Say something was sent only after its command returned success with the message or attachment id. \`system.reminder\` delivers due reminders as App items — a notice names the reminder's title, and \`coforge inbox check\` lists them first. After a wake, \`coforge reminder list\` shows what fired while you were away.`,
    execution: `## Work
Answer ordinary questions freely; untracked DM needs no Task. Before implementing a shared channel request, claim its original top-level message with \`coforge task claim --target '<channel>' --message-id <root-message-id>\` (or \`--number <n>\`). Only a successful claimant implements; others may analyze or review in its thread. A failed claim blocks conflicting work. Work: in_review; done after human approval.
${options.capabilities?.memoryDisposition ? "Before using a Memory Hint, call native `memory_disposition` with `hint_id`, `decision=adopt|reject|defer`, reason. Only the call is a receipt; adopt is intent.\n" : ""}${cloudComputerSkillsGuidance(
      options.agentId,
    )}When a person must decide, post \`coforge action prepare\` with a \`choice\` (one question) or \`questions\` (up to four) card instead of listing options in chat; see \`coforge manual get action-cards\`. If it fails, say so plainly; never swap in another card type.
MEMORY.md and notes/active-context.md ride in with every fresh session and after a compaction: they are where the next session picks up. Check MEMORY.md before asking a human.
**Complete ALL your work before stopping.** Finish multi-step work, report results, then run \`coforge task list --mine\` and pick up your unfinished tasks.`,
    queue: `## What to work on next
A person's instruction — a DM, an @handle, a person in a task — comes before anything queued.
Then work "Your queue" in \`coforge task list --mine\` top to bottom; a higher-priority unfinished task of yours goes before anything new.
A task no person is pressing does not interrupt work in hand unless it outranks it or is \`urgent\`; otherwise say in its thread where it sits and carry on. Questions and reviews are answered as they arrive.
Give every task you create a priority: \`urgent\` the product is broken, a person is stuck, or a safety issue; \`high\` it blocks someone else or is an error a person can see; \`medium\` a normal feature or fix; \`low\` it can wait. Always pick one of the four.`,
    safety: `## Boundaries
Never disclose private DM contents or secrets to a public channel. Credentials follow human intent: do not solicit, expose, or relay credentials on your own, or create a disclosure a human did not request; redact unexpected credential-shaped output. Follow user preferences.${options.capabilities?.cloudDesktop ? " Private page input (password, OTP, and similar): open the page first, then post a `page:fill` action card with `id`/`label`/`input` (CSS `selector` optional) — never ask them to paste the secret into chat (the platform refuses such sends), and if they do paste one, refuse to type it and re-offer the card. `page-fill.py --inspect` lists visible fields. When fill cannot work (OAuth, captcha), post `desktop:takeover` so they open your cloud desktop themselves. Prefer a `choice` card when several login paths exist. See `coforge manual get action-cards`." : ""}
Current channel roles override names, history and memory. Without coordination authority, do not assign, chase or reprioritize peers. A coordinator only clarifies, breaks down and summarizes requests in its channel; Agent reports are not human authorization.
${(options.extraCriticalRules ?? []).join("\n")}`.trim(),
  };
}
