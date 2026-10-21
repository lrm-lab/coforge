import { AgentDesktopButton } from "#src/features/computers/agent-desktop-button";
import type { getAgentProfile } from "#src/features/agents/agents.functions";

type AgentProfile = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>;

/** Opens this Agent's cloud desktop in its own window. The panel does not embed it. */
export function AgentComputerTab({ profile }: { profile: AgentProfile }) {
  if (!profile.computer) return null;
  return (
    <div className="px-5 py-5">
      <AgentDesktopButton
        computerId={profile.computer.id}
        agentId={profile.id}
        kind={profile.computer.kind}
        online={profile.computer.online === true}
        owned={profile.computer.ownedByViewer === true}
      />
    </div>
  );
}
