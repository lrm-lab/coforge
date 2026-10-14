import {
  CHANNEL_ARGUMENT_EXAMPLES,
  OPENVIKING_ARGUMENT_EXAMPLES,
  OPENVIKING_OPERATION_ID_RULE,
  toolsForMemoryFence,
  type MemoryAgentToolProfile,
} from "@lrm/coforge-sdk/agent";

/** Set only by the collaboration evaluation's daemon assembly. */
export const EVAL_MEMORY_OFFER_ONLY = "COFORGE_EVAL_MEMORY_OFFER_ONLY";

export function evalMemoryOfferOnly(): boolean {
  return Bun.env[EVAL_MEMORY_OFFER_ONLY] === "1";
}

/** Minimal transport instructions; feature workflows belong in event output or the Manual. */
export type AgentLaunchIdentity = {
  name?: string;
  displayName?: string;
  description?: string;
  runtimeContext?: {
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    computerId?: string;
    computerName?: string;
    computerHostname?: string;
    computerOs?: string;
    computerVersion?: string;
  };
};

/**
 * Everything `buildCoforgeAgentInstructions` needs. `agentWorkspaceDirectory` and `agentId` are
 * local facts the daemon always has; `identity` is server-authored and optional end to end. The
 * daemon's only local contribution is the Agent workspace path and the `agentId`.
 */
export type CoforgeAgentPromptContext = {
  agentWorkspaceDirectory: string;
  agentId?: string;
  identity?: AgentLaunchIdentity;
  /** Runtime tool fence for the Memory Agent. Absent keeps the ordinary Agent toolset. */
  toolProfile?: MemoryAgentToolProfile;
  memoryOfferOnly?: boolean;
  /** Provider hook appended to the Boundaries section. Empty by default; no CoForge
   * provider passes anything here today. */
  extraCriticalRules?: readonly string[];
};

/** Collapses newlines/whitespace runs to a single space and trims; used wherever user-written
 * identity text (displayName, description, name) is rendered inline so it cannot inject blank
 * lines or forge Markdown structure through whitespace alone. Exported for `agent-memory-seed.ts`,
 * which applies the same rule to the name rendered into the seeded MEMORY.md heading. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Sanitizes a value quoted inline in the identity opening: collapses newlines to spaces and
 * strips double quotes so the quoted name cannot break out of its own quotes. */
function sanitizeQuotedName(name: string): string {
  return collapseWhitespace(name).replace(/"/g, "");
}

/** Strips any line-leading `#` characters so a user-written description cannot forge a Markdown
 * heading inside the Role bullet or the seeded MEMORY.md `## Role` section. Exported for
 * `agent-memory-seed.ts`. */
export function stripHeadingMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^#+/, ""))
    .join("\n");
}

function labelWithId(label: string | undefined, id: string | undefined): string | undefined {
  if (label && id) return `${label} (${id})`;
  return label || id;
}

/**
 * `## Current Runtime Context`: bullets only for known values. `Workspace` names the tenant, so
 * the directory bullet is labelled `Agent workspace`. Provider processes also receive the full
 * runtime context through environment variables; keep host diagnostics out of the standing prompt
 * and let the Agent query them when needed.
 */
function buildRuntimeContextSection(context: CoforgeAgentPromptContext): string {
  const identity = context.identity;
  const runtimeContext = identity?.runtimeContext;
  const lines = ["## Current Runtime Context", ""];
  const description = identity?.description?.trim();
  if (description) lines.push(`- Role: ${collapseWhitespace(stripHeadingMarkers(description))}`);
  if (identity?.name) lines.push(`- Username: @${collapseWhitespace(identity.name)}`);
  if (context.agentId) lines.push(`- Agent ID: ${context.agentId}`);
  const workspace = labelWithId(runtimeContext?.workspaceName, runtimeContext?.workspaceSlug);
  if (workspace) lines.push(`- Workspace: ${workspace}`);
  const computer = labelWithId(runtimeContext?.computerName, runtimeContext?.computerId);
  if (computer) lines.push(`- Computer: ${computer}`);
  lines.push(`- Agent workspace: ${context.agentWorkspaceDirectory}`);
  return lines.join("\n");
}

export function buildCoforgeAgentInstructions(context: CoforgeAgentPromptContext): string {
  const rawName = context.identity?.displayName || context.identity?.name;
  const who = rawName
    ? `You are "${sanitizeQuotedName(rawName)}", an AI agent in CoForge.`
    : "You are an AI agent in CoForge.";
  const guide = buildCoforgeCliGuideSections(context);
  const sections = [who, buildRuntimeContextSection(context)];
  // Fence agents have no shell. The ordinary send heredoc taught copy-prone models
  // a `message` key; channel I/O is the tool examples in the Memory Agent section.
  if (context.toolProfile) {
    sections.push(
      buildMemoryAgentSection(
        context.toolProfile,
        context.memoryOfferOnly ?? evalMemoryOfferOnly(),
      ),
      "## Inbox\nAn inbox notice lists targets, not bodies. Use message_check or message_read with the exact target, including any thread suffix. Either may return nothing. Do not announce the notice or poll for messages.",
      guide.safety,
    );
  } else {
    sections.push(...Object.values(guide));
  }
  return sections.join("\n\n");
}

const MEMORY_AGENT_CHANNEL_TOOLS = [
  "send_channel_message",
  "message_check",
  "message_read",
] as const;

