import { AgentDisplayAvatar } from "./agent-display-avatar";
import { AgentMascotAvatar } from "./agent-mascot-avatar";
import { useLiveAgentDisplay, useLiveAgentMascot } from "./workspace-agents-realtime";

/** An Agent's `sm` avatar with that Agent's live status dot: it reads that one Agent, so another
 * Agent's activity never repaints the row that shows it. */
export function LiveAgentAvatar({
  agentId,
  name,
  src,
  deleted,
  animated = false,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  deleted?: boolean;
  /** The mascot moves with the Agent's activity (`AgentMascotAvatar`): where a mascot is the
   * subject, a message in the stream. An Agent outside the live roster, or a deleted one, stays a
   * still picture. */
  animated?: boolean;
}) {
  const display = useLiveAgentDisplay(agentId);
  const mascot = useLiveAgentMascot(agentId);
  if (animated && mascot && !deleted) {
    return <AgentMascotAvatar mascot={mascot} name={name} display={display} cornerDot announced />;
  }
  return (
    <AgentDisplayAvatar
      agentId={agentId}
      name={name}
      src={src}
      display={display}
      deleted={deleted}
      size="sm"
    />
  );
}
