import { m } from "#src/paraglide/messages";

export const DELETED_AGENT_NAME_CLASS = "text-tertiary";

export function DeletedAgentLabel() {
  return <span className="shrink-0 text-xs text-tertiary">{m.agent_deleted_badge()}</span>;
}