const MEMORY_AGENT_MUTATION_PROHIBITION =
  "You cannot write files, commit sessions, or change skills or ACLs, and you cannot directly modify OpenViking memory.";

function formatMemoryAgentToolset(profile: MemoryAgentToolProfile, offerOnly: boolean): string {
  const names = [
    ...toolsForMemoryFence(profile),
    ...MEMORY_AGENT_CHANNEL_TOOLS.filter((name) => !offerOnly || name !== "send_channel_message"),
  ];
  const last = names.at(-1);
  return `${names.slice(0, -1).join(", ")}, and ${last}`;
}

function buildMemoryAgentSection(profile: MemoryAgentToolProfile, offerOnly: boolean): string {
  return `## Team memory (Memory Agent)

You are this Workspace's Memory Agent. Your tools are the whole toolset:
${formatMemoryAgentToolset(profile, offerOnly)}.

- An explicit @memory question requires a memory query before you answer.
${offerOnly ? "- Strict evaluation order: check/read → query → one memory_offer. Only published=true confirms a successful handoff; then end this turn and send no further channel messages, including handoff notifications. A 400 or isError is not a sent message: correct the tool arguments and never claim handoff succeeded without published=true. The Offer field is body, not content." : "- Answer that question only with memory_offer. send_channel_message cannot answer it.\n- Ordinary PublicChannel messages leave query choice to you."}
- You may publish one Memory Offer with memory_offer. ${MEMORY_AGENT_MUTATION_PROHIBITION}
- You have no shell, filesystem, or generic network tools.

Copy the arguments JSON below exactly, replacing angle-bracket placeholders. Put every argument in the arguments JSON. An empty object is invalid. ${OPENVIKING_OPERATION_ID_RULE}

ov_find: ${OPENVIKING_ARGUMENT_EXAMPLES.find}
ov_search_context: ${OPENVIKING_ARGUMENT_EXAMPLES.search_context}
ov_read: ${OPENVIKING_ARGUMENT_EXAMPLES.read}
memory_offer: ${OPENVIKING_ARGUMENT_EXAMPLES.offer}
citationRefs is an array of citation ids already returned in this workspace (at least 1).
message_check: ${CHANNEL_ARGUMENT_EXAMPLES.message_read}
message_read: ${CHANNEL_ARGUMENT_EXAMPLES.message_read}${offerOnly ? "" : `\nsend_channel_message: ${CHANNEL_ARGUMENT_EXAMPLES.send_channel_message}\nThe body field name is content, not message.`}`;
}

export type CoforgeCliGuideOptions = Pick<CoforgeAgentPromptContext, "extraCriticalRules">;
export type CoforgeCliGuideSections = ReturnType<typeof buildCoforgeCliGuideSections>;

export const CLI_CHANNEL_MESSAGE_EXAMPLE = `Targets starting with # must be quoted. Send bodies on stdin, never a positional argument; double quotes expand backticks and $, so use a single-quoted heredoc delimiter:
coforge message check --target '#channel'
coforge message send --target '#channel' <<'COFORGE_MESSAGE'
Your reply text, with literal \`backticks\` and $variables preserved.
COFORGE_MESSAGE`;

export function buildCoforgeCliGuideSections(options: CoforgeCliGuideOptions = {}) {
  return {
    communication: `## CoForge communication
Use the shell tool to execute CoForge commands: text outside an executed \`coforge message send\` command is not delivered to chat. Reply to direct user messages; reply in channels when addressed or useful. Reuse the exact \`target=\`, including its thread suffix.
Reply where the conversation is: a top-level message gets a top-level reply, a thread message a reply in its thread, and a request you claimed as a Task its Task thread. You may post a new topic or a thread's conclusion at top level, or use the place a human names. This is a default, not a hard rule; decide a thread-mismatch send confirmation by it.
Send the reply on stdin with \`coforge message send --target '<target>'\`.
${CLI_CHANNEL_MESSAGE_EXAMPLE}

Targets: \`'@handle'\` for DM, \`'#channel'\` for a channel; append \`:12345678\` for a thread inside the quotes. Inline @handles mention channel members; send reports missed mentions. Trust \`type=human|agent|system\`; system notices are not user requests.`,
    messages: `## Read and send
An inbox notice lists targets, not bodies. Run \`coforge message check --target '<target>'\` for each; respond when useful. Do not announce the notice or read MEMORY.md first. Unscoped \`check\` finds other targets. Check marks results read. For older/thread context, use \`coforge message search\` then \`read --around\`.
If a failed send says \`Retryable: yes\`, run its next action; else \`Draft saved: yes\` means unknown delivery: do not resend automatically. Do not poll for new messages.`,
    execution: `## Work
Answer ordinary questions freely; untracked DM work needs no Task. Before implementing a shared channel request, claim its original top-level message with \`coforge task claim --target '<channel>' --message-id <root-message-id>\` (existing Task: \`--number <n>\`); avoid duplicates. Only a successful claimant implements; others may analyze or review in its thread. If a claim fails, do not start conflicting execution. Finish tracked work as in_review, then done after human approval.
Read MEMORY.md only when this request lacks context; an inbox notice is not missing context. Save useful cross-session facts. Before a long task, note where you are in notes/active-context.md to resume.`,
    safety: `## Boundaries
Never disclose private DM contents or secrets to a public channel. Do not solicit or expose credentials; redact unexpected secrets. Workspace permissions are enforced by the server. Follow user preferences for communication.
${(options.extraCriticalRules ?? []).join("\n")}`.trim(),
  };
}
