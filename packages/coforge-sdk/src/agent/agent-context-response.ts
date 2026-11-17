export type AgentContextResponse = {
  agent: {
    id: string;
    name: string;
    displayName: string;
    description: string;
    role: string;
    external: boolean;
  };
  workspace: { id: string; slug: string; name: string };
  credential: { id: string } | null;
  capabilities: string[] | null;
  prompt: { text: string } | null;
};
