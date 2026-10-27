import { expect, test } from "bun:test";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

const directory = "/coforge/workspaces/workspace-a/agents/agent-a";

function memoryAgentSection(prompt: string): string {
  const start = prompt.indexOf("## Team memory (Memory Agent)");
  expect(start).toBeGreaterThan(-1);
  const after = prompt.slice(start);
  const next = after.slice(1).search(/\n## /);
  return next === -1 ? after : after.slice(0, next + 1);
}

function instructionsForFence(): string {
  return buildCoforgeAgentInstructions({
    agentWorkspaceDirectory: directory,
    toolProfile: "openviking-memory",
    memoryOfferOnly: false,
  });
}

test("the memory fence shows copyable tool JSON and does not teach shell message send", () => {
  const fenced = instructionsForFence();
  const section = memoryAgentSection(fenced);
  expect(section).toContain('ov_experience_find: {"operationId": "exp-1"');
  expect(section).not.toContain("ov_fork_find");
  expect(section).not.toContain("ov_expand");
  expect(section).toContain(
    '{"operationId": "offer-1", "citationRefs": ["<ov_experience_find 返回的 citation id>"], "body": "<给 @task 的正文>"}',
  );
  expect(section).toContain('{"target": "#<频道名>"}');
  expect(section).toContain('{"target": "#<频道名>", "content": "<正文>"}');
  expect(section).toContain("The body field name is content, not message.");
  expect(section).toContain("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  expect(section).toContain("at least 1");
  expect(fenced).not.toContain("coforge message send");
  expect(fenced).toContain("## Boundaries");
});

test("the document-retrieval section is eval-only and tells the Task Agent to search itself", () => {
  const original = Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS;
  const cap = Bun.env.COFORGE_EVAL_TASK_FIND_CAP;
  try {
    delete Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS;
    expect(buildCoforgeAgentInstructions({ agentWorkspaceDirectory: directory })).not.toContain(
      "## Document retrieval (OpenViking)",
    );
    Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS = "1";
    Bun.env.COFORGE_EVAL_TASK_FIND_CAP = "30";
    const text = buildCoforgeAgentInstructions({ agentWorkspaceDirectory: directory });
    expect(text).toContain("## Document retrieval (OpenViking)");
    expect(text).toContain("The Memory Agent never searches documents");
    expect(text).toContain("about 30 ov_find");
    expect(text).toContain('ov_find: {"operationId"');
  } finally {
    if (original === undefined) delete Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS;
    else Bun.env.COFORGE_EVAL_TASK_DOC_TOOLS = original;
    if (cap === undefined) delete Bun.env.COFORGE_EVAL_TASK_FIND_CAP;
    else Bun.env.COFORGE_EVAL_TASK_FIND_CAP = cap;
  }
});
