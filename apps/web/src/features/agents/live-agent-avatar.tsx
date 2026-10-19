import { AgentDisplayAvatar } from "./agent-display-avatar";
import { useLiveAgentDisplay } from "./workspace-agents-realtime";

/** An Agent's `sm` avatar with that Agent's live status dot: it reads that one Agent, so another
 * Agent's activity never repaints the row that shows it. */
export function LiveAgentAvatar({
  agentId,
  name,
  src,
  deleted,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  deleted?: boolean;
}) {
  const display = useLiveAgentDisplay(agentId);
  return <AgentDisplayAvatar name={name} src={src} display={display} deleted={deleted} size="sm" />;
}
