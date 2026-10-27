/** information_retrieval variant of the parallel start. Memory offers experience about HOW to search and verify
 * (fork / skill cards); documents are the Task Agent's own ov_find / ov_read. */
export const MEMORY_PARALLEL_NOTE_IR = [
  "Memory Agent and Task Agent start together on this message.",
  "Memory Agent: you never search documents. Retrieve prior search and verification experience with ov_experience_find",
  "(describe the question type and the failure to avoid; deliverable 'text'), then publish ONE cited Offer to Task with memory_offer",
  "(citationRefs = the citation ids ov_experience_find returned for the cards you rely on). Do not invent evidence.",
  "If nothing was returned, or none of the returned cards applies to this question, send ONE short plain channel message",
  "saying no card applies (if the server first refuses it because an Offer is required, send the same message once more).",
  "Answer every later @memory question from Task the same way, using the question type and progress it states.",
  "Task Agent: search the corpus yourself with ov_find / ov_read and start right away; also ask Memory Agent for experience",
  "yourself, do not wait for a Hint to show up. Ask by sending a channel message to the channel this task came from, e.g.",
  "`coforge message send --target '<this channel>'` with a body that starts with @memory and has three parts:",
  "(1) question type: e.g. 'multi-constraint entity question about a film actor';",
  "(2) progress: constraints already verified, the leading candidate, searches tried so far;",
  "(3) the question: which search strategies, query patterns or verification checks apply, with citations. Never put the answer format lines in an ask.",
  "Ask at these moments, one short message each, at most 4 asks in total, never the same question twice:",
  "A. first, before your first search ('@memory Question type: ... Progress: just started. Any experience card on how to search this kind of question?');",
  "B. when about 5 searches gave no verified candidate or you are pivoting ('Progress: tried <queries>, no candidate. Which strategy applies?');",
  "C. when you have a leading candidate and still have constraints to verify ('Progress: candidate <name>, verified <x>, open <y>. Which checks apply?');",
  "D. before you post the final answer, as a self-check of format and evidence ('Progress: answer drafted. Which pre-submission checks apply?').",
  "Keep working while you wait; read the reply with `coforge message check`. When a Memory Hint arrives,",
  "call memory_disposition (adopt, reject or defer, with a reason) before applying it.",
].join(" ");

/** The document environment of the information_retrieval par protocol (the search MCP section of the task is dropped). */
export const IR_DOCS_NOTE = [
  "Documents: search the corpus with ov_find and read sources with ov_read (your tool instructions show the arguments).",
  "The document id to cite is the file name in the URI without .md, e.g. viking://resources/evo-ir/documents/12345.md is [12345].",
].join(" ");

/** The official task text tells the agent to use only a "search" tool and no other tool, which contradicts the
 * channel protocol (messages to Memory, final answer in the channel). With document tools the CRITICAL RULES block is
 * replaced by the same advice phrased for ov_find / ov_read; the question and the answer format are untouched. */
const IR_TASK_DOCS_RULES = [
  "## RULES",
  "- Find evidence with the ov_find and ov_read document tools; do not use web search or any source outside the corpus.",
  "- You may search many times with different queries.",
  "- Think step by step: decompose the question into constraints, search for the most specific ones first.",
  "- After finding a candidate answer, verify ALL constraints before responding.",
  "- If you cannot find the exact answer, give your best guess.",
  "",
].join("\n");

export function irTaskDocsPrompt(prompt: string): string {
  const start = prompt.indexOf("## CRITICAL RULES");
  const end = prompt.indexOf("## Response Format");
  return start >= 0 && end > start
    ? `${prompt.slice(0, start)}${IR_TASK_DOCS_RULES}\n${prompt.slice(end)}`
    : prompt;
}
