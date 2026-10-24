/** information_retrieval variant of the parallel start. Memory offers experience about HOW to search and verify
 * (fork / skill cards); documents are the Task Agent's own ov_find / ov_read. */
export const MEMORY_PARALLEL_NOTE_IR = [
  "Memory Agent and Task Agent start together on this message.",
  "Memory Agent: you never search documents. Retrieve prior search and verification experience with ov_experience_find",
  "(describe the question type and the failure to avoid; deliverable 'text'), then publish ONE cited Offer to Task with memory_offer",
  "(citationRefs = the citation ids ov_experience_find returned for the cards you rely on). Do not invent evidence.",
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
