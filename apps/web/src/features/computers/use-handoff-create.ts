import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { agentCreateErrorMessage } from "#src/features/agents/agent-form";
import type { CreateAgentInput } from "#src/features/agents/agent.schemas";
import { createAgent } from "#src/features/agents/agents.functions";
import { useRefreshAgentDirectory } from "#src/features/agents/workspace-agents-realtime";
import { useCloseConversationList } from "#src/features/conversations/conversation-navigation";
import {
  openDirectConversation,
  sendDirectConversationMessage,
} from "#src/features/conversations/conversations.functions";
import { useRefreshSidebar } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";

/** The Agent a handoff created and the briefing it still has to deliver. The key is made once, so
 * every resend is the same send to the server, never a second message. */
type CreatedHandoff = {
  agentId: string;
  name: string;
  idempotencyKey: string;
  briefing: string;
  conversationId?: string;
};

/**
 * Creates the handoff Agent, then opens its direct conversation and sends it the briefing. Once
 * the Agent exists the hook keeps it: `submit` again only delivers the briefing (the same text,
 * under the same idempotency key), so a failed delivery never leads to a second Agent.
 * `briefingFailed` says the Agent exists and the briefing is not delivered yet.
 */
export function useHandoffCreate({ onDone }: { onDone: () => void }) {
  const create = useServerFn(createAgent);
  const open = useServerFn(openDirectConversation);
  const send = useServerFn(sendDirectConversationMessage);
  const refreshDirectory = useRefreshAgentDirectory();
  const refreshSidebar = useRefreshSidebar({ throwOnError: false });
  const closeList = useCloseConversationList();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const [pending, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedHandoff>();
  const [briefingFailed, setBriefingFailed] = useState(false);

  async function deliver(handoff: CreatedHandoff) {
    let conversationId: string;
    try {
      conversationId =
        handoff.conversationId ??
        (await open({ data: { agentId: handoff.agentId } })).conversationId;
      handoff.conversationId = conversationId;
      await send({
        data: {
          conversationId,
          idempotencyKey: handoff.idempotencyKey,
          body: handoff.briefing,
        },
      });
    } catch {
      setBriefingFailed(true);
      return;
    }
    setBriefingFailed(false);
    await openConversation(conversationId);
  }

  /** Goes to the Agent's direct conversation and closes the dialog. */
  async function openConversation(conversationId: string) {
    await refreshSidebar(["dms"]);
    closeList();
    await navigate({
      to: "/w/$workspaceSlug/dm/$dmId",
      params: { workspaceSlug, dmId: conversationId },
    });
    onDone();
  }

  async function submit(input: CreateAgentInput, briefing: string) {
    setError("");
    await guard(async () => {
      let handoff = created;
      if (!handoff) {
        try {
          const { agent } = await create({ data: input });
          handoff = {
            agentId: agent.id,
            name: input.name,
            idempotencyKey: crypto.randomUUID(),
            briefing,
          };
        } catch (cause) {
          setError(agentCreateErrorMessage(cause));
          return;
        }
        setCreated(handoff);
        // The Agent exists now; a directory read that fails is repaired by the next signal.
        await refreshDirectory().catch(() => {});
      }
      await deliver(handoff);
    });
  }

  const conversationId = created?.conversationId;
  return {
    submit,
    pending,
    error,
    createdName: created?.name,
    briefingFailed,
    /** Leaves for the Agent's direct conversation, once it is open, without the briefing. */
    openConversation: conversationId ? () => openConversation(conversationId) : undefined,
  };
}
