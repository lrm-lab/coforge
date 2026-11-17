export type ReminderJob = {
  reminderId: string;
  ownerAgentId: string;
  version: number;
  title: string;
  target: string;
  messageId: string;
  fireAt: string;
};
