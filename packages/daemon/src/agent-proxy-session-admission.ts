export type AgentSessionState = {
  isRunning(agentId: string): boolean;
  launch(agentId: string): { stopping: boolean } | undefined;
};

export function agentSessionIsLive(state: AgentSessionState, agentId: string): boolean {
  if (state.isRunning(agentId)) return true;
  const launch = state.launch(agentId);
  return launch !== undefined && !launch.stopping;
}
