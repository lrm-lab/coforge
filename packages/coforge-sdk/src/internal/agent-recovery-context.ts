import {
  AGENT_START_OPEN_TASKS_MAX,
  isRecoverableAgentTarget,
  type AgentStartOpenTask,
  type AgentStartOpenTasks,
} from "./index";
import { isValidMessageSender } from "./message-sender";

export type AgentRecoveryContextMessage = {
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSenderKind: string;
  latestSenderHandle: string;
  body: string;
};

const AGENT_RECOVERY_RESUME_MESSAGES_MAX = 100;
const UNREAD_COUNT_MAX = 4294967295;
const OPEN_TASK_REF_MAX = 256;
const OPEN_TASK_TITLE_MAX = 512;
const OPEN_TASK_STATUSES = new Set<string>(["todo", "in_progress"]);

function isOpenTaskStatus(status: string): status is AgentStartOpenTask["status"] {
  return OPEN_TASK_STATUSES.has(status);
}

function sliceUtf16Safe(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = (value.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return value.slice(0, end);
}

export function assertAgentStartOpenTasks(
  openTasks: AgentStartOpenTasks | undefined,
): AgentStartOpenTasks | undefined {
  if (!openTasks) return undefined;
  const fail = (reason: string) => {
    throw new Error(`invalid Agent start open tasks: ${reason}`);
  };
  if (!Number.isInteger(openTasks.more) || openTasks.more < 0 || openTasks.more > UNREAD_COUNT_MAX)
    fail("more count is out of range");
  if (openTasks.tasks.length === 0) {
    if (openTasks.more > 0) fail("more count requires at least one task");
    return openTasks;
  }
  if (openTasks.tasks.length > AGENT_START_OPEN_TASKS_MAX)
    fail(`more than ${AGENT_START_OPEN_TASKS_MAX} tasks`);
  for (const task of openTasks.tasks) {
    if (typeof task.ref !== "string" || !task.ref.trim() || task.ref.length > OPEN_TASK_REF_MAX)
      fail("invalid task ref");
    if (typeof task.title !== "string" || task.title.length > OPEN_TASK_TITLE_MAX)
      fail("invalid task title");
    if (!isOpenTaskStatus(task.status)) fail("invalid task status");
  }
  return openTasks;
}

export function normalizeAgentStartOpenTasks(
  openTasks:
    | {
        tasks: readonly { ref: string; title: string; status: string }[];
        more: number;
      }
    | undefined,
): AgentStartOpenTasks | undefined {
  if (!openTasks) return undefined;
  if (openTasks.tasks.length === 0)
    return openTasks.more === 0 ? { tasks: [], more: 0 } : undefined;
  const tasks: AgentStartOpenTask[] = [];
  let overflow = 0;
  for (const task of openTasks.tasks) {
    if (!isOpenTaskStatus(task.status)) continue;
    const trimmedRef = task.ref.trim();
    if (!trimmedRef) continue;
    if (tasks.length >= AGENT_START_OPEN_TASKS_MAX) {
      overflow += 1;
      continue;
    }
    const ref = sliceUtf16Safe(trimmedRef, OPEN_TASK_REF_MAX).trim();
    if (!ref) continue;
    tasks.push({
      ref,
      title: sliceUtf16Safe(task.title, OPEN_TASK_TITLE_MAX),
      status: task.status,
    });
  }
  if (tasks.length === 0) return undefined;
  const rawMore = Number.isInteger(openTasks.more) && openTasks.more > 0 ? openTasks.more : 0;
  return {
    tasks,
    more: Math.min(UNREAD_COUNT_MAX, rawMore + overflow),
  };
}

function isRecoverableAgentMessage(message: AgentRecoveryContextMessage): boolean {
  return (
    !!message.messageId &&
    !!message.deliveryId &&
    !!message.conversationId &&
    !!message.body &&
    isRecoverableAgentTarget(message.target) &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence >= 1 &&
    isValidMessageSender(message.latestSenderKind, message.latestSenderHandle)
  );
}

export function assertAgentRecoveryContext(context: {
  wakeMessage?: AgentRecoveryContextMessage;
  resumeMessages: readonly AgentRecoveryContextMessage[];
  unreadSummary: readonly { target: string; count: number }[];
}): void {
  const { wakeMessage, resumeMessages, unreadSummary } = context;
  const fail = (reason: string) => {
    throw new Error(`invalid agent recovery context: ${reason}`);
  };
  const messages = [...(wakeMessage ? [wakeMessage] : []), ...resumeMessages];
  if (resumeMessages.length > AGENT_RECOVERY_RESUME_MESSAGES_MAX)
    fail(`more than ${AGENT_RECOVERY_RESUME_MESSAGES_MAX} resume messages`);
  if (!messages.every(isRecoverableAgentMessage)) fail("a message a Start cannot carry");
  if (
    new Set(messages.map(({ messageId }) => messageId)).size !== messages.length ||
    new Set(messages.map(({ deliveryId }) => deliveryId)).size !== messages.length
  )
    fail("a repeated message");
  for (const { target, count } of unreadSummary)
    if (
      !isRecoverableAgentTarget(target) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > UNREAD_COUNT_MAX
    )
      fail("an unread count a Start cannot carry");
  if (new Set(unreadSummary.map(({ target }) => target)).size !== unreadSummary.length)
    fail("a repeated unread target");
}
