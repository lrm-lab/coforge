import type { TaskStatus } from "@lrm/coforge-sdk/internal";

/** A person a system notice names: the id opens their profile, the handle and name survive it. */
export type SystemPerson = { memberId: string; handle: string; displayName: string };

/** A Task a system notice names; the id survives a title change. */
export type SystemTask = { taskId: string; number: number; title: string };

/**
 * A server-authored system message's structured content. `Message.body` is the rendered English
 * text the Agent API, CLI and search read; the web renders this shape in the viewer's language.
 * `params` carries facts only, never display text.
 */
export type SystemNotice =
  | { kind: "task.created"; params: { tasks: SystemTask[] } }
  | { kind: "task.converted"; params: { actor: SystemPerson; task: SystemTask } }
  | { kind: "task.from_message"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "task.assigned";
      params: { actor: SystemPerson; task: SystemTask; assignee: SystemPerson };
    }
  | { kind: "task.claimed"; params: { claimer: SystemPerson; task: SystemTask } }
  | { kind: "task.moved"; params: { actor: SystemPerson; task: SystemTask; status: TaskStatus } }
  | { kind: "task.unassigned"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "task.unfollowed";
      params: { actor: SystemPerson; task: SystemTask; reason?: string };
    }
  | { kind: "task.assigned_you"; params: { actor: SystemPerson; task: SystemTask } }
  | {
      kind: "channel.coordinator_changed";
      params: {
        channelId: string;
        channelName: string;
        actor: SystemPerson;
        previous?: SystemPerson;
        next?: SystemPerson;
      };
    }
  | { kind: "agent_dm.chain_limit" | "agent_dm.rate_limit"; params: Record<string, never> }
  | { kind: "legacy_text"; params: { body: string } };

/** The body and structured content one notice carries. */
export type SystemNoticeContent = { body: string; system: SystemNotice };
