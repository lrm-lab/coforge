export type ReminderJob = {
  reminderId: string;
  ownerAgentId: string;
  version: number;
  title: string;
  target: string;
  messageId: string;
  fireAt: string;
};

export type ReminderTriggerJob = Omit<ReminderJob, "messageId"> & {
  kind: "trigger";
  triggerKey: string;
  details?: string;
};
