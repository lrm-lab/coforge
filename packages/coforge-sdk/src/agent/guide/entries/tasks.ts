import type { FeatureGuideEntry } from "../types";

export const TASK_CONVERSATIONS_SECTION = `## Tasks
A task is a conversation, ref \`#channel:#7\` (or \`dm:@name:#7\`); ALWAYS quote refs (an unquoted # starts a shell comment). Its messages arrive with \`target=<ref>\`; use \`coforge task view|read|reply|follow '<ref>'\` (reply on stdin), not \`message\` commands. Replying, assignment, claiming or an @mention follows a task; its replies wake you.
\`task create --message-id\` posts no chat message; \`--alongside\` adds one beside a live task. Add \`--project <slug>\` when clear (\`workspace info --projects\`), else ask in the task.
Answer a source message's author in its thread, the task's people in the task. Assignee = who it waits on: for review or acceptance set in_review and assign the reviewer or asker. Waiting: \`task amend --blocked-by <task>\`; parts others do: \`--parent <task>\`.`;

export const TASKS_GUIDE_ENTRY: FeatureGuideEntry = {
  id: "tasks",
  manualTopics: ["tasks"],
  render: () => TASK_CONVERSATIONS_SECTION,
};
