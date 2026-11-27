import type { AgentRuntimeProviderConfig } from "#src/server/agents/agent-runtime-config.server";
import { m } from "#src/paraglide/messages";
import { FactRow } from "./agent-fact-row";

export function AgentCodexCompatibleFact({ provider }: { provider: AgentRuntimeProviderConfig }) {
  if (provider.kind !== "codex-compatible") return null;
  return (
    <FactRow label={m.agent_form_model_provider()}>
      <div className="min-w-0">
        <span className="block">{m.agent_form_codex_provider_compatible()}</span>
        <span dir="ltr" className="mt-0.5 block break-all text-xs text-tertiary">
          {provider.baseUrl}
        </span>
        <span className="mt-0.5 block text-xs text-tertiary">
          {m.computer_usage_provider_api_key()}
        </span>
      </div>
    </FactRow>
  );
}
