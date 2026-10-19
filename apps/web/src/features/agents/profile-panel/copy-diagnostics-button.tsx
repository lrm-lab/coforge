import { useState } from "react";
import { Check, Copy01 as Copy } from "@untitledui/icons";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  agentDiagnosticInfo,
  type AgentDiagnosticFacts,
} from "#src/features/agents/agent-diagnostics";
import { useReadAgentActivityFeed } from "#src/features/agents/workspace-agents-realtime";
import { copyText } from "#src/lib/clipboard";
import { m } from "#src/paraglide/messages";

/** Copies the Agent's diagnostic block; the icon turns into a check for a moment to confirm it.
 * The Activity tab's band and the error banner share it, so both copy the same text. */
export function CopyDiagnosticsButton({
  agent,
  display,
}: {
  agent: AgentDiagnosticFacts;
  display?: AgentDisplaySnapshot;
}) {
  const readFeed = useReadAgentActivityFeed(agent.id);
  const [copied, setCopied] = useState(false);
  return (
    <ButtonUtility
      icon={copied ? Check : Copy}
      size="sm"
      color="tertiary"
      tooltip={copied ? m.agent_activity_diagnostics_copied() : m.agent_activity_copy_diagnostics()}
      aria-label={m.agent_activity_copy_diagnostics()}
      onClick={() => {
        const text = agentDiagnosticInfo({
          agent,
          display,
          // The feed is newest first.
          lastActivityAtMs: readFeed()?.[0]?.observedAtMs,
        });
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    />
  );
}
