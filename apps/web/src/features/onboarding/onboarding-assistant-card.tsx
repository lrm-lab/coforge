import { AgentMascotView } from "#src/features/agents/agent-mascot-view";
import { agentMascot } from "#src/features/agents/agent-mascot";

/** The assistant as a card: its own mascot, large, and its name. */
export function AssistantCard({
  agentId,
  avatarMascot,
  name,
}: {
  agentId: string;
  avatarMascot: string | null;
  name: string;
}) {
  return (
    <div className="flex w-full max-w-72 flex-col items-center gap-3 rounded-2xl border border-secondary bg-primary px-6 py-8 text-center shadow-lg">
      <span role="img" aria-label={name} className="block size-28">
        <AgentMascotView mascot={agentMascot(agentId, avatarMascot)} activity="idle" />
      </span>
      <p className="text-xl font-semibold text-primary">{name}</p>
    </div>
  );
}
