/**
 * Eval-only standing instructions for a Task Agent that owns document retrieval (ov_find / ov_read, see
 * packages/agent/src/task-doc-tools.ts). Enabled only by COFORGE_EVAL_TASK_DOC_TOOLS=1. The documents are a task
 * environment; the Memory Agent never searches them and only offers experience (fork / skill cards).
 */
export function taskDocToolsSection(env: Record<string, string | undefined> = Bun.env):
  | string
  | undefined {
  if (env.COFORGE_EVAL_TASK_DOC_TOOLS !== "1") return undefined;
  const findCap = env.COFORGE_EVAL_TASK_FIND_CAP;
  const budget = findCap
    ? `
- Your document budget is limited: about ${findCap} ov_find and ${env.COFORGE_EVAL_TASK_READ_CAP ?? "unlimited"} ov_read calls for this episode. Spend queries on distinct pivots, verify the leading candidate with ov_read, and always leave time to publish your final answer. When the budget is exhausted the tool says so; answer immediately with the evidence you have instead of searching again.`
    : "";
  return `## Document retrieval (OpenViking)

You search the task's document corpus yourself with ov_find (BM25) and verify sources with ov_read. The Memory Agent never searches documents; ask it (with @memory) for experience about HOW to search and verify, not for facts.

- Copy the arguments JSON below exactly, replacing angle-bracket placeholders. Put every argument in the arguments JSON. An empty object is invalid.
- ov_find queries are OR-matched word searches: quotation marks do not enforce phrases and date ranges such as 1951..1969 are not filters. Prefer short distinctive clue queries; ov_read promising documents, verify dates and relations in their text, and pivot using actual candidate entities. Do not invent constraints absent from the question or the evidence.
- ov_find returns compact discovery cards: uri, excerpt, score and a retrieval chainRef. Repeated or long snippets are shortened or omitted; use ov_read on the URI before concluding a detail is absent. The document id for citations is the file name in the URI without .md.
- If a candidate is irrelevant, say why and pivot to different constraint or clue words; do not repeat equivalent searches.${budget}
- Your final answer counts only once delivered: send it with \`coforge message send\` (heredoc form, target from the trigger notice) in the required Explanation / Exact Answer / Confidence format. Text written in your session without a send command is never delivered.
- CLI discipline: \`coforge message read\` takes --target plus --before/--after/--around/--limit only. When a command fails with its usage text, never repeat the identical command; read the usage and fix the syntax. \`coforge message check\` already returns full recent messages.

ov_find: {"operationId":"find-<triggering-message-id>-1","query":"<short distinctive clue words>","limit":10}
ov_read: {"operationId":"read-<triggering-message-id>-1","uri":"<uri returned by ov_find>"}`;
}
