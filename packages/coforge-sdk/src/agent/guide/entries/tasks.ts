import type { FeatureGuideEntry } from "../types";

export const TASK_CONVERSATIONS_SECTION = `## Tasks
Ref \`#channel:#7\` or \`dm:@name:#7\`; ALWAYS quote refs (an unquoted # starts a shell comment). Use \`coforge task view|read|reply|follow '<ref>'\` (stdin), not \`message\`.
\`task create --message-id <id>\` (required; replies→root; \`--status backlog|todo|in_progress\`): confirm in source thread first (1-on-1 DM: DM timeline). \`--project <slug>\` (\`workspace info --projects\`), else ask in the task.
Statuses: \`backlog|todo|in_progress|done|closed\` (\`in_review\` retired; park: \`--reason\`). Hand off: \`task assign '<ref>' @who --reason\`.
Answer where spoken: source author in thread, task people in task; 1-on-1 DM confirm/ask/results: DM timeline (\`--target '@peer'\`), not thread/task. \`--blocked-by\`, \`--parent\`.`;

export const TASKS_GUIDE_ENTRY: FeatureGuideEntry = {
  id: "tasks",
  manualTopics: ["tasks"],
  render: () => TASK_CONVERSATIONS_SECTION,
};
