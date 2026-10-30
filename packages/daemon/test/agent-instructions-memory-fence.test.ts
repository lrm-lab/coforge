import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const directory = "/coforge/workspaces/workspace-a/agents/agent-a";
const AGENT_WORKSPACES: [string, string] = [
  "/coforge/workspaces/workspace-a/agents/agent-a",
  "/coforge/workspaces/workspace-b/agents/agent-b",
];
test("the openviking-memory profile queries before retrieval Offers and protects tenant secrets", () => {
  const fenced = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: AGENT_WORKSPACES[0],
    toolProfile: "openviking-memory",
    memoryOfferOnly: false,
  });
  expect(fenced).toContain("## Team memory (Memory Agent)");
  expect(fenced).toContain(
    "Retrieval questions require a memory query before an Offer; diagnosis questions use memory_diagnose.",
  );
  expect(fenced).toContain("Use message_read with the exact target");
  expect(fenced).not.toContain("Use message_check or message_read");
  expect(fenced).not.toContain("Bearer");
  expect(fenced).not.toContain("CAUSAL_MEMORY_TOKENS");
  expect(
    buildCoforgeAgentInstructions({ agentWorkspaceDirectory: AGENT_WORKSPACES[0] }),
  ).not.toContain("## Team memory (Memory Agent)");
});

const OPENVIKING_FENCE_TOOLS = [
  "ov_fork_find",
  "ov_expand",
  "memory_offer",
  "memory_diagnose",
] as const;
const CAUSAL_ONLY_TOOLS = [
  "causal_search",
  "causal_trace",
  "causal_intervention",
  "causal_propose_correction",
] as const;
const MUTATION_TOOL_NAMES = [
  "bash",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "filesystem",
  "network",
  "ov_write",
  "ov_commit",
  "session_commit",
] as const;
const CREDENTIAL_WORDS = [
  "Bearer",
  "credential",
  "token",
  "endpoint",
  "secret",
  "password",
  "api key",
  "API key",
] as const;
const ALLOWED_MUTATION_PHRASES = [
  "you may write",
  "you can write",
  "you may commit",
  "you can commit",
  "you may mutate",
  "you can mutate",
  "you may invalidate",
  "you can supersede",
] as const;

function memoryAgentSection(prompt: string): string {
  const start = prompt.indexOf("## Team memory (Memory Agent)");
  expect(start).toBeGreaterThan(-1);
  const after = prompt.slice(start);
  const next = after.slice(1).search(/\n## /);
  return next === -1 ? after : after.slice(0, next + 1);
}

function allowedToolsetListing(section: string): string {
  const match = section.match(/Your tools are the whole toolset:\n([\s\S]*?)\n\n-/);
  expect(match?.[1]).toBeDefined();
  return match![1]!;
}

function instructionsForFence(toolProfile: "openviking-memory"): string {
  return buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: AGENT_WORKSPACES[0],
    toolProfile,
    memoryOfferOnly: false,
  });
}

test("the openviking-memory fence names reads and server-owned memory controls", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  const listing = allowedToolsetListing(section);
  for (const name of OPENVIKING_FENCE_TOOLS) expect(listing).toContain(name);
  expect(listing).not.toContain("ov_find");
  expect(listing).not.toContain("ov_search_context");
  expect(listing).not.toContain("ov_read");
  expect(section).toContain("memory_diagnose");
  for (const name of CAUSAL_ONLY_TOOLS) expect(listing).not.toContain(name);
  expect(section).toContain(
    "Retrieval questions require a memory query before an Offer; diagnosis questions use memory_diagnose.",
  );
  expect(section).toContain("cannot write files");
  expect(section).toContain("commit sessions");
  expect(section).toContain("skills or ACLs");
  expect(section).toContain("cannot directly modify OpenViking memory");
});

test("the memory fence lists no mutation tools and allows no mutation verbs", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  const listing = allowedToolsetListing(section);
  for (const name of MUTATION_TOOL_NAMES) expect(listing).not.toContain(name);
  const allowedContext = listing.toLowerCase();
  expect(allowedContext).not.toMatch(/\bwrite\b/);
  expect(allowedContext).not.toMatch(/\bcommit\b/);
  expect(allowedContext).not.toMatch(/\bmutate\b/);
  expect(allowedContext).not.toMatch(/\binvalidate\b/);
  expect(allowedContext).not.toMatch(/\bsupersede\b/);
  const lowered = section.toLowerCase();
  for (const phrase of ALLOWED_MUTATION_PHRASES) expect(lowered).not.toContain(phrase);
});

test("the memory fence shows copyable tool JSON and does not teach shell message send", () => {
  const fenced = instructionsForFence("openviking-memory");
  const section = memoryAgentSection(fenced);
  expect(section).toContain('{"operationId": "find-1", "query": "<检索词>", "limit": 10}');
  expect(section).toContain(
    '{"operationId": "offer-1", "citationRefs": ["<ov_fork_find/ov_expand 返回的 citation id>"], "body": "<给 @task 的正文>"}',
  );
  expect(section).toContain('{"target": "#<频道名>"}');
  expect(section).toContain('{"target": "#<频道名>", "content": "<正文>"}');
  expect(section).toContain("The body field name is content, not message.");
  expect(section).toContain("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  expect(section).toContain("at least 1");
  expect(fenced).not.toContain("coforge message send");
  expect(fenced).toContain("## Boundaries");
});

test("the memory fence renders no credentials, tokens, or hidden endpoints", () => {
  const section = memoryAgentSection(instructionsForFence("openviking-memory"));
  for (const word of CREDENTIAL_WORDS) expect(section).not.toContain(word);
  expect(section).not.toContain("/api/");
  expect(section).not.toMatch(/https?:\/\//);
  expect(section).not.toContain("localhost");
});

test("strict eval Memory instructions agree with the Offer-only toolset", () => {
  const fenced = buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: directory,
    toolProfile: "openviking-memory",
    memoryOfferOnly: true,
  });
  expect(allowedToolsetListing(memoryAgentSection(fenced))).toContain(
    "message_check, and message_read",
  );
  expect(fenced).not.toContain("send_channel_message");
  expect(fenced).not.toContain("coforge message");
  expect(fenced).not.toContain("coforge task");
  expect(fenced).toContain("check/read → query → one memory_offer");
  expect(fenced).toContain("published=true");
  expect(fenced).toContain("400 or isError");
  expect(fenced).toContain("end this turn");
  expect(fenced).toContain("body, not content");
});

test("a fenced prompt teaches the native inbox read and no CLI command", () => {
  const prompt = instructionsForFence("openviking-memory");
  expect(prompt).toContain("## Inbox");
  expect(prompt).toContain("Use message_read with the exact target");
  expect(prompt).toContain("Continue while hasNewer is true");
  expect(prompt).toContain("A held count means");
  expect(prompt).not.toContain("coforge message");
});
