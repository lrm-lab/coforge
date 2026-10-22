import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  EXPERIENCE_CARD_KINDS,
  EXPERIENCE_DELIVERABLE_KINDS,
  EXPERIENCE_ISSUE_KINDS,
  OPENVIKING_GRAPH_RELATIONS,
  OPENVIKING_TOOL_NAMES,
  type OpenVikingAgentCommand,
} from "@lrm/coforge-sdk/agent";
import { Type } from "typebox";

type FenceTool = ReturnType<typeof defineTool>;

type OpenVikingFenceTool = (
  name: string,
  label: string,
  description: string,
  op: OpenVikingAgentCommand["op"],
  parameters: Parameters<typeof Type.Object>[0],
) => FenceTool;

/** OpenViking tool schemas for the Memory fence. Split out so runner.ts stays within the size ratchet. */
export function memoryFenceOpenVikingTools(
  openvikingTool: OpenVikingFenceTool,
): Record<string, FenceTool> {
  return {
    [OPENVIKING_TOOL_NAMES.diagnose]: openvikingTool(
      OPENVIKING_TOOL_NAMES.diagnose,
      "Diagnose with four roles",
      "Start or poll four-role AIG construction and diagnosis. You may decide from observed Task progress to diagnose repeated failures, stalled retrieval, conflicting evidence or an answer with unresolved constraints; no explicit @memory diagnose request is required. Use message_read to obtain a relevant saved message authored by that Task in your shared channel. The server freezes bounded conversation evidence through that message, binds the Task recipient, and publishes only a completed approved report. Reuse the same messageId while running; a different operationId does not create a new diagnosis for that message. Do not launch new diagnoses for unchanged task state. Stop after published=true or failed. No private tool trajectory, ground truth or grader score is supplied, and this never dispatches remediation.",
      "diagnose",
      {
        operationId: Type.String(),
        messageId: Type.String({
          description:
            "Full UUID from message_read of the Task-authored status, answer, failure or explicit diagnosis request that anchors this diagnosis. Use the same messageId for polling; never use your own message or invent an ID.",
        }),
      },
    ),
    [OPENVIKING_TOOL_NAMES.expand]: openvikingTool(
      OPENVIKING_TOOL_NAMES.expand,
      "Expand memory graph",
      "Read related experience and recorded evidence from nodes already returned by ov_fork_find or ov_expand. After finding a relevant Fork, inspect its suggested method with branch_steps, then next/previous on returned steps. To verify why the method was proposed, use anchor on the Fork to reach its original recorded AIG block; alternatively use observed_block on a Fork step to inspect its associated recorded block. From an AIG block, incoming/outgoing returns causal edges; source/target on a returned edge reaches the preceding/following blocks. Use the returned cited items and node metadata; choose the path that resolves the current question without loading the entire graph. Every hop must use the returned retrieval.chainRef, an already-served node URI and a relation listed for that node. Check remainingHops/exhausted; never invent URIs, relations or chain references. Fork steps are untested counterfactual proposals, while AIG blocks record prior execution; neither replaces documentary evidence for the current factual answer. Expansion is bounded and uses no embedding.",
      "expand",
      {
        operationId: Type.String({
          description: "Fresh id for a new logical expansion; identical retries keep the same id.",
        }),
        chainRef: Type.String({
          description: "Copy retrieval.chainRef from the active ov_fork_find/ov_expand result.",
        }),
        uri: Type.String({
          description: "Copy an already-returned retrieval.nodes[].uri from this chain.",
        }),
        relation: Type.Union(
          OPENVIKING_GRAPH_RELATIONS.map((value) => Type.Literal(value)),
          {
            description:
              "Must be listed in that node's relations. Fork: anchor or branch_steps. Fork step: next, previous or observed_block. AIG block: incoming or outgoing (returns edges), or forks. AIG edge: source or target (returns blocks).",
          },
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      },
    ),
    [OPENVIKING_TOOL_NAMES.forkFind]: openvikingTool(
      OPENVIKING_TOOL_NAMES.forkFind,
      "Find Fork experience",
      "Find frozen Fork methods only in viking://resources/causal/forks. Query abstract failure patterns or reusable methods, not factual entity clues. Inspect relevant served branch_steps with ov_expand, then next/previous as needed; follow anchor to the original AIG evidence. Forks are untested counterfactual suggestions and cannot replace documentary evidence. Tell Task when current factual evidence is still needed.",
      "fork_find",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: find-1. Use a fresh id for each new logical operation or changed arguments; preserve the id only for an identical retry.",
        }),
        query: Type.String({
          description: "Required. Search text. Example: deploy rollback.",
        }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Optional. Integer from 1 to 10. Example: 10.",
          }),
        ),
      },
    ),
    [OPENVIKING_TOOL_NAMES.experienceFind]: openvikingTool(
      OPENVIKING_TOOL_NAMES.experienceFind,
      "Find experience cards",
      "Find frozen experience cards from earlier tasks. A skill_card is a successful method whose steps include verify checks (what to check, how, and when it is violated). A fork is a guard: a corrective branch for a known failure, linked to the verify step it violates. Describe the task situation and the issue to avoid in the query; set deliverable when the output file type is known (pdf, docx, xlsx, pptx, av, text), occupation when you can infer it from the task, and issueKind for the failure type to avoid. If the deliverable filter matches nothing it is dropped and the result says relaxed. Each result is a self-contained cited card; cards are untested suggestions from other tasks, not evidence for the current task's facts. Use verify steps as a pre-submission checklist for Task.",
      "experience_find",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: exp-1. Use a fresh id for each new logical operation or changed arguments.",
        }),
        query: Type.String({
          description:
            "Required. Task situation and issue to avoid. Example: quarterly financial report pdf missing sections.",
        }),
        kind: Type.Optional(
          Type.Union(
            EXPERIENCE_CARD_KINDS.map((value) => Type.Literal(value)),
            { description: "Optional. Omit to get both kinds." },
          ),
        ),
        deliverable: Type.Optional(
          Type.Union(
            EXPERIENCE_DELIVERABLE_KINDS.map((value) => Type.Literal(value)),
            { description: "Optional hard filter on the output file type." },
          ),
        ),
        occupation: Type.Optional(
          Type.String({
            description: "Optional soft boost. GDPVal occupation label inferred from the task.",
          }),
        ),
        issueKind: Type.Optional(
          Type.Union(
            EXPERIENCE_ISSUE_KINDS.map((value) => Type.Literal(value)),
            { description: "Optional soft boost on the failure type to avoid." },
          ),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      },
    ),
    [OPENVIKING_TOOL_NAMES.searchContext]: openvikingTool(
      OPENVIKING_TOOL_NAMES.searchContext,
      "OpenViking search context",
      "Retrieve documentary evidence with local embedding recall and native hierarchical context assembly within the shared token budget. Use entity clues or paraphrased factual questions here, then ov_read promising cited sources to verify missing constraints. Use ov_fork_find for methods and failure-pattern experience.",
      "search_context",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: search-1. Use a new id on every call.",
        }),
        query: Type.String({
          description: "Required. Search text. Example: deploy rollback.",
        }),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: "Optional. Integer from 1 to 10. Example: 10.",
          }),
        ),
        targetUri: Type.Optional(
          Type.String({
            description:
              "Optional. URI scope. Omit to search the whole workspace. Example: viking://workspace/docs.",
          }),
        ),
        tokenBudget: Type.Optional(
          Type.Integer({
            minimum: 64,
            maximum: 32000,
            description: "Optional. Integer budget (64..32000) for this expansion. Example: 2400.",
          }),
        ),
      },
    ),
    [OPENVIKING_TOOL_NAMES.read]: openvikingTool(
      OPENVIKING_TOOL_NAMES.read,
      "OpenViking read",
      "Read one cited OpenViking document in full by URI. Document context results are bounded evidence cards; repeated snippets may be omitted. Read relevant sources to check unresolved constraints, and before concluding a detail is absent. A short or omitted discovery excerpt is not evidence that the full source lacks the answer.",
      "read",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: read-1. Use a fresh id for each new logical operation or changed arguments; preserve the id only for an identical retry.",
        }),
        uri: Type.String({
          description:
            "Required. URI cited by ov_search_context, ov_fork_find or ov_expand. Example: viking://workspace/docs/note.md.",
        }),
      },
    ),
    [OPENVIKING_TOOL_NAMES.offer]: openvikingTool(
      OPENVIKING_TOOL_NAMES.offer,
      "Publish Memory Offer",
      "Publish one visible, cited Memory Offer. Partial findings and explicit unresolved constraints are valid; do not wait to solve the whole Task. This is the only visible answer to an explicit @memory question. citationRefs are citation ids already returned in this workspace. The server binds the channel and recipient. This completes the retrieval round: include unresolved constraints and suggested next queries; do not promise autonomous continued searching.",
      "offer",
      {
        operationId: Type.String({
          description:
            "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: offer-request123-1. New request or changed findings require a new id; identical retries keep the same id.",
        }),
        citationRefs: Type.Array(
          Type.String({
            description: "One citation id already returned in this workspace.",
          }),
          {
            minItems: 1,
            description:
              'Required. Array of at least 1 citation id already returned in this workspace. Example: ["ov:wiki/deploy"].',
          },
        ),
        body: Type.String({
          description:
            "Required. Offer text for the task agent. Example: the last deploy rolled back.",
        }),
      },
    ),
  };
}
